import crypto from "node:crypto";
import fs from "node:fs";
import mongoose from "mongoose";
import { IdempotencyKey } from "../../database/models/idempotencyKey/index.js";
import type { SendMessageResponse } from "./chat.types.js";
import {
  ChatError,
  IdempotencyConflictError,
  IdempotencyPayloadMismatchError,
  IdempotencyUnresolvedRecoveryError,
} from "./chat.errors.js";

export const IDEMPOTENCY_IN_PROGRESS_TTL_MS = 10 * 60 * 1000; // 10 minutes
export const IDEMPOTENCY_SETTLED_RETENTION_MS = 24 * 60 * 60 * 1000; // 24 hours
export const IDEMPOTENCY_FAILED_RETENTION_MS = 60 * 1000; // 1 minute

export interface ReplayResult {
  isReplay: true;
  statusCode: number;
  payload: SendMessageResponse;
}

export interface ClaimResult {
  isReplay: false;
  claimToken: string;
  key: string;
}

export type IdempotencyCheckResult = ReplayResult | ClaimResult;

/**
 * Computes SHA-256 digest of actual attachment bytes.
 * Distinguishes different files even if they share identical filename, size, and MIME type.
 */
export const computeAttachmentDigest = (
  file?: Express.Multer.File
): string => {
  if (!file) {
    return "";
  }

  if (file.buffer && Buffer.isBuffer(file.buffer)) {
    return crypto.createHash("sha256").update(file.buffer).digest("hex");
  }

  if (file.path && fs.existsSync(file.path)) {
    try {
      const bytes = fs.readFileSync(file.path);
      return crypto.createHash("sha256").update(bytes).digest("hex");
    } catch {
      return "";
    }
  }

  return "";
};

/**
 * Computes deterministic SHA-256 request fingerprint combining
 * conversation ID, trimmed message content, and attachment SHA-256 digest.
 */
export const computeRequestHash = (
  conversationId: string | mongoose.Types.ObjectId,
  content: string,
  attachmentDigest: string
): string => {
  const normalizedContent = (content || "").trim();
  const convIdStr = conversationId.toString();
  return crypto
    .createHash("sha256")
    .update(`${convIdStr}:${normalizedContent}:${attachmentDigest}`)
    .digest("hex");
};

/**
 * Atomically checks, claims, or reclaims an idempotency key before heavy operations.
 * - If a settled replay exists with matching payload: returns cached response without calling AI or charging tokens.
 * - If in-progress or payload mismatch: rejects immediately.
 * - If expired: verifies no unresolved reservation exists before allowing in-place reclamation.
 * - Concurrently handles first-time claim races and duplicate key errors safely.
 */
export const claimOrCheckIdempotencyKey = async (
  userId: string | mongoose.Types.ObjectId,
  key: string,
  conversationId: string | mongoose.Types.ObjectId,
  requestHash: string
): Promise<IdempotencyCheckResult> => {
  const userObjectId =
    typeof userId === "string" ? new mongoose.Types.ObjectId(userId) : userId;
  const convObjectId =
    typeof conversationId === "string"
      ? new mongoose.Types.ObjectId(conversationId)
      : conversationId;

  const now = new Date();
  const existing = await IdempotencyKey.findOne({
    userId: userObjectId,
    key,
  });

  if (existing) {
    const isExpired = existing.expiresAt.getTime() <= now.getTime();

    if (!isExpired) {
      // Key is actively valid (unexpired)
      if (existing.requestHash && existing.requestHash !== requestHash) {
        throw new IdempotencyPayloadMismatchError();
      }

      if (existing.status === "SETTLED") {
        return {
          isReplay: true,
          statusCode: existing.statusCode || 201,
          payload: existing.responsePayload as SendMessageResponse,
        };
      }

      if (existing.status === "IN_PROGRESS") {
        throw new IdempotencyConflictError();
      }

      // If FAILED and not expired, allow retry if no reservation attached
      if (existing.status === "FAILED") {
        if (existing.reservationId != null) {
          throw new IdempotencyUnresolvedRecoveryError();
        }
      }
    }

    // Key is expired (or unexpired FAILED without reservation)
    // CRITICAL: Check for unresolved reservation before reclamation
    if (existing.reservationId != null && existing.status !== "SETTLED") {
      throw new IdempotencyUnresolvedRecoveryError(
        "Idempotency operation with unresolved reservation is pending recovery. Key cannot be reclaimed."
      );
    }

    // Safe to reclaim in-place
    const newClaimToken = crypto.randomUUID();
    const newExpiresAt = new Date(Date.now() + IDEMPOTENCY_IN_PROGRESS_TTL_MS);

    const reclaimed = await IdempotencyKey.findOneAndUpdate(
      {
        _id: existing._id,
        $or: [
          { status: "SETTLED" },
          { reservationId: null },
        ],
      },
      {
        $set: {
          claimToken: newClaimToken,
          conversationId: convObjectId,
          status: "IN_PROGRESS",
          requestHash,
          reservationId: null,
          assistantMessageId: null,
          responsePayload: null,
          statusCode: 201,
          expiresAt: newExpiresAt,
          updatedAt: new Date(),
        },
      },
      { returnDocument: "after" }
    );

    if (!reclaimed) {
      throw new IdempotencyConflictError();
    }

    return {
      isReplay: false,
      claimToken: newClaimToken,
      key,
    };
  }

  // First-time claim: attempt to create new document
  const claimToken = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + IDEMPOTENCY_IN_PROGRESS_TTL_MS);

  try {
    await IdempotencyKey.create({
      userId: userObjectId,
      key,
      conversationId: convObjectId,
      claimToken,
      requestHash,
      status: "IN_PROGRESS",
      statusCode: 201,
      reservationId: null,
      assistantMessageId: null,
      expiresAt,
    });

    return {
      isReplay: false,
      claimToken,
      key,
    };
  } catch (err: any) {
    if (err.code === 11000) {
      // Race condition: another concurrent worker claimed this key first
      const racedDoc = await IdempotencyKey.findOne({
        userId: userObjectId,
        key,
      });

      if (racedDoc) {
        if (racedDoc.requestHash && racedDoc.requestHash !== requestHash) {
          throw new IdempotencyPayloadMismatchError();
        }

        if (
          racedDoc.status === "SETTLED" &&
          racedDoc.expiresAt.getTime() > Date.now()
        ) {
          return {
            isReplay: true,
            statusCode: racedDoc.statusCode || 201,
            payload: racedDoc.responsePayload as SendMessageResponse,
          };
        }
      }

      throw new IdempotencyConflictError();
    }

    throw err;
  }
};

/**
 * Clean up an orphaned IN_PROGRESS claim if a pre-generation step fails
 * (e.g. lock contention 409, file upload error, balance error).
 * Strictly requires claimToken and reservationId === null so it never deletes another worker's claim.
 */
export const cleanupOrphanedClaim = async (
  userId: string | mongoose.Types.ObjectId,
  key: string,
  claimToken: string
): Promise<void> => {
  const userObjectId =
    typeof userId === "string" ? new mongoose.Types.ObjectId(userId) : userId;

  try {
    await IdempotencyKey.deleteOne({
      userId: userObjectId,
      key,
      claimToken,
      status: "IN_PROGRESS",
      reservationId: null,
    });
  } catch (err) {
    console.error("[Idempotency] Failed to clean up orphaned claim:", err);
  }
};

/**
 * Atomically links the created TokenReservation and assistant message to the claim
 * inside Transaction 1.
 */
export const bindReservationToClaim = async (
  userId: string | mongoose.Types.ObjectId,
  key: string,
  claimToken: string,
  reservationId: mongoose.Types.ObjectId,
  assistantMessageId: mongoose.Types.ObjectId,
  session: mongoose.ClientSession
): Promise<void> => {
  const userObjectId =
    typeof userId === "string" ? new mongoose.Types.ObjectId(userId) : userId;

  const result = await IdempotencyKey.updateOne(
    {
      userId: userObjectId,
      key,
      claimToken,
      status: "IN_PROGRESS",
    },
    {
      $set: {
        reservationId,
        assistantMessageId,
        updatedAt: new Date(),
      },
    },
    { session }
  );

  if (result.matchedCount === 0) {
    throw new ChatError(
      "Idempotency claim ownership lost before Transaction 1 commitment",
      500
    );
  }
};

/**
 * Finalizes the idempotency key to SETTLED inside Transaction 2A.
 * Atomically records response payload and extends expiration to the settled retention period.
 */
export const finalizeSettledClaim = async (
  userId: string | mongoose.Types.ObjectId,
  key: string,
  claimToken: string,
  responsePayload: SendMessageResponse,
  statusCode: number,
  session: mongoose.ClientSession
): Promise<void> => {
  const userObjectId =
    typeof userId === "string" ? new mongoose.Types.ObjectId(userId) : userId;

  const settled = await IdempotencyKey.findOneAndUpdate(
    {
      userId: userObjectId,
      key,
      claimToken,
      status: "IN_PROGRESS",
    },
    {
      $set: {
        status: "SETTLED",
        responsePayload,
        statusCode,
        expiresAt: new Date(Date.now() + IDEMPOTENCY_SETTLED_RETENTION_MS),
        updatedAt: new Date(),
      },
    },
    { session, returnDocument: "after" }
  );

  if (!settled) {
    throw new ChatError(
      "Idempotency claim ownership lost during settlement finalization",
      500
    );
  }
};

/**
 * Finalizes the idempotency key to FAILED inside Transaction 2B.
 */
export const finalizeFailedClaim = async (
  userId: string | mongoose.Types.ObjectId,
  key: string,
  claimToken: string,
  errorMessage: string,
  session: mongoose.ClientSession
): Promise<void> => {
  const userObjectId =
    typeof userId === "string" ? new mongoose.Types.ObjectId(userId) : userId;

  await IdempotencyKey.updateOne(
    {
      userId: userObjectId,
      key,
      claimToken,
      status: "IN_PROGRESS",
    },
    {
      $set: {
        status: "FAILED",
        statusCode: 500,
        responsePayload: {
          success: false,
          message: errorMessage,
        },
        expiresAt: new Date(Date.now() + IDEMPOTENCY_FAILED_RETENTION_MS),
        updatedAt: new Date(),
      },
    },
    { session }
  );
};

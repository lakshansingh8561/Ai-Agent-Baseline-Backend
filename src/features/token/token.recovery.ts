import mongoose, { Types, type ClientSession } from "mongoose";
import { TokenReservation } from "../../database/models/tokenReservation/index.js";
import type { ITokenReservationDocument } from "../../database/models/tokenReservation/tokenReservation.interface.js";
import { TokenWallet } from "../../database/models/tokenWallet/index.js";
import { Message } from "../../database/models/message/index.js";
import { IdempotencyKey } from "../../database/models/idempotencyKey/index.js";
import { Conversation } from "../../database/models/conversation/index.js";
import {
  ReservationStateConflictError,
  TokenInvariantViolationError,
} from "./token.errors.js";

export const DEFAULT_RECOVERY_LEASE_MS = 120 * 1000; // 120 seconds
export const DEFAULT_COMMIT_TIMEOUT_MS = 30 * 1000; // 30 seconds

export interface ClaimExpiredReservationParams {
  reservationId: string | Types.ObjectId;
  workerId: string;
  leaseTtlMs?: number;
  expectedVersion?: number;
}

export interface ResolveRecoveringReservationParams {
  reservationId: string | Types.ObjectId;
  workerId: string;
  expectedVersion: number;
  reason?: string;
  timeoutMs?: number;
}

export interface ResolveRecoveringReservationResult {
  reservation: ITokenReservationDocument;
  refundedAmount: number;
  messageUpdated: boolean;
  idempotencyUpdated: boolean;
  lockReleased: boolean;
}

export interface QuarantineTokenReservationParams {
  reservationId: string | Types.ObjectId;
  workerId: string;
  expectedVersion: number;
  reason: string;
}

export interface ReconcileAmbiguousCommitParams {
  reservationId: string | Types.ObjectId;
  workerId: string;
  expectedVersion: number;
}

export type ReconciliationStatus =
  | "COMMITTED"
  | "UNRESOLVED_CURRENT_VERSION"
  | "STOLEN"
  | "INDETERMINATE";

export interface ReconciliationOutcome {
  status: ReconciliationStatus;
  reservation: ITokenReservationDocument | null;
}

/**
 * Atomically claims an expired reservation using a versioned CAS predicate.
 *
 * Matches:
 * - RESERVED where lockExpiresAt <= now
 * - RECOVERING where recoveryExpiresAt <= now (reclaiming an expired previous recovery lease)
 * Optionally fences on expectedVersion if provided.
 *
 * Monotonically increments version and assigns claimOwner and recoveryExpiresAt.
 * Returns null if the reservation was claimed, updated, or finalized concurrently.
 */
export const claimExpiredReservation = async (
  params: ClaimExpiredReservationParams
): Promise<ITokenReservationDocument | null> => {
  const reservationObjectId =
    typeof params.reservationId === "string"
      ? new Types.ObjectId(params.reservationId)
      : params.reservationId;

  const now = new Date();
  const leaseTtl = params.leaseTtlMs ?? DEFAULT_RECOVERY_LEASE_MS;
  const leaseExpiresAt = new Date(now.getTime() + leaseTtl);

  const filter: Record<string, any> = {
    _id: reservationObjectId,
    $or: [
      { status: "RESERVED", lockExpiresAt: { $lte: now } },
      { status: "RECOVERING", recoveryExpiresAt: { $lte: now } },
    ],
  };

  if (typeof params.expectedVersion === "number") {
    filter.version = params.expectedVersion;
  }

  const claimed = await TokenReservation.findOneAndUpdate(
    filter,
    {
      $set: {
        status: "RECOVERING",
        claimOwner: params.workerId,
        recoveryExpiresAt: leaseExpiresAt,
        updatedAt: now,
      },
      $inc: {
        version: 1,
      },
    },
    { returnDocument: "after" }
  );

  return claimed;
};

/**
 * Atomically executes Phase B recovery resolution within a single MongoDB transaction.
 *
 * Mandatory Invariants:
 * 1. Fenced TokenReservation transition to REFUNDED guarded by { _id, status: 'RECOVERING', claimOwner, version }.
 *    If CAS fails, transaction aborts immediately (0 documents matched).
 * 2. TokenWallet hold restoration: { userId, reservedTokens: { $gte: reservedTokens } }.
 *    Restores 100% of hold to available balance. Aborts on hold deficit.
 * 3. Ancillary Message transition to 'failed' (best-effort within session; does not abort on missing message).
 * 4. Ancillary IdempotencyKey transition to 'FAILED' (best-effort within session; does not abort on missing key).
 * 5. Ancillary Conversation lock conditional release: strictly checks activeGenerationId === assistantMessageId
 *    AND lockExpiresAt <= now. Never clears a newer generation's lock.
 *
 * Uses MongoDB driver timeoutMS (default: 30_000ms) for client-side CSOT deadline.
 */
export const resolveRecoveringReservation = async (
  params: ResolveRecoveringReservationParams
): Promise<ResolveRecoveringReservationResult> => {
  const reservationObjectId =
    typeof params.reservationId === "string"
      ? new Types.ObjectId(params.reservationId)
      : params.reservationId;

  const timeoutMs = params.timeoutMs ?? DEFAULT_COMMIT_TIMEOUT_MS;
  const session = await mongoose.startSession();

  try {
    let result: ResolveRecoveringReservationResult | undefined;

    await session.withTransaction(
      async () => {
        const now = new Date();

        // 1. Core Gatekeeper: Transition TokenReservation from RECOVERING to REFUNDED
        const updatedReservation = await TokenReservation.findOneAndUpdate(
          {
            _id: reservationObjectId,
            status: "RECOVERING",
            claimOwner: params.workerId,
            version: params.expectedVersion,
          },
          {
            $set: {
              status: "REFUNDED",
              claimOwner: null,
              recoveryExpiresAt: null,
              verificationNotes:
                params.reason || "Refund finalized by Phase 4 recovery engine",
              updatedAt: now,
            },
            $inc: {
              version: 1,
            },
          },
          { session, returnDocument: "after" }
        );

        if (!updatedReservation) {
          throw new ReservationStateConflictError(
            `Recovery CAS conflict for reservation ${reservationObjectId} (expected version ${params.expectedVersion}, owner ${params.workerId})`
          );
        }

        // 2. Core Hold Restoration: Restore reserved hold back to available balance
        const updatedWallet = await TokenWallet.findOneAndUpdate(
          {
            userId: updatedReservation.userId,
            reservedTokens: { $gte: updatedReservation.reservedTokens },
          },
          {
            $inc: {
              reservedTokens: -updatedReservation.reservedTokens,
              balance: updatedReservation.reservedTokens,
            },
          },
          { session, returnDocument: "after" }
        );

        if (!updatedWallet) {
          throw new TokenInvariantViolationError(
            `Failed to restore token hold for user ${updatedReservation.userId}: reservedTokens deficit or wallet missing`
          );
        }

        // 3. Ancillary: Assistant Message status -> failed
        let messageUpdated = false;
        if (updatedReservation.assistantMessageId) {
          const msgRes = await Message.updateOne(
            {
              _id: updatedReservation.assistantMessageId,
              status: "generating",
            },
            {
              $set: {
                status: "failed",
                errorMessage:
                  params.reason ||
                  "Generation abandoned or timed out (recovered)",
                updatedAt: now,
              },
            },
            { session }
          );
          messageUpdated = msgRes.matchedCount > 0;
        }

        // 4. Ancillary: IdempotencyKey -> FAILED
        let idempotencyUpdated = false;
        const idempRes = await IdempotencyKey.updateOne(
          {
            reservationId: updatedReservation._id,
            status: "IN_PROGRESS",
          },
          {
            $set: {
              status: "FAILED",
              statusCode: 500,
              responsePayload: {
                success: false,
                message:
                  params.reason ||
                  "Generation timed out and reserved tokens were refunded",
              },
              expiresAt: new Date(now.getTime() + 60 * 1000), // 1-minute retention
              updatedAt: now,
            },
          },
          { session }
        );
        idempotencyUpdated = idempRes.matchedCount > 0;

        // 5. Ancillary: Conditional Conversation-Lock Fenced Release
        // Only releases if activeGenerationId matches assistantMessageId AND lockExpiresAt <= now
        let lockReleased = false;
        if (
          updatedReservation.conversationId &&
          updatedReservation.assistantMessageId
        ) {
          const lockRes = await Conversation.updateOne(
            {
              _id: updatedReservation.conversationId,
              activeGenerationId: updatedReservation.assistantMessageId,
              lockExpiresAt: { $lte: now },
            },
            {
              $set: {
                activeGenerationId: null,
                activeLockToken: null,
                lockExpiresAt: null,
                updatedAt: now,
              },
            },
            { session }
          );
          lockReleased = lockRes.matchedCount > 0;
        }

        result = {
          reservation: updatedReservation,
          refundedAmount: updatedReservation.reservedTokens,
          messageUpdated,
          idempotencyUpdated,
          lockReleased,
        };
      },
      { timeoutMS: timeoutMs }
    );

    return result!;
  } finally {
    await session.endSession();
  }
};

/**
 * Fenced quarantine transition for unresolvable or corrupted claims.
 *
 * Strict Fencing Predicates:
 * 1. _id matches reservation
 * 2. status === 'RECOVERING'
 * 3. claimOwner === params.workerId
 * 4. version === params.expectedVersion
 * 5. recoveryExpiresAt > now (Worker must still hold valid unexpired lease authority)
 *
 * Returns null if worker lost fencing, lease expired, or reservation was resolved concurrently.
 */
export const quarantineTokenReservation = async (
  params: QuarantineTokenReservationParams
): Promise<ITokenReservationDocument | null> => {
  const reservationObjectId =
    typeof params.reservationId === "string"
      ? new Types.ObjectId(params.reservationId)
      : params.reservationId;

  const now = new Date();

  const quarantined = await TokenReservation.findOneAndUpdate(
    {
      _id: reservationObjectId,
      status: "RECOVERING",
      claimOwner: params.workerId,
      version: params.expectedVersion,
      recoveryExpiresAt: { $gt: now },
    },
    {
      $set: {
        status: "QUARANTINED",
        claimOwner: null,
        recoveryExpiresAt: null,
        verificationNotes: `Quarantined: ${params.reason}`,
        updatedAt: now,
      },
      $inc: {
        version: 1,
      },
    },
    { returnDocument: "after" }
  );

  return quarantined;
};

/**
 * Reads the latest primary replica state using majority read concern
 * to determine the definitive outcome of an ambiguous commit.
 *
 * Outlines:
 * - COMMITTED: Document is REFUNDED with version === expectedVersion + 1. Succeeded remotely!
 * - ROLLED_BACK: Document is still RECOVERING with same claimOwner and expectedVersion. Safe to retry.
 * - STOLEN: Document version moved or claimOwner changed. Worker has lost fencing.
 * - INDETERMINATE: Document missing or in an unexpected state. Must be deferred/quarantined.
 */
export const reconcileAmbiguousCommit = async (
  params: ReconcileAmbiguousCommitParams
): Promise<ReconciliationOutcome> => {
  const reservationObjectId =
    typeof params.reservationId === "string"
      ? new Types.ObjectId(params.reservationId)
      : params.reservationId;

  const doc = await TokenReservation.findById(reservationObjectId).setOptions({
    readPreference: "primary",
    readConcern: { level: "majority" },
  });

  if (!doc) {
    return { status: "INDETERMINATE", reservation: null };
  }

  // 1. Succeeded remotely: REFUNDED and version incremented
  if (doc.status === "REFUNDED" && doc.version === params.expectedVersion + 1) {
    return { status: "COMMITTED", reservation: doc };
  }

  // 2. Did not take effect on primary: still RECOVERING with our workerId and version
  // Note: Does NOT prove definitive rollback (commit could still be in-flight); caller must use CAS.
  if (
    doc.status === "RECOVERING" &&
    doc.claimOwner === params.workerId &&
    doc.version === params.expectedVersion
  ) {
    return { status: "UNRESOLVED_CURRENT_VERSION", reservation: doc };
  }

  // 3. Stolen by another worker or version moved beyond expectedVersion + 1
  if (
    doc.claimOwner !== params.workerId ||
    doc.version > params.expectedVersion + 1 ||
    doc.status === "SETTLED"
  ) {
    return { status: "STOLEN", reservation: doc };
  }

  return { status: "INDETERMINATE", reservation: doc };
};

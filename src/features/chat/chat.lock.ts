import crypto from "node:crypto";
import mongoose from "mongoose";
import { Conversation } from "../../database/models/conversation/index.js";
import {
  ChatError,
  ChatLockConflictError,
  ConversationLockLostError,
} from "./chat.errors.js";

export const CONVERSATION_LOCK_TTL_MS = 120 * 1000; // 120 seconds

export interface AcquiredLock {
  conversationId: mongoose.Types.ObjectId;
  assistantMessageId: mongoose.Types.ObjectId;
  lockToken: string;
  lockVersion: number;
  lockExpiresAt: Date;
}

/**
 * Atomically acquires the conversation lock for a new generation.
 * Enforces authenticated user ownership and lease validity.
 * Monotonically increments lockVersion and assigns a cryptographically unique activeLockToken.
 * Throws ChatLockConflictError (409) if another generation holds an active, unexpired lease.
 */
export const acquireConversationLock = async (
  conversationId: string | mongoose.Types.ObjectId,
  userId: string | mongoose.Types.ObjectId,
  assistantMessageId: mongoose.Types.ObjectId,
  ttlMs = CONVERSATION_LOCK_TTL_MS
): Promise<AcquiredLock> => {
  const convObjectId =
    typeof conversationId === "string"
      ? new mongoose.Types.ObjectId(conversationId)
      : conversationId;
  const userObjectId =
    typeof userId === "string" ? new mongoose.Types.ObjectId(userId) : userId;

  const now = new Date();
  const lockExpiresAt = new Date(now.getTime() + ttlMs);
  const lockToken = crypto.randomUUID();

  const acquired = await Conversation.findOneAndUpdate(
    {
      _id: convObjectId,
      userId: userObjectId,
      $or: [
        { activeGenerationId: null },
        { activeLockToken: null },
        { lockExpiresAt: null },
        { lockExpiresAt: { $lte: now } },
      ],
    },
    {
      $set: {
        activeGenerationId: assistantMessageId,
        activeLockToken: lockToken,
        lockExpiresAt: lockExpiresAt,
      },
      $inc: {
        lockVersion: 1,
      },
    },
    {
      returnDocument: "after",
    }
  );

  if (!acquired) {
    const existing = await Conversation.findOne({
      _id: convObjectId,
      userId: userObjectId,
    });

    if (!existing) {
      throw new ChatError("Conversation not found", 404);
    }

    throw new ChatLockConflictError(
      "A generation is already in progress for this conversation"
    );
  }

  return {
    conversationId: convObjectId,
    assistantMessageId,
    lockToken,
    lockVersion: acquired.lockVersion,
    lockExpiresAt,
  };
};

/**
 * Atomically releases the conversation lock within a MongoDB session/transaction,
 * strictly verifying that the worker still holds ownership of this exact lock token and version.
 * If the lock was stolen by a newer worker, throws ConversationLockLostError (409) to abort the transaction.
 */
export const fencedReleaseConversationLock = async (
  conversationId: mongoose.Types.ObjectId,
  assistantMessageId: mongoose.Types.ObjectId,
  lockToken: string,
  lockVersion: number,
  session: mongoose.ClientSession
): Promise<void> => {
  const released = await Conversation.findOneAndUpdate(
    {
      _id: conversationId,
      activeGenerationId: assistantMessageId,
      activeLockToken: lockToken,
      lockVersion: lockVersion,
    },
    {
      $set: {
        activeGenerationId: null,
        activeLockToken: null,
        lockExpiresAt: null,
        updatedAt: new Date(),
      },
    },
    {
      session,
      returnDocument: "after",
    }
  );

  if (!released) {
    throw new ConversationLockLostError(
      `Conversation lock was lost or stolen (lockVersion ${lockVersion}, token ${lockToken})`
    );
  }
};

/**
 * Non-transactional fallback lock release used when a pre-generation step fails
 * (e.g. balance check, image upload error) before Transaction 1 commits.
 * Strictly guards with lockToken and lockVersion so newer workers' locks are never corrupted.
 */
export const releaseConversationLockImmediately = async (
  conversationId: mongoose.Types.ObjectId,
  lockToken: string,
  lockVersion: number
): Promise<void> => {
  try {
    await Conversation.updateOne(
      {
        _id: conversationId,
        activeLockToken: lockToken,
        lockVersion: lockVersion,
      },
      {
        $set: {
          activeGenerationId: null,
          activeLockToken: null,
          lockExpiresAt: null,
        },
      }
    );
  } catch (err) {
    console.error("[ChatLock] Failed to release conversation lock immediately:", err);
  }
};

/**
 * Periodically renews the lease on an active conversation lock during streaming.
 * Strictly verifies ownership with lockToken and lockVersion so that stale or stolen locks fail.
 * Throws ConversationLockLostError if the lock was superseded or expired.
 */
export const renewConversationLock = async (
  conversationId: mongoose.Types.ObjectId,
  assistantMessageId: mongoose.Types.ObjectId,
  lockToken: string,
  lockVersion: number,
  ttlMs = CONVERSATION_LOCK_TTL_MS
): Promise<Date> => {
  const now = new Date();
  const lockExpiresAt = new Date(now.getTime() + ttlMs);

  const renewed = await Conversation.findOneAndUpdate(
    {
      _id: conversationId,
      activeGenerationId: assistantMessageId,
      activeLockToken: lockToken,
      lockVersion: lockVersion,
    },
    {
      $set: {
        lockExpiresAt: lockExpiresAt,
      },
    },
    {
      returnDocument: "after",
    }
  );

  if (!renewed) {
    throw new ConversationLockLostError(
      `Conversation lock was lost or stolen during lease renewal (lockVersion ${lockVersion}, token ${lockToken})`
    );
  }

  return lockExpiresAt;
};

import mongoose, { Types } from "mongoose";
import { TokenWallet, type ITokenWalletDocument } from "../../database/models/tokenWallet/index.js";
import { TokenUsage, type ITokenUsageDocument } from "../../database/models/tokenUsage/index.js";
import { TOKEN_CONSTANTS } from "./token.constants.js";
import {
  TokenError,
  InsufficientTokensError,
  TokenWalletNotFoundError,
  TokenInvariantViolationError,
} from "./token.errors.js";
import type { TokenReservation, ActualUsageData, FinalizeTokenUsageOptions } from "./token.types.js";
import type { TokenBalanceDTO } from "./token.dto.js";

/**
 * Retrieves the token wallet for a user, or creates one if it doesn't exist.
 */
export const getOrCreateWallet = async (
  userId: string | Types.ObjectId
): Promise<ITokenWalletDocument> => {
  const objectId = typeof userId === "string" ? new Types.ObjectId(userId) : userId;

  let wallet = await TokenWallet.findOne({ userId: objectId });

  if (!wallet) {
    try {
      wallet = await TokenWallet.create({
        userId: objectId,
        balance: TOKEN_CONSTANTS.DEFAULT_FREE_ALLOCATION,
        totalAllocated: TOKEN_CONSTANTS.DEFAULT_FREE_ALLOCATION,
        totalUsed: 0,
        reservedTokens: 0,
      });
    } catch (createError: any) {
      // Handle potential race condition on unique index
      if (createError.code === 11000) {
        wallet = await TokenWallet.findOne({ userId: objectId });
      } else {
        throw createError;
      }
    }
  }

  if (!wallet) {
    throw new TokenWalletNotFoundError();
  }

  return wallet;
};

/**
 * Atomically reserves token budget before calling Gemini.
 * 
 * Rules:
 * - availableBalance = wallet.balance
 * - reservationAmount = min(inputTokens + DEFAULT_MAX_OUTPUT_BUDGET, availableBalance)
 * - allowedOutputTokens = reservationAmount - inputTokens
 * - availableBalance must support minimum valid generation budget (inputTokens + MIN_OUTPUT_BUDGET)
 */
export const reserveTokenBudget = async (
  userId: string | Types.ObjectId,
  inputTokens: number,
  maxOutputBudget: number = TOKEN_CONSTANTS.DEFAULT_MAX_OUTPUT_BUDGET
): Promise<TokenReservation> => {
  const objectId = typeof userId === "string" ? new Types.ObjectId(userId) : userId;
  const minRequiredBudget = inputTokens + TOKEN_CONSTANTS.MIN_OUTPUT_BUDGET;

  const maxRetries = 3;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const wallet = await getOrCreateWallet(objectId);

    if (wallet.balance < minRequiredBudget) {
      throw new InsufficientTokensError();
    }

    const reservedAmount = Math.min(
      inputTokens + maxOutputBudget,
      wallet.balance
    );

    const allowedOutputTokens = reservedAmount - inputTokens;

    if (allowedOutputTokens < TOKEN_CONSTANTS.MIN_OUTPUT_BUDGET) {
      throw new InsufficientTokensError();
    }

    // Atomic deduction from balance into reservedTokens
    const updated = await TokenWallet.findOneAndUpdate(
      {
        userId: objectId,
        balance: { $gte: reservedAmount },
      },
      {
        $inc: {
          balance: -reservedAmount,
          reservedTokens: reservedAmount,
        },
      },
      { returnDocument: "after" }
    );

    if (updated) {
      return {
        reservedAmount,
        allowedOutputTokens,
        inputTokens,
      };
    }
  }

  // If atomic reservation failed due to concurrency depletion
  throw new InsufficientTokensError();
};

/**
 * Atomically releases reserved tokens back to balance upon generation failure.
 */
export const releaseTokenReservation = async (
  userId: string | Types.ObjectId,
  reservedAmount: number
): Promise<void> => {
  if (reservedAmount <= 0) return;

  const objectId = typeof userId === "string" ? new Types.ObjectId(userId) : userId;

  await TokenWallet.findOneAndUpdate(
    {
      userId: objectId,
      reservedTokens: { $gte: reservedAmount },
    },
    {
      $inc: {
        balance: reservedAmount,
        reservedTokens: -reservedAmount,
      },
    }
  );
};

/**
 * Finalizes actual token usage after successful generation.
 * 
 * Rules:
 * - Invariant: actualUsage.totalTokens <= reservedAmount
 * - Refunds unused reservation (reservedAmount - actualUsage.totalTokens) back to balance
 * - Decrements reservedTokens by reservedAmount
 * - Increments totalUsed by actualUsage.totalTokens
 * - Persists TokenUsage document
 * 
 * Transaction Ownership:
 * - When options.session is provided (external session owned by caller):
 *   Executes operations within that session. Does NOT start, commit, or abort transactions,
 *   and does NOT independently release reservations on failure.
 * - When options.session is not provided (standalone):
 *   Creates and owns its own transaction. Commits on success, aborts and safely releases
 *   reservation on failure.
 */
export const finalizeTokenUsage = async (
  userId: string | Types.ObjectId,
  reservedAmount: number,
  actualUsage: ActualUsageData,
  options?: FinalizeTokenUsageOptions
): Promise<ITokenUsageDocument> => {
  const objectId = typeof userId === "string" ? new Types.ObjectId(userId) : userId;
  const isExternalSession = Boolean(options?.session);

  // Invariant verification
  if (actualUsage.totalTokens > reservedAmount) {
    console.error(
      `Token accounting invariant violation: actual usage (${actualUsage.totalTokens}) exceeded reserved amount (${reservedAmount}) for user ${objectId}`
    );

    // Only release reservation if NOT in an external session.
    // When external session is passed, the caller owns the lifecycle and handles release.
    if (!isExternalSession) {
      await releaseTokenReservation(objectId, reservedAmount);
    }

    throw new TokenInvariantViolationError(
      `Actual token usage (${actualUsage.totalTokens}) exceeded reserved amount (${reservedAmount})`
    );
  }

  const unusedTokensToRefund = reservedAmount - actualUsage.totalTokens;

  // Helper to execute finalization writes within the provided or internal session
  const executeFinalization = async (
    session?: mongoose.ClientSession
  ): Promise<ITokenUsageDocument> => {
    // Atomically finalize wallet state
    const updatedWallet = await TokenWallet.findOneAndUpdate(
      {
        userId: objectId,
        reservedTokens: { $gte: reservedAmount },
      },
      {
        $inc: {
          reservedTokens: -reservedAmount,
          balance: unusedTokensToRefund,
          totalUsed: actualUsage.totalTokens,
        },
      },
      { returnDocument: "after", session }
    );

    if (!updatedWallet) {
      throw new TokenError("Failed to finalize token wallet: reservation mismatch", 500);
    }

    // Create authoritative TokenUsage record
    const [tokenUsage] = await TokenUsage.create(
      [
        {
          userId: objectId,
          conversationId: actualUsage.conversationId
            ? new Types.ObjectId(actualUsage.conversationId)
            : undefined,
          messageId: actualUsage.messageId
            ? new Types.ObjectId(actualUsage.messageId)
            : undefined,
          inputTokens: actualUsage.inputTokens,
          outputTokens: actualUsage.outputTokens,
          totalTokens: actualUsage.totalTokens,
          model: actualUsage.model,
          type: actualUsage.type ?? TOKEN_CONSTANTS.TOKEN_USAGE_TYPE_CHAT,
        },
      ],
      { session }
    );

    return tokenUsage;
  };

  if (isExternalSession) {
    // External session provided by caller: do not start/commit/abort transaction or release reservation
    return await executeFinalization(options!.session);
  }

  // Internal session: caller did not pass a session, so finalizeTokenUsage creates and owns its own transaction
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const tokenUsage = await executeFinalization(session);
    await session.commitTransaction();
    return tokenUsage;
  } catch (error) {
    await session.abortTransaction();
    // After aborting internal transaction, release the reservation safely
    try {
      await releaseTokenReservation(objectId, reservedAmount);
    } catch (releaseErr) {
      console.error("Failed to release reservation after internal transaction abort:", releaseErr);
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

/**
 * Retrieves the current token balance for an authenticated user.
 * If the wallet does not exist, throws TokenWalletNotFoundError.
 * Does not silently create a wallet.
 */
export const getUserTokenBalance = async (
  userId: string | Types.ObjectId
): Promise<TokenBalanceDTO> => {
  const objectId = typeof userId === "string" ? new Types.ObjectId(userId) : userId;

  const wallet = await TokenWallet.findOne({ userId: objectId });

  if (!wallet) {
    throw new TokenWalletNotFoundError("Token wallet not found for user");
  }

  return {
    balance: wallet.balance,
    totalAllocated: wallet.totalAllocated,
    totalUsed: wallet.totalUsed,
    reservedTokens: wallet.reservedTokens,
  };
};


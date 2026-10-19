import mongoose, { Types, type ClientSession } from "mongoose";
import { TokenWallet, type ITokenWalletDocument } from "../../database/models/tokenWallet/index.js";
import { TokenUsage, type ITokenUsageDocument } from "../../database/models/tokenUsage/index.js";
import { TokenReservation, type ITokenReservationDocument } from "../../database/models/tokenReservation/index.js";
import { TokenAllocation } from "../../database/models/tokenAllocation/index.js";
import { Subscription } from "../../database/models/subscription/index.js";
import type { IProviderUsage } from "../../database/models/tokenReservation/tokenReservation.interface.js";
import { User } from "../../database/models/user/index.js";
import { SUBSCRIPTION_PLANS, SUBSCRIPTION_STATUS } from "../subscription/subscription.constants.js";
import { TOKEN_CONSTANTS } from "./token.constants.js";
import {
  TokenError,
  InsufficientTokensError,
  TokenWalletNotFoundError,
  TokenWalletCorruptedError,
  TokenInvariantViolationError,
  ReservationStateConflictError,
  InvalidUsageMetadataError,
  UncertainTransactionCommitError,
} from "./token.errors.js";
import type {
  AllocateTokensForPlanOptions,
  CreateReservationParams,
  SettleReservationParams,
  RefundReservationParams,
  RawProviderUsage,
  ValidatedUsageResult,
  TokenReservationResult,
} from "./token.types.js";
import type { TokenBalanceDTO } from "./token.dto.js";

/**
 * Authoritatively and idempotently allocates tokens for a subscription plan tier.
 * Pro -> 50,000 tokens
 * Plus -> 100,000 tokens
 * Free -> 10,000 tokens
 *
 * Invariants:
 * 1. Single logical grant applied at most once, protected by persistent TokenAllocation unique index.
 * 2. TokenAllocation creation and TokenWallet mutation are atomic in a MongoDB transaction.
 * 3. Duplicate triggers (webhooks, checkout confirmations, retries) return existing wallet without balance overwrite.
 * 4. Existing holds (reservedTokens) are preserved and respected: newBalance = max(0, targetTokens - reservedTokens).
 * 5. Unique-key conflicts (11000) are handled deliberately; arbitrary database failures are rethrown.
 */
export const allocateTokensForPlan = async (
  userId: string | Types.ObjectId,
  plan: "free" | "pro" | "plus",
  options?: AllocateTokensForPlanOptions
): Promise<ITokenWalletDocument> => {
  const objectId = typeof userId === "string" ? new Types.ObjectId(userId) : userId;
  const targetTokens =
    SUBSCRIPTION_PLANS[plan]?.tokensPerPeriod ?? TOKEN_CONSTANTS.DEFAULT_FREE_ALLOCATION;

  // Derive stable allocation identity from verified persisted provider and billing-period data
  let allocationKey = options?.allocationKey;
  if (!allocationKey) {
    if (options?.providerSubscriptionId && options?.periodStart) {
      const startIso = new Date(options.periodStart).toISOString();
      allocationKey = `polar:sub:${options.providerSubscriptionId}:${startIso}:${plan}`;
    } else {
      const activeSub = await Subscription.findOne({
        userId: objectId,
        status: SUBSCRIPTION_STATUS.ACTIVE,
      }).sort({ updatedAt: -1, createdAt: -1 });

      if (activeSub && activeSub.providerSubscriptionId && activeSub.currentPeriodStart) {
        const startIso = new Date(activeSub.currentPeriodStart).toISOString();
        allocationKey = `polar:sub:${activeSub.providerSubscriptionId}:${startIso}:${plan}`;
      } else {
        allocationKey = `initial:${objectId.toString()}:${plan}`;
      }
    }
  }

  const isExternalSession = Boolean(options?.session);
  const session = options?.session || (await mongoose.startSession());

  // Pre-check for duplicate grant (fast path for standalone calls only; transactional calls must use session)
  if (!isExternalSession) {
    const existingAllocation = await TokenAllocation.findOne({ allocationKey });
    if (existingAllocation) {
      if (existingAllocation.userId.toString() !== objectId.toString()) {
        throw new Error(
          `Token allocation conflict: allocation key or checkoutId already claimed by different user (${existingAllocation.userId})`
        );
      }
      const wallet = await TokenWallet.findOne({ userId: objectId });
      if (wallet) {
        return wallet;
      }
    }

    if (options?.checkoutId) {
      const existingByCheckout = await TokenAllocation.findOne({ checkoutId: options.checkoutId });
      if (existingByCheckout) {
        if (existingByCheckout.userId.toString() !== objectId.toString()) {
          throw new Error(
            `Token allocation conflict: allocation key or checkoutId already claimed by different user (${existingByCheckout.userId})`
          );
        }
        const wallet = await TokenWallet.findOne({ userId: objectId });
        if (wallet) {
          return wallet;
        }
      }
    }
  }

  const applyAllocationInSession = async (activeSession: ClientSession): Promise<ITokenWalletDocument> => {
    // 1. Check if this allocation was already recorded within this session
    const query = options?.checkoutId
      ? { $or: [{ allocationKey }, { checkoutId: options.checkoutId }] }
      : { allocationKey };

    const existingAlloc = await TokenAllocation.findOne(query).session(activeSession);

    if (existingAlloc) {
      // Enforce user linkage: allocation must belong to the same intended user
      if (existingAlloc.userId.toString() !== objectId.toString()) {
        throw new Error(
          `Token allocation conflict: allocation key or checkoutId already claimed by different user (${existingAlloc.userId})`
        );
      }
    } else {
      // Atomically insert TokenAllocation record within session only if not already recorded
      const allocation = new TokenAllocation({
        userId: objectId,
        allocationKey,
        ...(options?.checkoutId ? { checkoutId: options.checkoutId } : {}),
        plan,
        allocatedTokens: targetTokens,
        provider: options?.provider || "polar",
        providerSubscriptionId: options?.providerSubscriptionId || null,
        periodStart: options?.periodStart || null,
        periodEnd: options?.periodEnd || null,
        status: "APPLIED",
      });
      await allocation.save({ session: activeSession });
    }

    // 2. Mutate or recover TokenWallet atomically within the same session
    let wallet = await TokenWallet.findOne({ userId: objectId }).session(activeSession);

    if (!wallet) {
      // If the allocation record already existed prior to this call, or if this account already has
      // historical ledger records (other allocations, usage, reservations), creating a fresh wallet
      // with totalUsed: 0 and reservedTokens: 0 would grant an unearned replacement allowance and
      // break active holds. Fail closed.
      if (existingAlloc) {
        console.error(
          `[TokenService] Missing wallet detected for user ${objectId} with pre-existing allocation ${existingAlloc._id} ` +
          `(allocationKey: ${existingAlloc.allocationKey}). Refusing to grant unearned replacement allowance.`
        );
        throw new TokenWalletCorruptedError(
          "Token wallet is temporarily unavailable due to state verification failure. Please contact support."
        );
      }

      const [allocCount, hasUsage, hasRes] = await Promise.all([
        TokenAllocation.countDocuments({ userId: objectId }).session(activeSession),
        TokenUsage.exists({ userId: objectId }).session(activeSession),
        TokenReservation.exists({ userId: objectId }).session(activeSession),
      ]);

      // If !existingAlloc, a new allocation document was created above with allocation.save().
      // If count of allocations > 1, or usage/reservation exists, this is a damaged historical account.
      if (allocCount > 1 || hasUsage || hasRes) {
        console.error(
          `[TokenService] Missing wallet detected for historical user ${objectId} during allocation ` +
          `(allocCount: ${allocCount}, usage: ${Boolean(hasUsage)}, reservation: ${Boolean(hasRes)}). ` +
          `Refusing automatic wallet creation without verified ledger state.`
        );
        throw new TokenWalletCorruptedError(
          "Token wallet is temporarily unavailable due to state verification failure. Please contact support."
        );
      }

      // Genuinely clean, uninitialized account: initialize initial wallet
      const created = await TokenWallet.create(
        [
          {
            userId: objectId,
            balance: targetTokens,
            totalAllocated: targetTokens,
            totalUsed: 0,
            reservedTokens: 0,
            lastAllocatedPlan: plan,
          },
        ],
        { session: activeSession }
      );
      wallet = created[0];
    } else if (!existingAlloc) {
      // Existing wallet and NEW allocation grant: replenish period allowance
      const reserved = wallet.reservedTokens || 0;
      const newBalance = Math.max(0, targetTokens - reserved);

      wallet.balance = newBalance;
      wallet.totalAllocated = targetTokens;
      // Invariant: NEVER overwrite or reset totalUsed on an allocation! Historical usage is preserved.
      wallet.lastAllocatedPlan = plan;

      await wallet.save({ session: activeSession });
    }
    // If wallet already exists and existingAlloc was already recorded, this is an idempotent duplicate grant;
    // return the existing wallet without modifying balance or usage.

    return wallet;
  };

  try {
    if (isExternalSession) {
      return await applyAllocationInSession(session);
    } else {
      let resultWallet: ITokenWalletDocument | undefined;
      await session.withTransaction(async () => {
        resultWallet = await applyAllocationInSession(session);
      });
      return resultWallet!;
    }
  } catch (error: any) {
    const isAllocationKeyConflict =
      Boolean(error?.keyPattern?.allocationKey) ||
      (typeof error?.message === "string" &&
        error.message.includes("E11000") &&
        error.message.includes("allocationKey"));

    const isCheckoutIdConflict =
      Boolean(error?.keyPattern?.checkoutId) ||
      (typeof error?.message === "string" &&
        error.message.includes("E11000") &&
        error.message.includes("checkoutId"));

    const isWalletUserIdConflict =
      error?.code === 11000 &&
      (Boolean(error?.keyPattern?.userId) ||
        (typeof error?.message === "string" &&
          error.message.includes("E11000") &&
          (error.message.includes("TokenWallet") || error.message.includes("tokenwallets")) &&
          error.message.includes("userId")));

    if (isWalletUserIdConflict) {
      if (isExternalSession) {
        // In an external transaction session, an index conflict marks the MongoDB session aborted.
        // Rethrow so the caller's outer transaction rolls back cleanly and can retry.
        throw error;
      }

      // Standalone session: Bounded retry to allow the competing transaction to commit the wallet.
      let committedWallet = await TokenWallet.findOne({ userId: objectId });
      for (let attempt = 0; attempt < 5 && !committedWallet; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        committedWallet = await TokenWallet.findOne({ userId: objectId });
      }

      if (committedWallet) {
        // Enforce user linkage
        if (committedWallet.userId.toString() !== objectId.toString()) {
          throw new TokenInvariantViolationError(
            `Wallet creation collision: created wallet belongs to different user (${committedWallet.userId})`
          );
        }
        return committedWallet;
      }
    }

    const isRelevantAllocationConflict =
      error?.code === 11000 && (isAllocationKeyConflict || isCheckoutIdConflict);

    if (isRelevantAllocationConflict) {
      if (isExternalSession) {
        // In an external transaction session, an index conflict marks the MongoDB session aborted.
        // Rethrow so the caller's outer transaction rolls back cleanly and can retry.
        throw error;
      }

      // Standalone session: Bounded retry to allow the competing transaction to commit its allocation.
      const query = options?.checkoutId
        ? { $or: [{ allocationKey }, { checkoutId: options.checkoutId }] }
        : { allocationKey };

      let matchingAlloc = await TokenAllocation.findOne(query);
      for (let attempt = 0; attempt < 5 && !matchingAlloc; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        matchingAlloc = await TokenAllocation.findOne(query);
      }

      if (matchingAlloc) {
        // Enforce user linkage: The existing allocation MUST belong to the same intended user
        if (matchingAlloc.userId.toString() !== objectId.toString()) {
          throw new Error(
            `Token allocation conflict: allocation key or checkoutId already claimed by different user (${matchingAlloc.userId})`
          );
        }

        const wallet = await TokenWallet.findOne({ userId: objectId });
        if (wallet) {
          return wallet;
        }
      }
    }

    // Deliberately rethrow non-allocation errors or uncommitted duplicate conflicts
    throw error;
  } finally {
    if (!isExternalSession) {
      await session.endSession();
    }
  }
};




/**
 * Retrieves the current token balance for an authenticated user.
 * Strictly read-only query: performs zero database writes, creates, updates, or deletes.
 * If the wallet does not exist, throws TokenWalletNotFoundError.
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

/**
 * Validates provider token counts and determines the authoritative billing strategy.
 *
 * Scenarios:
 * 1. Missing or undefined metadata -> UNVERIFIED_INPUT_ONLY (bill verified prompt tokens only, output = 0)
 * 2. Invalid/corrupt/negative values -> INVALID_METADATA_FALLBACK (bill verified prompt tokens only, output = 0)
 * 3. Valid counts exceeding reservation -> EXCESS_CLAMPED (billed tokens capped at reservation, platform absorbs overrun, raw counts preserved)
 * 4. Valid authoritative counts <= reservation -> AUTHORITATIVE (billed exactly provider total tokens)
 */
export const validateUsageData = (
  rawUsage: RawProviderUsage | undefined,
  reservedAmount: number,
  precomputedInputTokens: number,
  model: string
): ValidatedUsageResult => {
  // Case 1: Missing metadata
  if (!rawUsage) {
    const billedTokens = Math.min(precomputedInputTokens, reservedAmount);
    return {
      billedTokens,
      billedInputTokens: billedTokens,
      billedOutputTokens: 0,
      overrunTokens: 0,
      verificationStatus: "UNVERIFIED_INPUT_ONLY",
      verificationNotes: "Provider usageMetadata omitted; billed verified prompt tokens only, output waived",
      model,
    };
  }

  const { promptTokenCount, candidatesTokenCount, thoughtsTokenCount, totalTokenCount } = rawUsage;

  // Case 2: Validation of numeric fields
  const isInvalidNumber = (val: number | null | undefined): boolean => {
    if (val === null || val === undefined) return false;
    return typeof val !== "number" || !Number.isFinite(val) || val < 0;
  };

  if (
    isInvalidNumber(promptTokenCount) ||
    isInvalidNumber(candidatesTokenCount) ||
    isInvalidNumber(thoughtsTokenCount) ||
    isInvalidNumber(totalTokenCount)
  ) {
    const billedTokens = Math.min(precomputedInputTokens, reservedAmount);
    return {
      billedTokens,
      billedInputTokens: billedTokens,
      billedOutputTokens: 0,
      overrunTokens: 0,
      verificationStatus: "INVALID_METADATA_FALLBACK",
      verificationNotes: "Provider usageMetadata values invalid/corrupt; billed verified prompt tokens only",
      model,
    };
  }

  // Construct raw provider telemetry
  const pTokens = promptTokenCount ?? 0;
  const cTokens = candidatesTokenCount ?? 0;
  const tTokens = thoughtsTokenCount ?? 0;
  const reportedTotal = totalTokenCount ?? (pTokens + cTokens + tTokens);

  const providerUsage: IProviderUsage = {
    promptTokens: pTokens,
    candidatesTokens: cTokens,
    thoughtsTokens: tTokens,
    totalTokens: reportedTotal,
  };

  // Case 3: Excess provider usage beyond authorized reservation
  if (reportedTotal > reservedAmount) {
    const billedInput = Math.min(pTokens, reservedAmount);
    const billedOutput = Math.max(0, reservedAmount - billedInput);

    return {
      billedTokens: reservedAmount,
      billedInputTokens: billedInput,
      billedOutputTokens: billedOutput,
      providerUsage,
      overrunTokens: reportedTotal - reservedAmount,
      verificationStatus: "EXCESS_CLAMPED",
      verificationNotes: `Provider usage (${reportedTotal}) exceeded reserved budget (${reservedAmount}); billed tokens capped to budget, excess absorbed`,
      model,
    };
  }

  // Case 4: Normal authoritative usage
  return {
    billedTokens: reportedTotal,
    billedInputTokens: pTokens,
    billedOutputTokens: cTokens,
    providerUsage,
    overrunTokens: 0,
    verificationStatus: "AUTHORITATIVE",
    verificationNotes: "Authoritative provider usage verified",
    model,
  };
};

/**
 * Atomically creates a durable TokenReservation and deducts the hold from the user's TokenWallet.
 * Executes within a caller-supplied ClientSession as part of Transaction 1.
 */
export const createTokenReservation = async (
  params: CreateReservationParams,
  options: { session: ClientSession }
): Promise<{
  reservation: ITokenReservationDocument;
  reservedAmount: number;
  allowedOutputTokens: number;
}> => {
  const { session } = options;
  const userObjectId = typeof params.userId === "string" ? new Types.ObjectId(params.userId) : params.userId;
  const conversationObjectId = typeof params.conversationId === "string" ? new Types.ObjectId(params.conversationId) : params.conversationId;
  const userMessageObjectId = typeof params.userMessageId === "string" ? new Types.ObjectId(params.userMessageId) : params.userMessageId;
  const assistantMessageObjectId = typeof params.assistantMessageId === "string" ? new Types.ObjectId(params.assistantMessageId) : params.assistantMessageId;
  const reservationObjectId = params.reservationId
    ? (typeof params.reservationId === "string" ? new Types.ObjectId(params.reservationId) : params.reservationId)
    : new Types.ObjectId();

  const minRequiredBudget = params.inputTokens + TOKEN_CONSTANTS.MIN_OUTPUT_BUDGET;

  // Wallet must exist; initialize transactionally within the caller's session under verified entitlement
  let wallet: ITokenWalletDocument | null = await TokenWallet.findOne({ userId: userObjectId }).session(session);
  if (!wallet) {
    const user = await User.findById(userObjectId).select("plan").session(session).lean();
    if (!user) {
      throw new TokenWalletNotFoundError("User not found for token reservation");
    }

    // Safety guard: Verify this is a genuinely uninitialized account and not an existing ledger account
    // whose wallet document has gone missing or corrupted.
    const [hasAlloc, hasUsage, hasRes] = await Promise.all([
      TokenAllocation.exists({ userId: userObjectId }).session(session),
      TokenUsage.exists({ userId: userObjectId }).session(session),
      TokenReservation.exists({ userId: userObjectId }).session(session),
    ]);

    if (hasAlloc || hasUsage || hasRes) {
      console.error(
        `[TokenService] Missing wallet detected for user ${userObjectId} with existing ledger history ` +
        `(allocation: ${Boolean(hasAlloc)}, usage: ${Boolean(hasUsage)}, reservation: ${Boolean(hasRes)}). ` +
        `Refusing automatic wallet recreation during reservation.`
      );
      throw new TokenWalletCorruptedError(
        "Token wallet is temporarily unavailable due to state verification failure. Please contact support."
      );
    }

    const userPlan = (user.plan || "free") as "free" | "pro" | "plus";
    if (userPlan === "free") {
      wallet = await allocateTokensForPlan(userObjectId, "free", {
        session,
        allocationKey: `initial:${userObjectId.toString()}:free`,
        provider: "none",
      });
    } else {
      // For paid plan, verify active subscription in Subscription collection
      const activeSub = await Subscription.findOne({
        userId: userObjectId,
        status: SUBSCRIPTION_STATUS.ACTIVE,
      }).session(session);

      if (activeSub && activeSub.currentPeriodStart) {
        const startIso = activeSub.currentPeriodStart.toISOString();
        const periodAllocKey = activeSub.providerSubscriptionId
          ? `polar:sub:${activeSub.providerSubscriptionId}:${startIso}:${userPlan}`
          : `initial:sub:${activeSub._id.toString()}:${startIso}:${userPlan}`;

        wallet = await allocateTokensForPlan(userObjectId, userPlan, {
          session,
          allocationKey: periodAllocKey,
          provider: "polar",
          providerSubscriptionId: activeSub.providerSubscriptionId || undefined,
          periodStart: activeSub.currentPeriodStart,
          periodEnd: activeSub.currentPeriodEnd || undefined,
        });
      } else {
        throw new TokenWalletNotFoundError(
          `Token wallet missing for ${userPlan} user without verified active subscription`
        );
      }
    }
  }

  if (!wallet || wallet.balance <= 0 || wallet.balance < minRequiredBudget) {
    throw new InsufficientTokensError();
  }

  const reservedAmount = Math.min(
    params.inputTokens + (params.maxOutputBudget ?? TOKEN_CONSTANTS.DEFAULT_MAX_OUTPUT_BUDGET),
    wallet.balance
  );

  const allowedOutputTokens = reservedAmount - params.inputTokens;
  if (allowedOutputTokens < TOKEN_CONSTANTS.MIN_OUTPUT_BUDGET) {
    throw new InsufficientTokensError();
  }

  // 1. Atomic deduction from wallet within session
  const updatedWallet = await TokenWallet.findOneAndUpdate(
    {
      userId: userObjectId,
      balance: { $gte: reservedAmount },
    },
    {
      $inc: {
        balance: -reservedAmount,
        reservedTokens: reservedAmount,
      },
    },
    { returnDocument: "after", session }
  );

  if (!updatedWallet) {
    throw new InsufficientTokensError("Insufficient wallet balance for reservation");
  }

  // 2. Insert durable TokenReservation
  const lockDurationSeconds = params.lockDurationSeconds ?? 180;
  const lockExpiresAt = new Date(Date.now() + lockDurationSeconds * 1000);

  const [reservation] = await TokenReservation.create(
    [
      {
        _id: reservationObjectId,
        userId: userObjectId,
        conversationId: conversationObjectId,
        userMessageId: userMessageObjectId,
        assistantMessageId: assistantMessageObjectId,
        reservedTokens: reservedAmount,
        model: params.model,
        status: "RESERVED",
        version: 1,
        lockExpiresAt,
      },
    ],
    { session }
  );

  return {
    reservation,
    reservedAmount,
    allowedOutputTokens,
  };
};

/**
 * Atomically transitions a TokenReservation from RESERVED to SETTLED, adjusts the user's
 * TokenWallet (restoring unused tokens and incrementing totalUsed), and records TokenUsage.
 *
 * Uses dynamic expectedVersion for state transition and fencing.
 */
export const settleTokenReservation = async (
  params: SettleReservationParams,
  options: { session: ClientSession }
): Promise<{
  reservation: ITokenReservationDocument;
  tokenUsage: ITokenUsageDocument;
  unusedTokensToRefund: number;
}> => {
  const { session } = options;
  const userObjectId = typeof params.userId === "string" ? new Types.ObjectId(params.userId) : params.userId;
  const reservationObjectId = typeof params.reservationId === "string" ? new Types.ObjectId(params.reservationId) : params.reservationId;
  const assistantMessageObjectId = typeof params.assistantMessageId === "string" ? new Types.ObjectId(params.assistantMessageId) : params.assistantMessageId;

  // 1. Transition reservation state using dynamic version match
  const updatedReservation = await TokenReservation.findOneAndUpdate(
    {
      _id: reservationObjectId,
      userId: userObjectId,
      status: "RESERVED",
      version: params.expectedVersion,
    },
    {
      $set: {
        status: "SETTLED",
        actualTokens: {
          inputTokens: params.usageData.billedInputTokens,
          outputTokens: params.usageData.billedOutputTokens,
          totalTokens: params.usageData.billedTokens,
        },
        providerUsage: params.usageData.providerUsage,
        billedTokens: params.usageData.billedTokens,
        overrunTokens: params.usageData.overrunTokens,
        usageVerification: params.usageData.verificationStatus,
        verificationNotes: params.usageData.verificationNotes,
      },
      $inc: {
        version: 1,
      },
    },
    { returnDocument: "after", session }
  );

  if (!updatedReservation) {
    throw new ReservationStateConflictError(
      `Reservation ${reservationObjectId} not found, already finalized, or version mismatch (expected: ${params.expectedVersion})`
    );
  }

  // Accounting invariant: billedTokens cannot exceed reservedTokens
  if (params.usageData.billedTokens > updatedReservation.reservedTokens) {
    throw new TokenInvariantViolationError(
      `Billed tokens (${params.usageData.billedTokens}) cannot exceed reserved budget (${updatedReservation.reservedTokens})`
    );
  }

  const unusedTokensToRefund = updatedReservation.reservedTokens - params.usageData.billedTokens;

  // 2. Update wallet: release reservedTokens, credit unused balance, increment totalUsed
  const updatedWallet = await TokenWallet.findOneAndUpdate(
    {
      userId: userObjectId,
      reservedTokens: { $gte: updatedReservation.reservedTokens },
    },
    {
      $inc: {
        reservedTokens: -updatedReservation.reservedTokens,
        balance: unusedTokensToRefund,
        totalUsed: params.usageData.billedTokens,
      },
    },
    { returnDocument: "after", session }
  );

  if (!updatedWallet) {
    throw new TokenInvariantViolationError(
      `Failed to settle wallet for user ${userObjectId}: insufficient reservedTokens or wallet missing`
    );
  }

  // 3. Persist TokenUsage document
  const conversationObjectId = params.conversationId
    ? (typeof params.conversationId === "string" ? new Types.ObjectId(params.conversationId) : params.conversationId)
    : updatedReservation.conversationId;

  const [tokenUsage] = await TokenUsage.create(
    [
      {
        userId: userObjectId,
        conversationId: conversationObjectId,
        messageId: assistantMessageObjectId,
        inputTokens: params.usageData.billedInputTokens,
        outputTokens: params.usageData.billedOutputTokens,
        totalTokens: params.usageData.billedTokens,
        model: params.usageData.model,
        type: "chat",
        usageVerification: params.usageData.verificationStatus,
        providerTotalTokens: params.usageData.providerUsage?.totalTokens,
      },
    ],
    { session }
  );

  return {
    reservation: updatedReservation,
    tokenUsage,
    unusedTokensToRefund,
  };
};

/**
 * Atomically transitions a TokenReservation from RESERVED to REFUNDED and restores
 * 100% of reserved tokens back to user's available wallet balance.
 *
 * Uses dynamic expectedVersion for state transition and fencing.
 */
export const refundTokenReservation = async (
  params: RefundReservationParams,
  options: { session: ClientSession }
): Promise<{
  reservation: ITokenReservationDocument;
  refundedAmount: number;
}> => {
  const { session } = options;
  const userObjectId = typeof params.userId === "string" ? new Types.ObjectId(params.userId) : params.userId;
  const reservationObjectId = typeof params.reservationId === "string" ? new Types.ObjectId(params.reservationId) : params.reservationId;

  // 1. Transition reservation state using dynamic version match
  const updatedReservation = await TokenReservation.findOneAndUpdate(
    {
      _id: reservationObjectId,
      userId: userObjectId,
      status: "RESERVED",
      version: params.expectedVersion,
    },
    {
      $set: {
        status: "REFUNDED",
        verificationNotes: params.reason || "Generation failed",
      },
      $inc: {
        version: 1,
      },
    },
    { returnDocument: "after", session }
  );

  if (!updatedReservation) {
    throw new ReservationStateConflictError(
      `Reservation ${reservationObjectId} not found, already finalized, or version mismatch (expected: ${params.expectedVersion})`
    );
  }

  // 2. Restore 100% of hold to wallet balance
  const updatedWallet = await TokenWallet.findOneAndUpdate(
    {
      userId: userObjectId,
      reservedTokens: { $gte: updatedReservation.reservedTokens },
    },
    {
      $inc: {
        reservedTokens: -updatedReservation.reservedTokens,
        balance: updatedReservation.reservedTokens,
      },
    },
    { returnDocument: "after", session }
  );

  if (!updatedWallet) {
    throw new TokenInvariantViolationError(
      `Failed to refund wallet for user ${userObjectId}: insufficient reservedTokens or wallet missing`
    );
  }

  return {
    reservation: updatedReservation,
    refundedAmount: updatedReservation.reservedTokens,
  };
};



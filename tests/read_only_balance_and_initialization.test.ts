import "dotenv/config";
import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import mongoose, { Types } from "mongoose";
import { connectDatabase } from "../src/config/database.js";
import { User } from "../src/database/models/user/index.js";
import { TokenWallet } from "../src/database/models/tokenWallet/index.js";
import { Subscription } from "../src/database/models/subscription/index.js";
import { TokenAllocation } from "../src/database/models/tokenAllocation/index.js";
import { TokenReservation } from "../src/database/models/tokenReservation/index.js";
import {
  getUserTokenBalance,
  createTokenReservation,
  allocateTokensForPlan,
} from "../src/features/token/token.service.js";
import {
  TokenWalletNotFoundError,
  TokenWalletCorruptedError,
} from "../src/features/token/token.errors.js";
import { SUBSCRIPTION_STATUS } from "../src/features/subscription/subscription.constants.js";

describe("Phase 5 — Step 3: Read-Only Balance API & Transaction-Safe Initialization", () => {
  const createdUserIds: Types.ObjectId[] = [];
  let isDbConnected = false;

  const createTestUser = async (plan: "free" | "pro" | "plus" = "free") => {
    const userId = new Types.ObjectId();
    createdUserIds.push(userId);
    const user = await User.create({
      _id: userId,
      name: `TestUser_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      email: `test_ro_${Date.now()}_${Math.random().toString(36).slice(2, 7)}@example.com`,
      passwordHash: "dummy_hash",
      role: "user",
      plan,
      isActive: true,
    });
    return user;
  };

  before(async () => {
    await connectDatabase();
    isDbConnected = true;
  });

  after(async () => {
    if (isDbConnected && createdUserIds.length > 0) {
      await TokenAllocation.deleteMany({ userId: { $in: createdUserIds } });
      await TokenReservation.deleteMany({ userId: { $in: createdUserIds } });
      await TokenWallet.deleteMany({ userId: { $in: createdUserIds } });
      await Subscription.deleteMany({ userId: { $in: createdUserIds } });
      await User.deleteMany({ _id: { $in: createdUserIds } });
      await mongoose.disconnect();
    }
  });

  // --- 1. Balance Endpoint Tests ---

  test("1. Plan mismatch does NOT mutate the wallet during balance read", async () => {
    const user = await createTestUser("plus"); // User upgraded in User doc
    // Wallet is on pro plan
    const initialWallet = await TokenWallet.create({
      userId: user._id,
      balance: 15000,
      totalAllocated: 50000,
      totalUsed: 35000,
      reservedTokens: 0,
      lastAllocatedPlan: "pro",
    });

    const initialUpdatedAt = initialWallet.updatedAt;

    // Call balance endpoint service
    const balanceResult = await getUserTokenBalance(user._id);

    // Invariant: Balance result reflects existing persistent state
    assert.equal(balanceResult.balance, 15000);
    assert.equal(balanceResult.totalAllocated, 50000);
    assert.equal(balanceResult.totalUsed, 35000);
    assert.equal(balanceResult.reservedTokens, 0);

    // Verify wallet in database was NOT mutated
    const walletInDb = await TokenWallet.findOne({ userId: user._id });
    assert.equal(walletInDb?.balance, 15000, "Balance must not be modified by GET");
    assert.equal(walletInDb?.totalAllocated, 50000, "totalAllocated must not be modified by GET");
    assert.equal(walletInDb?.lastAllocatedPlan, "pro", "lastAllocatedPlan must not be modified by GET");
    assert.equal(
      walletInDb?.updatedAt.getTime(),
      initialUpdatedAt.getTime(),
      "updatedAt timestamp must remain strictly identical"
    );
  });

  test("2. Active reservations are returned unchanged and holds are not modified", async () => {
    const user = await createTestUser("pro");
    const initialWallet = await TokenWallet.create({
      userId: user._id,
      balance: 32000,
      totalAllocated: 50000,
      totalUsed: 10000,
      reservedTokens: 8000,
      lastAllocatedPlan: "pro",
    });

    const balanceResult = await getUserTokenBalance(user._id);

    assert.equal(balanceResult.balance, 32000);
    assert.equal(balanceResult.reservedTokens, 8000);
    assert.equal(balanceResult.totalAllocated, 50000);
    assert.equal(balanceResult.totalUsed, 10000);

    const walletInDb = await TokenWallet.findOne({ userId: user._id });
    assert.equal(walletInDb?.reservedTokens, 8000, "Hold must remain intact");
    assert.equal(walletInDb?.balance, 32000, "Balance must remain intact");
  });

  test("3. Missing wallet throws TokenWalletNotFoundError without creating a wallet", async () => {
    const user = await createTestUser("free");
    // Explicitly ensure no wallet exists
    await TokenWallet.deleteOne({ userId: user._id });

    await assert.rejects(
      async () => {
        await getUserTokenBalance(user._id);
      },
      (err: any) => {
        assert.ok(err instanceof TokenWalletNotFoundError);
        return true;
      }
    );

    // Verify wallet was NOT created
    const walletInDb = await TokenWallet.findOne({ userId: user._id });
    assert.strictEqual(walletInDb, null, "GET must never lazily create a wallet");
  });

  test("4. Response contract adheres strictly to TokenBalanceDTO schema", async () => {
    const user = await createTestUser("free");
    await TokenWallet.create({
      userId: user._id,
      balance: 10000,
      totalAllocated: 10000,
      totalUsed: 0,
      reservedTokens: 0,
      lastAllocatedPlan: "free",
    });

    const res = await getUserTokenBalance(user._id);
    assert.equal(typeof res.balance, "number");
    assert.equal(typeof res.totalAllocated, "number");
    assert.equal(typeof res.totalUsed, "number");
    assert.equal(typeof res.reservedTokens, "number");
    // Ensure all 4 expected keys exist
    const keys = Object.keys(res).sort();
    assert.deepEqual(keys, ["balance", "reservedTokens", "totalAllocated", "totalUsed"]);
  });

  // --- 2. Transaction-Safe Wallet Initialization Tests ---

  test("5. Missing wallet for Free user is initialized transactionally with TokenAllocation record", async () => {
    const user = await createTestUser("free");
    // No wallet exists initially
    const preWallet = await TokenWallet.findOne({ userId: user._id });
    assert.strictEqual(preWallet, null);

    const session = await mongoose.startSession();
    session.startTransaction();

    let resResult: any;
    try {
      resResult = await createTokenReservation(
        {
          userId: user._id,
          conversationId: new Types.ObjectId(),
          userMessageId: new Types.ObjectId(),
          assistantMessageId: new Types.ObjectId(),
          inputTokens: 1000,
          maxOutputBudget: 2000,
        },
        { session }
      );

      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      throw err;
    } finally {
      await session.endSession();
    }

    assert.ok(resResult.reservation);
    assert.equal(resResult.reservedAmount, 3000);

    // Verify wallet created in transaction
    const postWallet = await TokenWallet.findOne({ userId: user._id });
    assert.ok(postWallet !== null);
    // Initial Free budget: 10,000 - 3,000 reserved = 7,000 balance
    assert.equal(postWallet.balance, 7000);
    assert.equal(postWallet.reservedTokens, 3000);
    assert.equal(postWallet.totalAllocated, 10000);

    // Verify persistent TokenAllocation record was created
    const alloc = await TokenAllocation.findOne({
      userId: user._id,
      allocationKey: `initial:${user._id.toString()}:free`,
    });
    assert.ok(alloc !== null, "TokenAllocation record must be created for initial grant");
    assert.equal(alloc.allocatedTokens, 10000);
    assert.equal(alloc.status, "APPLIED");
  });

  test("6. Wallet creation and reservation roll back atomically together upon transaction failure", async () => {
    const user = await createTestUser("free");
    const allocKey = `initial:${user._id.toString()}:free`;

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      await createTokenReservation(
        {
          userId: user._id,
          conversationId: new Types.ObjectId(),
          userMessageId: new Types.ObjectId(),
          assistantMessageId: new Types.ObjectId(),
          inputTokens: 1000,
          maxOutputBudget: 2000,
        },
        { session }
      );

      // Explicitly abort transaction to simulate failure
      await session.abortTransaction();
    } finally {
      await session.endSession();
    }

    // Invariant: Both wallet and allocation must be rolled back completely
    const walletInDb = await TokenWallet.findOne({ userId: user._id });
    assert.strictEqual(walletInDb, null, "Wallet creation must be rolled back");

    const allocInDb = await TokenAllocation.findOne({ allocationKey: allocKey });
    assert.strictEqual(allocInDb, null, "TokenAllocation must be rolled back");

    const resInDb = await TokenReservation.findOne({ userId: user._id });
    assert.strictEqual(resInDb, null, "TokenReservation must be rolled back");
  });

  test("7. Missing wallet for Paid user without verified active subscription fails explicitly", async () => {
    const user = await createTestUser("pro"); // User claims Pro plan, but no Subscription record exists

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      await assert.rejects(
        async () => {
          await createTokenReservation(
            {
              userId: user._id,
              conversationId: new Types.ObjectId(),
              userMessageId: new Types.ObjectId(),
              assistantMessageId: new Types.ObjectId(),
              inputTokens: 1000,
              maxOutputBudget: 2000,
            },
            { session }
          );
        },
        (err: any) => {
          assert.ok(
            err.message.includes("without verified active subscription") ||
            err instanceof TokenWalletNotFoundError
          );
          return true;
        }
      );

      await session.abortTransaction();
    } finally {
      await session.endSession();
    }

    // Verify no un-audited wallet or free tokens were fabricated
    const wallet = await TokenWallet.findOne({ userId: user._id });
    assert.strictEqual(wallet, null, "Must NOT grant arbitrary free tokens to an unverified paid user");
  });

  test("8. Missing wallet for Paid user with verified active subscription initializes Pro allocation", async () => {
    const user = await createTestUser("pro");
    const subId = `sub_active_test_${Date.now()}`;
    const periodStart = new Date("2026-10-01T00:00:00.000Z");

    // Create authoritative Subscription record in database
    await Subscription.create({
      userId: user._id,
      plan: "pro",
      price: 20,
      tokensPerPeriod: 50000,
      status: SUBSCRIPTION_STATUS.ACTIVE,
      provider: "polar",
      providerSubscriptionId: subId,
      currentPeriodStart: periodStart,
      currentPeriodEnd: new Date("2026-11-01T00:00:00.000Z"),
    });

    const session = await mongoose.startSession();
    session.startTransaction();

    let resResult: any;
    try {
      resResult = await createTokenReservation(
        {
          userId: user._id,
          conversationId: new Types.ObjectId(),
          userMessageId: new Types.ObjectId(),
          assistantMessageId: new Types.ObjectId(),
          inputTokens: 1000,
          maxOutputBudget: 2000,
        },
        { session }
      );

      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      throw err;
    } finally {
      await session.endSession();
    }

    assert.ok(resResult.reservation);
    // Pro plan entitlement: 50,000 - 3,000 reserved = 47,000
    const wallet = await TokenWallet.findOne({ userId: user._id });
    assert.ok(wallet !== null);
    assert.equal(wallet.balance, 47000);
    assert.equal(wallet.reservedTokens, 3000);
    assert.equal(wallet.totalAllocated, 50000);
    assert.equal(wallet.lastAllocatedPlan, "pro");

    // Verify TokenAllocation record was created for Pro plan
    const alloc = await TokenAllocation.findOne({
      userId: user._id,
      providerSubscriptionId: subId,
    });
    assert.ok(alloc !== null);
    assert.equal(alloc.plan, "pro");
    assert.equal(alloc.allocatedTokens, 50000);
  });

  test("9. Existing wallet is never regranted or overwritten by reservation path", async () => {
    const user = await createTestUser("pro");
    // Pre-existing wallet with usage and 10,000 balance remaining
    await TokenWallet.create({
      userId: user._id,
      balance: 10000,
      totalAllocated: 50000,
      totalUsed: 40000,
      reservedTokens: 0,
      lastAllocatedPlan: "pro",
    });

    const session = await mongoose.startSession();
    session.startTransaction();

    await createTokenReservation(
      {
        userId: user._id,
        conversationId: new Types.ObjectId(),
        userMessageId: new Types.ObjectId(),
        assistantMessageId: new Types.ObjectId(),
        inputTokens: 1000,
        maxOutputBudget: 2000,
      },
      { session }
    );

    await session.commitTransaction();
    await session.endSession();

    const wallet = await TokenWallet.findOne({ userId: user._id });
    // Invariant: Balance: 10,000 - 3,000 = 7,000. totalUsed preserved at 40,000.
    assert.equal(wallet?.balance, 7000);
    assert.equal(wallet?.reservedTokens, 3000);
    assert.equal(wallet?.totalUsed, 40000, "Historical usage must never be reset");
    assert.equal(wallet?.totalAllocated, 50000);
  });

  // --- 3. Step 3D: Missing-Wallet Concurrency and Allocation Recovery Tests ---

  test("10. Concurrent initialization attempts for missing wallet serialize cleanly without duplicate grants", async () => {
    const user = await createTestUser("free");
    // Ensure no wallet exists initially
    await TokenWallet.deleteOne({ userId: user._id });

    // Function simulating a chat reservation transaction with retry on transient conflict
    const attemptReservationWithRetry = async (inputTokens: number, maxBudget: number) => {
      const maxRetries = 3;
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        const session = await mongoose.startSession();
        session.startTransaction();

        try {
          const res = await createTokenReservation(
            {
              userId: user._id,
              conversationId: new Types.ObjectId(),
              userMessageId: new Types.ObjectId(),
              assistantMessageId: new Types.ObjectId(),
              inputTokens,
              maxOutputBudget: maxBudget,
            },
            { session }
          );

          await session.commitTransaction();
          await session.endSession();
          return res;
        } catch (err: any) {
          await session.abortTransaction();
          await session.endSession();

          const isTransient =
            err.code === 11000 ||
            err.code === 112 ||
            (err.errorLabels && err.errorLabels.includes("TransientTransactionError")) ||
            (typeof err.message === "string" && (err.message.includes("WriteConflict") || err.message.includes("E11000")));

          if (isTransient && attempt < maxRetries - 1) {
            await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
            continue;
          }
          throw err;
        }
      }
    };

    // Fire two concurrent reservation attempts on the missing wallet
    const [resA, resB] = await Promise.all([
      attemptReservationWithRetry(1000, 1000), // reserves 2,000
      attemptReservationWithRetry(1000, 1000), // reserves 2,000
    ]);

    assert.ok(resA?.reservation);
    assert.ok(resB?.reservation);
    assert.equal(resA.reservedAmount, 2000);
    assert.equal(resB.reservedAmount, 2000);

    // Assert: Exactly ONE TokenWallet document exists
    const walletCount = await TokenWallet.countDocuments({ userId: user._id });
    assert.equal(walletCount, 1, "Exactly one TokenWallet must exist for user");

    // Assert: Exactly ONE initial TokenAllocation document exists
    const allocCount = await TokenAllocation.countDocuments({
      userId: user._id,
      allocationKey: `initial:${user._id.toString()}:free`,
    });
    assert.equal(allocCount, 1, "Exactly one initial TokenAllocation must be recorded");

    // Assert: Total budget accounting is strictly consistent:
    // Initial Free grant = 10,000. Two reservations of 2,000 each = 4,000 reserved hold.
    // Liquid balance = 10,000 - 4,000 = 6,000.
    const finalWallet = await TokenWallet.findOne({ userId: user._id });
    assert.equal(finalWallet?.totalAllocated, 10000, "totalAllocated must reflect single 10,000 grant");
    assert.equal(finalWallet?.reservedTokens, 4000, "Both holds must be atomically encumbered");
    assert.equal(finalWallet?.balance, 6000, "Available balance must equal 6,000");
    assert.equal(finalWallet?.balance! + finalWallet?.reservedTokens!, 10000);
  });

  test("11. Missing wallet for account with prior allocation history fails closed with TokenWalletCorruptedError", async () => {
    const user = await createTestUser("pro");
    const subId = `sub_reuse_ch_${Date.now()}`;
    const historicalCheckoutId = `ch_prior_october_${Date.now()}`;
    const octoberStart = new Date("2026-10-01T00:00:00.000Z");
    const novemberStart = new Date("2026-11-01T00:00:00.000Z");

    // Step A: Pre-existing historical TokenAllocation for the initial October checkout session
    await TokenAllocation.create({
      userId: user._id,
      allocationKey: `polar:checkout:${historicalCheckoutId}:pro`,
      checkoutId: historicalCheckoutId,
      plan: "pro",
      allocatedTokens: 50000,
      provider: "polar",
      providerSubscriptionId: subId,
      periodStart: octoberStart,
      periodEnd: novemberStart,
      status: "APPLIED",
    });

    // Step B: Active subscription in November has lastCheckoutId referencing the historical checkout
    await Subscription.create({
      userId: user._id,
      plan: "pro",
      price: 20,
      tokensPerPeriod: 50000,
      status: SUBSCRIPTION_STATUS.ACTIVE,
      provider: "polar",
      providerSubscriptionId: subId,
      currentPeriodStart: novemberStart,
      currentPeriodEnd: new Date("2026-12-01T00:00:00.000Z"),
      lastCheckoutId: historicalCheckoutId, // Historical checkout referenced on subscription
    });

    // Step C: Ensure TokenWallet is missing (e.g. disaster recovery / uninitialized)
    await TokenWallet.deleteOne({ userId: user._id });

    // Step D: User initiates chat generation; createTokenReservation must fail closed with TokenWalletCorruptedError
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      await assert.rejects(
        async () => {
          await createTokenReservation(
            {
              userId: user._id,
              conversationId: new Types.ObjectId(),
              userMessageId: new Types.ObjectId(),
              assistantMessageId: new Types.ObjectId(),
              inputTokens: 1000,
              maxOutputBudget: 2000,
            },
            { session }
          );
        },
        (err: any) => {
          assert.ok(err instanceof TokenWalletCorruptedError);
          assert.equal(err.statusCode, 503);
          assert.ok(err.message.includes("temporarily unavailable"));
          return true;
        }
      );

      await session.abortTransaction();
    } finally {
      await session.endSession();
    }

    // Invariant: Missing wallet is NOT automatically fabricated for accounts with historical allocation
    const wallet = await TokenWallet.findOne({ userId: user._id });
    assert.equal(wallet, null, "Wallet must not be automatically reconstructed without verified ledger state");

    // Total allocations for user: exactly 1 (October checkout remains intact)
    const totalAllocs = await TokenAllocation.countDocuments({ userId: user._id });
    assert.equal(totalAllocs, 1, "Historical allocation must remain unmodified");
  });

  test("12. Missing wallet when current-period allocation ALREADY exists fails closed and preserves allocation", async () => {
    const user = await createTestUser("pro");
    const subId = `sub_exist_alloc_${Date.now()}`;
    const periodStart = new Date("2026-11-01T00:00:00.000Z");
    const periodKey = `polar:sub:${subId}:${periodStart.toISOString()}:pro`;

    // Step A: Current period TokenAllocation record ALREADY exists (e.g. delivered via webhook earlier)
    await TokenAllocation.create({
      userId: user._id,
      allocationKey: periodKey,
      plan: "pro",
      allocatedTokens: 50000,
      provider: "polar",
      providerSubscriptionId: subId,
      periodStart,
      periodEnd: new Date("2026-12-01T00:00:00.000Z"),
      status: "APPLIED",
    });

    // Step B: Active Subscription exists
    await Subscription.create({
      userId: user._id,
      plan: "pro",
      price: 20,
      tokensPerPeriod: 50000,
      status: SUBSCRIPTION_STATUS.ACTIVE,
      provider: "polar",
      providerSubscriptionId: subId,
      currentPeriodStart: periodStart,
      currentPeriodEnd: new Date("2026-12-01T00:00:00.000Z"),
    });

    // Step C: TokenWallet is missing
    await TokenWallet.deleteOne({ userId: user._id });

    // Step D: createTokenReservation runs; must fail closed with TokenWalletCorruptedError
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      await assert.rejects(
        async () => {
          await createTokenReservation(
            {
              userId: user._id,
              conversationId: new Types.ObjectId(),
              userMessageId: new Types.ObjectId(),
              assistantMessageId: new Types.ObjectId(),
              inputTokens: 1000,
              maxOutputBudget: 2000,
            },
            { session }
          );
        },
        (err: any) => {
          assert.ok(err instanceof TokenWalletCorruptedError);
          assert.equal(err.statusCode, 503);
          assert.ok(err.message.includes("temporarily unavailable"));
          return true;
        }
      );

      await session.abortTransaction();
    } finally {
      await session.endSession();
    }

    // Invariant: Missing wallet is NOT automatically fabricated
    const wallet = await TokenWallet.findOne({ userId: user._id });
    assert.equal(wallet, null, "Wallet must not be automatically created without verified ledger state");

    const allocCount = await TokenAllocation.countDocuments({
      userId: user._id,
      allocationKey: periodKey,
    });
    assert.equal(allocCount, 1, "Must NOT duplicate or mutate existing TokenAllocation record");
  });
});

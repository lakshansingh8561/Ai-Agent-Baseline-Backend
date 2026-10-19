import "dotenv/config";
import test, { describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import mongoose, { Types } from "mongoose";
import { connectDatabase } from "../src/config/database.js";
import { User } from "../src/database/models/user/index.js";
import { TokenWallet } from "../src/database/models/tokenWallet/index.js";
import { Subscription } from "../src/database/models/subscription/index.js";
import { TokenAllocation } from "../src/database/models/tokenAllocation/index.js";
import { TokenReservation } from "../src/database/models/tokenReservation/index.js";
import { Conversation } from "../src/database/models/conversation/index.js";
import { Message } from "../src/database/models/message/index.js";
import { IdempotencyKey } from "../src/database/models/idempotencyKey/index.js";
import {
  allocateTokensForPlan,
  createTokenReservation,
  settleTokenReservation,
  refundTokenReservation,
} from "../src/features/token/token.service.js";
import { resolveRecoveringReservation } from "../src/features/token/token.recovery.js";
import {
  confirmCheckoutSession,
  syncPolarSubscriptionEvent,
  _setInternalPolarClient,
  SUBSCRIPTION_STATUS,
  SUBSCRIPTION_PROVIDER,
} from "../src/features/subscription/index.js";

describe("Phase 5 — Subscription Allocation Integrity Test Suite", () => {
  const createdUserIds: Types.ObjectId[] = [];
  const createdSubIds: string[] = [];
  let isDbConnected = false;

  const createTestUser = async (plan: "free" | "pro" | "plus" = "free") => {
    const userId = new Types.ObjectId();
    createdUserIds.push(userId);
    const user = await User.create({
      _id: userId,
      name: `User_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      email: `test_alloc_${Date.now()}_${Math.random().toString(36).slice(2, 7)}@example.com`,
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
    _setInternalPolarClient(null);
    if (isDbConnected && createdUserIds.length > 0) {
      await TokenAllocation.deleteMany({ userId: { $in: createdUserIds } });
      await TokenReservation.deleteMany({ userId: { $in: createdUserIds } });
      await TokenWallet.deleteMany({ userId: { $in: createdUserIds } });
      await Subscription.deleteMany({ userId: { $in: createdUserIds } });
      await Message.deleteMany({ userId: { $in: createdUserIds } });
      await Conversation.deleteMany({ userId: { $in: createdUserIds } });
      await IdempotencyKey.deleteMany({ userId: { $in: createdUserIds } });
      await User.deleteMany({ _id: { $in: createdUserIds } });
      await mongoose.disconnect();
    }
  });

  // 1. First-time allocation
  test("1. First-time allocation creates TokenAllocation record and sets initial wallet balance", async () => {
    const user = await createTestUser("free");
    const subId = `sub_first_time_${Date.now()}`;
    createdSubIds.push(subId);
    const periodStart = new Date("2026-10-01T00:00:00.000Z");

    const wallet = await allocateTokensForPlan(user._id, "pro", {
      allocationKey: `polar:sub:${subId}:${periodStart.toISOString()}:pro`,
      provider: "polar",
      providerSubscriptionId: subId,
      periodStart,
    });

    assert.equal(wallet.balance, 50000);
    assert.equal(wallet.totalAllocated, 50000);
    assert.equal(wallet.totalUsed, 0);
    assert.equal(wallet.reservedTokens, 0);
    assert.equal(wallet.lastAllocatedPlan, "pro");

    // Verify TokenAllocation document is persisted
    const allocation = await TokenAllocation.findOne({
      allocationKey: `polar:sub:${subId}:${periodStart.toISOString()}:pro`,
    });
    assert.ok(allocation !== null);
    assert.equal(allocation.userId.toString(), user._id.toString());
    assert.equal(allocation.plan, "pro");
    assert.equal(allocation.allocatedTokens, 50000);
    assert.equal(allocation.status, "APPLIED");
  });

  // 2. Duplicate checkout confirmation
  test("2. Duplicate checkout confirmation does NOT double-credit wallet and preserves existing usage", async () => {
    const user = await createTestUser("free");
    const checkoutId = `ch_dup_confirm_${Date.now()}`;
    const subId = `sub_dup_confirm_${Date.now()}`;
    createdSubIds.push(subId);

    // Mock Polar client returning checkout
    _setInternalPolarClient({
      checkouts: {
        get: async () => ({
          id: checkoutId,
          subscriptionId: subId,
          productId: process.env.POLAR_PRO_PRODUCT_ID || "cd17ed50-da7e-46ee-8bd6-74cd4e597a1b",
          status: "confirmed",
          metadata: { userId: user._id.toString() },
        }),
      },
      subscriptions: {
        get: async () => ({
          id: subId,
          currentPeriodStart: new Date("2026-10-01T00:00:00.000Z"),
          currentPeriodEnd: new Date("2026-11-01T00:00:00.000Z"),
          status: "active",
        }),
        list: async () => ({ result: { items: [] } }),
      },
    });

    // 1st checkout confirmation
    await confirmCheckoutSession(user._id.toString(), checkoutId);

    let wallet = await TokenWallet.findOne({ userId: user._id });
    assert.equal(wallet?.balance, 50000);

    // Simulate user spending 5,000 tokens
    wallet!.balance = 45000;
    wallet!.totalUsed = 5000;
    await wallet!.save();

    // 2nd duplicate checkout confirmation (e.g. user refreshed /confirm page)
    await confirmCheckoutSession(user._id.toString(), checkoutId);

    const walletAfterDup = await TokenWallet.findOne({ userId: user._id });
    // Invariant: Balance must NOT be reset to 50,000 and totalUsed must NOT be reset to 0
    assert.equal(walletAfterDup?.balance, 45000, "Balance must remain intact after duplicate confirmation");
    assert.equal(walletAfterDup?.totalUsed, 5000, "Usage counter must remain intact after duplicate confirmation");
    assert.equal(walletAfterDup?.totalAllocated, 50000);

    const allocCount = await TokenAllocation.countDocuments({
      userId: user._id,
      plan: "pro",
    });
    assert.equal(allocCount, 1, "Only one TokenAllocation record must exist");
  });

  // 3. Duplicate webhook delivery
  test("3. Duplicate webhook delivery preserves wallet state and avoids redundant grants", async () => {
    const user = await createTestUser("free");
    const subId = `sub_dup_wh_${Date.now()}`;
    createdSubIds.push(subId);
    const periodStart = new Date("2026-10-01T00:00:00.000Z");

    const webhookEvent = {
      type: "subscription.created",
      data: {
        id: subId,
        productId: process.env.POLAR_PRO_PRODUCT_ID || "cd17ed50-da7e-46ee-8bd6-74cd4e597a1b",
        amount: 600,
        currency: "usd",
        status: "active",
        currentPeriodStart: periodStart,
        currentPeriodEnd: new Date("2026-11-01T00:00:00.000Z"),
        cancelAtPeriodEnd: false,
        metadata: { userId: user._id.toString() },
      },
    };

    // 1st webhook delivery
    const res1 = await syncPolarSubscriptionEvent(webhookEvent);
    assert.equal(res1.synchronized, true);

    let wallet = await TokenWallet.findOne({ userId: user._id });
    assert.equal(wallet?.balance, 50000);

    // Spend tokens
    wallet!.balance = 42000;
    wallet!.totalUsed = 8000;
    await wallet!.save();

    // 2nd webhook delivery (retry / redelivery with different delivery ID or event)
    const res2 = await syncPolarSubscriptionEvent({
      ...webhookEvent,
      type: "subscription.active",
    });
    assert.equal(res2.synchronized, true);

    const walletAfterRetry = await TokenWallet.findOne({ userId: user._id });
    assert.equal(walletAfterRetry?.balance, 42000, "Wallet balance must NOT be overwritten by duplicate webhook");
    assert.equal(walletAfterRetry?.totalUsed, 8000, "Wallet usage must NOT be overwritten by duplicate webhook");
  });

  // 4. Checkout confirmation followed by the matching webhook
  test("4. Checkout confirmation followed by matching webhook does not wipe balance or duplicate tokens", async () => {
    const user = await createTestUser("free");
    const checkoutId = `ch_race_flow_${Date.now()}`;
    const subId = `sub_race_flow_${Date.now()}`;
    createdSubIds.push(subId);
    const periodStart = new Date("2026-10-01T00:00:00.000Z");

    _setInternalPolarClient({
      checkouts: {
        get: async () => ({
          id: checkoutId,
          subscriptionId: subId,
          productId: process.env.POLAR_PRO_PRODUCT_ID || "cd17ed50-da7e-46ee-8bd6-74cd4e597a1b",
          status: "confirmed",
          metadata: { userId: user._id.toString() },
        }),
      },
      subscriptions: {
        get: async () => ({
          id: subId,
          currentPeriodStart: periodStart,
          currentPeriodEnd: new Date("2026-11-01T00:00:00.000Z"),
          status: "active",
        }),
        list: async () => ({ result: { items: [] } }),
      },
    });

    // Step A: User completes checkout in browser
    await confirmCheckoutSession(user._id.toString(), checkoutId);

    // Step B: User uses tokens in chat
    const wallet = await TokenWallet.findOne({ userId: user._id });
    assert.equal(wallet?.balance, 50000);
    wallet!.balance = 38000;
    wallet!.totalUsed = 12000;
    await wallet!.save();

    // Step C: Polar webhook arrives asynchronously
    const webhookEvent = {
      type: "subscription.created",
      data: {
        id: subId,
        checkoutId,
        productId: process.env.POLAR_PRO_PRODUCT_ID || "cd17ed50-da7e-46ee-8bd6-74cd4e597a1b",
        amount: 600,
        currency: "usd",
        status: "active",
        currentPeriodStart: periodStart,
        currentPeriodEnd: new Date("2026-11-01T00:00:00.000Z"),
        cancelAtPeriodEnd: false,
        metadata: { userId: user._id.toString() },
      },
    };

    await syncPolarSubscriptionEvent(webhookEvent);

    // Step D: Verify wallet remains 38,000 available and 12,000 used
    const finalWallet = await TokenWallet.findOne({ userId: user._id });
    assert.equal(finalWallet?.balance, 38000, "Matching webhook must NOT overwrite existing balance");
    assert.equal(finalWallet?.totalUsed, 12000, "Matching webhook must NOT reset totalUsed");
    assert.equal(finalWallet?.totalAllocated, 50000);
  });

  // 5. Concurrent processing of the same logical grant
  test("5. Concurrent processing of the same logical grant creates exactly one allocation and avoids race condition", async () => {
    const user = await createTestUser("free");
    const subId = `sub_concurrent_${Date.now()}`;
    createdSubIds.push(subId);
    const periodStart = new Date("2026-10-01T00:00:00.000Z");

    const allocOptions = {
      allocationKey: `polar:sub:${subId}:${periodStart.toISOString()}:pro`,
      provider: "polar" as const,
      providerSubscriptionId: subId,
      periodStart,
    };

    // Fire 5 concurrent allocation requests for the same logical grant
    const results = await Promise.all([
      allocateTokensForPlan(user._id, "pro", allocOptions),
      allocateTokensForPlan(user._id, "pro", allocOptions),
      allocateTokensForPlan(user._id, "pro", allocOptions),
      allocateTokensForPlan(user._id, "pro", allocOptions),
      allocateTokensForPlan(user._id, "pro", allocOptions),
    ]);

    // All callers must receive a valid wallet with exactly 50,000 tokens
    for (const w of results) {
      assert.equal(w.balance, 50000);
      assert.equal(w.totalAllocated, 50000);
    }

    // Exactly one TokenAllocation document must exist in database
    const allocations = await TokenAllocation.find({
      allocationKey: allocOptions.allocationKey,
    });
    assert.equal(allocations.length, 1, "Exactly one persistent TokenAllocation record must be created");

    const walletInDb = await TokenWallet.findOne({ userId: user._id });
    assert.equal(walletInDb?.balance, 50000);
    assert.equal(walletInDb?.totalAllocated, 50000);
  });

  // 6. Transaction failure and retry
  test("6. Transaction failure leaves zero orphan records; subsequent retry succeeds cleanly", async () => {
    const user = await createTestUser("free");
    const subId = `sub_retry_failure_${Date.now()}`;
    createdSubIds.push(subId);
    const periodStart = new Date("2026-10-01T00:00:00.000Z");
    const allocKey = `polar:sub:${subId}:${periodStart.toISOString()}:pro`;

    // Simulate an aborted transaction using an external session that explicitly aborts
    const abortSession = await mongoose.startSession();
    abortSession.startTransaction();

    try {
      await allocateTokensForPlan(user._id, "pro", {
        allocationKey: allocKey,
        provider: "polar",
        providerSubscriptionId: subId,
        periodStart,
        session: abortSession,
      });

      // Explicitly abort transaction to simulate network / lock / commit failure
      await abortSession.abortTransaction();
    } finally {
      await abortSession.endSession();
    }

    // Invariant: Aborted transaction must not commit TokenAllocation or mutate TokenWallet
    const orphanAlloc = await TokenAllocation.findOne({ allocationKey: allocKey });
    assert.strictEqual(orphanAlloc, null, "Aborted transaction must leave zero TokenAllocation records");

    const walletAfterAbort = await TokenWallet.findOne({ userId: user._id });
    assert.strictEqual(walletAfterAbort, null, "Aborted transaction must leave zero TokenWallet records");

    // Retry path: New attempt succeeds cleanly
    const retryWallet = await allocateTokensForPlan(user._id, "pro", {
      allocationKey: allocKey,
      provider: "polar",
      providerSubscriptionId: subId,
      periodStart,
    });

    assert.equal(retryWallet.balance, 50000);
    const committedAlloc = await TokenAllocation.findOne({ allocationKey: allocKey });
    assert.ok(committedAlloc !== null, "Retry must commit TokenAllocation record");
    assert.equal(committedAlloc.status, "APPLIED");
  });

  // 7. Legitimate subsequent billing-period grant (Renewal)
  test("7. Legitimate subsequent billing-period renewal grants tokens with distinct period identity", async () => {
    const user = await createTestUser("pro");
    const subId = `sub_renewal_${Date.now()}`;
    createdSubIds.push(subId);

    // Period 1: October
    const period1Start = new Date("2026-10-01T00:00:00.000Z");
    await allocateTokensForPlan(user._id, "pro", {
      allocationKey: `polar:sub:${subId}:${period1Start.toISOString()}:pro`,
      provider: "polar",
      providerSubscriptionId: subId,
      periodStart: period1Start,
    });

    let wallet = await TokenWallet.findOne({ userId: user._id });
    assert.equal(wallet?.balance, 50000);

    // User spends 45,000 tokens during October
    wallet!.balance = 5000;
    wallet!.totalUsed = 45000;
    await wallet!.save();

    // Period 2: November renewal arrives with new period start
    const period2Start = new Date("2026-11-01T00:00:00.000Z");
    await allocateTokensForPlan(user._id, "pro", {
      allocationKey: `polar:sub:${subId}:${period2Start.toISOString()}:pro`,
      provider: "polar",
      providerSubscriptionId: subId,
      periodStart: period2Start,
    });

    const walletPeriod2 = await TokenWallet.findOne({ userId: user._id });
    assert.equal(walletPeriod2?.balance, 50000, "Renewal must authoritatively grant 50,000 tokens for new billing cycle");
    assert.equal(walletPeriod2?.totalUsed, 45000, "Historical cumulative usage must be preserved across renewals");

    // Two distinct TokenAllocation records must exist
    const count = await TokenAllocation.countDocuments({
      userId: user._id,
      providerSubscriptionId: subId,
    });
    assert.equal(count, 2, "Both periods must have distinct persistent allocation records");
  });

  // 8. Legitimate plan change (Upgrade from Pro to Plus)
  test("8. Legitimate plan upgrade (Pro -> Plus) updates tier and grants Plus tokens", async () => {
    const user = await createTestUser("pro");
    const subId = `sub_upgrade_${Date.now()}`;
    createdSubIds.push(subId);
    const periodStart = new Date("2026-10-01T00:00:00.000Z");

    // 1. Initial Pro allocation
    await allocateTokensForPlan(user._id, "pro", {
      allocationKey: `polar:sub:${subId}:${periodStart.toISOString()}:pro`,
      provider: "polar",
      providerSubscriptionId: subId,
      periodStart,
    });

    let wallet = await TokenWallet.findOne({ userId: user._id });
    assert.equal(wallet?.balance, 50000);
    assert.equal(wallet?.lastAllocatedPlan, "pro");

    // Simulate substantial usage on Pro: 35,000 tokens used, 15,000 remaining
    wallet!.balance = 15000;
    wallet!.totalUsed = 35000;
    await wallet!.save();

    // 2. User upgrades mid-period to Plus (100,000 tokens)
    await allocateTokensForPlan(user._id, "plus", {
      allocationKey: `polar:sub:${subId}:${periodStart.toISOString()}:plus`,
      provider: "polar",
      providerSubscriptionId: subId,
      periodStart,
    });

    const upgradedWallet = await TokenWallet.findOne({ userId: user._id });
    assert.equal(upgradedWallet?.balance, 100000, "Plus upgrade must allocate 100,000 tokens");
    assert.equal(upgradedWallet?.totalAllocated, 100000, "totalAllocated reflects new tier allowance");
    assert.equal(upgradedWallet?.totalUsed, 35000, "Substantial prior usage must be strictly preserved across upgrade");
    assert.equal(upgradedWallet?.lastAllocatedPlan, "plus");

    // 3. Retry of Plus upgrade is a duplicate and ignored
    await allocateTokensForPlan(user._id, "plus", {
      allocationKey: `polar:sub:${subId}:${periodStart.toISOString()}:plus`,
      provider: "polar",
      providerSubscriptionId: subId,
      periodStart,
    });

    const postRetryWallet = await TokenWallet.findOne({ userId: user._id });
    assert.equal(postRetryWallet?.balance, 100000);
    assert.equal(postRetryWallet?.totalUsed, 35000);
  });

  // 9. Wallets with nonzero reservedTokens during renewal and upgrade
  test("9. Allocation preserves existing holds when wallet has nonzero reservedTokens", async () => {
    const user = await createTestUser("pro");
    const subId = `sub_holds_${Date.now()}`;
    createdSubIds.push(subId);
    const period1Start = new Date("2026-10-01T00:00:00.000Z");

    // Initialize wallet with active hold: 5,000 balance + 10,000 reserved (total budget 15k, 35k used)
    await TokenWallet.create({
      userId: user._id,
      balance: 5000,
      totalAllocated: 50000,
      totalUsed: 35000,
      reservedTokens: 10000,
      lastAllocatedPlan: "pro",
    });

    // Case A: Renewal arrives while hold is active
    const period2Start = new Date("2026-11-01T00:00:00.000Z");
    await allocateTokensForPlan(user._id, "pro", {
      allocationKey: `polar:sub:${subId}:${period2Start.toISOString()}:pro`,
      provider: "polar",
      providerSubscriptionId: subId,
      periodStart: period2Start,
    });

    let wallet = await TokenWallet.findOne({ userId: user._id });
    // Invariant: targetTokens (50,000) - reservedTokens (10,000) = balance 40,000
    // Total wallet budget (balance + reservedTokens) = 50,000
    assert.equal(wallet?.reservedTokens, 10000, "Reserved hold must be strictly preserved on renewal");
    assert.equal(wallet?.balance, 40000, "Balance must equal targetTokens - reservedTokens");
    assert.equal(wallet?.balance! + wallet?.reservedTokens!, 50000, "Total token budget must equal 50,000");
    assert.equal(wallet?.totalUsed, 35000, "Lifetime totalUsed must be preserved on renewal");

    // Case B: Legitimate allocation for Plus (100,000 tokens) arrives while hold is active
    await allocateTokensForPlan(user._id, "plus", {
      allocationKey: `polar:sub:${subId}:${period2Start.toISOString()}:plus`,
      provider: "polar",
      providerSubscriptionId: subId,
      periodStart: period2Start,
    });

    wallet = await TokenWallet.findOne({ userId: user._id });
    // Invariant: targetTokens (100,000) - reservedTokens (10,000) = balance 90,000
    // Total wallet budget (balance + reservedTokens) = 100,000
    assert.equal(wallet?.reservedTokens, 10000, "Reserved hold must be strictly preserved on upgrade");
    assert.equal(wallet?.balance, 90000, "Balance must equal targetTokens - reservedTokens");
    assert.equal(wallet?.balance! + wallet?.reservedTokens!, 100000, "Total token budget must equal 100,000");
    assert.equal(wallet?.totalUsed, 35000, "Lifetime totalUsed must be preserved on upgrade");
  });

  // 10. Existing usage remaining correctly accounted for after duplicate attempt
  test("10. Existing usage remains correctly accounted for and is never zeroed out by duplicate events", async () => {
    const user = await createTestUser("pro");
    const subId = `sub_usage_protect_${Date.now()}`;
    createdSubIds.push(subId);
    const periodStart = new Date("2026-10-01T00:00:00.000Z");
    const key = `polar:sub:${subId}:${periodStart.toISOString()}:pro`;

    // 1st allocation
    await allocateTokensForPlan(user._id, "pro", {
      allocationKey: key,
      provider: "polar",
      providerSubscriptionId: subId,
      periodStart,
    });

    // User spends 15,000 tokens
    let wallet = await TokenWallet.findOne({ userId: user._id });
    wallet!.balance = 35000;
    wallet!.totalUsed = 15000;
    await wallet!.save();

    // Fire duplicate allocation
    await allocateTokensForPlan(user._id, "pro", {
      allocationKey: key,
      provider: "polar",
      providerSubscriptionId: subId,
      periodStart,
    });

    const checkedWallet = await TokenWallet.findOne({ userId: user._id });
    assert.equal(checkedWallet?.balance, 35000, "Balance must remain 35,000");
    assert.equal(checkedWallet?.totalUsed, 15000, "Total used must remain 15,000");
  });

  // 11. Existing token reservation, settlement, refund, and recovery behavior remaining unaffected
  test("11. Token reservation, settlement, refund, and Phase 4 recovery primitives remain 100% operational", async () => {
    const user = await createTestUser("pro");
    const subId = `sub_ledger_flow_${Date.now()}`;
    createdSubIds.push(subId);
    const periodStart = new Date("2026-10-01T00:00:00.000Z");

    // Allocate 50,000 tokens
    await allocateTokensForPlan(user._id, "pro", {
      allocationKey: `polar:sub:${subId}:${periodStart.toISOString()}:pro`,
      provider: "polar",
      providerSubscriptionId: subId,
      periodStart,
    });

    const convId = new Types.ObjectId();
    const userMsgId = new Types.ObjectId();
    const assistantMsgId = new Types.ObjectId();

    // Step A: Create token reservation (3,000 tokens)
    const resSession = await mongoose.startSession();
    let reservationDoc: any;
    await resSession.withTransaction(async () => {
      const res = await createTokenReservation(
        {
          userId: user._id,
          conversationId: convId,
          userMessageId: userMsgId,
          assistantMessageId: assistantMsgId,
          inputTokens: 1000,
          maxOutputBudget: 2000,
        },
        { session: resSession }
      );
      reservationDoc = res.reservation;
    });
    await resSession.endSession();

    assert.ok(reservationDoc._id);
    let wallet = await TokenWallet.findOne({ userId: user._id });
    assert.equal(wallet?.reservedTokens, 3000);
    assert.equal(wallet?.balance, 47000);

    // Step B: Settle reservation with actual usage (1,500 tokens used, 1,500 refunded to balance)
    const settleSession = await mongoose.startSession();
    await settleSession.withTransaction(async () => {
      await settleTokenReservation(
        {
          reservationId: reservationDoc._id,
          userId: user._id,
          conversationId: convId,
          assistantMessageId: assistantMsgId,
          expectedVersion: reservationDoc.version,
          usageData: {
            billedTokens: 1500,
            billedInputTokens: 1000,
            billedOutputTokens: 500,
            overrunTokens: 0,
            verificationStatus: "AUTHORITATIVE",
            model: "gemini-2.5-pro",
          },
        },
        { session: settleSession }
      );
    });
    await settleSession.endSession();

    wallet = await TokenWallet.findOne({ userId: user._id });
    assert.equal(wallet?.reservedTokens, 0, "Hold cleared after settlement");
    assert.equal(wallet?.balance, 48500, "Unused 1,500 refunded to balance");
    assert.equal(wallet?.totalUsed, 1500, "1,500 added to totalUsed");

    // Step C: Verify Phase 4 recovery refund primitive
    const recAssistantMsgId = new Types.ObjectId();
    const recReservation = await TokenReservation.create({
      userId: user._id,
      conversationId: convId,
      userMessageId: new Types.ObjectId(),
      assistantMessageId: recAssistantMsgId,
      reservedTokens: 2000,
      inputTokens: 500,
      maxOutputBudget: 1500,
      status: "RECOVERING",
      claimOwner: "worker-phase5-test",
      recoveryExpiresAt: new Date(Date.now() + 60000),
      lockExpiresAt: new Date(Date.now() - 60000),
      version: 1,
    });

    await TokenWallet.updateOne(
      { userId: user._id },
      { $inc: { balance: -2000, reservedTokens: 2000 } }
    );

    const recResult = await resolveRecoveringReservation({
      reservationId: recReservation._id,
      workerId: "worker-phase5-test",
      expectedVersion: 1,
    });

    assert.equal(recResult.reservation.status, "REFUNDED");
    assert.equal(recResult.refundedAmount, 2000);

    wallet = await TokenWallet.findOne({ userId: user._id });
    assert.equal(wallet?.reservedTokens, 0, "Recovery hold cleared");
    assert.equal(wallet?.balance, 48500, "2,000 restored to balance");
  });

  // 12. Unique-index conflict handling verifies user linkage and does not swallow unrelated errors
  test("12. Unique-index conflicts enforce user linkage and unrelated errors are not silently swallowed", async () => {
    const userA = await createTestUser("pro");
    const userB = await createTestUser("free");
    const checkoutId = `ch_linkage_conflict_${Date.now()}`;
    const subIdA = `sub_linkage_A_${Date.now()}`;
    const periodStart = new Date("2026-10-01T00:00:00.000Z");

    // User A successfully claims checkoutId
    await allocateTokensForPlan(userA._id, "pro", {
      allocationKey: `polar:sub:${subIdA}:${periodStart.toISOString()}:pro`,
      checkoutId,
      provider: "polar",
      providerSubscriptionId: subIdA,
      periodStart,
    });

    const allocA = await TokenAllocation.findOne({ checkoutId });
    assert.ok(allocA !== null);
    assert.equal(allocA.userId.toString(), userA._id.toString());

    // User B attempts to claim the exact same checkoutId
    await assert.rejects(
      async () => {
        await allocateTokensForPlan(userB._id, "pro", {
          allocationKey: `polar:sub:sub_linkage_B_${Date.now()}:${periodStart.toISOString()}:pro`,
          checkoutId, // Collision with User A's grant!
          provider: "polar",
          providerSubscriptionId: `sub_linkage_B_${Date.now()}`,
          periodStart,
        });
      },
      (err: any) => {
        assert.ok(
          err.message.includes("already claimed by different user") ||
          err.message.includes("Token allocation conflict"),
          `Expected user-linkage conflict error, got: ${err.message}`
        );
        return true;
      }
    );

    // Verify User B's wallet was never modified
    const walletB = await TokenWallet.findOne({ userId: userB._id });
    assert.strictEqual(walletB, null, "User B wallet must not be created or credited with User A grant");
  });

  // 13. End-to-end multi-period consistency between documented counter meanings and wallet mutations
  test("13. Full lifecycle multi-period consistency adheres strictly to documented ledger invariant", async () => {
    const user = await createTestUser("free");
    const subId = `sub_lifecycle_${Date.now()}`;
    createdSubIds.push(subId);

    // 1. Initial Free Wallet
    await allocateTokensForPlan(user._id, "free", {
      allocationKey: `initial:${user._id.toString()}:free`,
      provider: "none",
    });

    let wallet = await TokenWallet.findOne({ userId: user._id });
    assert.equal(wallet?.balance, 10000, "Initial Free balance = 10,000");
    assert.equal(wallet?.totalAllocated, 10000, "Initial period quota = 10,000");
    assert.equal(wallet?.totalUsed, 0, "Initial lifetime usage = 0");
    assert.equal(wallet?.reservedTokens, 0, "Initial reserved hold = 0");

    // 2. Generation on Free tier: Reserve 4,000, settle 2,500 (1,500 refund)
    const convId = new Types.ObjectId();
    const resSession = await mongoose.startSession();
    let resDoc: any;
    await resSession.withTransaction(async () => {
      const res = await createTokenReservation(
        {
          userId: user._id,
          conversationId: convId,
          userMessageId: new Types.ObjectId(),
          assistantMessageId: new Types.ObjectId(),
          inputTokens: 1000,
          maxOutputBudget: 3000,
        },
        { session: resSession }
      );
      resDoc = res.reservation;
    });
    await resSession.endSession();

    const settleSession = await mongoose.startSession();
    await settleSession.withTransaction(async () => {
      await settleTokenReservation(
        {
          reservationId: resDoc._id,
          userId: user._id,
          conversationId: convId,
          assistantMessageId: resDoc.assistantMessageId,
          expectedVersion: resDoc.version,
          usageData: {
            billedTokens: 2500,
            billedInputTokens: 1000,
            billedOutputTokens: 1500,
            overrunTokens: 0,
            verificationStatus: "AUTHORITATIVE",
            model: "gemini-2.5-flash",
          },
        },
        { session: settleSession }
      );
    });
    await settleSession.endSession();

    wallet = await TokenWallet.findOne({ userId: user._id });
    assert.equal(wallet?.balance, 7500, "Free balance = 10,000 - 2,500 = 7,500");
    assert.equal(wallet?.totalUsed, 2500, "Lifetime usage = 2,500");

    // 3. User buys Pro subscription (Month 1: October)
    const period1Start = new Date("2026-10-01T00:00:00.000Z");
    const checkoutId = `ch_lifecycle_${Date.now()}`;
    await allocateTokensForPlan(user._id, "pro", {
      allocationKey: `polar:checkout:${checkoutId}:pro`,
      checkoutId,
      provider: "polar",
      providerSubscriptionId: subId,
      periodStart: period1Start,
    });

    wallet = await TokenWallet.findOne({ userId: user._id });
    assert.equal(wallet?.balance, 50000, "Pro allocation replenishes active balance to 50,000");
    assert.equal(wallet?.totalAllocated, 50000, "Active plan quota updated to 50,000");
    assert.equal(wallet?.totalUsed, 2500, "Historical usage strictly preserved at 2,500");

    // 4. Month 2 Renewal arrives (November) with prior 6,000 additional tokens spent
    wallet!.balance = 44000;
    wallet!.totalUsed = 8500;
    await wallet!.save();

    const period2Start = new Date("2026-11-01T00:00:00.000Z");
    await allocateTokensForPlan(user._id, "pro", {
      allocationKey: `polar:sub:${subId}:${period2Start.toISOString()}:pro`,
      provider: "polar",
      providerSubscriptionId: subId,
      periodStart: period2Start,
    });

    wallet = await TokenWallet.findOne({ userId: user._id });
    assert.equal(wallet?.balance, 50000, "Renewal replenishes active balance to 50,000");
    assert.equal(wallet?.totalAllocated, 50000, "Active plan quota = 50,000");
    assert.equal(wallet?.totalUsed, 8500, "Historical cumulative usage strictly preserved at 8,500");

    // 5. In-flight generation creates 10,000 hold
    wallet!.balance = 40000;
    wallet!.reservedTokens = 10000;
    await wallet!.save();

    // 6. Mid-cycle upgrade to Plus (100,000) arrives while 10,000 hold is active
    await allocateTokensForPlan(user._id, "plus", {
      allocationKey: `polar:sub:${subId}:${period2Start.toISOString()}:plus`,
      provider: "polar",
      providerSubscriptionId: subId,
      periodStart: period2Start,
    });

    wallet = await TokenWallet.findOne({ userId: user._id });
    // Invariant: balance (90,000) + reservedTokens (10,000) = targetTokens (100,000)
    assert.equal(wallet?.reservedTokens, 10000, "Active hold preserved");
    assert.equal(wallet?.balance, 90000, "Balance reduced by active hold");
    assert.equal(wallet?.totalAllocated, 100000, "Active plan quota updated to 100,000");
    assert.equal(wallet?.totalUsed, 8500, "Historical lifetime usage preserved");
    assert.equal(wallet?.balance! + wallet?.reservedTokens!, 100000, "Total liquid + reserved budget = 100,000");
  });
});

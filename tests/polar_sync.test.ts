import "dotenv/config";
import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import type { Server } from "node:http";
import { Webhook } from "standardwebhooks";
import app from "../src/app.js";
import { connectDatabase } from "../src/config/database.js";
import { User } from "../src/database/models/user/index.js";
import { TokenWallet } from "../src/database/models/tokenWallet/index.js";
import { Subscription } from "../src/database/models/subscription/index.js";
import {
  SUBSCRIPTION_STATUS,
  SUBSCRIPTION_PROVIDER,
} from "../src/features/subscription/index.js";

describe("Polar Subscription Synchronization Test Suite (Phase 7C)", () => {
  let server: Server;
  let baseUrl: string;
  const TEST_SECRET = "polar_whsec_test_secret_for_automated_testing_123";
  let originalSecret: string | undefined;
  const createdUserIds: mongoose.Types.ObjectId[] = [];

  // Helper to sign payloads with standardwebhooks
  const signPayload = (
    msgId: string,
    timestamp: Date,
    payload: string,
    secret: string = TEST_SECRET
  ) => {
    const base64Secret = Buffer.from(secret, "utf-8").toString("base64");
    const wh = new Webhook(base64Secret);
    return wh.sign(msgId, timestamp, payload);
  };

  const createSubscriptionPayload = (
    eventType: string,
    subscriptionId: string,
    userId: string,
    overrides: any = {}
  ) => {
    const now = new Date();
    const periodStart = new Date(now.getTime() - 24 * 3600 * 1000).toISOString();
    const periodEnd = new Date(now.getTime() + 30 * 24 * 3600 * 1000).toISOString();

    return {
      type: eventType,
      timestamp: now.toISOString(),
      data: {
        id: subscriptionId,
        created_at: periodStart,
        modified_at: null,
        amount: 600,
        currency: "usd",
        recurring_interval: "month",
        recurring_interval_count: 1,
        status: "active",
        current_period_start: periodStart,
        current_period_end: periodEnd,
        current_meter_period_start: null,
        current_meter_period_end: null,
        trial_start: null,
        trial_end: null,
        cancel_at_period_end: false,
        canceled_at: null,
        started_at: periodStart,
        ends_at: null,
        ended_at: null,
        pause_at_period_end: false,
        paused_at: null,
        resumes_at: null,
        customer_id: "cust_polar_test_123",
        product_id: process.env.POLAR_PRO_PRODUCT_ID || "cd17ed50-da7e-46ee-8bd6-74cd4e597a1b",
        discount_id: null,
        checkout_id: null,
        customer_cancellation_reason: null,
        customer_cancellation_comment: null,
        metadata: { userId },
        customer: {
          id: "cust_polar_test_123",
          created_at: periodStart,
          modified_at: null,
          metadata: {},
          external_id: userId,
          email: "polar_test_sync@example.com",
          email_verified: true,
          name: "Polar Sync Tester",
          billing_name: null,
          billing_address: null,
          tax_id: null,
          organization_id: "org_polar_test_123",
          avatar_url: null,
          deleted_at: null,
          type: "individual",
        },
        product: {
          id: process.env.POLAR_PRO_PRODUCT_ID || "cd17ed50-da7e-46ee-8bd6-74cd4e597a1b",
          created_at: periodStart,
          modified_at: null,
          trial_interval: null,
          trial_interval_count: null,
          visibility: "public",
          name: "Pro",
          description: null,
          recurring_interval: "month",
          recurring_interval_count: 1,
          meter_interval: null,
          meter_interval_count: null,
          is_recurring: true,
          is_archived: false,
          organization_id: "org_polar_test_123",
          metadata: {},
          prices: [],
          benefits: [],
          medias: [],
          attached_custom_fields: [],
        },
        meters: [],
        prices: [],
        discount: null,
        pending_update: null,
        ...overrides,
      },
    };
  };


  const sendWebhook = async (
    deliveryId: string,
    payloadObj: any,
    secret: string = TEST_SECRET
  ) => {
    const payloadStr = JSON.stringify(payloadObj);
    const now = new Date();
    const signature = signPayload(deliveryId, now, payloadStr, secret);

    return fetch(`${baseUrl}/api/subscriptions/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "webhook-id": deliveryId,
        "webhook-timestamp": Math.floor(now.getTime() / 1000).toString(),
        "webhook-signature": signature,
      },
      body: payloadStr,
    });
  };

  before(async () => {
    originalSecret = process.env.POLAR_WEBHOOK_SECRET;
    process.env.POLAR_WEBHOOK_SECRET = TEST_SECRET;

    await connectDatabase();
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address();
        if (addr && typeof addr === "object") {
          baseUrl = `http://127.0.0.1:${addr.port}`;
        }
        resolve();
      });
    });
  });

  after(async () => {
    if (originalSecret !== undefined) {
      process.env.POLAR_WEBHOOK_SECRET = originalSecret;
    } else {
      delete process.env.POLAR_WEBHOOK_SECRET;
    }

    if (createdUserIds.length > 0) {
      await Subscription.deleteMany({ userId: { $in: createdUserIds } });
      await TokenWallet.deleteMany({ userId: { $in: createdUserIds } });
      await User.deleteMany({ _id: { $in: createdUserIds } });
    }
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await mongoose.disconnect();
  });

  test("1. Verified subscription.created creates active Pro subscription and updates User.plan to 'pro'", async () => {
    const userId = new mongoose.Types.ObjectId();
    createdUserIds.push(userId);

    await User.create({
      _id: userId,
      name: "Created User",
      email: `sync_created_${Date.now()}@example.com`,
      passwordHash: "dummy_hash",
      role: "user",
      plan: "free",
      isActive: true,
    });

    const initialWallet = await TokenWallet.create({
      userId,
      balance: 10000,
      totalAllocated: 10000,
      totalUsed: 0,
      reservedTokens: 0,
    });

    const polarSubId = "sub_polar_created_001";
    const deliveryId = "msg_created_001";
    const payload = createSubscriptionPayload("subscription.created", polarSubId, userId.toString());

    const res = await sendWebhook(deliveryId, payload);
    assert.equal(res.status, 200);

    // Verify User.plan updated to pro
    const userInDb = await User.findById(userId);
    assert.equal(userInDb?.plan, "pro");

    // Verify Subscription record
    const sub = await Subscription.findOne({ providerSubscriptionId: polarSubId });
    assert(sub !== null);
    assert.equal(sub.userId.toString(), userId.toString());
    assert.equal(sub.provider, SUBSCRIPTION_PROVIDER.POLAR);
    assert.equal(sub.plan, "pro");
    assert.equal(sub.status, SUBSCRIPTION_STATUS.ACTIVE);
    assert.equal(sub.price, 6);
    assert.equal(sub.currency, "USD");
    assert.equal(sub.providerSubscriptionId, polarSubId);
    assert.notEqual(sub.providerSubscriptionId, deliveryId, "Must NOT store delivery ID as subscription ID");

    // Verify TokenWallet is 100% untouched
    const wallet = await TokenWallet.findOne({ userId });
    assert.equal(wallet?.balance, initialWallet.balance);
    assert.equal(wallet?.totalAllocated, initialWallet.totalAllocated);
    assert.equal(wallet?.totalUsed, initialWallet.totalUsed);
  });

  test("2. Verified subscription.active updates subscription and keeps User.plan 'pro'", async () => {
    const userId = new mongoose.Types.ObjectId();
    createdUserIds.push(userId);

    await User.create({
      _id: userId,
      name: "Active Event User",
      email: `sync_active_${Date.now()}@example.com`,
      passwordHash: "dummy_hash",
      role: "user",
      plan: "free",
      isActive: true,
    });

    const polarSubId = "sub_polar_active_002";
    const payload = createSubscriptionPayload("subscription.active", polarSubId, userId.toString());

    const res = await sendWebhook("msg_active_002", payload);
    assert.equal(res.status, 200);

    const userInDb = await User.findById(userId);
    assert.equal(userInDb?.plan, "pro");

    const sub = await Subscription.findOne({ providerSubscriptionId: polarSubId });
    assert.equal(sub?.status, SUBSCRIPTION_STATUS.ACTIVE);
    assert.equal(sub?.plan, "pro");
  });

  test("3. Verified subscription.updated updates period dates and preserves Pro status", async () => {
    const userId = new mongoose.Types.ObjectId();
    createdUserIds.push(userId);

    await User.create({
      _id: userId,
      name: "Updated Event User",
      email: `sync_updated_${Date.now()}@example.com`,
      passwordHash: "dummy_hash",
      role: "user",
      plan: "free",
      isActive: true,
    });

    const polarSubId = "sub_polar_updated_003";
    const initialPayload = createSubscriptionPayload("subscription.created", polarSubId, userId.toString());
    await sendWebhook("msg_initial_003", initialPayload);

    // Now send update with extended period
    const newEnd = new Date(Date.now() + 60 * 24 * 3600 * 1000).toISOString();
    const updatePayload = createSubscriptionPayload("subscription.updated", polarSubId, userId.toString(), {
      current_period_end: newEnd,
    });

    const res = await sendWebhook("msg_update_003", updatePayload);
    assert.equal(res.status, 200);

    const sub = await Subscription.findOne({ providerSubscriptionId: polarSubId });
    assert.equal(sub?.status, SUBSCRIPTION_STATUS.ACTIVE);
    assert.equal(new Date(sub!.currentPeriodEnd!).toISOString(), newEnd);
  });

  test("4. Cancellation with cancel_at_period_end preserves Pro access until period end", async () => {
    const userId = new mongoose.Types.ObjectId();
    createdUserIds.push(userId);

    await User.create({
      _id: userId,
      name: "Cancel Period End User",
      email: `sync_cancel_period_${Date.now()}@example.com`,
      passwordHash: "dummy_hash",
      role: "user",
      plan: "free",
      isActive: true,
    });

    const polarSubId = "sub_polar_cancel_004";
    const initialPayload = createSubscriptionPayload("subscription.created", polarSubId, userId.toString());
    await sendWebhook("msg_initial_004", initialPayload);

    // Send cancellation event scheduled at future period end
    const futurePeriodEnd = new Date(Date.now() + 15 * 24 * 3600 * 1000).toISOString();
    const cancelPayload = createSubscriptionPayload("subscription.canceled", polarSubId, userId.toString(), {
      cancel_at_period_end: true,
      current_period_end: futurePeriodEnd,
      ended_at: null,
      status: "active",
    });

    const res = await sendWebhook("msg_cancel_004", cancelPayload);
    assert.equal(res.status, 200);

    // CRITICAL: User access must NOT be immediately revoked
    const userInDb = await User.findById(userId);
    assert.equal(userInDb?.plan, "pro", "Access must be preserved when cancel_at_period_end is true");

    const sub = await Subscription.findOne({ providerSubscriptionId: polarSubId });
    assert.equal(sub?.status, SUBSCRIPTION_STATUS.ACTIVE);
    assert.equal(sub?.cancelAtPeriodEnd, true);
  });

  test("5. Immediate/ended cancellation downgrades User.plan to 'free' and marks status 'cancelled'", async () => {
    const userId = new mongoose.Types.ObjectId();
    createdUserIds.push(userId);

    await User.create({
      _id: userId,
      name: "Immediate Cancel User",
      email: `sync_cancel_imm_${Date.now()}@example.com`,
      passwordHash: "dummy_hash",
      role: "user",
      plan: "free",
      isActive: true,
    });

    const polarSubId = "sub_polar_cancel_005";
    const initialPayload = createSubscriptionPayload("subscription.created", polarSubId, userId.toString());
    await sendWebhook("msg_initial_005", initialPayload);

    // Send immediate cancellation event (ended_at in past)
    const pastEndedAt = new Date(Date.now() - 1000).toISOString();
    const cancelPayload = createSubscriptionPayload("subscription.canceled", polarSubId, userId.toString(), {
      cancel_at_period_end: false,
      ended_at: pastEndedAt,
      status: "canceled",
    });

    const res = await sendWebhook("msg_cancel_005", cancelPayload);
    assert.equal(res.status, 200);

    const userInDb = await User.findById(userId);
    assert.equal(userInDb?.plan, "free");

    const sub = await Subscription.findOne({ providerSubscriptionId: polarSubId });
    assert.equal(sub?.status, SUBSCRIPTION_STATUS.CANCELLED);
  });

  test("6. Revoked subscription immediately expires subscription and downgrades User.plan to 'free'", async () => {
    const userId = new mongoose.Types.ObjectId();
    createdUserIds.push(userId);

    await User.create({
      _id: userId,
      name: "Revoked User",
      email: `sync_revoked_${Date.now()}@example.com`,
      passwordHash: "dummy_hash",
      role: "user",
      plan: "free",
      isActive: true,
    });

    const polarSubId = "sub_polar_revoked_006";
    const initialPayload = createSubscriptionPayload("subscription.created", polarSubId, userId.toString());
    await sendWebhook("msg_initial_006", initialPayload);

    // Send revoked event
    const revokedPayload = createSubscriptionPayload("subscription.revoked", polarSubId, userId.toString(), {
      status: "canceled",
    });

    const res = await sendWebhook("msg_revoked_006", revokedPayload);
    assert.equal(res.status, 200);

    const userInDb = await User.findById(userId);
    assert.equal(userInDb?.plan, "free");

    const sub = await Subscription.findOne({ providerSubscriptionId: polarSubId });
    assert.equal(sub?.status, SUBSCRIPTION_STATUS.EXPIRED);
  });

  test("7. past_due event sets status to 'past_due' while preserving Pro access during grace period", async () => {
    const userId = new mongoose.Types.ObjectId();
    createdUserIds.push(userId);

    await User.create({
      _id: userId,
      name: "Past Due User",
      email: `sync_pastdue_${Date.now()}@example.com`,
      passwordHash: "dummy_hash",
      role: "user",
      plan: "free",
      isActive: true,
    });

    const polarSubId = "sub_polar_pastdue_007";
    const initialPayload = createSubscriptionPayload("subscription.created", polarSubId, userId.toString());
    await sendWebhook("msg_initial_007", initialPayload);

    // Send past_due event
    const pastDuePayload = createSubscriptionPayload("subscription.past_due", polarSubId, userId.toString(), {
      status: "past_due",
    });

    const res = await sendWebhook("msg_pastdue_007", pastDuePayload);
    assert.equal(res.status, 200);

    // Invariant: past_due retains Pro access without immediate downgrade
    const userInDb = await User.findById(userId);
    assert.equal(userInDb?.plan, "pro");

    const sub = await Subscription.findOne({ providerSubscriptionId: polarSubId });
    assert.equal(sub?.status, SUBSCRIPTION_STATUS.PAST_DUE);
  });

  test("8. Unknown user correlation safely handled without database corruption", async () => {
    const unknownUserId = new mongoose.Types.ObjectId().toString();
    const polarSubId = "sub_polar_unknown_008";

    const payload = createSubscriptionPayload("subscription.created", polarSubId, unknownUserId, {
      customer: {
        id: "cust_unknown",
        created_at: new Date().toISOString(),
        modified_at: null,
        metadata: {},
        external_id: unknownUserId,
        email: "nonexistent_user@example.com",
        email_verified: true,
        name: "Unknown User",
        billing_name: null,
        billing_address: null,
        tax_id: null,
        organization_id: "org_polar_test_123",
        avatar_url: null,
        deleted_at: null,
        type: "individual",
      },
    });


    const res = await sendWebhook("msg_unknown_008", payload);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.data.syncResult?.correlated, false);

    // Ensure zero records were created in Subscription
    const sub = await Subscription.findOne({ providerSubscriptionId: polarSubId });
    assert.equal(sub, null);
  });

  test("9. Duplicate webhook delivery is recognized and safely acknowledged", async () => {
    const userId = new mongoose.Types.ObjectId();
    createdUserIds.push(userId);

    await User.create({
      _id: userId,
      name: "Duplicate Tester",
      email: `sync_dup_${Date.now()}@example.com`,
      passwordHash: "dummy_hash",
      role: "user",
      plan: "free",
      isActive: true,
    });

    const polarSubId = "sub_polar_dup_009";
    const deliveryId = "msg_duplicate_delivery_009";
    const payload = createSubscriptionPayload("subscription.created", polarSubId, userId.toString());

    // 1st delivery
    const res1 = await sendWebhook(deliveryId, payload);
    assert.equal(res1.status, 200);

    // 2nd delivery of the exact same message
    const res2 = await sendWebhook(deliveryId, payload);
    assert.equal(res2.status, 200);
    const body2 = await res2.json();
    assert.equal(body2.success, true);
    assert.match(body2.data.syncResult?.message || "", /duplicate/i);

    // Must have exactly ONE subscription record
    const count = await Subscription.countDocuments({ providerSubscriptionId: polarSubId });
    assert.equal(count, 1);
  });

  test("10. Repeated same event is completely idempotent and produces identical database state", async () => {
    const userId = new mongoose.Types.ObjectId();
    createdUserIds.push(userId);

    await User.create({
      _id: userId,
      name: "Idempotency Tester",
      email: `sync_idempotent_${Date.now()}@example.com`,
      passwordHash: "dummy_hash",
      role: "user",
      plan: "free",
      isActive: true,
    });

    const polarSubId = "sub_polar_idempotent_010";
    const payload = createSubscriptionPayload("subscription.created", polarSubId, userId.toString());

    // Fire 3 times with different delivery IDs (e.g. provider retry with new delivery ID)
    await sendWebhook("msg_retry_1", payload);
    await sendWebhook("msg_retry_2", payload);
    await sendWebhook("msg_retry_3", payload);

    const count = await Subscription.countDocuments({ providerSubscriptionId: polarSubId });
    assert.equal(count, 1, "Repeated deliveries must NOT duplicate subscription records");

    const sub = await Subscription.findOne({ providerSubscriptionId: polarSubId });
    assert.equal(sub?.status, SUBSCRIPTION_STATUS.ACTIVE);
    assert.equal(sub?.plan, "pro");

    const user = await User.findById(userId);
    assert.equal(user?.plan, "pro");
  });

  test("11. Missing explicit NexaMind identity does NOT correlate by email and performs zero database mutations", async () => {
    const userId = new mongoose.Types.ObjectId();
    createdUserIds.push(userId);
    const existingUserEmail = `target_no_email_sync_${Date.now()}@example.com`;

    await User.create({
      _id: userId,
      name: "Target User",
      email: existingUserEmail,
      passwordHash: "dummy_hash",
      role: "user",
      plan: "free",
      isActive: true,
    });

    const initialWallet = await TokenWallet.create({
      userId,
      balance: 10000,
      totalAllocated: 10000,
      totalUsed: 0,
      reservedTokens: 0,
    });

    const polarSubId = "sub_polar_no_email_match_011";
    // Payload with NO metadata.userId, NO external_id, but customer.email matching the user's email
    const payload = createSubscriptionPayload("subscription.created", polarSubId, "omitted", {
      metadata: {},
      customer: {
        id: "cust_no_match",
        created_at: new Date().toISOString(),
        modified_at: null,
        metadata: {},
        external_id: null,
        email: existingUserEmail,
        email_verified: true,
        name: "Target User",
        billing_name: null,
        billing_address: null,
        tax_id: null,
        organization_id: "org_polar_test_123",
        avatar_url: null,
        deleted_at: null,
        type: "individual",
      },
    });

    const res = await sendWebhook("msg_no_email_sync_011", payload);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.data.syncResult?.correlated, false);

    // CRITICAL: User must NOT be upgraded to pro
    const userInDb = await User.findById(userId);
    assert.equal(userInDb?.plan, "free", "Must NOT upgrade user based on email matching alone");

    // ZERO Subscription records created for this Polar subscription
    const subInDb = await Subscription.findOne({ providerSubscriptionId: polarSubId });
    assert.equal(subInDb, null, "Zero subscription records must be created");

    // ZERO TokenWallet modifications
    const walletInDb = await TokenWallet.findOne({ userId });
    assert.equal(walletInDb?.balance, initialWallet.balance);
    assert.equal(walletInDb?.totalAllocated, initialWallet.totalAllocated);
    assert.equal(walletInDb?.totalUsed, initialWallet.totalUsed);
  });
});


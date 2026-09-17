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
import { TokenUsage } from "../src/database/models/tokenUsage/index.js";

describe("Polar Webhook Infrastructure Test Suite (Phase 7B)", () => {
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

  const createValidSubscriptionPayload = (
    subscriptionId: string,
    userId: string
  ) => {
    const nowIso = new Date().toISOString();
    return {
      type: "subscription.created",
      timestamp: nowIso,
      data: {
        id: subscriptionId,
        created_at: nowIso,
        modified_at: null,
        amount: 600,
        currency: "usd",
        recurring_interval: "month",
        recurring_interval_count: 1,
        status: "active",
        current_period_start: nowIso,
        current_period_end: nowIso,
        current_meter_period_start: null,
        current_meter_period_end: null,
        trial_start: null,
        trial_end: null,
        cancel_at_period_end: false,
        canceled_at: null,
        started_at: nowIso,
        ends_at: null,
        ended_at: null,
        pause_at_period_end: false,
        paused_at: null,
        resumes_at: null,
        customer_id: "cust_polar_test_123",
        product_id: "prod_polar_test_123",
        discount_id: null,
        checkout_id: null,
        customer_cancellation_reason: null,
        customer_cancellation_comment: null,
        metadata: { userId },
        customer: {
          id: "cust_polar_test_123",
          created_at: nowIso,
          modified_at: null,
          metadata: {},
          email: "polar_test@example.com",
          email_verified: true,
          name: "Polar Tester",
          billing_name: null,
          billing_address: null,
          tax_id: null,
          organization_id: "org_polar_test_123",
          avatar_url: null,
          deleted_at: null,
          type: "individual",
        },
        product: {
          id: "prod_polar_test_123",
          created_at: nowIso,
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
      },
    };
  };

  before(async () => {
    await connectDatabase();
    originalSecret = process.env.POLAR_WEBHOOK_SECRET;
    process.env.POLAR_WEBHOOK_SECRET = TEST_SECRET;

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
    process.env.POLAR_WEBHOOK_SECRET = originalSecret;

    if (createdUserIds.length > 0) {
      await TokenWallet.deleteMany({ userId: { $in: createdUserIds } });
      await TokenUsage.deleteMany({ userId: { $in: createdUserIds } });
      await User.deleteMany({ _id: { $in: createdUserIds } });
    }

    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await mongoose.disconnect();
  });

  test("1. Valid webhook signature succeeds with 200 OK and acknowledges event", async () => {
    const subId = "sub_valid_polar_001";
    const fakeUserId = new mongoose.Types.ObjectId().toString();
    const payloadObj = createValidSubscriptionPayload(subId, fakeUserId);
    const payloadStr = JSON.stringify(payloadObj);

    const now = new Date();
    const deliveryId = "msg_delivery_valid_001";
    const signature = signPayload(deliveryId, now, payloadStr);

    const res = await fetch(`${baseUrl}/api/subscriptions/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "webhook-id": deliveryId,
        "webhook-timestamp": Math.floor(now.getTime() / 1000).toString(),
        "webhook-signature": signature,
      },
      body: payloadStr,
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.data.eventType, "subscription.created");
    assert.equal(body.data.received, true);
  });

  test("2. Distinct webhook delivery ID is not used as providerSubscriptionId", async () => {
    const subId = "sub_actual_subscription_id_999";
    const deliveryId = "msg_polar_delivery_uuid_000";
    const fakeUserId = new mongoose.Types.ObjectId().toString();

    const payloadObj = createValidSubscriptionPayload(subId, fakeUserId);
    const payloadStr = JSON.stringify(payloadObj);

    const now = new Date();
    const signature = signPayload(deliveryId, now, payloadStr);

    const res = await fetch(`${baseUrl}/api/subscriptions/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "webhook-id": deliveryId,
        "webhook-timestamp": Math.floor(now.getTime() / 1000).toString(),
        "webhook-signature": signature,
      },
      body: payloadStr,
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.webhookDeliveryId, deliveryId);
    assert.equal(body.data.providerSubscriptionId, subId);
    assert.notEqual(
      body.data.providerSubscriptionId,
      body.data.webhookDeliveryId,
      "providerSubscriptionId must NOT equal webhook delivery ID"
    );
  });

  test("3. Invalid signature is rejected with 400 Bad Request", async () => {
    const payloadStr = JSON.stringify({ type: "subscription.created", data: {} });
    const now = new Date();

    const res = await fetch(`${baseUrl}/api/subscriptions/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "webhook-id": "msg_tampered_123",
        "webhook-timestamp": Math.floor(now.getTime() / 1000).toString(),
        "webhook-signature": "v1,tampered_invalid_signature_hex",
      },
      body: payloadStr,
    });

    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.match(body.message, /invalid webhook signature/i);
  });

  test("4. Missing signature headers is rejected with 400 Bad Request", async () => {
    const payloadStr = JSON.stringify({ type: "subscription.created", data: {} });

    const res = await fetch(`${baseUrl}/api/subscriptions/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: payloadStr,
    });

    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.success, false);
  });

  test("5. Malformed payload with valid signature is rejected with 400 Bad Request", async () => {
    const brokenPayload = "{malformed_not_json_body";
    const now = new Date();
    const deliveryId = "msg_malformed_001";
    const signature = signPayload(deliveryId, now, brokenPayload);

    const res = await fetch(`${baseUrl}/api/subscriptions/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "webhook-id": deliveryId,
        "webhook-timestamp": Math.floor(now.getTime() / 1000).toString(),
        "webhook-signature": signature,
      },
      body: brokenPayload,
    });

    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.match(body.message, /malformed webhook payload/i);
  });

  test("6. Missing webhook secret configuration returns 500 Internal Server Error", async () => {
    // Temporarily clear the webhook secret
    delete process.env.POLAR_WEBHOOK_SECRET;

    try {
      const res = await fetch(`${baseUrl}/api/subscriptions/webhook`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "webhook-id": "msg_test",
          "webhook-timestamp": "12345",
          "webhook-signature": "v1,sig",
        },
        body: JSON.stringify({ type: "subscription.created" }),
      });

      assert.equal(res.status, 500);
      const body = await res.json();
      assert.equal(body.success, false);
      assert.match(body.message, /webhook secret is not configured/i);
    } finally {
      process.env.POLAR_WEBHOOK_SECRET = TEST_SECRET;
    }
  });

  test("7. Unsupported/unhandled event with valid signature is safely acknowledged with 200 OK", async () => {
    const unhandledPayload = JSON.stringify({
      type: "unsupported.custom.event",
      data: { custom: "payload" },
    });
    const now = new Date();
    const deliveryId = "msg_unhandled_001";
    const signature = signPayload(deliveryId, now, unhandledPayload);

    const res = await fetch(`${baseUrl}/api/subscriptions/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "webhook-id": deliveryId,
        "webhook-timestamp": Math.floor(now.getTime() / 1000).toString(),
        "webhook-signature": signature,
      },
      body: unhandledPayload,
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.match(body.message, /acknowledged/i);
  });

  test("8. Webhook does NOT modify TokenWallet or allocate tokens", async () => {
    const testUserId = new mongoose.Types.ObjectId();
    createdUserIds.push(testUserId);

    await User.create({
      _id: testUserId,
      name: "Token Invariant User",
      email: `token_wh_user_${Date.now()}@example.com`,
      passwordHash: "hashed",
      role: "user",
      plan: "free",
      isActive: true,
    });

    await TokenWallet.create({
      userId: testUserId,
      balance: 10000,
      totalAllocated: 10000,
      totalUsed: 0,
      reservedTokens: 0,
    });

    const walletBefore = await TokenWallet.findOne({ userId: testUserId }).lean();
    const tokenUsageCountBefore = await TokenUsage.countDocuments({ userId: testUserId });

    const payloadObj = createValidSubscriptionPayload(
      "sub_token_safe_001",
      testUserId.toString()
    );
    const payloadStr = JSON.stringify(payloadObj);

    const now = new Date();
    const deliveryId = "msg_token_safety_check";
    const signature = signPayload(deliveryId, now, payloadStr);

    const res = await fetch(`${baseUrl}/api/subscriptions/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "webhook-id": deliveryId,
        "webhook-timestamp": Math.floor(now.getTime() / 1000).toString(),
        "webhook-signature": signature,
      },
      body: payloadStr,
    });

    assert.equal(res.status, 200);

    const walletAfter = await TokenWallet.findOne({ userId: testUserId }).lean();
    const tokenUsageCountAfter = await TokenUsage.countDocuments({ userId: testUserId });

    // Ensure wallet is 100% untouched
    assert.equal(walletAfter?.balance, walletBefore?.balance);
    assert.equal(walletAfter?.totalAllocated, walletBefore?.totalAllocated);
    assert.equal(walletAfter?.totalUsed, walletBefore?.totalUsed);
    assert.equal(walletAfter?.reservedTokens, walletBefore?.reservedTokens);

    // Ensure zero token usage records created
    assert.equal(tokenUsageCountAfter, tokenUsageCountBefore);
    assert.equal(tokenUsageCountAfter, 0);
  });
});

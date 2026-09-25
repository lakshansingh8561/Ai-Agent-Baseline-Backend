import "dotenv/config";
import test, { describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import type { Server } from "node:http";
import jwt from "jsonwebtoken";
import app from "../src/app.js";
import { connectDatabase } from "../src/config/database.js";
import { User } from "../src/database/models/user/index.js";
import { TokenWallet } from "../src/database/models/tokenWallet/index.js";
import { Subscription } from "../src/database/models/subscription/index.js";
import {
  SUBSCRIPTION_PLANS,
  SUBSCRIPTION_STATUS,
  SUBSCRIPTION_PROVIDER,
  getPolarProductIdForPlan,
  getPlanForPolarProductId,
  syncPolarSubscriptionEvent,
  _setInternalPolarClient,
} from "../src/features/subscription/index.js";

describe("Polar Plus Plan & Multi-Plan Checkout Test Suite", () => {
  let server: Server;
  let baseUrl: string;
  const createdUserIds: mongoose.Types.ObjectId[] = [];
  let capturedCheckoutArgs: any = null;

  const mockPolarClient = {
    checkouts: {
      create: async (args: any) => {
        capturedCheckoutArgs = args;
        return {
          id: "checkout_polar_mock_plus_123",
          url: "https://sandbox-api.polar.sh/checkout/checkout_polar_mock_plus_123",
          status: "open",
          expiresAt: new Date(Date.now() + 3600 * 1000),
          createdAt: new Date(),
          modifiedAt: null,
          products: args.products,
          metadata: args.metadata,
        };
      },
    },
  };

  const signTestToken = (userId: string, role: "user" | "admin" = "user") => {
    const secret =
      process.env.JWT_SECRET ||
      "1ff6e690959aeaeb72e6db045b982cfa3a020e76e67905427ee1dc2bbabf343f";
    return jwt.sign({ userId, role }, secret, { expiresIn: "1h" });
  };

  before(async () => {
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

  beforeEach(() => {
    capturedCheckoutArgs = null;
    _setInternalPolarClient(mockPolarClient);
  });

  after(async () => {
    _setInternalPolarClient(null);
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

  test("1. Plan configurations: free, plus, and pro are properly configured", () => {
    assert.ok(SUBSCRIPTION_PLANS.free);
    assert.equal(SUBSCRIPTION_PLANS.free.plan, "free");
    assert.equal(SUBSCRIPTION_PLANS.free.price, 0);

    assert.ok(SUBSCRIPTION_PLANS.plus);
    assert.equal(SUBSCRIPTION_PLANS.plus.plan, "plus");
    assert.equal(SUBSCRIPTION_PLANS.plus.price, 20);
    assert.equal(SUBSCRIPTION_PLANS.plus.billingInterval, "month");
    assert.ok(SUBSCRIPTION_PLANS.plus.tokensPerPeriod > 0);

    assert.ok(SUBSCRIPTION_PLANS.pro);
    assert.equal(SUBSCRIPTION_PLANS.pro.plan, "pro");
    assert.equal(SUBSCRIPTION_PLANS.pro.price, 6);
  });

  test("2. getPolarProductIdForPlan maps plus to POLAR_PLUS_PRODUCT_ID and pro to POLAR_PRO_PRODUCT_ID", () => {
    const plusId = getPolarProductIdForPlan("plus");
    const proId = getPolarProductIdForPlan("pro");

    assert.equal(plusId, process.env.POLAR_PLUS_PRODUCT_ID || null);
    assert.equal(proId, process.env.POLAR_PRO_PRODUCT_ID || null);
  });

  test("3. getPlanForPolarProductId resolves product IDs to their respective plans", () => {
    if (process.env.POLAR_PLUS_PRODUCT_ID) {
      assert.equal(
        getPlanForPolarProductId(process.env.POLAR_PLUS_PRODUCT_ID),
        "plus"
      );
    }
    if (process.env.POLAR_PRO_PRODUCT_ID) {
      assert.equal(
        getPlanForPolarProductId(process.env.POLAR_PRO_PRODUCT_ID),
        "pro"
      );
    }
    assert.equal(getPlanForPolarProductId("unknown-product-xyz-999"), null);
  });

  test("4. Free plan cannot create a Polar checkout (rejected with 400)", async () => {
    const userId = new mongoose.Types.ObjectId();
    createdUserIds.push(userId);

    await User.create({
      _id: userId,
      email: `test_free_checkout_${Date.now()}@example.com`,
      passwordHash: "hashed_dummy_password",
      name: "Free Tester",
      role: "user",
      plan: "free",
      isActive: true,
    });

    const token = signTestToken(userId.toString());
    const res = await fetch(`${baseUrl}/api/subscriptions/checkout`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ plan: "free" }),
    });

    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.equal(capturedCheckoutArgs, null);
  });

  test("5. Invalid plan string is rejected with 400", async () => {
    const userId = new mongoose.Types.ObjectId();
    createdUserIds.push(userId);

    await User.create({
      _id: userId,
      email: `test_invalid_checkout_${Date.now()}@example.com`,
      passwordHash: "hashed_dummy_password",
      name: "Invalid Plan Tester",
      role: "user",
      plan: "free",
      isActive: true,
    });

    const token = signTestToken(userId.toString());
    const res = await fetch(`${baseUrl}/api/subscriptions/checkout`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ plan: "enterprise_invalid" }),
    });

    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.equal(capturedCheckoutArgs, null);
  });

  test("6. Free user can successfully initiate Plus checkout with { plan: 'plus' }", async () => {
    const userId = new mongoose.Types.ObjectId();
    createdUserIds.push(userId);

    await User.create({
      _id: userId,
      email: `test_plus_success_${Date.now()}@example.com`,
      passwordHash: "hashed_dummy_password",
      name: "Plus Tester",
      role: "user",
      plan: "free",
      isActive: true,
    });

    const token = signTestToken(userId.toString());
    const res = await fetch(`${baseUrl}/api/subscriptions/checkout`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ plan: "plus" }),
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.ok(capturedCheckoutArgs);
    assert.deepEqual(capturedCheckoutArgs.products, [process.env.POLAR_PLUS_PRODUCT_ID]);
    assert.equal(capturedCheckoutArgs.metadata.plan, "plus");
    assert.equal(capturedCheckoutArgs.metadata.userId, userId.toString());
    assert.ok(
      capturedCheckoutArgs.successUrl.includes("/app/billing?checkout=success&checkout_id={CHECKOUT_ID}"),
      `successUrl must point to /app/billing, got: ${capturedCheckoutArgs.successUrl}`
    );
    assert.ok(
      capturedCheckoutArgs.returnUrl.endsWith("/app/billing"),
      `returnUrl must point to /app/billing, got: ${capturedCheckoutArgs.returnUrl}`
    );
  });

  test("7. Free user can successfully initiate Pro checkout with { plan: 'pro' }", async () => {
    const userId = new mongoose.Types.ObjectId();
    createdUserIds.push(userId);

    await User.create({
      _id: userId,
      email: `test_pro_success_${Date.now()}@example.com`,
      passwordHash: "hashed_dummy_password",
      name: "Pro Tester",
      role: "user",
      plan: "free",
      isActive: true,
    });

    const token = signTestToken(userId.toString());
    const res = await fetch(`${baseUrl}/api/subscriptions/checkout`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ plan: "pro" }),
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.ok(capturedCheckoutArgs);
    assert.deepEqual(capturedCheckoutArgs.products, [process.env.POLAR_PRO_PRODUCT_ID]);
    assert.equal(capturedCheckoutArgs.metadata.userId, userId.toString());
    assert.ok(
      capturedCheckoutArgs.successUrl.includes("/app/billing?checkout=success&checkout_id={CHECKOUT_ID}")
    );
    assert.ok(capturedCheckoutArgs.returnUrl.endsWith("/app/billing"));
  });

  test("8. Pro user can successfully upgrade to Plus (PRO -> PLUS allowed)", async () => {
    const userId = new mongoose.Types.ObjectId();
    createdUserIds.push(userId);

    await User.create({
      _id: userId,
      email: `test_pro_to_plus_${Date.now()}@example.com`,
      passwordHash: "hashed_dummy_password",
      name: "Pro to Plus User",
      role: "user",
      plan: "pro",
      isActive: true,
    });

    const token = signTestToken(userId.toString());
    const res = await fetch(`${baseUrl}/api/subscriptions/checkout`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ plan: "plus" }),
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.ok(capturedCheckoutArgs);
    assert.deepEqual(capturedCheckoutArgs.products, [process.env.POLAR_PLUS_PRODUCT_ID]);
  });

  test("9. Plan hierarchy rejections: same-tier or downgrades rejected", async () => {
    // 9a: Plus user requesting Plus (PLUS -> PLUS rejected with 409)
    const plusUserId = new mongoose.Types.ObjectId();
    createdUserIds.push(plusUserId);
    await User.create({
      _id: plusUserId,
      email: `plus_self_${Date.now()}@example.com`,
      passwordHash: "dummy",
      name: "Plus Self",
      role: "user",
      plan: "plus",
      isActive: true,
    });
    const plusToken = signTestToken(plusUserId.toString());
    const resPlusPlus = await fetch(`${baseUrl}/api/subscriptions/checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${plusToken}` },
      body: JSON.stringify({ plan: "plus" }),
    });
    assert.equal(resPlusPlus.status, 409);

    // 9b: Pro user requesting Pro (PRO -> PRO rejected with 409)
    const proUserId = new mongoose.Types.ObjectId();
    createdUserIds.push(proUserId);
    await User.create({
      _id: proUserId,
      email: `pro_self_${Date.now()}@example.com`,
      passwordHash: "dummy",
      name: "Pro Self",
      role: "user",
      plan: "pro",
      isActive: true,
    });
    const proToken = signTestToken(proUserId.toString());
    const resProPro = await fetch(`${baseUrl}/api/subscriptions/checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${proToken}` },
      body: JSON.stringify({ plan: "pro" }),
    });
    assert.equal(resProPro.status, 409);

    // 9c: Plus user requesting Pro (PLUS -> PRO downgrade rejected with 400)
    const resPlusPro = await fetch(`${baseUrl}/api/subscriptions/checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${plusToken}` },
      body: JSON.stringify({ plan: "pro" }),
    });
    assert.equal(resPlusPro.status, 400);

    // 9d: Plus user requesting Free (PLUS -> FREE rejected with 400)
    const resPlusFree = await fetch(`${baseUrl}/api/subscriptions/checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${plusToken}` },
      body: JSON.stringify({ plan: "free" }),
    });
    assert.equal(resPlusFree.status, 400);

    // 9e: Pro user requesting Free (PRO -> FREE rejected with 400)
    const resProFree = await fetch(`${baseUrl}/api/subscriptions/checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${proToken}` },
      body: JSON.stringify({ plan: "free" }),
    });
    assert.equal(resProFree.status, 400);
  });

  test("10. Public Catalog GET /api/subscriptions/plans returns authoritative prices without secrets", async () => {
    const res = await fetch(`${baseUrl}/api/subscriptions/plans`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.ok(Array.isArray(body.data.plans));
    assert.equal(body.data.plans.length, 3);

    const [freePlan, proPlan, plusPlan] = body.data.plans;
    assert.equal(freePlan.id, "free");
    assert.equal(freePlan.price, 0);
    assert.equal(freePlan.polarProductId, null);

    assert.equal(proPlan.id, "pro");
    assert.equal(proPlan.price, 6);
    assert.equal(proPlan.currency, "USD");
    assert.equal(proPlan.interval, "USD / month");

    assert.equal(plusPlan.id, "plus");
    assert.equal(plusPlan.price, 20);
    assert.equal(plusPlan.currency, "USD");
    assert.equal(plusPlan.interval, "USD / month");

    // Strictly ensure no secrets exist anywhere in the payload
    const bodyString = JSON.stringify(body);
    assert.ok(!bodyString.includes("whsec_"));
    assert.ok(!bodyString.includes("polar_oat_"));
  });

  test("11. Webhook sync: Polar event with POLAR_PLUS_PRODUCT_ID sets plan to 'plus'", async () => {
    const userId = new mongoose.Types.ObjectId();
    createdUserIds.push(userId);

    const user = await User.create({
      _id: userId,
      email: `webhook_plus_sync_${Date.now()}@example.com`,
      passwordHash: "hashed_dummy_password",
      name: "Webhook Plus User",
      role: "user",
      plan: "free",
      isActive: true,
    });

    const plusEvent = {
      type: "subscription.created",
      data: {
        id: `sub_plus_polar_${Date.now()}`,
        productId: process.env.POLAR_PLUS_PRODUCT_ID,
        amount: 300,
        currency: "usd",
        status: "active",
        currentPeriodStart: new Date(),
        currentPeriodEnd: new Date(Date.now() + 30 * 24 * 3600 * 1000),
        cancelAtPeriodEnd: false,
        metadata: { userId: userId.toString() },
      },
    };

    const syncResult = await syncPolarSubscriptionEvent(plusEvent);
    assert.equal(syncResult.synchronized, true);
    assert.equal(syncResult.action, "created");

    const updatedUser = await User.findById(userId);
    assert.equal(updatedUser?.plan, "plus");

    const sub = await Subscription.findOne({ userId });
    assert.equal(sub?.plan, "plus");
  });

  test("12. Webhook sync: Unknown Polar product ID is safely ignored without converting to Pro", async () => {
    const userId = new mongoose.Types.ObjectId();
    createdUserIds.push(userId);

    await User.create({
      _id: userId,
      email: `webhook_unknown_prod_${Date.now()}@example.com`,
      passwordHash: "hashed_dummy_password",
      name: "Unknown Prod User",
      role: "user",
      plan: "free",
      isActive: true,
    });

    const unknownEvent = {
      type: "subscription.created",
      data: {
        id: `sub_unknown_polar_${Date.now()}`,
        productId: "totally_unrecognized_product_id_xyz",
        amount: 5000,
        currency: "usd",
        status: "active",
        metadata: { userId: userId.toString() },
      },
    };

    const syncResult = await syncPolarSubscriptionEvent(unknownEvent);
    assert.equal(syncResult.synchronized, false);
    assert.equal(syncResult.action, "ignored");

    // Verify user remained Free and no subscription was created
    const userInDb = await User.findById(userId);
    assert.equal(userInDb?.plan, "free");

    const subInDb = await Subscription.findOne({ userId, provider: "polar" });
    assert.equal(subInDb, null);
  });
});

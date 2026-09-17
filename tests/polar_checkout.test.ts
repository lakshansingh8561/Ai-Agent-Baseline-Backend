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
  _setInternalPolarClient,
} from "../src/features/subscription/index.js";

describe("Polar Checkout Flow Test Suite (Phase 7B)", () => {
  let server: Server;
  let baseUrl: string;
  const createdUserIds: mongoose.Types.ObjectId[] = [];
  let capturedCheckoutArgs: any = null;

  const mockPolarClient = {
    checkouts: {
      create: async (args: any) => {
        capturedCheckoutArgs = args;
        return {
          id: "checkout_polar_mock_abc123",
          url: "https://sandbox-api.polar.sh/checkout/checkout_polar_mock_abc123",
          status: "open",
          expiresAt: new Date(Date.now() + 3600 * 1000),
          createdAt: new Date(),
          modifiedAt: null,
          customFieldData: undefined,
          paymentProcessor: "stripe",
          clientSecret: "mock_client_secret_xyz",
          successUrl: args.successUrl,
          returnUrl: args.returnUrl,
          embedOrigin: null,
          amount: 600,
          currency: "usd",
          products: args.products,
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

  test("1. Unauthenticated request to POST /api/subscriptions/checkout is rejected with 401", async () => {
    const res = await fetch(`${baseUrl}/api/subscriptions/checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });

    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.equal(capturedCheckoutArgs, null);
  });

  test("2. Inactive user request to POST /api/subscriptions/checkout is rejected with 403", async () => {
    const userId = new mongoose.Types.ObjectId();
    createdUserIds.push(userId);

    await User.create({
      _id: userId,
      email: `inactive_user_${Date.now()}@example.com`,
      passwordHash: "hashed_dummy_password",
      name: "Inactive Tester",
      role: "user",
      plan: "free",
      isActive: false,
    });

    const token = signTestToken(userId.toString());
    const res = await fetch(`${baseUrl}/api/subscriptions/checkout`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
    });

    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.match(body.message, /inactive/i);
    assert.equal(capturedCheckoutArgs, null);
  });

  test("3. Non-existent user ID in JWT is rejected with 404", async () => {
    const ghostUserId = new mongoose.Types.ObjectId();
    const token = signTestToken(ghostUserId.toString());

    const res = await fetch(`${baseUrl}/api/subscriptions/checkout`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
    });

    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.match(body.message, /not found/i);
    assert.equal(capturedCheckoutArgs, null);
  });

  test("4. User with already-active Pro plan in User document is rejected with 409", async () => {
    const userId = new mongoose.Types.ObjectId();
    createdUserIds.push(userId);

    await User.create({
      _id: userId,
      email: `pro_user_doc_${Date.now()}@example.com`,
      passwordHash: "hashed_dummy_password",
      name: "Pro User",
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
    });

    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.match(body.message, /already has an active Pro subscription/i);
    assert.equal(capturedCheckoutArgs, null);
  });

  test("5. User with active Pro subscription in Subscription collection is rejected with 409", async () => {
    const userId = new mongoose.Types.ObjectId();
    createdUserIds.push(userId);

    await User.create({
      _id: userId,
      email: `pro_sub_doc_${Date.now()}@example.com`,
      passwordHash: "hashed_dummy_password",
      name: "ProSub User",
      role: "user",
      plan: "free", // Even if User.plan says free, active subscription document guards it
      isActive: true,
    });

    await Subscription.create({
      userId,
      plan: "pro",
      status: SUBSCRIPTION_STATUS.ACTIVE,
      provider: SUBSCRIPTION_PROVIDER.POLAR,
      providerSubscriptionId: "sub_existing_polar_pro",
      providerProductId: process.env.POLAR_PRO_PRODUCT_ID || "cd17ed50-da7e-46ee-8bd6-74cd4e597a1b",
      price: 6,
      currency: "USD",
      tokensPerPeriod: 100000,
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(Date.now() + 30 * 24 * 3600 * 1000),
      cancelAtPeriodEnd: false,
    });

    const token = signTestToken(userId.toString());
    const res = await fetch(`${baseUrl}/api/subscriptions/checkout`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
    });

    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.match(body.message, /already has an active Pro subscription/i);
    assert.equal(capturedCheckoutArgs, null);
  });

  test("6. Authenticated free active user successfully creates Polar Checkout Session with correct product and customer parameters", async () => {
    const userId = new mongoose.Types.ObjectId();
    createdUserIds.push(userId);
    const userEmail = `checkout_test_${Date.now()}@example.com`;

    await User.create({
      _id: userId,
      email: userEmail,
      passwordHash: "hashed_dummy_password",
      name: "Checkout Success",
      role: "user",
      plan: "free",
      isActive: true,
    });

    await TokenWallet.create({
      userId,
      balance: 10000,
      totalAllocated: 10000,
      totalUsed: 0,
    });

    const token = signTestToken(userId.toString());
    const res = await fetch(`${baseUrl}/api/subscriptions/checkout`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(
      body.data.checkoutUrl,
      "https://sandbox-api.polar.sh/checkout/checkout_polar_mock_abc123"
    );
    assert.equal(body.data.id, "checkout_polar_mock_abc123");

    // Check secrets are NEVER exposed in response
    const stringifiedBody = JSON.stringify(body);
    if (process.env.POLAR_ACCESS_TOKEN) {
      assert.equal(stringifiedBody.includes(process.env.POLAR_ACCESS_TOKEN), false);
    }
    if (process.env.POLAR_WEBHOOK_SECRET) {
      assert.equal(stringifiedBody.includes(process.env.POLAR_WEBHOOK_SECRET), false);
    }

    // Verify Polar SDK call arguments
    assert.notEqual(capturedCheckoutArgs, null);
    const expectedProductId =
      process.env.POLAR_PRO_PRODUCT_ID || "cd17ed50-da7e-46ee-8bd6-74cd4e597a1b";
    assert.deepEqual(capturedCheckoutArgs.products, [expectedProductId]);
    assert.equal(capturedCheckoutArgs.externalCustomerId, userId.toString());
    assert.equal(capturedCheckoutArgs.customerEmail, userEmail);
    assert.deepEqual(capturedCheckoutArgs.metadata, { userId: userId.toString() });

    // Verify success and return URLs configure FRONTEND_URL
    const frontendUrl = process.env.FRONTEND_URL || "http://localhost:5173";
    const expectedBaseUrl =
      frontendUrl.startsWith("http://") || frontendUrl.startsWith("https://")
        ? frontendUrl
        : `https://${frontendUrl}`;
    assert.equal(
      capturedCheckoutArgs.successUrl,
      `${expectedBaseUrl}/app?checkout=success&checkout_id={CHECKOUT_ID}`
    );
    assert.equal(capturedCheckoutArgs.returnUrl, `${expectedBaseUrl}/app`);
  });


  test("7. Checkout creation strictly enforces req.user.userId and ignores any userId passed in body/query", async () => {
    const realUserId = new mongoose.Types.ObjectId();
    const spoofedUserId = new mongoose.Types.ObjectId();
    createdUserIds.push(realUserId);

    await User.create({
      _id: realUserId,
      email: `real_user_${Date.now()}@example.com`,
      passwordHash: "hashed_dummy_password",
      name: "Real User",
      role: "user",
      plan: "free",
      isActive: true,
    });

    const token = signTestToken(realUserId.toString());
    const res = await fetch(
      `${baseUrl}/api/subscriptions/checkout?userId=${spoofedUserId.toString()}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ userId: spoofedUserId.toString() }),
      }
    );

    assert.equal(res.status, 200);
    // Polar request must receive real authenticated userId, NOT the spoofed one
    assert.equal(capturedCheckoutArgs.externalCustomerId, realUserId.toString());
    assert.equal(capturedCheckoutArgs.metadata.userId, realUserId.toString());
    assert.notEqual(capturedCheckoutArgs.externalCustomerId, spoofedUserId.toString());
  });

  test("8. Checkout creation does NOT activate Pro and does NOT modify TokenWallet", async () => {
    const userId = new mongoose.Types.ObjectId();
    createdUserIds.push(userId);

    await User.create({
      _id: userId,
      email: `safety_test_${Date.now()}@example.com`,
      passwordHash: "hashed_dummy_password",
      name: "Safety Check",
      role: "user",
      plan: "free",
      isActive: true,
    });

    const initialWallet = await TokenWallet.create({
      userId,
      balance: 10000,
      totalAllocated: 10000,
      totalUsed: 0,
    });

    const token = signTestToken(userId.toString());
    const res = await fetch(`${baseUrl}/api/subscriptions/checkout`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
    });

    assert.equal(res.status, 200);

    // Verify User has NOT been upgraded to pro
    const userInDb = await User.findById(userId);
    assert.equal(userInDb?.plan, "free");

    // Verify TokenWallet has NOT been modified or allocated tokens
    const walletInDb = await TokenWallet.findOne({ userId });
    assert.equal(walletInDb?.balance, initialWallet.balance);
    assert.equal(walletInDb?.totalAllocated, initialWallet.totalAllocated);
    assert.equal(walletInDb?.totalUsed, initialWallet.totalUsed);

    // Verify no Pro subscription was created
    const subInDb = await Subscription.findOne({ userId, plan: "pro" });
    assert.equal(subInDb, null);
  });
});

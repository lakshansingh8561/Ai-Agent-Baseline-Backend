import "dotenv/config";
import test, { describe, before, after } from "node:test";
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
  getUserSubscription,
} from "../src/features/subscription/index.js";
import { register } from "../src/features/auth/auth.service.js";

describe("Subscription Foundation & Plan Configuration Test Suite (Phase 7A)", () => {
  let server: Server;
  let baseUrl: string;
  const createdUserIds: mongoose.Types.ObjectId[] = [];

  const signTestToken = (userId: string, role: "user" | "admin" = "user") => {
    const secret = process.env.JWT_SECRET || "1ff6e690959aeaeb72e6db045b982cfa3a020e76e67905427ee1dc2bbabf343f";
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

  after(async () => {
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

  test("1. Free plan configuration matches exact product specification", () => {
    const free = SUBSCRIPTION_PLANS.free;
    assert.equal(free.price, 0);
    assert.equal(free.currency, "USD");
    assert.equal(free.tokensPerPeriod, 10000);
    assert.equal(free.billingInterval, "none");
    assert.equal(free.plan, "free");
  });

  test("2. Pro plan configuration matches exact product specification", () => {
    const pro = SUBSCRIPTION_PLANS.pro;
    assert.equal(pro.price, 6);
    assert.equal(pro.currency, "USD");
    assert.equal(pro.tokensPerPeriod, 100000);
    assert.equal(pro.billingInterval, "month");
    assert.equal(pro.plan, "pro");
  });

  test("3. Unauthenticated request to GET /api/subscriptions/me returns 401", async () => {
    const res = await fetch(`${baseUrl}/api/subscriptions/me`, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
    });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.success, false);
  });

  test("4. Invalid authorization token returns 401", async () => {
    const res = await fetch(`${baseUrl}/api/subscriptions/me`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer invalid.token.value",
      },
    });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.success, false);
  });

  test("5. Authenticated user receives their subscription via GET /api/subscriptions/me", async () => {
    const userId = new mongoose.Types.ObjectId();
    createdUserIds.push(userId);

    await User.create({
      _id: userId,
      name: "Sub Test User",
      email: `sub_test_${Date.now()}@example.com`,
      passwordHash: "hashed",
      role: "user",
      plan: "free",
      isActive: true,
    });

    await Subscription.create({
      userId,
      plan: "free",
      status: "active",
      provider: "none",
      price: SUBSCRIPTION_PLANS.free.price,
      currency: SUBSCRIPTION_PLANS.free.currency,
      tokensPerPeriod: SUBSCRIPTION_PLANS.free.tokensPerPeriod,
      currentPeriodStart: new Date(),
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
    });

    const token = signTestToken(userId.toString());
    const res = await fetch(`${baseUrl}/api/subscriptions/me`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.data.userId, userId.toString());
    assert.equal(body.data.plan, "free");
    assert.equal(body.data.price, 0);
    assert.equal(body.data.currency, "USD");
    assert.equal(body.data.tokensPerPeriod, 10000);
    assert.equal(body.data.billingInterval, "none");
    assert.equal(body.data.status, "active");
  });

  test("6. User cannot retrieve another user's subscription (strictly derives ID from JWT)", async () => {
    const userA = new mongoose.Types.ObjectId();
    const userB = new mongoose.Types.ObjectId();
    createdUserIds.push(userA, userB);

    await User.create([
      {
        _id: userA,
        name: "User A",
        email: `usera_${Date.now()}@example.com`,
        passwordHash: "hashed",
        role: "user",
        plan: "free",
        isActive: true,
      },
      {
        _id: userB,
        name: "User B",
        email: `userb_${Date.now()}@example.com`,
        passwordHash: "hashed",
        role: "user",
        plan: "pro",
        isActive: true,
      },
    ]);

    await Subscription.create([
      {
        userId: userA,
        plan: "free",
        status: "active",
        provider: "none",
        price: 0,
        currency: "USD",
        tokensPerPeriod: 10000,
        currentPeriodStart: new Date(),
        cancelAtPeriodEnd: false,
      },
      {
        userId: userB,
        plan: "pro",
        status: "active",
        provider: "none",
        price: 6,
        currency: "USD",
        tokensPerPeriod: 100000,
        currentPeriodStart: new Date(),
        cancelAtPeriodEnd: false,
      },
    ]);

    const tokenA = signTestToken(userA.toString());

    // User A attempts to request User B's subscription via query param or body
    const res = await fetch(`${baseUrl}/api/subscriptions/me?userId=${userB.toString()}`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenA}`,
      },
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.userId, userA.toString());
    assert.equal(body.data.plan, "free");
    assert.notEqual(body.data.userId, userB.toString());
  });

  test("7. Existing user with no Subscription document safely resolves to free without creating DB records", async () => {
    const existingUserId = new mongoose.Types.ObjectId();
    createdUserIds.push(existingUserId);

    await User.create({
      _id: existingUserId,
      name: "Existing Legacy User",
      email: `legacy_${Date.now()}@example.com`,
      passwordHash: "hashed",
      role: "user",
      plan: "free",
      isActive: true,
    });

    // Ensure 0 subscription documents exist prior to request
    const beforeCount = await Subscription.countDocuments({ userId: existingUserId });
    assert.equal(beforeCount, 0);

    const token = signTestToken(existingUserId.toString());

    // Call GET /api/subscriptions/me multiple times
    const res1 = await fetch(`${baseUrl}/api/subscriptions/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res1.status, 200);
    const body1 = await res1.json();
    assert.equal(body1.success, true);
    assert.equal(body1.data.plan, "free");
    assert.equal(body1.data.price, 0);
    assert.equal(body1.data.tokensPerPeriod, 10000);

    const res2 = await fetch(`${baseUrl}/api/subscriptions/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res2.status, 200);

    // CRITICAL: Ensure NO Subscription documents were silently created
    const afterCount = await Subscription.countDocuments({ userId: existingUserId });
    assert.equal(afterCount, 0, "GET request must remain strictly read-only and create 0 records");
  });

  test("8. Registration creates initial free entitlement without double-allocating tokens", async () => {
    const email = `new_reg_${Date.now()}@example.com`;
    const regResult = await register({
      name: "New Registered User",
      email,
      password: "Password123!",
    });

    const newUserId = new mongoose.Types.ObjectId(regResult.user.id);
    createdUserIds.push(newUserId);

    // Verify token wallet has exactly 10,000 tokens allocated and available
    const wallet = await TokenWallet.findOne({ userId: newUserId });
    assert(wallet !== null);
    assert.equal(wallet.balance, 10000);
    assert.equal(wallet.totalAllocated, 10000);
    assert.equal(wallet.reservedTokens, 0);
    assert.equal(wallet.totalUsed, 0);

    // Verify initial subscription document was created atomically
    const sub = await Subscription.findOne({ userId: newUserId });
    assert(sub !== null);
    assert.equal(sub.plan, "free");
    assert.equal(sub.status, "active");
    assert.equal(sub.price, 0);
    assert.equal(sub.tokensPerPeriod, 10000);
    assert.equal(sub.provider, "none");
  });

  test("9. Read API performs zero token allocations or deductions", async () => {
    const userId = new mongoose.Types.ObjectId();
    createdUserIds.push(userId);

    await User.create({
      _id: userId,
      name: "Token Safety User",
      email: `tokensafety_${Date.now()}@example.com`,
      passwordHash: "hashed",
      role: "user",
      plan: "free",
      isActive: true,
    });

    await TokenWallet.create({
      userId,
      balance: 10000,
      totalAllocated: 10000,
      totalUsed: 0,
      reservedTokens: 0,
    });

    const token = signTestToken(userId.toString());

    const walletBefore = await TokenWallet.findOne({ userId }).lean();

    // Call subscription read API
    await fetch(`${baseUrl}/api/subscriptions/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    const walletAfter = await TokenWallet.findOne({ userId }).lean();

    assert.equal(walletAfter?.balance, walletBefore?.balance);
    assert.equal(walletAfter?.totalAllocated, walletBefore?.totalAllocated);
    assert.equal(walletAfter?.totalUsed, walletBefore?.totalUsed);
    assert.equal(walletAfter?.reservedTokens, walletBefore?.reservedTokens);
  });

  test("10. Subscription model validates required fields and enum constraints", async () => {
    const invalidSub = new Subscription({
      userId: new mongoose.Types.ObjectId(),
      plan: "invalid_plan" as any,
      status: "invalid_status" as any,
      provider: "none",
      price: 0,
      tokensPerPeriod: 10000,
    });

    await assert.rejects(async () => {
      await invalidSub.validate();
    }, /is not a valid enum value/);
  });

  test("11. Active Pro subscription in MongoDB is properly returned", async () => {
    const proUserId = new mongoose.Types.ObjectId();
    createdUserIds.push(proUserId);

    await User.create({
      _id: proUserId,
      name: "Pro Member",
      email: `promember_${Date.now()}@example.com`,
      passwordHash: "hashed",
      role: "user",
      plan: "pro",
      isActive: true,
    });

    await Subscription.create({
      userId: proUserId,
      plan: "pro",
      status: "active",
      provider: "none",
      price: SUBSCRIPTION_PLANS.pro.price,
      currency: SUBSCRIPTION_PLANS.pro.currency,
      tokensPerPeriod: SUBSCRIPTION_PLANS.pro.tokensPerPeriod,
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      cancelAtPeriodEnd: false,
    });

    const token = signTestToken(proUserId.toString());
    const res = await fetch(`${baseUrl}/api/subscriptions/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.plan, "pro");
    assert.equal(body.data.price, 6);
    assert.equal(body.data.currency, "USD");
    assert.equal(body.data.tokensPerPeriod, 100000);
    assert.equal(body.data.billingInterval, "month");
  });
});

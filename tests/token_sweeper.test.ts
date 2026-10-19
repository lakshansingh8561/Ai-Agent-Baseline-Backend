import "dotenv/config";
import test, { describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { connectDatabase } from "../src/config/database.js";
import { TokenWallet } from "../src/database/models/tokenWallet/index.js";
import { TokenReservation } from "../src/database/models/tokenReservation/index.js";
import { Conversation } from "../src/database/models/conversation/index.js";
import { Message } from "../src/database/models/message/index.js";
import { IdempotencyKey } from "../src/database/models/idempotencyKey/index.js";
import {
  TokenSweeper,
  startTokenSweeper,
  stopTokenSweeper,
} from "../src/features/token/token.sweeper.js";

describe("Phase 4 — Token Sweeper Batch Poller Test Suite", () => {
  let isDbConnected = false;
  let testUserId: mongoose.Types.ObjectId;
  let testConvId: mongoose.Types.ObjectId;

  before(async () => {
    try {
      await connectDatabase();
      isDbConnected = true;
      testUserId = new mongoose.Types.ObjectId();
      testConvId = new mongoose.Types.ObjectId();
    } catch (err) {
      console.warn("DB connection error:", err);
    }
  });

  after(async () => {
    if (isDbConnected && testUserId) {
      await stopTokenSweeper();
      await TokenReservation.deleteMany({ userId: testUserId });
      await TokenWallet.deleteMany({ userId: testUserId });
      await Message.deleteMany({ userId: testUserId });
      await Conversation.deleteMany({ userId: testUserId });
      await IdempotencyKey.deleteMany({ userId: testUserId });
      await mongoose.disconnect();
    }
  });

  beforeEach(async () => {
    if (isDbConnected && testUserId) {
      await stopTokenSweeper();
      await Conversation.deleteMany({ userId: testUserId });
      await IdempotencyKey.deleteMany({ userId: testUserId });
      await TokenReservation.deleteMany({ userId: testUserId });
      await Message.deleteMany({ userId: testUserId });
      await TokenWallet.deleteMany({ userId: testUserId });

      // Seed conversation
      await Conversation.create({
        _id: testConvId,
        userId: testUserId,
        title: "Sweeper Test Conversation",
        activeGenerationId: null,
        activeLockToken: null,
        lockVersion: 0,
        lockExpiresAt: null,
      });

      // Seed wallet
      await TokenWallet.create({
        userId: testUserId,
        balance: 10000,
        reservedTokens: 0,
        totalPurchased: 10000,
        totalUsed: 0,
      });
    }
  });

  // 1. Expired RESERVED candidate discovery and claiming
  test("1. Sweeper discovers expired RESERVED candidate, claims, and resolves it", async () => {
    const reservedTokens = 2000;
    await TokenWallet.updateOne(
      { userId: testUserId },
      { $set: { balance: 8000, reservedTokens: reservedTokens } }
    );

    const expiredDate = new Date(Date.now() - 5000);
    const reservation = await TokenReservation.create({
      userId: testUserId,
      conversationId: testConvId,
      userMessageId: new mongoose.Types.ObjectId(),
      assistantMessageId: new mongoose.Types.ObjectId(),
      reservedTokens: reservedTokens,
      status: "RESERVED",
      version: 1,
      lockExpiresAt: expiredDate,
    });

    const sweeper = new TokenSweeper({
      batchSize: 10,
      candidateFilter: { userId: testUserId },
    });
    const stats = await sweeper.runSweepOnce();

    assert.strictEqual(stats.discovered, 1);
    assert.strictEqual(stats.claimed, 1);
    assert.strictEqual(stats.resolved, 1);
    assert.strictEqual(stats.errors, 0);

    // Verify reservation transitioned to REFUNDED
    const updatedRes = await TokenReservation.findById(reservation._id);
    assert.strictEqual(updatedRes?.status, "REFUNDED");
    assert.strictEqual(updatedRes?.version, 3); // 1 -> 2 (claimed) -> 3 (resolved)
    assert.strictEqual(updatedRes?.claimOwner, null);

    // Verify wallet was credited
    const wallet = await TokenWallet.findOne({ userId: testUserId });
    assert.strictEqual(wallet?.balance, 10000);
    assert.strictEqual(wallet?.reservedTokens, 0);
  });

  // 2. Expired RECOVERING claim reclamation
  test("2. Sweeper discovers expired RECOVERING claim, reclaims, and resolves it", async () => {
    const reservedTokens = 1500;
    await TokenWallet.updateOne(
      { userId: testUserId },
      { $set: { balance: 8500, reservedTokens: reservedTokens } }
    );

    const expiredDate = new Date(Date.now() - 5000);
    const reservation = await TokenReservation.create({
      userId: testUserId,
      conversationId: testConvId,
      userMessageId: new mongoose.Types.ObjectId(),
      assistantMessageId: new mongoose.Types.ObjectId(),
      reservedTokens: reservedTokens,
      status: "RECOVERING",
      claimOwner: "dead-worker",
      version: 2,
      lockExpiresAt: expiredDate,
      recoveryExpiresAt: expiredDate,
    });

    const sweeper = new TokenSweeper({
      batchSize: 10,
      workerId: "active-sweeper",
      candidateFilter: { userId: testUserId },
    });
    const stats = await sweeper.runSweepOnce();

    assert.strictEqual(stats.discovered, 1);
    assert.strictEqual(stats.claimed, 1);
    assert.strictEqual(stats.resolved, 1);

    const updatedRes = await TokenReservation.findById(reservation._id);
    assert.strictEqual(updatedRes?.status, "REFUNDED");
    assert.strictEqual(updatedRes?.version, 4); // 2 -> 3 (reclaimed) -> 4 (resolved)

    const wallet = await TokenWallet.findOne({ userId: testUserId });
    assert.strictEqual(wallet?.balance, 10000);
  });

  // 3. Two workers competing for one candidate
  test("3. Two concurrent sweeper workers competing for the same candidate serialize cleanly without double credit", async () => {
    const reservedTokens = 3000;
    await TokenWallet.updateOne(
      { userId: testUserId },
      { $set: { balance: 7000, reservedTokens: reservedTokens } }
    );

    const expiredDate = new Date(Date.now() - 5000);
    const reservation = await TokenReservation.create({
      userId: testUserId,
      conversationId: testConvId,
      userMessageId: new mongoose.Types.ObjectId(),
      assistantMessageId: new mongoose.Types.ObjectId(),
      reservedTokens: reservedTokens,
      status: "RESERVED",
      version: 1,
      lockExpiresAt: expiredDate,
    });

    const sweeperA = new TokenSweeper({
      workerId: "sweeper-A",
      batchSize: 10,
      candidateFilter: { userId: testUserId },
    });
    const sweeperB = new TokenSweeper({
      workerId: "sweeper-B",
      batchSize: 10,
      candidateFilter: { userId: testUserId },
    });

    // Run both sweeps concurrently
    const [statsA, statsB] = await Promise.all([
      sweeperA.runSweepOnce(),
      sweeperB.runSweepOnce(),
    ]);

    const totalClaimed = statsA.claimed + statsB.claimed;
    const totalResolved = statsA.resolved + statsB.resolved;
    const totalSkipped = statsA.skipped + statsB.skipped;

    assert.strictEqual(totalClaimed, 1, "Exactly one sweeper must successfully claim the candidate");
    assert.strictEqual(totalResolved, 1, "Exactly one resolution must commit");
    assert.strictEqual(totalSkipped, 1, "The loser must cleanly skip without error");

    // Wallet balance restored exactly once (not 13000!)
    const wallet = await TokenWallet.findOne({ userId: testUserId });
    assert.strictEqual(wallet?.balance, 10000);
    assert.strictEqual(wallet?.reservedTokens, 0);
  });

  // 4. Bounded batches and pagination / repeat polling
  test("4. Sweeper bounds batch processing to configured batchSize and resolves remaining on next sweep", async () => {
    const expiredDate = new Date(Date.now() - 5000);

    // Create 5 expired reservations, 1000 tokens each
    await TokenWallet.updateOne(
      { userId: testUserId },
      { $set: { balance: 5000, reservedTokens: 5000 } }
    );

    for (let i = 0; i < 5; i++) {
      await TokenReservation.create({
        userId: testUserId,
        conversationId: testConvId,
        userMessageId: new mongoose.Types.ObjectId(),
        assistantMessageId: new mongoose.Types.ObjectId(),
        reservedTokens: 1000,
        status: "RESERVED",
        version: 1,
        lockExpiresAt: expiredDate,
      });
    }

    // Configure sweeper with batchSize of 2
    const sweeper = new TokenSweeper({
      batchSize: 2,
      candidateFilter: { userId: testUserId },
    });

    // Pass 1: should process exactly 2
    const pass1 = await sweeper.runSweepOnce();
    assert.strictEqual(pass1.discovered, 2);
    assert.strictEqual(pass1.resolved, 2);

    // Pass 2: should process next 2
    const pass2 = await sweeper.runSweepOnce();
    assert.strictEqual(pass2.discovered, 2);
    assert.strictEqual(pass2.resolved, 2);

    // Pass 3: should process remaining 1
    const pass3 = await sweeper.runSweepOnce();
    assert.strictEqual(pass3.discovered, 1);
    assert.strictEqual(pass3.resolved, 1);

    // Pass 4: no more expired
    const pass4 = await sweeper.runSweepOnce();
    assert.strictEqual(pass4.discovered, 0);

    const wallet = await TokenWallet.findOne({ userId: testUserId });
    assert.strictEqual(wallet?.balance, 10000);
    assert.strictEqual(wallet?.reservedTokens, 0);
  });

  // 5. One candidate failure does not stop the remaining batch
  test("5. A corrupted candidate failure does not abort remaining candidates in the batch", async () => {
    const expiredDate = new Date(Date.now() - 5000);

    // Candidate 1: Valid
    const resValid1 = await TokenReservation.create({
      userId: testUserId,
      conversationId: testConvId,
      userMessageId: new mongoose.Types.ObjectId(),
      assistantMessageId: new mongoose.Types.ObjectId(),
      reservedTokens: 1000,
      status: "RESERVED",
      version: 1,
      lockExpiresAt: expiredDate,
    });

    // Candidate 2: Corrupted (hold deficit: wallet only has 2000 total reservedTokens, but this reservation asks for 99999)
    const resCorrupted = await TokenReservation.create({
      userId: testUserId,
      conversationId: testConvId,
      userMessageId: new mongoose.Types.ObjectId(),
      assistantMessageId: new mongoose.Types.ObjectId(),
      reservedTokens: 99999, // Impossible hold amount
      status: "RESERVED",
      version: 1,
      lockExpiresAt: expiredDate,
    });

    // Candidate 3: Valid
    const resValid2 = await TokenReservation.create({
      userId: testUserId,
      conversationId: testConvId,
      userMessageId: new mongoose.Types.ObjectId(),
      assistantMessageId: new mongoose.Types.ObjectId(),
      reservedTokens: 1000,
      status: "RESERVED",
      version: 1,
      lockExpiresAt: expiredDate,
    });

    await TokenWallet.updateOne(
      { userId: testUserId },
      { $set: { balance: 8000, reservedTokens: 2000 } }
    );

    const sweeper = new TokenSweeper({
      batchSize: 10,
      candidateFilter: { userId: testUserId },
    });
    const stats = await sweeper.runSweepOnce();

    assert.strictEqual(stats.discovered, 3);
    assert.strictEqual(stats.claimed, 3);
    assert.strictEqual(stats.resolved, 2, "The 2 valid reservations must resolve successfully");
    // The corrupted reservation was quarantined due to hold deficit
    assert.strictEqual(stats.quarantined, 1, "The corrupted reservation must be quarantined");

    // Verify valid 1 and valid 2 are REFUNDED
    const doc1 = await TokenReservation.findById(resValid1._id);
    const doc3 = await TokenReservation.findById(resValid2._id);
    assert.strictEqual(doc1?.status, "REFUNDED");
    assert.strictEqual(doc3?.status, "REFUNDED");

    // Verify corrupted is QUARANTINED
    const doc2 = await TokenReservation.findById(resCorrupted._id);
    assert.strictEqual(doc2?.status, "QUARANTINED");
  });

  // 6. Overlapping runs within one process being prevented
  test("6. Overlapping runs within one process are skipped gracefully", async () => {
    const sweeper = new TokenSweeper({
      batchSize: 10,
      candidateFilter: { userId: testUserId },
    });

    // Start a sweep and immediately invoke another while the first is in flight
    const promise1 = sweeper.runSweepOnce();
    const promise2 = sweeper.runSweepOnce();

    const [res1, res2] = await Promise.all([promise1, promise2]);

    assert.strictEqual(
      res2.skippedDueToOverlap,
      true,
      "Second simultaneous sweep must detect in-flight sweep and skip immediately"
    );
    assert.strictEqual(res2.discovered, 0);
  });

  // 7. Unresolved commit outcomes never cause direct wallet credits
  test("7. Unresolved commit outcomes never cause direct wallet credits from sweeper", async () => {
    // Wallet hold deficit ensures transaction cannot commit
    await TokenWallet.updateOne(
      { userId: testUserId },
      { $set: { balance: 5000, reservedTokens: 0 } }
    );

    const expiredDate = new Date(Date.now() - 5000);
    const reservation = await TokenReservation.create({
      userId: testUserId,
      conversationId: testConvId,
      userMessageId: new mongoose.Types.ObjectId(),
      assistantMessageId: new mongoose.Types.ObjectId(),
      reservedTokens: 2500,
      status: "RESERVED",
      version: 1,
      lockExpiresAt: expiredDate,
    });

    const sweeper = new TokenSweeper({
      batchSize: 10,
      candidateFilter: { userId: testUserId },
    });
    const stats = await sweeper.runSweepOnce();

    // The sweeper must NOT directly increment wallet balance!
    const wallet = await TokenWallet.findOne({ userId: testUserId });
    assert.strictEqual(wallet?.balance, 5000, "Wallet balance must remain strictly unchanged");
    assert.strictEqual(wallet?.reservedTokens, 0);

    // Reservation must be safely quarantined
    const resDoc = await TokenReservation.findById(reservation._id);
    assert.strictEqual(resDoc?.status, "QUARANTINED");
  });

  // 8. Startup, shutdown, and timer cleanup
  test("8. Sweeper startup and stopTokenSweeper clean up timers and await in-flight work", async () => {
    const sweeper = startTokenSweeper({
      intervalMs: 100, // fast interval for test
      runImmediately: false,
    });

    assert.strictEqual(sweeper.isScheduled, true);

    // Stop the sweeper
    await stopTokenSweeper();

    assert.strictEqual(sweeper.isScheduled, false);
    assert.strictEqual(sweeper.isRunning, false);
  });
});

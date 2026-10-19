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
  claimExpiredReservation,
  resolveRecoveringReservation,
  quarantineTokenReservation,
  reconcileAmbiguousCommit,
} from "../src/features/token/token.recovery.js";
import {
  ReservationStateConflictError,
  TokenInvariantViolationError,
} from "../src/features/token/token.errors.js";

describe("Phase 4 — Recovery Primitives Test Suite", () => {
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
      await Conversation.deleteMany({ userId: testUserId });
      await IdempotencyKey.deleteMany({ userId: testUserId });
      await TokenReservation.deleteMany({ userId: testUserId });
      await Message.deleteMany({ userId: testUserId });
      await TokenWallet.deleteMany({ userId: testUserId });

      // Seed standard conversation
      await Conversation.create({
        _id: testConvId,
        userId: testUserId,
        title: "Phase 4 Recovery Test",
        activeGenerationId: null,
        activeLockToken: null,
        lockVersion: 0,
        lockExpiresAt: null,
      });

      // Seed standard token wallet
      await TokenWallet.create({
        userId: testUserId,
        balance: 10000,
        reservedTokens: 0,
        totalPurchased: 10000,
        totalUsed: 0,
      });
    }
  });

  // 1. Concurrent claim race
  test("1. Two workers concurrently attempting to claim the same expired reservation: exactly one succeeds", async () => {
    const expiredDate = new Date(Date.now() - 5000);
    const reservation = await TokenReservation.create({
      userId: testUserId,
      conversationId: testConvId,
      userMessageId: new mongoose.Types.ObjectId(),
      assistantMessageId: new mongoose.Types.ObjectId(),
      reservedTokens: 2000,
      status: "RESERVED",
      version: 1,
      lockExpiresAt: expiredDate,
    });

    const [claimA, claimB] = await Promise.all([
      claimExpiredReservation({
        reservationId: reservation._id,
        workerId: "worker-A",
      }),
      claimExpiredReservation({
        reservationId: reservation._id,
        workerId: "worker-B",
      }),
    ]);

    const winnerCount = (claimA ? 1 : 0) + (claimB ? 1 : 0);
    assert.strictEqual(winnerCount, 1, "Exactly one worker must acquire the claim");

    const winner = claimA || claimB;
    assert.ok(winner);
    assert.strictEqual(winner.status, "RECOVERING");
    assert.strictEqual(winner.version, 2, "Version must monotonically increment to 2");
    assert.ok(winner.recoveryExpiresAt, "recoveryExpiresAt must be populated");
  });

  // 2. Stale claim owner attempting resolution or quarantine after reclamation
  test("2. Stale claim owner attempting to resolve or quarantine after reclamation is rejected", async () => {
    const expiredRecoveryDate = new Date(Date.now() - 1000);
    const reservation = await TokenReservation.create({
      userId: testUserId,
      conversationId: testConvId,
      userMessageId: new mongoose.Types.ObjectId(),
      assistantMessageId: new mongoose.Types.ObjectId(),
      reservedTokens: 1500,
      status: "RECOVERING",
      claimOwner: "worker-A",
      version: 2,
      lockExpiresAt: expiredRecoveryDate,
      recoveryExpiresAt: expiredRecoveryDate,
    });

    // Worker B reclaims the expired claim
    const reclaimedByB = await claimExpiredReservation({
      reservationId: reservation._id,
      workerId: "worker-B",
    });
    assert.ok(reclaimedByB);
    assert.strictEqual(reclaimedByB.version, 3);
    assert.strictEqual(reclaimedByB.claimOwner, "worker-B");

    // Worker A (stale) tries to resolve with old version V=2 and old owner 'worker-A'
    await assert.rejects(
      async () => {
        await resolveRecoveringReservation({
          reservationId: reservation._id,
          workerId: "worker-A",
          expectedVersion: 2,
        });
      },
      ReservationStateConflictError,
      "Stale worker resolve attempt must be rejected with ReservationStateConflictError"
    );

    // Worker A (stale) tries to quarantine
    const quarantineResult = await quarantineTokenReservation({
      reservationId: reservation._id,
      workerId: "worker-A",
      expectedVersion: 2,
      reason: "Stale worker quarantine attempt",
    });
    assert.strictEqual(quarantineResult, null, "Stale worker quarantine must return null (zero matches)");

    // Verify reservation is still owned by Worker B at version 3
    const currentDoc = await TokenReservation.findById(reservation._id);
    assert.strictEqual(currentDoc?.claimOwner, "worker-B");
    assert.strictEqual(currentDoc?.version, 3);
    assert.strictEqual(currentDoc?.status, "RECOVERING");
  });

  // 3. Successful atomic refund
  test("3. Successful atomic refund restores wallet balance and finalizes reservation", async () => {
    const assistantMessageId = new mongoose.Types.ObjectId();
    const reservedTokens = 3000;

    // Set hold in wallet
    await TokenWallet.updateOne(
      { userId: testUserId },
      { $set: { balance: 7000, reservedTokens: reservedTokens } }
    );

    // Create reservation in RECOVERING state
    const reservation = await TokenReservation.create({
      userId: testUserId,
      conversationId: testConvId,
      userMessageId: new mongoose.Types.ObjectId(),
      assistantMessageId: assistantMessageId,
      reservedTokens: reservedTokens,
      status: "RECOVERING",
      claimOwner: "worker-A",
      version: 2,
      lockExpiresAt: new Date(Date.now() - 5000),
      recoveryExpiresAt: new Date(Date.now() + 60000),
    });

    // Create assistant placeholder
    await Message.create({
      _id: assistantMessageId,
      conversationId: testConvId,
      userId: testUserId,
      role: "assistant",
      content: "",
      status: "generating",
    });

    // Create in-progress idempotency key
    await IdempotencyKey.create({
      userId: testUserId,
      key: "test-idemp-key-1",
      conversationId: testConvId,
      reservationId: reservation._id,
      assistantMessageId: assistantMessageId,
      status: "IN_PROGRESS",
      expiresAt: new Date(Date.now() + 600000),
    });

    // Execute atomic recovery resolution
    const result = await resolveRecoveringReservation({
      reservationId: reservation._id,
      workerId: "worker-A",
      expectedVersion: 2,
      reason: "Test successful refund",
    });

    assert.ok(result);
    assert.strictEqual(result.refundedAmount, reservedTokens);
    assert.strictEqual(result.reservation.status, "REFUNDED");
    assert.strictEqual(result.reservation.version, 3);
    assert.strictEqual(result.reservation.claimOwner, null);
    assert.strictEqual(result.messageUpdated, true);
    assert.strictEqual(result.idempotencyUpdated, true);

    // Verify wallet: balance restored from 7000 back to 10000, hold decremented to 0
    const wallet = await TokenWallet.findOne({ userId: testUserId });
    assert.strictEqual(wallet?.balance, 10000);
    assert.strictEqual(wallet?.reservedTokens, 0);

    // Verify message status
    const message = await Message.findById(assistantMessageId);
    assert.strictEqual(message?.status, "failed");

    // Verify idempotency status
    const idemp = await IdempotencyKey.findOne({ reservationId: reservation._id });
    assert.strictEqual(idemp?.status, "FAILED");
  });

  // 4. Wallet hold deficit aborting the refund transaction
  test("4. Wallet hold deficit aborts the entire refund transaction without state changes", async () => {
    // Wallet has only 1000 reservedTokens, but reservation requires 2500
    await TokenWallet.updateOne(
      { userId: testUserId },
      { $set: { balance: 5000, reservedTokens: 1000 } }
    );

    const reservation = await TokenReservation.create({
      userId: testUserId,
      conversationId: testConvId,
      userMessageId: new mongoose.Types.ObjectId(),
      assistantMessageId: new mongoose.Types.ObjectId(),
      reservedTokens: 2500,
      status: "RECOVERING",
      claimOwner: "worker-A",
      version: 2,
      lockExpiresAt: new Date(Date.now() - 5000),
      recoveryExpiresAt: new Date(Date.now() + 60000),
    });

    await assert.rejects(
      async () => {
        await resolveRecoveringReservation({
          reservationId: reservation._id,
          workerId: "worker-A",
          expectedVersion: 2,
        });
      },
      TokenInvariantViolationError,
      "Wallet hold deficit must throw TokenInvariantViolationError and abort transaction"
    );

    // Verify TokenReservation state was rolled back
    const unchangedReservation = await TokenReservation.findById(reservation._id);
    assert.strictEqual(unchangedReservation?.status, "RECOVERING");
    assert.strictEqual(unchangedReservation?.version, 2);

    // Verify TokenWallet state was untouched
    const unchangedWallet = await TokenWallet.findOne({ userId: testUserId });
    assert.strictEqual(unchangedWallet?.balance, 5000);
    assert.strictEqual(unchangedWallet?.reservedTokens, 1000);
  });

  // 5. Failed reservation CAS producing no wallet credit
  test("5. Failed reservation CAS produces zero wallet credit", async () => {
    await TokenWallet.updateOne(
      { userId: testUserId },
      { $set: { balance: 5000, reservedTokens: 2000 } }
    );

    const reservation = await TokenReservation.create({
      userId: testUserId,
      conversationId: testConvId,
      userMessageId: new mongoose.Types.ObjectId(),
      assistantMessageId: new mongoose.Types.ObjectId(),
      reservedTokens: 2000,
      status: "RECOVERING",
      claimOwner: "worker-A",
      version: 5, // actual version is 5
      lockExpiresAt: new Date(Date.now() - 5000),
      recoveryExpiresAt: new Date(Date.now() + 60000),
    });

    // Provide incorrect expectedVersion (4 instead of 5)
    await assert.rejects(
      async () => {
        await resolveRecoveringReservation({
          reservationId: reservation._id,
          workerId: "worker-A",
          expectedVersion: 4,
        });
      },
      ReservationStateConflictError,
      "CAS version mismatch must reject with ReservationStateConflictError"
    );

    // Wallet balance must NOT be credited
    const wallet = await TokenWallet.findOne({ userId: testUserId });
    assert.strictEqual(wallet?.balance, 5000);
    assert.strictEqual(wallet?.reservedTokens, 2000);
  });

  // 6. Expired Generation A lock not clearing Generation B's lock
  test("6. Expired Generation A lock recovery does NOT clear Generation B's active lock", async () => {
    const genAAssistantId = new mongoose.Types.ObjectId();
    const genBAssistantId = new mongoose.Types.ObjectId();
    const genBLockToken = "token-gen-b";

    // Conversation is currently locked by Generation B
    await Conversation.updateOne(
      { _id: testConvId },
      {
        $set: {
          activeGenerationId: genBAssistantId,
          activeLockToken: genBLockToken,
          lockVersion: 3,
          lockExpiresAt: new Date(Date.now() + 100000), // unexpired
        },
      }
    );

    await TokenWallet.updateOne(
      { userId: testUserId },
      { $set: { balance: 8000, reservedTokens: 2000 } }
    );

    // Reservation belongs to Generation A
    const reservationA = await TokenReservation.create({
      userId: testUserId,
      conversationId: testConvId,
      userMessageId: new mongoose.Types.ObjectId(),
      assistantMessageId: genAAssistantId,
      reservedTokens: 2000,
      status: "RECOVERING",
      claimOwner: "worker-A",
      version: 2,
      lockExpiresAt: new Date(Date.now() - 10000),
      recoveryExpiresAt: new Date(Date.now() + 60000),
    });

    const result = await resolveRecoveringReservation({
      reservationId: reservationA._id,
      workerId: "worker-A",
      expectedVersion: 2,
    });

    assert.strictEqual(result.lockReleased, false, "Must not release Generation B's lock");

    // Conversation lock must remain held by Generation B
    const conv = await Conversation.findById(testConvId);
    assert.strictEqual(
      conv?.activeGenerationId?.toString(),
      genBAssistantId.toString(),
      "Generation B's activeGenerationId must be preserved"
    );
    assert.strictEqual(conv?.activeLockToken, genBLockToken);
  });

  // 7. Still-valid conversation lock remaining untouched
  test("7. Still-valid conversation lock for Generation A remains untouched during resolution", async () => {
    const genAAssistantId = new mongoose.Types.ObjectId();
    const futureLockExpiry = new Date(Date.now() + 90000); // lock still valid for 90s

    await Conversation.updateOne(
      { _id: testConvId },
      {
        $set: {
          activeGenerationId: genAAssistantId,
          activeLockToken: "token-gen-a",
          lockVersion: 1,
          lockExpiresAt: futureLockExpiry,
        },
      }
    );

    await TokenWallet.updateOne(
      { userId: testUserId },
      { $set: { balance: 8000, reservedTokens: 2000 } }
    );

    const reservationA = await TokenReservation.create({
      userId: testUserId,
      conversationId: testConvId,
      userMessageId: new mongoose.Types.ObjectId(),
      assistantMessageId: genAAssistantId,
      reservedTokens: 2000,
      status: "RECOVERING",
      claimOwner: "worker-A",
      version: 2,
      lockExpiresAt: new Date(Date.now() - 5000),
      recoveryExpiresAt: new Date(Date.now() + 60000),
    });

    const result = await resolveRecoveringReservation({
      reservationId: reservationA._id,
      workerId: "worker-A",
      expectedVersion: 2,
    });

    // Because lockExpiresAt > now, conditional release predicate evaluates to false
    assert.strictEqual(result.lockReleased, false);

    const conv = await Conversation.findById(testConvId);
    assert.strictEqual(
      conv?.activeGenerationId?.toString(),
      genAAssistantId.toString(),
      "Lock must not be prematurely cleared while unexpired"
    );
  });

  // 8. Ambiguous commit reconciliation
  test("8. Ambiguous commit outcome is safely reconciled without blind credit", async () => {
    const reservation = await TokenReservation.create({
      userId: testUserId,
      conversationId: testConvId,
      userMessageId: new mongoose.Types.ObjectId(),
      assistantMessageId: new mongoose.Types.ObjectId(),
      reservedTokens: 1000,
      status: "RECOVERING",
      claimOwner: "worker-A",
      version: 2,
      lockExpiresAt: new Date(Date.now() - 5000),
      recoveryExpiresAt: new Date(Date.now() + 60000),
    });

    // 8a. Case UNRESOLVED_CURRENT_VERSION: Primary still shows RECOVERING with same owner and version
    const recon1 = await reconcileAmbiguousCommit({
      reservationId: reservation._id,
      workerId: "worker-A",
      expectedVersion: 2,
    });
    assert.strictEqual(recon1.status, "UNRESOLVED_CURRENT_VERSION");

    // 8b. Case COMMITTED: Primary shows REFUNDED with incremented version
    await TokenReservation.updateOne(
      { _id: reservation._id },
      { $set: { status: "REFUNDED", version: 3, claimOwner: null } }
    );
    const recon2 = await reconcileAmbiguousCommit({
      reservationId: reservation._id,
      workerId: "worker-A",
      expectedVersion: 2,
    });
    assert.strictEqual(recon2.status, "COMMITTED");

    // 8c. Case STOLEN: Reclaimed by another worker
    await TokenReservation.updateOne(
      { _id: reservation._id },
      { $set: { status: "RECOVERING", version: 4, claimOwner: "worker-B" } }
    );
    const recon3 = await reconcileAmbiguousCommit({
      reservationId: reservation._id,
      workerId: "worker-A",
      expectedVersion: 2,
    });
    assert.strictEqual(recon3.status, "STOLEN");
  });

  // 9. Missing assistant message and idempotency record do not prevent financial refund
  test("9. Missing assistant message and idempotency record do not prevent financial refund", async () => {
    const missingAssistantId = new mongoose.Types.ObjectId(); // Non-existent message
    const reservedTokens = 2500;

    await TokenWallet.updateOne(
      { userId: testUserId },
      { $set: { balance: 7500, reservedTokens: reservedTokens } }
    );

    const reservation = await TokenReservation.create({
      userId: testUserId,
      conversationId: testConvId,
      userMessageId: new mongoose.Types.ObjectId(),
      assistantMessageId: missingAssistantId,
      reservedTokens: reservedTokens,
      status: "RECOVERING",
      claimOwner: "worker-A",
      version: 2,
      lockExpiresAt: new Date(Date.now() - 5000),
      recoveryExpiresAt: new Date(Date.now() + 60000),
    });

    // No Message and no IdempotencyKey seeded for this reservation
    const result = await resolveRecoveringReservation({
      reservationId: reservation._id,
      workerId: "worker-A",
      expectedVersion: 2,
      reason: "Recovery with missing ancillary records",
    });

    assert.ok(result);
    assert.strictEqual(result.refundedAmount, reservedTokens);
    assert.strictEqual(result.messageUpdated, false);
    assert.strictEqual(result.idempotencyUpdated, false);
    assert.strictEqual(result.reservation.status, "REFUNDED");

    // Core financial refund must succeed
    const wallet = await TokenWallet.findOne({ userId: testUserId });
    assert.strictEqual(wallet?.balance, 10000);
    assert.strictEqual(wallet?.reservedTokens, 0);
  });

  // 10. Fenced quarantine with unexpired lease authority
  test("10. Fenced quarantine transitions to QUARANTINED only if worker holds active lease", async () => {
    // 10a. Valid quarantine with active lease
    const reservationValid = await TokenReservation.create({
      userId: testUserId,
      conversationId: testConvId,
      userMessageId: new mongoose.Types.ObjectId(),
      assistantMessageId: new mongoose.Types.ObjectId(),
      reservedTokens: 1000,
      status: "RECOVERING",
      claimOwner: "worker-A",
      version: 2,
      lockExpiresAt: new Date(Date.now() - 5000),
      recoveryExpiresAt: new Date(Date.now() + 60000), // active lease
    });

    const quarantined = await quarantineTokenReservation({
      reservationId: reservationValid._id,
      workerId: "worker-A",
      expectedVersion: 2,
      reason: "Unresolvable commit ambiguity",
    });

    assert.ok(quarantined);
    assert.strictEqual(quarantined.status, "QUARANTINED");
    assert.strictEqual(quarantined.version, 3);
    assert.strictEqual(quarantined.claimOwner, null);
    assert.strictEqual(quarantined.recoveryExpiresAt, null);

    // 10b. Expired lease prevents quarantine
    const reservationExpired = await TokenReservation.create({
      userId: testUserId,
      conversationId: testConvId,
      userMessageId: new mongoose.Types.ObjectId(),
      assistantMessageId: new mongoose.Types.ObjectId(),
      reservedTokens: 1000,
      status: "RECOVERING",
      claimOwner: "worker-A",
      version: 2,
      lockExpiresAt: new Date(Date.now() - 10000),
      recoveryExpiresAt: new Date(Date.now() - 1000), // expired lease
    });

    const failedQuarantine = await quarantineTokenReservation({
      reservationId: reservationExpired._id,
      workerId: "worker-A",
      expectedVersion: 2,
      reason: "Attempt quarantine after lease expired",
    });

    assert.strictEqual(failedQuarantine, null, "Quarantine with expired lease must return null");

    const unchanged = await TokenReservation.findById(reservationExpired._id);
    assert.strictEqual(unchanged?.status, "RECOVERING");
    assert.strictEqual(unchanged?.version, 2);
  });
});

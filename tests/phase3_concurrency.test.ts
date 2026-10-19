import "dotenv/config";
import test, { describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { connectDatabase } from "../src/config/database.js";
import { User } from "../src/database/models/user/index.js";
import { TokenWallet } from "../src/database/models/tokenWallet/index.js";
import { TokenReservation } from "../src/database/models/tokenReservation/index.js";
import { Conversation } from "../src/database/models/conversation/index.js";
import { Message } from "../src/database/models/message/index.js";
import { IdempotencyKey } from "../src/database/models/idempotencyKey/index.js";
import {
  acquireConversationLock,
  fencedReleaseConversationLock,
  releaseConversationLockImmediately,
  CONVERSATION_LOCK_TTL_MS,
} from "../src/features/chat/chat.lock.js";
import {
  computeAttachmentDigest,
  computeRequestHash,
  claimOrCheckIdempotencyKey,
  cleanupOrphanedClaim,
  bindReservationToClaim,
  finalizeSettledClaim,
  finalizeFailedClaim,
} from "../src/features/chat/chat.idempotency.js";
import {
  sendMessage,
  _internalAI,
  ChatError,
  ChatLockConflictError,
  ConversationLockLostError,
  IdempotencyConflictError,
  IdempotencyPayloadMismatchError,
  IdempotencyUnresolvedRecoveryError,
} from "../src/features/chat/index.js";
import {
  createTokenReservation,
  settleTokenReservation,
  refundTokenReservation,
  validateUsageData,
} from "../src/features/token/index.js";
import { PRIMARY_MODEL } from "../src/features/ai/ai.service.js";

describe("Phase 3 — Conversation Concurrency & Request Idempotency Test Suite", () => {
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

      // Seed fresh conversation
      await Conversation.create({
        _id: testConvId,
        userId: testUserId,
        title: "Phase 3 Concurrency Test",
        activeGenerationId: null,
        activeLockToken: null,
        lockVersion: 0,
        lockExpiresAt: null,
      });

      // Seed funded wallet
      await TokenWallet.create({
        userId: testUserId,
        balance: 50000,
        reservedTokens: 0,
        totalPurchased: 50000,
        totalUsed: 0,
      });
    }
  });

  // 1. Atomic lock acquisition
  test("1. Atomic lock acquisition increments lockVersion and sets lease", async () => {
    const assistantMessageId = new mongoose.Types.ObjectId();
    const lock = await acquireConversationLock(
      testConvId,
      testUserId,
      assistantMessageId
    );

    assert.ok(lock.lockToken, "Lock token should be assigned");
    assert.strictEqual(lock.lockVersion, 1, "lockVersion should increment to 1");

    const conv = await Conversation.findById(testConvId);
    assert.ok(conv);
    assert.strictEqual(
      conv.activeGenerationId?.toString(),
      assistantMessageId.toString()
    );
    assert.strictEqual(conv.activeLockToken, lock.lockToken);
    assert.strictEqual(conv.lockVersion, 1);
    assert.ok(conv.lockExpiresAt);
    assert.ok(conv.lockExpiresAt.getTime() > Date.now());

    // Release immediately
    await releaseConversationLockImmediately(
      testConvId,
      lock.lockToken,
      lock.lockVersion
    );
    const releasedConv = await Conversation.findById(testConvId);
    assert.strictEqual(releasedConv?.activeGenerationId, null);
    assert.strictEqual(releasedConv?.activeLockToken, null);
  });

  // 2. Concurrent requests to one conversation
  test("2. Concurrent requests to one conversation: second caller rejected with 409 ChatLockConflictError", async () => {
    const assistantMsg1 = new mongoose.Types.ObjectId();
    const assistantMsg2 = new mongoose.Types.ObjectId();

    // Worker 1 acquires lock
    const lock1 = await acquireConversationLock(
      testConvId,
      testUserId,
      assistantMsg1
    );
    assert.ok(lock1.lockToken);

    // Worker 2 attempts concurrent lock acquisition on same conversation
    await assert.rejects(
      async () => {
        await acquireConversationLock(
          testConvId,
          testUserId,
          assistantMsg2
        );
      },
      (err: any) => {
        assert.ok(
          err instanceof ChatLockConflictError,
          "Should be ChatLockConflictError"
        );
        assert.strictEqual(err.statusCode, 409);
        return true;
      }
    );

    // Verify Worker 1's lock was unaffected
    const conv = await Conversation.findById(testConvId);
    assert.strictEqual(conv?.activeLockToken, lock1.lockToken);
    assert.strictEqual(conv?.lockVersion, 1);
  });

  // 3. Concurrent first-time claims for the same idempotency key
  test("3. Concurrent first-time claims: one succeeds, racer handles E11000 and throws 409 IdempotencyConflictError", async () => {
    const key = "first-time-race-key";
    const requestHash = "hash-123456";

    // Launch two concurrent claims
    const [result1, result2] = await Promise.allSettled([
      claimOrCheckIdempotencyKey(testUserId, key, testConvId, requestHash),
      claimOrCheckIdempotencyKey(testUserId, key, testConvId, requestHash),
    ]);

    const successes = [result1, result2].filter(
      (r) => r.status === "fulfilled"
    );
    const rejections = [result1, result2].filter(
      (r) => r.status === "rejected"
    );

    assert.strictEqual(successes.length, 1, "Exactly one claim should succeed");
    assert.strictEqual(rejections.length, 1, "Exactly one claim should be rejected");

    const winner = (successes[0] as PromiseFulfilledResult<any>).value;
    assert.strictEqual(winner.isReplay, false);
    assert.ok(winner.claimToken);

    const loserErr = (rejections[0] as PromiseRejectedResult).reason;
    assert.ok(
      loserErr instanceof IdempotencyConflictError,
      "Racer should catch E11000 and throw IdempotencyConflictError"
    );
    assert.strictEqual(loserErr.statusCode, 409);

    // Only 1 document exists in MongoDB
    const count = await IdempotencyKey.countDocuments({
      userId: testUserId,
      key,
    });
    assert.strictEqual(count, 1);
  });

  // 4. Claim ownership and cleanup races
  test("4. Claim ownership and cleanup: foreign claimToken cannot delete an active claim", async () => {
    const key = "cleanup-ownership-key";
    const requestHash = "hash-cleanup-456";

    const claim = await claimOrCheckIdempotencyKey(
      testUserId,
      key,
      testConvId,
      requestHash
    );
    assert.strictEqual(claim.isReplay, false);
    const legitimateToken = (claim as any).claimToken;

    // Stale/foreign worker attempts to clean up with invalid claimToken
    await cleanupOrphanedClaim(testUserId, key, "stale-foreign-token-xyz");

    // Verify claim is still present and intact
    let doc = await IdempotencyKey.findOne({ userId: testUserId, key });
    assert.ok(doc, "Claim must not be deleted by foreign claimToken");
    assert.strictEqual(doc?.claimToken, legitimateToken);

    // Legitimate worker cleans up
    await cleanupOrphanedClaim(testUserId, key, legitimateToken);
    doc = await IdempotencyKey.findOne({ userId: testUserId, key });
    assert.strictEqual(doc, null, "Claim should be deleted by legitimate token");
  });

  // 5. Expired-but-not-deleted key reclamation
  test("5. Expired-but-not-deleted key reclamation: safe in-place CAS reclamation", async () => {
    const key = "expired-reclamation-key";
    const oldRequestHash = "old-hash-789";

    // Seed expired SETTLED record (TTL monitor has not yet swept it)
    await IdempotencyKey.create({
      userId: testUserId,
      key,
      conversationId: testConvId,
      claimToken: "old-token-expired",
      requestHash: oldRequestHash,
      status: "SETTLED",
      statusCode: 201,
      responsePayload: { old: "data" },
      expiresAt: new Date(Date.now() - 5000), // Expired 5 seconds ago
    });

    const newRequestHash = "new-request-hash-999";
    const reclaimed = await claimOrCheckIdempotencyKey(
      testUserId,
      key,
      testConvId,
      newRequestHash
    );

    assert.strictEqual(reclaimed.isReplay, false);
    assert.ok(
      (reclaimed as any).claimToken !== "old-token-expired",
      "Should generate a fresh claimToken"
    );

    const updatedDoc = await IdempotencyKey.findOne({
      userId: testUserId,
      key,
    });
    assert.ok(updatedDoc);
    assert.strictEqual(updatedDoc.status, "IN_PROGRESS");
    assert.strictEqual(updatedDoc.requestHash, newRequestHash);
    assert.ok(updatedDoc.expiresAt.getTime() > Date.now());
  });

  // 6. Blocking reclamation when a reservation remains unresolved
  test("6. Blocking reclamation when reservation remains unresolved (blocked for Phase 4 sweeper)", async () => {
    const key = "unresolved-res-key";
    const unresolvedReservationId = new mongoose.Types.ObjectId();

    // Seed expired IN_PROGRESS record with an un-cleared reservationId
    await IdempotencyKey.create({
      userId: testUserId,
      key,
      conversationId: testConvId,
      claimToken: "unresolved-worker-token",
      requestHash: "hash-unresolved",
      status: "IN_PROGRESS",
      statusCode: 201,
      reservationId: unresolvedReservationId,
      assistantMessageId: new mongoose.Types.ObjectId(),
      expiresAt: new Date(Date.now() - 5000), // Expired
    });

    // Attempting reclamation must be blocked!
    await assert.rejects(
      async () => {
        await claimOrCheckIdempotencyKey(
          testUserId,
          key,
          testConvId,
          "hash-unresolved"
        );
      },
      (err: any) => {
        assert.ok(
          err instanceof IdempotencyUnresolvedRecoveryError,
          "Must throw IdempotencyUnresolvedRecoveryError"
        );
        assert.strictEqual(err.statusCode, 409);
        return true;
      }
    );

    // Verify reservationId was NOT wiped or reclaimed
    const doc = await IdempotencyKey.findOne({ userId: testUserId, key });
    assert.strictEqual(
      doc?.reservationId?.toString(),
      unresolvedReservationId.toString(),
      "Reservation reference must be preserved for Phase 4 sweeper"
    );
  });

  // 7. Settled response replay without a second Gemini call or wallet deduction
  test("7. Settled response replay: short-circuits without Gemini call or token deduction", async () => {
    let aiCallCount = 0;
    const originalGenerate = _internalAI.generateAIResponseWithUsage;
    const originalCount = _internalAI.countPromptTokens;

    _internalAI.countPromptTokens = async () => 50;
    _internalAI.generateAIResponseWithUsage = async () => {
      aiCallCount++;
      return {
        text: "Authoritative idempotent response from Gemini",
        inputTokens: 50,
        outputTokens: 40,
        totalTokens: 90,
        model: PRIMARY_MODEL,
        rawUsage: {
          promptTokenCount: 50,
          candidatesTokenCount: 40,
          totalTokenCount: 90,
        },
      };
    };

    try {
      const idempotencyKey = "repeatable-key-abc";
      const messageContent = "What is the square root of 144?";

      // Call 1: fresh execution
      const res1 = await sendMessage(
        testUserId.toString(),
        testConvId.toString(),
        messageContent,
        undefined,
        idempotencyKey
      );

      assert.strictEqual(res1.isReplay, false);
      assert.strictEqual(res1.assistantMessage.content, "Authoritative idempotent response from Gemini");
      assert.strictEqual(aiCallCount, 1);

      const walletAfterCall1 = await TokenWallet.findOne({ userId: testUserId });
      const balanceAfterCall1 = walletAfterCall1!.balance;
      assert.ok(balanceAfterCall1 < 50000, "Tokens should be deducted");

      // Call 2: replay with exact same key and payload
      const res2 = await sendMessage(
        testUserId.toString(),
        testConvId.toString(),
        messageContent,
        undefined,
        idempotencyKey
      );

      assert.strictEqual(res2.isReplay, true, "Response should be marked isReplay: true");
      assert.strictEqual(res2.assistantMessage.content, res1.assistantMessage.content);
      assert.strictEqual(res2.userMessage.id, res1.userMessage.id);
      assert.strictEqual(aiCallCount, 1, "Gemini MUST NOT be called a second time!");

      const walletAfterCall2 = await TokenWallet.findOne({ userId: testUserId });
      assert.strictEqual(
        walletAfterCall2!.balance,
        balanceAfterCall1,
        "Wallet balance MUST NOT be deducted on replay!"
      );
    } finally {
      _internalAI.generateAIResponseWithUsage = originalGenerate;
      _internalAI.countPromptTokens = originalCount;
    }
  });

  // 8. Request fingerprint mismatch (different attachment bytes with identical metadata)
  test("8. Request fingerprint mismatch: identical metadata but different file bytes rejected with 422", async () => {
    const fileA: Express.Multer.File = {
      fieldname: "file",
      originalname: "design.png",
      mimetype: "image/png",
      size: 50,
      buffer: Buffer.alloc(50, 1), // All bytes = 1
    } as any;

    const fileB: Express.Multer.File = {
      fieldname: "file",
      originalname: "design.png",
      mimetype: "image/png",
      size: 50,
      buffer: Buffer.alloc(50, 2), // All bytes = 2
    } as any;

    const digestA = computeAttachmentDigest(fileA);
    const digestB = computeAttachmentDigest(fileB);
    assert.notStrictEqual(digestA, digestB, "Content digests must differ for different bytes");

    const hashA = computeRequestHash(testConvId, "Inspect this design", digestA);
    const hashB = computeRequestHash(testConvId, "Inspect this design", digestB);
    assert.notStrictEqual(hashA, hashB, "Request hashes must differ");

    const key = "attachment-mismatch-key";

    // Claim key with file A
    await claimOrCheckIdempotencyKey(testUserId, key, testConvId, hashA);

    // Reuse key with file B
    await assert.rejects(
      async () => {
        await claimOrCheckIdempotencyKey(testUserId, key, testConvId, hashB);
      },
      (err: any) => {
        assert.ok(
          err instanceof IdempotencyPayloadMismatchError,
          "Must throw IdempotencyPayloadMismatchError"
        );
        assert.strictEqual(err.statusCode, 422);
        return true;
      }
    );
  });

  // 9. Stale worker settlement fencing
  test("9. Stale worker settlement fencing: older worker cannot settle reservation or modify lock if lock was stolen", async () => {
    const assistantMsg1 = new mongoose.Types.ObjectId();
    const assistantMsg2 = new mongoose.Types.ObjectId();
    const reservationId1 = new mongoose.Types.ObjectId();
    const userMsg1 = new mongoose.Types.ObjectId();

    // Worker 1 acquires lock (version 1)
    const lock1 = await acquireConversationLock(
      testConvId,
      testUserId,
      assistantMsg1
    );
    assert.strictEqual(lock1.lockVersion, 1);

    // Worker 1 establishes reservation in Transaction 1
    const session1 = await mongoose.startSession();
    session1.startTransaction();
    await createTokenReservation(
      {
        userId: testUserId,
        conversationId: testConvId,
        userMessageId: userMsg1,
        assistantMessageId: assistantMsg1,
        reservationId: reservationId1,
        inputTokens: 50,
        model: PRIMARY_MODEL,
      },
      { session: session1 }
    );
    await session1.commitTransaction();
    await session1.endSession();

    // Simulate 120s timeout expiry and Worker 2 stealing the lock
    await Conversation.updateOne(
      { _id: testConvId },
      { $set: { lockExpiresAt: new Date(Date.now() - 1000) } }
    );
    const lock2 = await acquireConversationLock(
      testConvId,
      testUserId,
      assistantMsg2
    );
    assert.strictEqual(lock2.lockVersion, 2, "Worker 2 acquires with lockVersion 2");

    // Worker 1 finishes generation late and attempts Transaction 2A with stale lock1
    const tx2aSession = await mongoose.startSession();
    tx2aSession.startTransaction();

    let tx2aAborted = false;
    try {
      // 1. Fenced lock release check
      await fencedReleaseConversationLock(
        testConvId,
        assistantMsg1,
        lock1.lockToken,
        lock1.lockVersion,
        tx2aSession
      );

      // Settle should NOT run
      await settleTokenReservation(
        {
          reservationId: reservationId1,
          userId: testUserId,
          conversationId: testConvId,
          assistantMessageId: assistantMsg1,
          expectedVersion: 1,
          usageData: {
            billedInputTokens: 50,
            billedOutputTokens: 30,
            billedTokens: 80,
            overrunTokens: 0,
            model: PRIMARY_MODEL,
            verificationStatus: "VERIFIED_AUTHORITATIVE",
          },
        },
        { session: tx2aSession }
      );

      await tx2aSession.commitTransaction();
    } catch (err: any) {
      await tx2aSession.abortTransaction();
      tx2aAborted = true;
      assert.ok(
        err instanceof ConversationLockLostError,
        "Must abort with ConversationLockLostError"
      );
    } finally {
      await tx2aSession.endSession();
    }

    assert.ok(tx2aAborted, "Tx 2A must have aborted");

    // Verify Worker 2's lock is completely untouched
    const convAfter = await Conversation.findById(testConvId);
    assert.strictEqual(convAfter?.activeLockToken, lock2.lockToken);
    assert.strictEqual(convAfter?.lockVersion, 2);

    // Verify Worker 1's reservation was NOT settled and remains RESERVED
    const resDoc = await TokenReservation.findById(reservationId1);
    assert.strictEqual(
      resDoc?.status,
      "RESERVED",
      "Reservation must remain RESERVED for recovery"
    );
  });

  // 10. Stale worker refund fencing
  test("10. Stale worker refund fencing: older worker cannot refund or modify lock if lock was stolen", async () => {
    const assistantMsg1 = new mongoose.Types.ObjectId();
    const assistantMsg2 = new mongoose.Types.ObjectId();
    const reservationId1 = new mongoose.Types.ObjectId();
    const userMsg1 = new mongoose.Types.ObjectId();

    // Worker 1 acquires lock
    const lock1 = await acquireConversationLock(
      testConvId,
      testUserId,
      assistantMsg1
    );

    // Create reservation 1
    const s1 = await mongoose.startSession();
    s1.startTransaction();
    await createTokenReservation(
      {
        userId: testUserId,
        conversationId: testConvId,
        userMessageId: userMsg1,
        assistantMessageId: assistantMsg1,
        reservationId: reservationId1,
        inputTokens: 50,
        model: PRIMARY_MODEL,
      },
      { session: s1 }
    );
    await s1.commitTransaction();
    await s1.endSession();

    // Worker 2 steals lock
    await Conversation.updateOne(
      { _id: testConvId },
      { $set: { lockExpiresAt: new Date(Date.now() - 1000) } }
    );
    const lock2 = await acquireConversationLock(
      testConvId,
      testUserId,
      assistantMsg2
    );

    // Worker 1 experiences failure and attempts Transaction 2B with stale lock1
    const tx2bSession = await mongoose.startSession();
    tx2bSession.startTransaction();

    let tx2bAborted = false;
    try {
      await fencedReleaseConversationLock(
        testConvId,
        assistantMsg1,
        lock1.lockToken,
        lock1.lockVersion,
        tx2bSession
      );

      await refundTokenReservation(
        {
          reservationId: reservationId1,
          userId: testUserId,
          expectedVersion: 1,
          reason: "Simulated worker 1 error",
        },
        { session: tx2bSession }
      );

      await tx2bSession.commitTransaction();
    } catch (err: any) {
      await tx2bSession.abortTransaction();
      tx2bAborted = true;
      assert.ok(err instanceof ConversationLockLostError);
    } finally {
      await tx2bSession.endSession();
    }

    assert.ok(tx2bAborted, "Tx 2B must have aborted");

    // Worker 2's lock is still intact
    const conv = await Conversation.findById(testConvId);
    assert.strictEqual(conv?.activeLockToken, lock2.lockToken);

    // Reservation remains RESERVED (not refunded)
    const resDoc = await TokenReservation.findById(reservationId1);
    assert.strictEqual(resDoc?.status, "RESERVED");
  });

  // 11. Fenced message completion: placeholder message not finalized when lock lost
  test("11. Fenced message completion: assistant placeholder message not marked completed when lock check fails", async () => {
    const assistantMsgId = new mongoose.Types.ObjectId();
    const lock = await acquireConversationLock(
      testConvId,
      testUserId,
      assistantMsgId
    );

    // Seed assistant placeholder message in 'generating'
    await Message.create({
      _id: assistantMsgId,
      conversationId: testConvId,
      userId: testUserId,
      role: "assistant",
      content: "",
      status: "generating",
    });

    // Worker 2 steals lock
    await Conversation.updateOne(
      { _id: testConvId },
      { $set: { lockExpiresAt: new Date(Date.now() - 1000) } }
    );
    await acquireConversationLock(
      testConvId,
      testUserId,
      new mongoose.Types.ObjectId()
    );

    // Stale worker tries to complete message in Tx 2A
    const txSession = await mongoose.startSession();
    txSession.startTransaction();

    try {
      await fencedReleaseConversationLock(
        testConvId,
        assistantMsgId,
        lock.lockToken,
        lock.lockVersion,
        txSession
      );

      await Message.updateOne(
        { _id: assistantMsgId },
        { $set: { status: "completed", content: "Should not persist" } },
        { session: txSession }
      );

      await txSession.commitTransaction();
    } catch {
      await txSession.abortTransaction();
    } finally {
      await txSession.endSession();
    }

    // Verify message remains 'generating' and content is not overwritten
    const msg = await Message.findById(assistantMsgId);
    assert.strictEqual(msg?.status, "generating");
    assert.strictEqual(msg?.content, "");
  });
});

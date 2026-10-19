import "dotenv/config";
import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { connectDatabase } from "../src/config/database.js";
import { User } from "../src/database/models/user/index.js";
import { TokenWallet } from "../src/database/models/tokenWallet/index.js";
import { TokenUsage } from "../src/database/models/tokenUsage/index.js";
import { TokenReservation } from "../src/database/models/tokenReservation/index.js";
import { Conversation } from "../src/database/models/conversation/index.js";
import { Message } from "../src/database/models/message/index.js";
import {
  createTokenReservation,
  settleTokenReservation,
  refundTokenReservation,
  validateUsageData,
  InsufficientTokensError,
  ReservationStateConflictError,
  TokenInvariantViolationError,
  PRIMARY_MODEL,
} from "../src/features/token/index.js";

describe("Phase 2 — Core Token Ledger & Safety Test Suite", () => {
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
      console.warn("DB connection unavailable for Phase 2 integration tests:", err);
    }
  });

  after(async () => {
    if (isDbConnected && testUserId) {
      await TokenReservation.deleteMany({ userId: testUserId });
      await TokenWallet.deleteMany({ userId: testUserId });
      await TokenUsage.deleteMany({ userId: testUserId });
      await Message.deleteMany({ userId: testUserId });
      await Conversation.deleteMany({ userId: testUserId });
      await mongoose.disconnect();
    }
  });

  // --- UNIT TESTS: validateUsageData (100% deterministic, no DB required) ---

  describe("Unit: validateUsageData accounting & metadata auditing", () => {
    test("8. Excess-usage capping while preserving raw provider usage", () => {
      const reservedAmount = 1000;
      const precomputedInput = 200;
      const rawUsage = {
        promptTokenCount: 200,
        candidatesTokenCount: 1200,
        thoughtsTokenCount: 100,
        totalTokenCount: 1500, // Exceeds 1000
      };

      const result = validateUsageData(rawUsage, reservedAmount, precomputedInput, "gemini-3.6-flash");

      assert.equal(result.verificationStatus, "EXCESS_CLAMPED");
      assert.equal(result.billedTokens, 1000); // Clamped to reserved
      assert.equal(result.overrunTokens, 500); // 1500 - 1000
      assert.equal(result.providerUsage?.totalTokens, 1500); // Preserved raw
      assert.equal(result.providerUsage?.thoughtsTokens, 100);
      assert.equal(result.providerUsage?.candidatesTokens, 1200);
    });

    test("9A. Missing provider metadata fallback (UNVERIFIED_INPUT_ONLY)", () => {
      const reservedAmount = 1200;
      const precomputedInput = 150;

      const result = validateUsageData(undefined, reservedAmount, precomputedInput, "gemini-3.6-flash");

      assert.equal(result.verificationStatus, "UNVERIFIED_INPUT_ONLY");
      assert.equal(result.billedTokens, 150); // Bills verified input
      assert.equal(result.billedOutputTokens, 0); // Output waived
      assert.equal(result.overrunTokens, 0);
      assert.equal(result.providerUsage, undefined);
    });

    test("9B. Corrupted/invalid provider metadata fallback (INVALID_METADATA_FALLBACK)", () => {
      const reservedAmount = 1200;
      const precomputedInput = 180;
      const rawUsage = {
        promptTokenCount: -10, // Invalid negative count
        candidatesTokenCount: 200,
        totalTokenCount: NaN,
      };

      const result = validateUsageData(rawUsage, reservedAmount, precomputedInput, "gemini-3.6-flash");

      assert.equal(result.verificationStatus, "INVALID_METADATA_FALLBACK");
      assert.equal(result.billedTokens, 180);
      assert.equal(result.billedOutputTokens, 0);
      assert.equal(result.overrunTokens, 0);
    });

    test("Authoritative provider usage within reserved budget", () => {
      const reservedAmount = 1000;
      const precomputedInput = 150;
      const rawUsage = {
        promptTokenCount: 150,
        candidatesTokenCount: 300,
        thoughtsTokenCount: 50,
        totalTokenCount: 500,
      };

      const result = validateUsageData(rawUsage, reservedAmount, precomputedInput, "gemini-3.6-flash");

      assert.equal(result.verificationStatus, "AUTHORITATIVE");
      assert.equal(result.billedTokens, 500);
      assert.equal(result.billedInputTokens, 150);
      assert.equal(result.billedOutputTokens, 300);
      assert.equal(result.overrunTokens, 0);
      assert.equal(result.providerUsage?.totalTokens, 500);
    });
  });

  // --- INTEGRATION TESTS: Multi-Document Transactions ---

  describe("Integration: Transaction-aware ledger operations", () => {
    test("1. Atomic reservation creation decrements balance and creates TokenReservation", async (t) => {
      if (!isDbConnected) return t.skip("MongoDB connection unavailable");

      const userId = new mongoose.Types.ObjectId();
      const conversationId = new mongoose.Types.ObjectId();
      const userMessageId = new mongoose.Types.ObjectId();
      const assistantMessageId = new mongoose.Types.ObjectId();

      await TokenWallet.create({
        userId,
        balance: 1000,
        totalAllocated: 1000,
        totalUsed: 0,
        reservedTokens: 0,
      });

      const session = await mongoose.startSession();
      session.startTransaction();

      try {
        const { reservation, reservedAmount, allowedOutputTokens } = await createTokenReservation(
          {
            userId,
            conversationId,
            userMessageId,
            assistantMessageId,
            inputTokens: 100,
            maxOutputBudget: 500,
          },
          { session }
        );

        assert.equal(reservedAmount, 600); // 100 + 500
        assert.equal(allowedOutputTokens, 500);
        assert.equal(reservation.status, "RESERVED");
        assert.equal(reservation.version, 1);

        await session.commitTransaction();
      } finally {
        await session.endSession();
      }

      // Verify DB state outside transaction
      const wallet = await TokenWallet.findOne({ userId });
      assert.equal(wallet?.balance, 400); // 1000 - 600
      assert.equal(wallet?.reservedTokens, 600);

      const savedReservation = await TokenReservation.findOne({ assistantMessageId });
      assert.ok(savedReservation);
      assert.equal(savedReservation.reservedTokens, 600);
      assert.equal(savedReservation.status, "RESERVED");

      // Cleanup
      await TokenWallet.deleteOne({ userId });
      await TokenReservation.deleteOne({ _id: savedReservation._id });
    });

    test("2. Insufficient balance aborts reservation creation", async (t) => {
      if (!isDbConnected) return t.skip("MongoDB connection unavailable");

      const userId = new mongoose.Types.ObjectId();
      await TokenWallet.create({
        userId,
        balance: 50, // Insufficient for inputTokens (100) + MIN_OUTPUT_BUDGET (16)
        totalAllocated: 50,
        totalUsed: 0,
        reservedTokens: 0,
      });

      const session = await mongoose.startSession();
      session.startTransaction();

      try {
        await assert.rejects(
          async () => {
            await createTokenReservation(
              {
                userId,
                conversationId: new mongoose.Types.ObjectId(),
                userMessageId: new mongoose.Types.ObjectId(),
                assistantMessageId: new mongoose.Types.ObjectId(),
                inputTokens: 100,
              },
              { session }
            );
          },
          InsufficientTokensError
        );
        await session.abortTransaction();
      } finally {
        await session.endSession();
        await TokenWallet.deleteOne({ userId });
      }
    });

    test("3. Transaction rollback leaves no partial wallet deduction or reservation", async (t) => {
      if (!isDbConnected) return t.skip("MongoDB connection unavailable");

      const userId = new mongoose.Types.ObjectId();
      const assistantMessageId = new mongoose.Types.ObjectId();

      await TokenWallet.create({
        userId,
        balance: 1000,
        totalAllocated: 1000,
        totalUsed: 0,
        reservedTokens: 0,
      });

      const session = await mongoose.startSession();
      session.startTransaction();

      try {
        await createTokenReservation(
          {
            userId,
            conversationId: new mongoose.Types.ObjectId(),
            userMessageId: new mongoose.Types.ObjectId(),
            assistantMessageId,
            inputTokens: 200,
          },
          { session }
        );

        // Intentionally abort
        await session.abortTransaction();
      } finally {
        await session.endSession();
      }

      // Verify complete rollback
      const wallet = await TokenWallet.findOne({ userId });
      assert.equal(wallet?.balance, 1000);
      assert.equal(wallet?.reservedTokens, 0);

      const reservation = await TokenReservation.findOne({ assistantMessageId });
      assert.equal(reservation, null);

      await TokenWallet.deleteOne({ userId });
    });

    test("4. Correct settlement math refunds unused tokens and increments totalUsed", async (t) => {
      if (!isDbConnected) return t.skip("MongoDB connection unavailable");

      const userId = new mongoose.Types.ObjectId();
      const conversationId = new mongoose.Types.ObjectId();
      const assistantMessageId = new mongoose.Types.ObjectId();
      const reservationId = new mongoose.Types.ObjectId();

      await TokenWallet.create({
        userId,
        balance: 400,
        reservedTokens: 600,
        totalAllocated: 1000,
        totalUsed: 0,
      });

      await TokenReservation.create({
        _id: reservationId,
        userId,
        conversationId,
        userMessageId: new mongoose.Types.ObjectId(),
        assistantMessageId,
        reservedTokens: 600,
        status: "RESERVED",
        version: 1,
        lockExpiresAt: new Date(Date.now() + 60000),
      });

      const validatedUsage = {
        billedTokens: 250,
        billedInputTokens: 100,
        billedOutputTokens: 150,
        overrunTokens: 0,
        verificationStatus: "AUTHORITATIVE" as const,
        model: "gemini-3.6-flash",
      };

      const session = await mongoose.startSession();
      session.startTransaction();

      try {
        const { unusedTokensToRefund } = await settleTokenReservation(
          {
            reservationId,
            userId,
            assistantMessageId,
            expectedVersion: 1,
            usageData: validatedUsage,
          },
          { session }
        );

        assert.equal(unusedTokensToRefund, 350); // 600 - 250
        await session.commitTransaction();
      } finally {
        await session.endSession();
      }

      const wallet = await TokenWallet.findOne({ userId });
      assert.equal(wallet?.balance, 750); // 400 + 350 refunded
      assert.equal(wallet?.reservedTokens, 0);
      assert.equal(wallet?.totalUsed, 250);

      const settledRes = await TokenReservation.findById(reservationId);
      assert.equal(settledRes?.status, "SETTLED");
      assert.equal(settledRes?.version, 2); // Dynamic version incremented
      assert.equal(settledRes?.billedTokens, 250);

      const usage = await TokenUsage.findOne({ messageId: assistantMessageId });
      assert.ok(usage);
      assert.equal(usage.totalTokens, 250);

      // Cleanup
      await TokenWallet.deleteOne({ userId });
      await TokenReservation.deleteOne({ _id: reservationId });
      await TokenUsage.deleteOne({ messageId: assistantMessageId });
    });

    test("5. Duplicate settlement protection (rejects re-settlement of already settled reservation)", async (t) => {
      if (!isDbConnected) return t.skip("MongoDB connection unavailable");

      const userId = new mongoose.Types.ObjectId();
      const reservationId = new mongoose.Types.ObjectId();

      await TokenReservation.create({
        _id: reservationId,
        userId,
        conversationId: new mongoose.Types.ObjectId(),
        userMessageId: new mongoose.Types.ObjectId(),
        assistantMessageId: new mongoose.Types.ObjectId(),
        reservedTokens: 500,
        status: "SETTLED", // Already settled
        version: 2,
        lockExpiresAt: new Date(),
      });

      const session = await mongoose.startSession();
      session.startTransaction();

      try {
        await assert.rejects(
          async () => {
            await settleTokenReservation(
              {
                reservationId,
                userId,
                assistantMessageId: new mongoose.Types.ObjectId(),
                expectedVersion: 1, // Mismatched version and status
                usageData: {
                  billedTokens: 300,
                  billedInputTokens: 100,
                  billedOutputTokens: 200,
                  overrunTokens: 0,
                  verificationStatus: "AUTHORITATIVE",
                  model: "gemini-3.6-flash",
                },
              },
              { session }
            );
          },
          ReservationStateConflictError
        );
        await session.abortTransaction();
      } finally {
        await session.endSession();
        await TokenReservation.deleteOne({ _id: reservationId });
      }
    });

    test("6. Duplicate refund protection (rejects re-refund of already refunded reservation)", async (t) => {
      if (!isDbConnected) return t.skip("MongoDB connection unavailable");

      const userId = new mongoose.Types.ObjectId();
      const reservationId = new mongoose.Types.ObjectId();

      await TokenReservation.create({
        _id: reservationId,
        userId,
        conversationId: new mongoose.Types.ObjectId(),
        userMessageId: new mongoose.Types.ObjectId(),
        assistantMessageId: new mongoose.Types.ObjectId(),
        reservedTokens: 500,
        status: "REFUNDED",
        version: 2,
        lockExpiresAt: new Date(),
      });

      const session = await mongoose.startSession();
      session.startTransaction();

      try {
        await assert.rejects(
          async () => {
            await refundTokenReservation(
              {
                reservationId,
                userId,
                expectedVersion: 1,
              },
              { session }
            );
          },
          ReservationStateConflictError
        );
        await session.abortTransaction();
      } finally {
        await session.endSession();
        await TokenReservation.deleteOne({ _id: reservationId });
      }
    });

    test("7. Settlement / Refund race (only one terminal transition succeeds)", async (t) => {
      if (!isDbConnected) return t.skip("MongoDB connection unavailable");

      const userId = new mongoose.Types.ObjectId();
      const reservationId = new mongoose.Types.ObjectId();
      const assistantMessageId = new mongoose.Types.ObjectId();

      await TokenWallet.create({
        userId,
        balance: 500,
        reservedTokens: 500,
        totalAllocated: 1000,
        totalUsed: 0,
      });

      await TokenReservation.create({
        _id: reservationId,
        userId,
        conversationId: new mongoose.Types.ObjectId(),
        userMessageId: new mongoose.Types.ObjectId(),
        assistantMessageId,
        reservedTokens: 500,
        status: "RESERVED",
        version: 1,
        lockExpiresAt: new Date(Date.now() + 60000),
      });

      // Session 1: Settle
      const session1 = await mongoose.startSession();
      session1.startTransaction();
      await settleTokenReservation(
        {
          reservationId,
          userId,
          assistantMessageId,
          expectedVersion: 1,
          usageData: {
            billedTokens: 500,
            billedInputTokens: 100,
            billedOutputTokens: 400,
            overrunTokens: 0,
            verificationStatus: "AUTHORITATIVE",
            model: "gemini-3.6-flash",
          },
        },
        { session: session1 }
      );
      await session1.commitTransaction();
      await session1.endSession();

      // Session 2: Refund attempt on the now-settled reservation
      const session2 = await mongoose.startSession();
      session2.startTransaction();

      try {
        await assert.rejects(
          async () => {
            await refundTokenReservation(
              {
                reservationId,
                userId,
                expectedVersion: 1,
              },
              { session: session2 }
            );
          },
          ReservationStateConflictError
        );
        await session2.abortTransaction();
      } finally {
        await session2.endSession();
        await TokenWallet.deleteOne({ userId });
        await TokenReservation.deleteOne({ _id: reservationId });
        await TokenUsage.deleteOne({ messageId: assistantMessageId });
      }
    });

    test("10. Dynamic version/fencing mismatch aborts settlement", async (t) => {
      if (!isDbConnected) return t.skip("MongoDB connection unavailable");

      const userId = new mongoose.Types.ObjectId();
      const reservationId = new mongoose.Types.ObjectId();

      await TokenReservation.create({
        _id: reservationId,
        userId,
        conversationId: new mongoose.Types.ObjectId(),
        userMessageId: new mongoose.Types.ObjectId(),
        assistantMessageId: new mongoose.Types.ObjectId(),
        reservedTokens: 500,
        status: "RESERVED",
        version: 2, // Fencing version has been advanced by a recovery worker
        lockExpiresAt: new Date(Date.now() + 60000),
      });

      const session = await mongoose.startSession();
      session.startTransaction();

      try {
        await assert.rejects(
          async () => {
            await settleTokenReservation(
              {
                reservationId,
                userId,
                assistantMessageId: new mongoose.Types.ObjectId(),
                expectedVersion: 1, // Stale worker with version 1
                usageData: {
                  billedTokens: 200,
                  billedInputTokens: 50,
                  billedOutputTokens: 150,
                  overrunTokens: 0,
                  verificationStatus: "AUTHORITATIVE",
                  model: "gemini-3.6-flash",
                },
              },
              { session }
            );
          },
          ReservationStateConflictError
        );
        await session.abortTransaction();
      } finally {
        await session.endSession();
        await TokenReservation.deleteOne({ _id: reservationId });
      }
    });

    test("11. Wallet ownership mismatch aborts settlement", async (t) => {
      if (!isDbConnected) return t.skip("MongoDB connection unavailable");

      const trueOwnerId = new mongoose.Types.ObjectId();
      const attackerId = new mongoose.Types.ObjectId();
      const reservationId = new mongoose.Types.ObjectId();

      await TokenReservation.create({
        _id: reservationId,
        userId: trueOwnerId,
        conversationId: new mongoose.Types.ObjectId(),
        userMessageId: new mongoose.Types.ObjectId(),
        assistantMessageId: new mongoose.Types.ObjectId(),
        reservedTokens: 500,
        status: "RESERVED",
        version: 1,
        lockExpiresAt: new Date(Date.now() + 60000),
      });

      const session = await mongoose.startSession();
      session.startTransaction();

      try {
        await assert.rejects(
          async () => {
            // Attempt to settle using attackerId instead of trueOwnerId
            await settleTokenReservation(
              {
                reservationId,
                userId: attackerId,
                assistantMessageId: new mongoose.Types.ObjectId(),
                expectedVersion: 1,
                usageData: {
                  billedTokens: 200,
                  billedInputTokens: 50,
                  billedOutputTokens: 150,
                  overrunTokens: 0,
                  verificationStatus: "AUTHORITATIVE",
                  model: "gemini-3.6-flash",
                },
              },
              { session }
            );
          },
          ReservationStateConflictError
        );
        await session.abortTransaction();
      } finally {
        await session.endSession();
        await TokenReservation.deleteOne({ _id: reservationId });
      }
    });

    test("12. Deferred unique-index documentation check", () => {
      // Confirms TokenUsage model retains messageId indexed without forcing live index conflict
      const messageIdConfig = (TokenUsage.schema.paths as any)["messageId"];
      assert.ok(messageIdConfig);
      // Confirms new audit fields are properly defined on the schema
      const usageVerificationConfig = (TokenUsage.schema.paths as any)["usageVerification"];
      assert.ok(usageVerificationConfig);
      const providerTotalConfig = (TokenUsage.schema.paths as any)["providerTotalTokens"];
      assert.ok(providerTotalConfig);
    });
  });
});

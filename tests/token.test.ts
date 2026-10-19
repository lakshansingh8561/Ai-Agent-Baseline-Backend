import "dotenv/config";
import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { connectDatabase } from "../src/config/database.js";
import { User } from "../src/database/models/user/index.js";
import { TokenWallet } from "../src/database/models/tokenWallet/index.js";
import { TokenUsage } from "../src/database/models/tokenUsage/index.js";
import { Conversation } from "../src/database/models/conversation/index.js";
import { Message } from "../src/database/models/message/index.js";
import { TokenReservation } from "../src/database/models/tokenReservation/index.js";
import {
  createTokenReservation,
  settleTokenReservation,
  refundTokenReservation,
  getUserTokenBalance,
  InsufficientTokensError,
  TokenInvariantViolationError,
  TOKEN_CONSTANTS,
} from "../src/features/token/index.js";
import {
  generateAIResponse,
  generateAIResponseWithUsage,
  countPromptTokens,
  PRIMARY_MODEL,
} from "../src/features/ai/ai.service.js";
import {
  sendMessage,
  ChatError,
  _internalAI,
} from "../src/features/chat/chat.service.js";

describe("Token Accounting Engine Test Suite", () => {
  let testUserId: mongoose.Types.ObjectId;

  before(async () => {
    await connectDatabase();
    testUserId = new mongoose.Types.ObjectId();
  });

  after(async () => {
    // Cleanup test data
    if (testUserId) {
      await TokenWallet.deleteMany({ userId: testUserId });
      await TokenReservation.deleteMany({ userId: testUserId });
      await TokenUsage.deleteMany({ userId: testUserId });
      await Conversation.deleteMany({ userId: testUserId });
      await Message.deleteMany({ userId: testUserId });
      await User.deleteOne({ _id: testUserId });
    }
    await mongoose.disconnect();
  });

  test("1. Successful token reservation synchronizes allowedOutputTokens with budget", async () => {
    const userId = new mongoose.Types.ObjectId();
    await TokenWallet.create({
      userId,
      balance: 500,
      totalAllocated: 500,
      totalUsed: 0,
      reservedTokens: 0,
    });

    const inputTokens = 100;
    const session = await mongoose.startSession();
    session.startTransaction();
    let reservation: any;
    try {
      reservation = await createTokenReservation(
        {
          userId,
          conversationId: new mongoose.Types.ObjectId(),
          userMessageId: new mongoose.Types.ObjectId(),
          assistantMessageId: new mongoose.Types.ObjectId(),
          inputTokens,
          maxOutputBudget: 1000,
        },
        { session }
      );
      await session.commitTransaction();
    } finally {
      await session.endSession();
    }

    // available was 500. min(100 + 1000, 500) = 500
    assert.equal(reservation.reservedAmount, 500);
    // allowedOutputTokens = 500 - 100 = 400
    assert.equal(reservation.allowedOutputTokens, 400);
    assert.ok(reservation.reservation);
    assert.equal(reservation.reservation.status, "RESERVED");

    const wallet = await TokenWallet.findOne({ userId });
    assert.equal(wallet?.balance, 0);
    assert.equal(wallet?.reservedTokens, 500);

    // Clean up
    await TokenWallet.deleteOne({ userId });
    await TokenReservation.deleteOne({ _id: reservation.reservation._id });
  });

  test("2. Successful generation finalizes actual usage and refunds unused reservation", async () => {
    const userId = new mongoose.Types.ObjectId();
    const convId = new mongoose.Types.ObjectId();
    const userMsgId = new mongoose.Types.ObjectId();
    const assistantMsgId = new mongoose.Types.ObjectId();

    await TokenWallet.create({
      userId,
      balance: 1000,
      totalAllocated: 1000,
      totalUsed: 0,
      reservedTokens: 0,
    });

    // 1. Reserve tokens
    const resSession = await mongoose.startSession();
    resSession.startTransaction();
    let resResult: any;
    try {
      resResult = await createTokenReservation(
        {
          userId,
          conversationId: convId,
          userMessageId: userMsgId,
          assistantMessageId: assistantMsgId,
          inputTokens: 50,
          maxOutputBudget: 500,
        },
        { session: resSession }
      );
      await resSession.commitTransaction();
    } finally {
      await resSession.endSession();
    }

    // Reserved = min(50 + 500, 1000) = 550, balance left = 450, reservedTokens = 550
    assert.equal(resResult.reservedAmount, 550);

    // 2. Settle actual usage (150 total: 50 input + 100 output)
    const settleSession = await mongoose.startSession();
    settleSession.startTransaction();
    let settleResult: any;
    try {
      settleResult = await settleTokenReservation(
        {
          userId,
          reservationId: resResult.reservation._id,
          assistantMessageId: assistantMsgId,
          expectedVersion: resResult.reservation.version,
          conversationId: convId,
          usageData: {
            billedTokens: 150,
            billedInputTokens: 50,
            billedOutputTokens: 100,
            overrunTokens: 0,
            verificationStatus: "AUTHORITATIVE",
            model: PRIMARY_MODEL,
          },
        },
        { session: settleSession }
      );
      await settleSession.commitTransaction();
    } finally {
      await settleSession.endSession();
    }

    assert.ok(settleResult.tokenUsage._id);
    assert.equal(settleResult.tokenUsage.totalTokens, 150);
    assert.equal(settleResult.unusedTokensToRefund, 400);
    assert.equal(settleResult.reservation.status, "SETTLED");

    const wallet = await TokenWallet.findOne({ userId });
    // Balance should be: initial (1000) - actualUsed (150) = 850
    assert.equal(wallet?.balance, 850);
    assert.equal(wallet?.reservedTokens, 0);
    assert.equal(wallet?.totalUsed, 150);

    await TokenWallet.deleteOne({ userId });
    await TokenReservation.deleteOne({ _id: resResult.reservation._id });
    await TokenUsage.deleteOne({ _id: settleResult.tokenUsage._id });
  });

  test("3. TokenUsage document correctly captures all required fields", async () => {
    const userId = new mongoose.Types.ObjectId();
    const convId = new mongoose.Types.ObjectId();
    const userMsgId = new mongoose.Types.ObjectId();
    const msgId = new mongoose.Types.ObjectId();

    await TokenWallet.create({
      userId,
      balance: 1000,
      totalAllocated: 1000,
      totalUsed: 0,
      reservedTokens: 0,
    });

    const session = await mongoose.startSession();
    session.startTransaction();
    let settleResult: any;
    try {
      const reservation = await createTokenReservation(
        {
          userId,
          conversationId: convId,
          userMessageId: userMsgId,
          assistantMessageId: msgId,
          inputTokens: 20,
          maxOutputBudget: 200,
        },
        { session }
      );

      settleResult = await settleTokenReservation(
        {
          userId,
          reservationId: reservation.reservation._id,
          assistantMessageId: msgId,
          conversationId: convId,
          expectedVersion: reservation.reservation.version,
          usageData: {
            billedTokens: 70,
            billedInputTokens: 20,
            billedOutputTokens: 50,
            overrunTokens: 0,
            verificationStatus: "AUTHORITATIVE",
            model: PRIMARY_MODEL,
          },
        },
        { session }
      );
      await session.commitTransaction();
    } finally {
      await session.endSession();
    }

    const record = await TokenUsage.findById(settleResult.tokenUsage._id);
    assert.ok(record);
    assert.equal(record.userId.toString(), userId.toString());
    assert.equal(record.conversationId?.toString(), convId.toString());
    assert.equal(record.messageId?.toString(), msgId.toString());
    assert.equal(record.inputTokens, 20);
    assert.equal(record.outputTokens, 50);
    assert.equal(record.totalTokens, 70);
    assert.equal(record.model, PRIMARY_MODEL);
    assert.equal(record.type, "chat");
    assert.equal(record.usageVerification, "AUTHORITATIVE");

    await TokenWallet.deleteOne({ userId });
    await TokenReservation.deleteOne({ _id: settleResult.reservation._id });
    await TokenUsage.deleteOne({ _id: settleResult.tokenUsage._id });
  });

  test("4. Insufficient balance rejects request with 402 without reserving or calling Gemini", async () => {
    const userId = new mongoose.Types.ObjectId();
    await TokenWallet.create({
      userId,
      balance: 10, // less than MIN_OUTPUT_BUDGET (16)
      totalAllocated: 10,
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
              inputTokens: 20,
            },
            { session }
          );
        },
        (error: any) => {
          assert.ok(error instanceof InsufficientTokensError);
          assert.equal(error.statusCode, 402);
          return true;
        }
      );
      await session.abortTransaction();
    } finally {
      await session.endSession();
    }

    const wallet = await TokenWallet.findOne({ userId });
    assert.equal(wallet?.balance, 10);
    assert.equal(wallet?.reservedTokens, 0);

    await TokenWallet.deleteOne({ userId });
  });

  test("5. Generation failure releases reservation and preserves wallet consistency", async () => {
    const userId = new mongoose.Types.ObjectId();
    const convId = new mongoose.Types.ObjectId();
    const userMsgId = new mongoose.Types.ObjectId();
    const assistantMsgId = new mongoose.Types.ObjectId();

    await TokenWallet.create({
      userId,
      balance: 500,
      totalAllocated: 500,
      totalUsed: 0,
      reservedTokens: 0,
    });

    const resSession = await mongoose.startSession();
    resSession.startTransaction();
    let resResult: any;
    try {
      resResult = await createTokenReservation(
        {
          userId,
          conversationId: convId,
          userMessageId: userMsgId,
          assistantMessageId: assistantMsgId,
          inputTokens: 50,
          maxOutputBudget: 300,
        },
        { session: resSession }
      );
      await resSession.commitTransaction();
    } finally {
      await resSession.endSession();
    }

    assert.equal(resResult.reservedAmount, 350);

    let wallet = await TokenWallet.findOne({ userId });
    assert.equal(wallet?.balance, 150);
    assert.equal(wallet?.reservedTokens, 350);

    // Simulate failure refund via canonical refundTokenReservation
    const refundSession = await mongoose.startSession();
    refundSession.startTransaction();
    try {
      const refundResult = await refundTokenReservation(
        {
          userId,
          reservationId: resResult.reservation._id,
          expectedVersion: resResult.reservation.version,
          reason: "Simulated generation failure",
        },
        { session: refundSession }
      );
      await refundSession.commitTransaction();
      assert.equal(refundResult.reservation.status, "REFUNDED");
      assert.equal(refundResult.refundedAmount, 350);
    } finally {
      await refundSession.endSession();
    }

    wallet = await TokenWallet.findOne({ userId });
    assert.equal(wallet?.balance, 500);
    assert.equal(wallet?.reservedTokens, 0);
    assert.equal(wallet?.totalUsed, 0);

    const usageCount = await TokenUsage.countDocuments({ userId });
    assert.equal(usageCount, 0);

    await TokenWallet.deleteOne({ userId });
    await TokenReservation.deleteOne({ _id: resResult.reservation._id });
  });

  test("6. Actual usage invariant: actualUsage > reservedAmount fails safely", async () => {
    const userId = new mongoose.Types.ObjectId();
    const convId = new mongoose.Types.ObjectId();
    const userMsgId = new mongoose.Types.ObjectId();
    const assistantMsgId = new mongoose.Types.ObjectId();

    await TokenWallet.create({
      userId,
      balance: 500,
      totalAllocated: 500,
      totalUsed: 0,
      reservedTokens: 0,
    });

    const resSession = await mongoose.startSession();
    resSession.startTransaction();
    let resResult: any;
    try {
      resResult = await createTokenReservation(
        {
          userId,
          conversationId: convId,
          userMessageId: userMsgId,
          assistantMessageId: assistantMsgId,
          inputTokens: 50,
          maxOutputBudget: 100,
        },
        { session: resSession }
      );
      await resSession.commitTransaction();
    } finally {
      await resSession.endSession();
    }

    assert.equal(resResult.reservedAmount, 150);

    // Attempt settlement with actual usage (200) > reserved (150)
    const settleSession = await mongoose.startSession();
    settleSession.startTransaction();
    try {
      await assert.rejects(
        async () => {
          await settleTokenReservation(
            {
              userId,
              reservationId: resResult.reservation._id,
              assistantMessageId: assistantMsgId,
              expectedVersion: resResult.reservation.version,
              usageData: {
                billedTokens: 200,
                billedInputTokens: 50,
                billedOutputTokens: 150,
                overrunTokens: 0,
                verificationStatus: "AUTHORITATIVE",
                model: PRIMARY_MODEL,
              },
            },
            { session: settleSession }
          );
        },
        (error: any) => {
          assert.ok(error instanceof TokenInvariantViolationError);
          return true;
        }
      );
      await settleSession.abortTransaction();
    } finally {
      await settleSession.endSession();
    }

    // Reservation safely refunded upon invariant failure
    const refundSession = await mongoose.startSession();
    refundSession.startTransaction();
    try {
      await refundTokenReservation(
        {
          userId,
          reservationId: resResult.reservation._id,
          expectedVersion: resResult.reservation.version,
          reason: "Settlement invariant violation fallback",
        },
        { session: refundSession }
      );
      await refundSession.commitTransaction();
    } finally {
      await refundSession.endSession();
    }

    const wallet = await TokenWallet.findOne({ userId });
    assert.equal(wallet?.balance, 500);
    assert.equal(wallet?.reservedTokens, 0);
    assert.equal(wallet?.totalUsed, 0);

    const usageCount = await TokenUsage.countDocuments({ userId });
    assert.equal(usageCount, 0);

    await TokenWallet.deleteOne({ userId });
    await TokenReservation.deleteOne({ _id: resResult.reservation._id });
  });

  test("7. Wallet balance never becomes negative", async () => {
    const userId = new mongoose.Types.ObjectId();
    const convId = new mongoose.Types.ObjectId();
    const userMsgId = new mongoose.Types.ObjectId();
    const assistantMsgId = new mongoose.Types.ObjectId();

    await TokenWallet.create({
      userId,
      balance: 100,
      totalAllocated: 100,
      totalUsed: 0,
      reservedTokens: 0,
    });

    // Attempting to reserve 200 when balance is 100 should cap at 100
    const session = await mongoose.startSession();
    session.startTransaction();
    let res: any;
    try {
      res = await createTokenReservation(
        {
          userId,
          conversationId: convId,
          userMessageId: userMsgId,
          assistantMessageId: assistantMsgId,
          inputTokens: 10,
          maxOutputBudget: 200,
        },
        { session }
      );
      await session.commitTransaction();
    } finally {
      await session.endSession();
    }

    assert.equal(res.reservedAmount, 100);

    const updated = await TokenWallet.findOne({ userId });
    assert.ok((updated?.balance ?? -1) >= 0);
    assert.equal(updated?.balance, 0);

    // Refunding brings it back to 100
    const refundSession = await mongoose.startSession();
    refundSession.startTransaction();
    try {
      await refundTokenReservation(
        {
          userId,
          reservationId: res.reservation._id,
          expectedVersion: res.reservation.version,
        },
        { session: refundSession }
      );
      await refundSession.commitTransaction();
    } finally {
      await refundSession.endSession();
    }

    const restored = await TokenWallet.findOne({ userId });
    assert.equal(restored?.balance, 100);

    await TokenWallet.deleteOne({ userId });
    await TokenReservation.deleteOne({ _id: res.reservation._id });
  });

  test("8. Concurrent reservation attempts cannot overspend the wallet", async () => {
    const userId = new mongoose.Types.ObjectId();
    await TokenWallet.create({
      userId,
      balance: 300,
      totalAllocated: 300,
      totalUsed: 0,
      reservedTokens: 0,
    });

    // Helper simulating reservation transaction with retry on transient write conflict
    const attemptReservation = async () => {
      const maxRetries = 3;
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        const session = await mongoose.startSession();
        session.startTransaction();
        try {
          const res = await createTokenReservation(
            {
              userId,
              conversationId: new mongoose.Types.ObjectId(),
              userMessageId: new mongoose.Types.ObjectId(),
              assistantMessageId: new mongoose.Types.ObjectId(),
              inputTokens: 50,
              maxOutputBudget: 100,
            },
            { session }
          );
          await session.commitTransaction();
          await session.endSession();
          return res;
        } catch (err: any) {
          await session.abortTransaction();
          await session.endSession();
          const isTransient =
            err.code === 112 ||
            (err.errorLabels && err.errorLabels.includes("TransientTransactionError"));
          if (isTransient && attempt < maxRetries - 1) {
            await new Promise((r) => setTimeout(r, 20 * (attempt + 1)));
            continue;
          }
          throw err;
        }
      }
    };

    // 4 concurrent requests each trying to reserve 150 tokens (total 600 > 300)
    const promises = [
      attemptReservation(),
      attemptReservation(),
      attemptReservation(),
      attemptReservation(),
    ];

    const results = await Promise.allSettled(promises);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    // Exactly 2 requests can succeed (150 * 2 = 300), the others must be rejected for insufficient tokens
    assert.equal(fulfilled.length, 2);
    assert.equal(rejected.length, 2);

    for (const r of rejected) {
      if (r.status === "rejected") {
        assert.ok(r.reason instanceof InsufficientTokensError);
      }
    }

    const finalWallet = await TokenWallet.findOne({ userId });
    assert.equal(finalWallet?.balance, 0);
    assert.equal(finalWallet?.reservedTokens, 300);

    await TokenWallet.deleteOne({ userId });
    await TokenReservation.deleteMany({ userId });
  });

  test("9. User wallet initialization initializes reservedTokens to 0", async () => {
    const tempUserId = new mongoose.Types.ObjectId();
    await User.create({
      _id: tempUserId,
      email: `temp_${Date.now()}@test.com`,
      name: "Temp User",
      passwordHash: "hash",
      role: "user",
      plan: "free",
      isActive: true,
    });

    // In the canonical architecture, missing wallet is initialized lazily via createTokenReservation
    const session = await mongoose.startSession();
    session.startTransaction();
    let res: any;
    try {
      res = await createTokenReservation(
        {
          userId: tempUserId,
          conversationId: new mongoose.Types.ObjectId(),
          userMessageId: new mongoose.Types.ObjectId(),
          assistantMessageId: new mongoose.Types.ObjectId(),
          inputTokens: 100,
          maxOutputBudget: 200,
        },
        { session }
      );
      await session.commitTransaction();
    } finally {
      await session.endSession();
    }

    // Reservation of 300 from 10,000 initial grant leaves 9,700 balance and 300 reserved
    assert.equal(res.reservedAmount, 300);

    const wallet = await TokenWallet.findOne({ userId: tempUserId });
    assert.ok(wallet);
    assert.equal(wallet.totalAllocated, TOKEN_CONSTANTS.DEFAULT_FREE_ALLOCATION);
    assert.equal(wallet.totalUsed, 0);
    assert.equal(wallet.balance, TOKEN_CONSTANTS.DEFAULT_FREE_ALLOCATION - 300);
    assert.equal(wallet.reservedTokens, 300);

    // Also assert strictly read-only getUserTokenBalance returns consistent snapshot
    const balanceDTO = await getUserTokenBalance(tempUserId);
    assert.equal(balanceDTO.balance, 9700);
    assert.equal(balanceDTO.totalAllocated, 10000);
    assert.equal(balanceDTO.totalUsed, 0);
    assert.equal(balanceDTO.reservedTokens, 300);

    await TokenWallet.deleteOne({ userId: tempUserId });
    await TokenReservation.deleteOne({ _id: res.reservation._id });
    await User.deleteOne({ _id: tempUserId });
  });

  test("10. Chat integration: sendMessage completes token lifecycle end-to-end", async () => {
    const chatUserId = new mongoose.Types.ObjectId();
    await TokenWallet.create({
      chatUserId,
      userId: chatUserId,
      balance: 10000,
      totalAllocated: 10000,
      totalUsed: 0,
      reservedTokens: 0,
    });

    const conversation = await Conversation.create({
      userId: chatUserId,
      title: "Test Conversation",
    });

    const response = await sendMessage(
      chatUserId.toString(),
      conversation._id.toString(),
      "Respond with the single word: Pong"
    );

    assert.ok(response.userMessage);
    assert.ok(response.assistantMessage);
    assert.equal(response.userMessage.role, "user");
    assert.equal(response.assistantMessage.role, "assistant");

    // Check token usage record was created
    const usage = await TokenUsage.findOne({
      userId: chatUserId,
      conversationId: conversation._id,
      messageId: new mongoose.Types.ObjectId(response.assistantMessage.id),
    });

    assert.ok(usage);
    assert.ok(usage.inputTokens > 0);
    assert.ok(usage.totalTokens >= usage.inputTokens);
    assert.equal(usage.type, "chat");

    // Check wallet balance was deducted
    const wallet = await TokenWallet.findOne({ userId: chatUserId });
    assert.equal(wallet?.reservedTokens, 0);
    assert.equal(wallet?.totalUsed, usage.totalTokens);
    assert.equal(wallet?.balance, 10000 - usage.totalTokens);

    // Cleanup
    await TokenWallet.deleteOne({ userId: chatUserId });
    await TokenUsage.deleteMany({ userId: chatUserId });
    await Message.deleteMany({ conversationId: conversation._id });
    await Conversation.deleteOne({ _id: conversation._id });
  });

  test("11. Chat integration: exhausted balance rejects with 402", async () => {
    const exhaustedUserId = new mongoose.Types.ObjectId();
    await TokenWallet.create({
      userId: exhaustedUserId,
      balance: 0,
      totalAllocated: 10000,
      totalUsed: 10000,
      reservedTokens: 0,
    });

    const conversation = await Conversation.create({
      userId: exhaustedUserId,
      title: "Exhausted Test",
    });

    await assert.rejects(
      async () => {
        await sendMessage(
          exhaustedUserId.toString(),
          conversation._id.toString(),
          "Hello there"
        );
      },
      (error: any) => {
        assert.ok(error instanceof InsufficientTokensError);
        assert.equal(error.statusCode, 402);
        assert.equal(error.message, "Token balance exhausted");
        return true;
      }
    );

    // No messages created
    const messages = await Message.find({ conversationId: conversation._id });
    assert.equal(messages.length, 0);

    await TokenWallet.deleteOne({ userId: exhaustedUserId });
    await Conversation.deleteOne({ _id: conversation._id });
  });

  test("12. Backward compatibility: generateAIResponse still returns string", async () => {
    const text = await generateAIResponse("Respond with the single word: Hello");
    assert.ok(typeof text === "string");
    assert.ok(text.length > 0);
  });

  describe("Token Accounting Review — Consistency Fixes", () => {
    test("A. Assistant message is not permanently stored when token finalization fails", async () => {
      const userId = new mongoose.Types.ObjectId();
      const initialBalance = 1000;
      await TokenWallet.create({
        userId,
        balance: initialBalance,
        totalAllocated: initialBalance,
        totalUsed: 0,
        reservedTokens: 0,
      });

      const conversation = await Conversation.create({
        userId,
        title: "Test A Conversation",
      });

      // Stub TokenUsage.create to simulate finalization persistence failure inside the transaction
      const origTokenUsageCreate = TokenUsage.create;
      (TokenUsage as any).create = async () => {
        throw new Error("Simulated TokenUsage database persistence error");
      };

      // Mock AI so this test is deterministic and independent of external API limits
      const origGenerate = _internalAI.generateAIResponseWithUsage;
      const origCount = _internalAI.countPromptTokens;
      _internalAI.countPromptTokens = async () => 20;
      _internalAI.generateAIResponseWithUsage = async () => ({
        text: "Simulated AI Assistant Reply",
        model: PRIMARY_MODEL,
        inputTokens: 20,
        outputTokens: 30,
        totalTokens: 50,
      });

      try {
        await assert.rejects(
          async () => {
            await sendMessage(userId.toString(), conversation._id.toString(), "Hello Assistant");
          },
          (err: any) => {
            assert.match(err.message, /Simulated TokenUsage database persistence error/);
            return true;
          }
        );

        // Verify: Completed assistant message must NOT be stored
        const assistantMessages = await Message.find({
          conversationId: conversation._id,
          role: "assistant",
          status: "completed",
        });
        assert.equal(assistantMessages.length, 0, "No completed assistant message should be persisted");

        // Verify: No TokenUsage record created
        const usageCount = await TokenUsage.countDocuments({ userId });
        assert.equal(usageCount, 0, "No TokenUsage record should be stored");

        // Verify: Total used was not incremented, and reservation remains preserved for inspection/recovery
        const wallet = await TokenWallet.findOne({ userId });
        assert.equal(wallet?.totalUsed, 0, "Total used must remain 0");
        assert.ok(wallet && wallet.reservedTokens > 0, "Reservation is preserved rather than guessed or double-refunded");
      } finally {
        TokenUsage.create = origTokenUsageCreate;
        _internalAI.generateAIResponseWithUsage = origGenerate;
        _internalAI.countPromptTokens = origCount;
        await TokenWallet.deleteOne({ userId });
        await Message.deleteMany({ conversationId: conversation._id });
        await Conversation.deleteOne({ _id: conversation._id });
      }
    });

    test("B. TokenUsage and wallet remain consistent if persistence fails", async () => {
      const userId = new mongoose.Types.ObjectId();
      const convId = new mongoose.Types.ObjectId();
      const userMsgId = new mongoose.Types.ObjectId();
      const assistantMsgId = new mongoose.Types.ObjectId();
      const initialBalance = 800;

      await TokenWallet.create({
        userId,
        balance: initialBalance,
        totalAllocated: initialBalance,
        totalUsed: 0,
        reservedTokens: 0,
      });

      // Reserve 200 tokens via canonical createTokenReservation
      const resSession = await mongoose.startSession();
      resSession.startTransaction();
      let reservation: any;
      try {
        reservation = await createTokenReservation(
          {
            userId,
            conversationId: convId,
            userMessageId: userMsgId,
            assistantMessageId: assistantMsgId,
            inputTokens: 50,
            maxOutputBudget: 150,
          },
          { session: resSession }
        );
        await resSession.commitTransaction();
      } finally {
        await resSession.endSession();
      }

      assert.equal(reservation.reservedAmount, 200);

      // Verify wallet post-reservation
      let wallet = await TokenWallet.findOne({ userId });
      assert.equal(wallet?.balance, 600);
      assert.equal(wallet?.reservedTokens, 200);

      // Stub TokenUsage.create to simulate persistence error during settleTokenReservation
      const origTokenUsageCreate = TokenUsage.create;
      (TokenUsage as any).create = async () => {
        throw new Error("Simulated standalone TokenUsage write failure");
      };

      const settleSession = await mongoose.startSession();
      settleSession.startTransaction();

      try {
        await assert.rejects(
          async () => {
            await settleTokenReservation(
              {
                userId,
                reservationId: reservation.reservation._id,
                assistantMessageId: assistantMsgId,
                conversationId: convId,
                expectedVersion: reservation.reservation.version,
                usageData: {
                  billedTokens: 100,
                  billedInputTokens: 50,
                  billedOutputTokens: 50,
                  overrunTokens: 0,
                  verificationStatus: "AUTHORITATIVE",
                  model: PRIMARY_MODEL,
                },
              },
              { session: settleSession }
            );
          },
          (err: any) => {
            assert.match(err.message, /Simulated standalone TokenUsage write failure/);
            return true;
          }
        );

        // Abort the failed settlement transaction
        await settleSession.abortTransaction();

        // Release the reservation using refundTokenReservation
        const refundSession = await mongoose.startSession();
        refundSession.startTransaction();
        try {
          await refundTokenReservation(
            {
              userId,
              reservationId: reservation.reservation._id,
              expectedVersion: reservation.reservation.version,
              reason: "Settlement failure recovery",
            },
            { session: refundSession }
          );
          await refundSession.commitTransaction();
        } finally {
          await refundSession.endSession();
        }

        // Verify: Wallet state was restored and reservation released
        wallet = await TokenWallet.findOne({ userId });
        assert.equal(wallet?.reservedTokens, 0, "Reserved tokens must be refunded");
        assert.equal(wallet?.balance, initialBalance, "User must not be charged; balance fully restored");
        assert.equal(wallet?.totalUsed, 0, "totalUsed must not be incremented without audit record");

        // Verify: No orphaned TokenUsage records
        const usages = await TokenUsage.find({ userId });
        assert.equal(usages.length, 0, "No TokenUsage records should exist");
      } finally {
        TokenUsage.create = origTokenUsageCreate;
        await settleSession.endSession();
        await TokenWallet.deleteOne({ userId });
        await TokenReservation.deleteOne({ _id: reservation.reservation._id });
      }
    });

    test("C. Successful chat still stores both assistant message and TokenUsage", async () => {
      const userId = new mongoose.Types.ObjectId();
      const initialBalance = 5000;
      await TokenWallet.create({
        userId,
        balance: initialBalance,
        totalAllocated: initialBalance,
        totalUsed: 0,
        reservedTokens: 0,
      });

      const conversation = await Conversation.create({
        userId,
        title: "Test C Conversation",
      });

      // Mock AI response to keep test deterministic and avoid external quota consumption
      const origGenerate = _internalAI.generateAIResponseWithUsage;
      const origCount = _internalAI.countPromptTokens;
      _internalAI.countPromptTokens = async () => 25;
      _internalAI.generateAIResponseWithUsage = async () => ({
        text: "Deterministic AI Assistant Answer",
        model: PRIMARY_MODEL,
        inputTokens: 25,
        outputTokens: 75,
        totalTokens: 100,
      });

      try {
        const result = await sendMessage(
          userId.toString(),
          conversation._id.toString(),
          "How does token accounting work?"
        );

        assert.ok(result.userMessage);
        assert.ok(result.assistantMessage);
        assert.equal(result.assistantMessage.role, "assistant");
        assert.equal(result.assistantMessage.content, "Deterministic AI Assistant Answer");

        // Verify assistant message is in DB
        const savedMessage = await Message.findById(result.assistantMessage.id);
        assert.ok(savedMessage);
        assert.equal(savedMessage.role, "assistant");

        // Verify TokenUsage is in DB and correctly linked
        const savedUsage = await TokenUsage.findOne({
          userId,
          conversationId: conversation._id,
          messageId: new mongoose.Types.ObjectId(result.assistantMessage.id),
        });
        assert.ok(savedUsage, "TokenUsage document must exist");
        assert.equal(savedUsage.inputTokens, 25);
        assert.equal(savedUsage.outputTokens, 75);
        assert.equal(savedUsage.totalTokens, 100);
        assert.equal(savedUsage.type, "chat");

        // Verify wallet deducted actual tokens
        const wallet = await TokenWallet.findOne({ userId });
        assert.equal(wallet?.reservedTokens, 0);
        assert.equal(wallet?.totalUsed, 100);
        assert.equal(wallet?.balance, initialBalance - 100);
      } finally {
        _internalAI.generateAIResponseWithUsage = origGenerate;
        _internalAI.countPromptTokens = origCount;
        await TokenWallet.deleteOne({ userId });
        await TokenUsage.deleteMany({ userId });
        await Message.deleteMany({ conversationId: conversation._id });
        await Conversation.deleteOne({ _id: conversation._id });
      }
    });

    test("D. Gemini failure still releases reservation", async () => {
      const userId = new mongoose.Types.ObjectId();
      const initialBalance = 1500;
      await TokenWallet.create({
        userId,
        balance: initialBalance,
        totalAllocated: initialBalance,
        totalUsed: 0,
        reservedTokens: 0,
      });

      const conversation = await Conversation.create({
        userId,
        title: "Test D Conversation",
      });

      // Mock Gemini to throw an error
      const origGenerate = _internalAI.generateAIResponseWithUsage;
      const origCount = _internalAI.countPromptTokens;
      _internalAI.countPromptTokens = async () => 30;
      _internalAI.generateAIResponseWithUsage = async () => {
        throw new Error("Simulated Gemini API service unavailable");
      };

      try {
        await assert.rejects(
          async () => {
            await sendMessage(
              userId.toString(),
              conversation._id.toString(),
              "This prompt will trigger Gemini failure"
            );
          },
          (err: any) => {
            assert.ok(err instanceof ChatError);
            assert.equal(err.statusCode, 500);
            assert.equal(err.message, "Failed to generate AI response");
            return true;
          }
        );

        // Verify wallet reservation was safely released back to balance
        const wallet = await TokenWallet.findOne({ userId });
        assert.equal(wallet?.reservedTokens, 0, "Reserved tokens must be released to 0");
        assert.equal(wallet?.balance, initialBalance, "Balance must be restored to initial");
        assert.equal(wallet?.totalUsed, 0, "User must not be charged");

        // Verify no completed assistant message or TokenUsage was created
        const assistantMessages = await Message.find({
          conversationId: conversation._id,
          role: "assistant",
          status: "completed",
        });
        assert.equal(assistantMessages.length, 0);

        const usages = await TokenUsage.find({ userId });
        assert.equal(usages.length, 0);
      } finally {
        _internalAI.generateAIResponseWithUsage = origGenerate;
        _internalAI.countPromptTokens = origCount;
        await TokenWallet.deleteOne({ userId });
        await Message.deleteMany({ conversationId: conversation._id });
        await Conversation.deleteOne({ _id: conversation._id });
      }
    });

    test("E. Excess provider usage is capped to reserved budget and completes safely (EXCESS_CLAMPED)", async () => {
      const userId = new mongoose.Types.ObjectId();
      const initialBalance = 2000;
      await TokenWallet.create({
        userId,
        balance: initialBalance,
        totalAllocated: initialBalance,
        totalUsed: 0,
        reservedTokens: 0,
      });

      const conversation = await Conversation.create({
        userId,
        title: "Test E Conversation",
      });

      // Mock Gemini to return usage that exceeds the reserved budget
      // Prompt tokens = 50 -> reservation = 50 + 1000 = 1050
      // Mock Gemini reporting 1500 tokens (> 1050)
      const origGenerate = _internalAI.generateAIResponseWithUsage;
      const origCount = _internalAI.countPromptTokens;
      _internalAI.countPromptTokens = async () => 50;
      _internalAI.generateAIResponseWithUsage = async () => ({
        text: "Response that somehow blew past token limits",
        model: PRIMARY_MODEL,
        inputTokens: 50,
        outputTokens: 1450,
        totalTokens: 1500,
        rawUsage: {
          promptTokenCount: 50,
          candidatesTokenCount: 1450,
          totalTokenCount: 1500,
        },
      });

      try {
        const response = await sendMessage(
          userId.toString(),
          conversation._id.toString(),
          "Testing excess usage capping in chat"
        );

        assert.ok(response.assistantMessage);
        assert.equal(response.assistantMessage.status, "completed");

        // Verify: TokenUsage capped at 1050 (reserved budget)
        const usage = await TokenUsage.findOne({ messageId: new mongoose.Types.ObjectId(response.assistantMessage.id) });
        assert.ok(usage);
        assert.equal(usage.totalTokens, 1050, "Billed tokens must be capped to reservation amount");
        assert.equal(usage.usageVerification, "EXCESS_CLAMPED");
        assert.equal(usage.providerTotalTokens, 1500);

        // Verify: User wallet never overcharged
        const wallet = await TokenWallet.findOne({ userId });
        assert.equal(wallet?.reservedTokens, 0, "Reserved tokens must be 0");
        assert.equal(wallet?.balance, initialBalance - 1050, "Balance must only deduct the reserved budget");
        assert.equal(wallet?.totalUsed, 1050, "totalUsed must reflect capped billable tokens");
      } finally {
        _internalAI.generateAIResponseWithUsage = origGenerate;
        _internalAI.countPromptTokens = origCount;
        await TokenWallet.deleteOne({ userId });
        await Message.deleteMany({ conversationId: conversation._id });
        await Conversation.deleteOne({ _id: conversation._id });
      }
    });
  });
});

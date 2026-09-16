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
import {
  reserveTokenBudget,
  releaseTokenReservation,
  finalizeTokenUsage,
  getOrCreateWallet,
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
    const reservation = await reserveTokenBudget(userId, inputTokens, 1000);

    // available was 500. min(100 + 1000, 500) = 500
    assert.equal(reservation.reservedAmount, 500);
    // allowedOutputTokens = 500 - 100 = 400
    assert.equal(reservation.allowedOutputTokens, 400);

    const wallet = await TokenWallet.findOne({ userId });
    assert.equal(wallet?.balance, 0);
    assert.equal(wallet?.reservedTokens, 500);

    // Clean up
    await TokenWallet.deleteOne({ userId });
  });

  test("2. Successful generation finalizes actual usage and refunds unused reservation", async () => {
    const userId = new mongoose.Types.ObjectId();
    await TokenWallet.create({
      userId,
      balance: 1000,
      totalAllocated: 1000,
      totalUsed: 0,
      reservedTokens: 0,
    });

    const inputTokens = 50;
    const reservation = await reserveTokenBudget(userId, inputTokens, 500);
    // Reserved = 550, balance left = 450, reservedTokens = 550
    assert.equal(reservation.reservedAmount, 550);

    // Actual usage = 150 total (50 input + 100 output)
    const actualUsage = {
      inputTokens: 50,
      outputTokens: 100,
      totalTokens: 150,
      model: PRIMARY_MODEL,
    };

    const usageDoc = await finalizeTokenUsage(userId, reservation.reservedAmount, actualUsage);

    assert.ok(usageDoc._id);
    assert.equal(usageDoc.totalTokens, 150);

    const wallet = await TokenWallet.findOne({ userId });
    // Balance should be: initial (1000) - actualUsed (150) = 850
    assert.equal(wallet?.balance, 850);
    assert.equal(wallet?.reservedTokens, 0);
    assert.equal(wallet?.totalUsed, 150);

    await TokenWallet.deleteOne({ userId });
    await TokenUsage.deleteOne({ _id: usageDoc._id });
  });

  test("3. TokenUsage document correctly captures all required fields", async () => {
    const userId = new mongoose.Types.ObjectId();
    const convId = new mongoose.Types.ObjectId();
    const msgId = new mongoose.Types.ObjectId();

    await TokenWallet.create({
      userId,
      balance: 1000,
      totalAllocated: 1000,
      totalUsed: 0,
      reservedTokens: 0,
    });

    const reservation = await reserveTokenBudget(userId, 20, 200);

    const usageDoc = await finalizeTokenUsage(userId, reservation.reservedAmount, {
      userId: userId.toString(),
      conversationId: convId.toString(),
      messageId: msgId.toString(),
      inputTokens: 20,
      outputTokens: 50,
      totalTokens: 70,
      model: PRIMARY_MODEL,
      type: "chat",
    } as any);

    const record = await TokenUsage.findById(usageDoc._id);
    assert.ok(record);
    assert.equal(record.userId.toString(), userId.toString());
    assert.equal(record.conversationId?.toString(), convId.toString());
    assert.equal(record.messageId?.toString(), msgId.toString());
    assert.equal(record.inputTokens, 20);
    assert.equal(record.outputTokens, 50);
    assert.equal(record.totalTokens, 70);
    assert.equal(record.model, PRIMARY_MODEL);
    assert.equal(record.type, "chat");

    await TokenWallet.deleteOne({ userId });
    await TokenUsage.deleteOne({ _id: usageDoc._id });
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

    await assert.rejects(
      async () => {
        await reserveTokenBudget(userId, 20);
      },
      (error: any) => {
        assert.ok(error instanceof InsufficientTokensError);
        assert.equal(error.statusCode, 402);
        assert.equal(error.message, "Token balance exhausted");
        return true;
      }
    );

    const wallet = await TokenWallet.findOne({ userId });
    assert.equal(wallet?.balance, 10);
    assert.equal(wallet?.reservedTokens, 0);

    await TokenWallet.deleteOne({ userId });
  });

  test("5. Generation failure releases reservation and preserves wallet consistency", async () => {
    const userId = new mongoose.Types.ObjectId();
    await TokenWallet.create({
      userId,
      balance: 500,
      totalAllocated: 500,
      totalUsed: 0,
      reservedTokens: 0,
    });

    const reservation = await reserveTokenBudget(userId, 50, 300);
    assert.equal(reservation.reservedAmount, 350);

    let wallet = await TokenWallet.findOne({ userId });
    assert.equal(wallet?.balance, 150);
    assert.equal(wallet?.reservedTokens, 350);

    // Simulate failure release
    await releaseTokenReservation(userId, reservation.reservedAmount);

    wallet = await TokenWallet.findOne({ userId });
    assert.equal(wallet?.balance, 500);
    assert.equal(wallet?.reservedTokens, 0);
    assert.equal(wallet?.totalUsed, 0);

    const usageCount = await TokenUsage.countDocuments({ userId });
    assert.equal(usageCount, 0);

    await TokenWallet.deleteOne({ userId });
  });

  test("6. Actual usage invariant: actualUsage > reservedAmount fails safely", async () => {
    const userId = new mongoose.Types.ObjectId();
    await TokenWallet.create({
      userId,
      balance: 500,
      totalAllocated: 500,
      totalUsed: 0,
      reservedTokens: 0,
    });

    const reservation = await reserveTokenBudget(userId, 50, 100);
    assert.equal(reservation.reservedAmount, 150);

    // Attempt finalization with actual usage (200) > reserved (150)
    await assert.rejects(
      async () => {
        await finalizeTokenUsage(userId, reservation.reservedAmount, {
          inputTokens: 50,
          outputTokens: 150,
          totalTokens: 200,
          model: PRIMARY_MODEL,
        });
      },
      (error: any) => {
        assert.ok(error instanceof TokenInvariantViolationError);
        return true;
      }
    );

    // Reservation was safely refunded
    const wallet = await TokenWallet.findOne({ userId });
    assert.equal(wallet?.balance, 500);
    assert.equal(wallet?.reservedTokens, 0);
    assert.equal(wallet?.totalUsed, 0);

    const usageCount = await TokenUsage.countDocuments({ userId });
    assert.equal(usageCount, 0);

    await TokenWallet.deleteOne({ userId });
  });

  test("7. Wallet balance never becomes negative", async () => {
    const userId = new mongoose.Types.ObjectId();
    const wallet = await TokenWallet.create({
      userId,
      balance: 100,
      totalAllocated: 100,
      totalUsed: 0,
      reservedTokens: 0,
    });

    // Attempting to reserve 200 when balance is 100 should cap at 100
    const res = await reserveTokenBudget(userId, 10, 200);
    assert.equal(res.reservedAmount, 100);

    const updated = await TokenWallet.findOne({ userId });
    assert.ok((updated?.balance ?? -1) >= 0);
    assert.equal(updated?.balance, 0);

    // Releasing brings it back to 100
    await releaseTokenReservation(userId, res.reservedAmount);
    const restored = await TokenWallet.findOne({ userId });
    assert.equal(restored?.balance, 100);

    await TokenWallet.deleteOne({ userId });
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

    // 4 concurrent requests each trying to reserve 150 tokens (total 600 > 300)
    const promises = [
      reserveTokenBudget(userId, 50, 100),
      reserveTokenBudget(userId, 50, 100),
      reserveTokenBudget(userId, 50, 100),
      reserveTokenBudget(userId, 50, 100),
    ];

    const results = await Promise.allSettled(promises);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    // Exactly 2 requests can succeed (150 * 2 = 300), the others must be rejected
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
  });

  test("9. User wallet initialization initializes reservedTokens to 0", async () => {
    const tempUserId = new mongoose.Types.ObjectId();
    const wallet = await getOrCreateWallet(tempUserId);

    assert.equal(wallet.balance, TOKEN_CONSTANTS.DEFAULT_FREE_ALLOCATION);
    assert.equal(wallet.totalAllocated, TOKEN_CONSTANTS.DEFAULT_FREE_ALLOCATION);
    assert.equal(wallet.totalUsed, 0);
    assert.equal(wallet.reservedTokens, 0);

    await TokenWallet.deleteOne({ userId: tempUserId });
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

        // Verify: Assistant message must NOT be permanently stored
        const assistantMessages = await Message.find({
          conversationId: conversation._id,
          role: "assistant",
        });
        assert.equal(assistantMessages.length, 0, "No assistant message should be persisted");

        // Verify: No TokenUsage record created
        const usageCount = await TokenUsage.countDocuments({ userId });
        assert.equal(usageCount, 0, "No TokenUsage record should be stored");

        // Verify: Wallet reservation was released safely and user was not charged
        const wallet = await TokenWallet.findOne({ userId });
        assert.equal(wallet?.reservedTokens, 0, "Reserved tokens must be refunded to 0");
        assert.equal(wallet?.balance, initialBalance, "Balance must be fully restored");
        assert.equal(wallet?.totalUsed, 0, "Total used must remain 0");
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
      const initialBalance = 800;
      await TokenWallet.create({
        userId,
        balance: initialBalance,
        totalAllocated: initialBalance,
        totalUsed: 0,
        reservedTokens: 0,
      });

      // Reserve 200 tokens
      const reservation = await reserveTokenBudget(userId, 50, 150);
      assert.equal(reservation.reservedAmount, 200);

      // Verify wallet post-reservation
      let wallet = await TokenWallet.findOne({ userId });
      assert.equal(wallet?.balance, 600);
      assert.equal(wallet?.reservedTokens, 200);

      // Stub TokenUsage.create to simulate persistence error during standalone finalizeTokenUsage
      const origTokenUsageCreate = TokenUsage.create;
      (TokenUsage as any).create = async () => {
        throw new Error("Simulated standalone TokenUsage write failure");
      };

      try {
        await assert.rejects(
          async () => {
            await finalizeTokenUsage(userId, reservation.reservedAmount, {
              inputTokens: 50,
              outputTokens: 50,
              totalTokens: 100,
              model: PRIMARY_MODEL,
            });
          },
          (err: any) => {
            assert.match(err.message, /Simulated standalone TokenUsage write failure/);
            return true;
          }
        );

        // Verify: Wallet state was rolled back by transaction and reservation released
        wallet = await TokenWallet.findOne({ userId });
        assert.equal(wallet?.reservedTokens, 0, "Reserved tokens must be refunded");
        assert.equal(wallet?.balance, initialBalance, "User must not be charged; balance fully restored");
        assert.equal(wallet?.totalUsed, 0, "totalUsed must not be incremented without audit record");

        // Verify: No orphaned TokenUsage records
        const usages = await TokenUsage.find({ userId });
        assert.equal(usages.length, 0, "No TokenUsage records should exist");
      } finally {
        TokenUsage.create = origTokenUsageCreate;
        await TokenWallet.deleteOne({ userId });
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

        // Verify no assistant message or TokenUsage was created
        const assistantMessages = await Message.find({
          conversationId: conversation._id,
          role: "assistant",
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

    test("E. Invariant violation still releases reservation without charging the user", async () => {
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
      });

      try {
        await assert.rejects(
          async () => {
            await sendMessage(
              userId.toString(),
              conversation._id.toString(),
              "Testing invariant violation in chat"
            );
          },
          (err: any) => {
            assert.ok(err instanceof TokenInvariantViolationError);
            return true;
          }
        );

        // Verify: No assistant message stored
        const assistantMessages = await Message.find({
          conversationId: conversation._id,
          role: "assistant",
        });
        assert.equal(assistantMessages.length, 0, "No assistant message must be stored");

        // Verify: No TokenUsage stored
        const usages = await TokenUsage.find({ userId });
        assert.equal(usages.length, 0, "No TokenUsage must be created");

        // Verify: Reservation released safely without charging the user
        const wallet = await TokenWallet.findOne({ userId });
        assert.equal(wallet?.reservedTokens, 0, "Reserved tokens must be 0");
        assert.equal(wallet?.balance, initialBalance, "Balance must be fully refunded");
        assert.equal(wallet?.totalUsed, 0, "totalUsed must remain 0");
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

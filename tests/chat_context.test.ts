import "dotenv/config";
import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { connectDatabase } from "../src/config/database.js";
import { User } from "../src/database/models/user/index.js";
import { TokenWallet } from "../src/database/models/tokenWallet/index.js";
import { Conversation } from "../src/database/models/conversation/index.js";
import { Message } from "../src/database/models/message/index.js";
import { TokenUsage } from "../src/database/models/tokenUsage/index.js";
import {
  sendMessage,
  createConversation,
  _internalAI,
  ChatError,
} from "../src/features/chat/chat.service.js";
import { PRIMARY_MODEL, type GeminiContent } from "../src/features/ai/ai.service.js";

describe("Conversational Context & Chat Memory Test Suite", () => {
  let userAId: mongoose.Types.ObjectId;
  let userBId: mongoose.Types.ObjectId;

  before(async () => {
    await connectDatabase();
    userAId = new mongoose.Types.ObjectId();
    userBId = new mongoose.Types.ObjectId();

    await TokenWallet.create([
      {
        userId: userAId,
        balance: 100000,
        totalAllocated: 100000,
        totalUsed: 0,
        reservedTokens: 0,
      },
      {
        userId: userBId,
        balance: 100000,
        totalAllocated: 100000,
        totalUsed: 0,
        reservedTokens: 0,
      },
    ]);
  });

  after(async () => {
    await TokenWallet.deleteMany({ userId: { $in: [userAId, userBId] } });
    await TokenUsage.deleteMany({ userId: { $in: [userAId, userBId] } });
    await Conversation.deleteMany({ userId: { $in: [userAId, userBId] } });
    await Message.deleteMany({ userId: { $in: [userAId, userBId] } });
    await mongoose.disconnect();
  });

  test("1. First message in a new conversation sends only 1 user turn to Gemini and countPromptTokens", async () => {
    const conv = await createConversation(userAId.toString(), "Test 1");
    let recordedPromptForCount: any = null;
    let recordedPromptForGen: any = null;

    const origCount = _internalAI.countPromptTokens;
    const origGen = _internalAI.generateAIResponseWithUsage;

    _internalAI.countPromptTokens = async (prompt) => {
      recordedPromptForCount = prompt;
      return 20;
    };
    _internalAI.generateAIResponseWithUsage = async (prompt, allowedOutputTokens) => {
      recordedPromptForGen = prompt;
      return {
        text: "Hello there! How can I help you?",
        model: PRIMARY_MODEL,
        inputTokens: 20,
        outputTokens: 10,
        totalTokens: 30,
      };
    };

    try {
      const res = await sendMessage(userAId.toString(), conv.id, "Hello from user");
      assert.equal(res.userMessage.content, "Hello from user");
      assert.equal(res.assistantMessage.content, "Hello there! How can I help you?");

      // Verify prompt format
      assert(Array.isArray(recordedPromptForCount));
      assert.equal(recordedPromptForCount.length, 1);
      assert.equal(recordedPromptForCount[0].role, "user");
      assert.equal(recordedPromptForCount[0].parts[0].text, "Hello from user");

      assert(Array.isArray(recordedPromptForGen));
      assert.equal(recordedPromptForGen.length, 1);
      assert.equal(recordedPromptForGen[0].role, "user");
      assert.equal(recordedPromptForGen[0].parts[0].text, "Hello from user");
    } finally {
      _internalAI.countPromptTokens = origCount;
      _internalAI.generateAIResponseWithUsage = origGen;
    }
  });

  test("2. Second message receives previous user and assistant context", async () => {
    const conv = await createConversation(userAId.toString(), "Test 2");

    let recordedPrompt: any = null;
    const origCount = _internalAI.countPromptTokens;
    const origGen = _internalAI.generateAIResponseWithUsage;

    _internalAI.countPromptTokens = async () => 20;
    _internalAI.generateAIResponseWithUsage = async (prompt) => {
      recordedPrompt = prompt;
      return {
        text: "Turn response",
        model: PRIMARY_MODEL,
        inputTokens: 20,
        outputTokens: 10,
        totalTokens: 30,
      };
    };

    try {
      // Turn 1
      await sendMessage(userAId.toString(), conv.id, "I love electric vehicles");

      // Turn 2
      await sendMessage(userAId.toString(), conv.id, "Which model is the fastest?");

      assert(Array.isArray(recordedPrompt));
      assert.equal(recordedPrompt.length, 3);

      // Turn 1 user
      assert.equal(recordedPrompt[0].role, "user");
      assert.equal(recordedPrompt[0].parts[0].text, "I love electric vehicles");

      // Turn 1 assistant (Gemini role: model)
      assert.equal(recordedPrompt[1].role, "model");
      assert.equal(recordedPrompt[1].parts[0].text, "Turn response");

      // Turn 2 user
      assert.equal(recordedPrompt[2].role, "user");
      assert.equal(recordedPrompt[2].parts[0].text, "Which model is the fastest?");
    } finally {
      _internalAI.countPromptTokens = origCount;
      _internalAI.generateAIResponseWithUsage = origGen;
    }
  });

  test("3. 'tell me more about that' uses previous context", async () => {
    const conv = await createConversation(userAId.toString(), "Test 3");

    let secondPrompt: any = null;
    const origCount = _internalAI.countPromptTokens;
    const origGen = _internalAI.generateAIResponseWithUsage;

    _internalAI.countPromptTokens = async () => 25;
    let turn = 0;
    _internalAI.generateAIResponseWithUsage = async (prompt) => {
      turn++;
      if (turn === 2) {
        secondPrompt = prompt;
      }
      return {
        text: turn === 1 ? "Apex Predator is a hypercar concept." : "Apex Predator features a quad-turbo V16 engine.",
        model: PRIMARY_MODEL,
        inputTokens: 25,
        outputTokens: 15,
        totalTokens: 40,
      };
    };

    try {
      await sendMessage(userAId.toString(), conv.id, "Tell me about Apex Predator car");
      await sendMessage(userAId.toString(), conv.id, "tell me more about that");

      assert(Array.isArray(secondPrompt));
      assert.equal(secondPrompt.length, 3);
      assert.equal(secondPrompt[0].parts[0].text, "Tell me about Apex Predator car");
      assert.equal(secondPrompt[1].parts[0].text, "Apex Predator is a hypercar concept.");
      assert.equal(secondPrompt[2].parts[0].text, "tell me more about that");
    } finally {
      _internalAI.countPromptTokens = origCount;
      _internalAI.generateAIResponseWithUsage = origGen;
    }
  });

  test("4. Persisted conversation reopened and continued retrieves MongoDB history", async () => {
    const conv = await createConversation(userAId.toString(), "Test 4 Reopened");

    const origCount = _internalAI.countPromptTokens;
    const origGen = _internalAI.generateAIResponseWithUsage;

    _internalAI.countPromptTokens = async () => 30;
    _internalAI.generateAIResponseWithUsage = async () => ({
      text: "Persisted reply",
      model: PRIMARY_MODEL,
      inputTokens: 30,
      outputTokens: 10,
      totalTokens: 40,
    });

    try {
      // First session: 1 turn
      await sendMessage(userAId.toString(), conv.id, "First session message");

      // Verify MongoDB contains messages
      const msgsInDb = await Message.find({ conversationId: conv.id }).sort({ createdAt: 1 });
      assert.equal(msgsInDb.length, 2);

      // Reopen in a simulated new session / request later
      let recordedPromptLater: any = null;
      _internalAI.generateAIResponseWithUsage = async (prompt) => {
        recordedPromptLater = prompt;
        return {
          text: "Continued reply",
          model: PRIMARY_MODEL,
          inputTokens: 30,
          outputTokens: 10,
          totalTokens: 40,
        };
      };

      await sendMessage(userAId.toString(), conv.id, "Continuing after reopening chat");

      assert(Array.isArray(recordedPromptLater));
      assert.equal(recordedPromptLater.length, 3);
      assert.equal(recordedPromptLater[0].parts[0].text, "First session message");
      assert.equal(recordedPromptLater[1].parts[0].text, "Persisted reply");
      assert.equal(recordedPromptLater[2].parts[0].text, "Continuing after reopening chat");
    } finally {
      _internalAI.countPromptTokens = origCount;
      _internalAI.generateAIResponseWithUsage = origGen;
    }
  });

  test("5. Multiple turns maintain chronological order", async () => {
    const conv = await createConversation(userAId.toString(), "Test 5 Order");

    let lastPrompt: any = null;
    const origCount = _internalAI.countPromptTokens;
    const origGen = _internalAI.generateAIResponseWithUsage;

    let step = 0;
    _internalAI.countPromptTokens = async () => 20;
    _internalAI.generateAIResponseWithUsage = async (prompt) => {
      step++;
      lastPrompt = prompt;
      return {
        text: `Answer ${step}`,
        model: PRIMARY_MODEL,
        inputTokens: 20,
        outputTokens: 10,
        totalTokens: 30,
      };
    };

    try {
      await sendMessage(userAId.toString(), conv.id, "Step 1 question");
      await sendMessage(userAId.toString(), conv.id, "Step 2 question");
      await sendMessage(userAId.toString(), conv.id, "Step 3 question");

      assert(Array.isArray(lastPrompt));
      assert.equal(lastPrompt.length, 5); // U1, A1, U2, A2, U3
      assert.equal(lastPrompt[0].parts[0].text, "Step 1 question");
      assert.equal(lastPrompt[1].parts[0].text, "Answer 1");
      assert.equal(lastPrompt[2].parts[0].text, "Step 2 question");
      assert.equal(lastPrompt[3].parts[0].text, "Answer 2");
      assert.equal(lastPrompt[4].parts[0].text, "Step 3 question");
    } finally {
      _internalAI.countPromptTokens = origCount;
      _internalAI.generateAIResponseWithUsage = origGen;
    }
  });

  test("6. Assistant messages are sent with the correct Gemini role ('model')", async () => {
    const conv = await createConversation(userAId.toString(), "Test 6 Role");

    let promptSeen: any = null;
    const origCount = _internalAI.countPromptTokens;
    const origGen = _internalAI.generateAIResponseWithUsage;

    _internalAI.countPromptTokens = async () => 20;
    _internalAI.generateAIResponseWithUsage = async (prompt) => {
      promptSeen = prompt;
      return {
        text: "Assistant response",
        model: PRIMARY_MODEL,
        inputTokens: 20,
        outputTokens: 10,
        totalTokens: 30,
      };
    };

    try {
      await sendMessage(userAId.toString(), conv.id, "User Q1");
      await sendMessage(userAId.toString(), conv.id, "User Q2");

      const assistantTurn = promptSeen[1];
      assert.equal(assistantTurn.role, "model", "Assistant role must be mapped to 'model'");
      assert.notEqual(assistantTurn.role, "assistant");
      assert.notEqual(assistantTurn.role, "user");
    } finally {
      _internalAI.countPromptTokens = origCount;
      _internalAI.generateAIResponseWithUsage = origGen;
    }
  });

  test("7. Current message is not duplicated in Gemini request", async () => {
    const conv = await createConversation(userAId.toString(), "Test 7 No Duplication");

    let promptSeen: any = null;
    const origCount = _internalAI.countPromptTokens;
    const origGen = _internalAI.generateAIResponseWithUsage;

    _internalAI.countPromptTokens = async () => 20;
    _internalAI.generateAIResponseWithUsage = async (prompt) => {
      promptSeen = prompt;
      return {
        text: "Response",
        model: PRIMARY_MODEL,
        inputTokens: 20,
        outputTokens: 10,
        totalTokens: 30,
      };
    };

    try {
      await sendMessage(userAId.toString(), conv.id, "Unique User Message Content 12345");

      const occurrences = promptSeen.filter(
        (c: GeminiContent) => c.parts[0].text === "Unique User Message Content 12345"
      );
      assert.equal(occurrences.length, 1, "Latest message must be included exactly once");
    } finally {
      _internalAI.countPromptTokens = origCount;
      _internalAI.generateAIResponseWithUsage = origGen;
    }
  });

  test("8. Different users cannot access or use another user's conversation history", async () => {
    const convA = await createConversation(userAId.toString(), "User A Secret Conv");

    const origCount = _internalAI.countPromptTokens;
    const origGen = _internalAI.generateAIResponseWithUsage;

    _internalAI.countPromptTokens = async () => 20;
    _internalAI.generateAIResponseWithUsage = async () => ({
      text: "User A Secret Answer",
      model: PRIMARY_MODEL,
      inputTokens: 20,
      outputTokens: 10,
      totalTokens: 30,
    });

    try {
      await sendMessage(userAId.toString(), convA.id, "Secret message for User A only");

      // User B attempts to access or send to User A's conversation
      await assert.rejects(
        async () => {
          await sendMessage(userBId.toString(), convA.id, "Sneaky prompt from User B");
        },
        (err: any) => {
          assert.equal(err.statusCode, 404);
          assert.match(err.message, /Conversation not found/);
          return true;
        }
      );
    } finally {
      _internalAI.countPromptTokens = origCount;
      _internalAI.generateAIResponseWithUsage = origGen;
    }
  });

  test("9. Token counting includes the actual conversation context", async () => {
    const conv = await createConversation(userAId.toString(), "Test 9 Count Context");

    let tokensCountedArg: any = null;
    const origCount = _internalAI.countPromptTokens;
    const origGen = _internalAI.generateAIResponseWithUsage;

    _internalAI.countPromptTokens = async (prompt) => {
      tokensCountedArg = prompt;
      return 50;
    };
    _internalAI.generateAIResponseWithUsage = async () => ({
      text: "Reply",
      model: PRIMARY_MODEL,
      inputTokens: 50,
      outputTokens: 10,
      totalTokens: 60,
    });

    try {
      await sendMessage(userAId.toString(), conv.id, "Question 1");
      await sendMessage(userAId.toString(), conv.id, "Question 2");

      // Verify countPromptTokens received full multi-turn array
      assert(Array.isArray(tokensCountedArg));
      assert.equal(tokensCountedArg.length, 3);
      assert.equal(tokensCountedArg[0].parts[0].text, "Question 1");
      assert.equal(tokensCountedArg[1].parts[0].text, "Reply");
      assert.equal(tokensCountedArg[2].parts[0].text, "Question 2");
    } finally {
      _internalAI.countPromptTokens = origCount;
      _internalAI.generateAIResponseWithUsage = origGen;
    }
  });

  test("10. Token reservation, finalization, and refund behavior remain correct with multi-turn context", async () => {
    const testUser = new mongoose.Types.ObjectId();
    await TokenWallet.create({
      userId: testUser,
      balance: 10000,
      totalAllocated: 10000,
      totalUsed: 0,
      reservedTokens: 0,
    });

    const conv = await createConversation(testUser.toString(), "Test 10 Financials");

    const origCount = _internalAI.countPromptTokens;
    const origGen = _internalAI.generateAIResponseWithUsage;

    // Simulate multi-turn context token sizes
    let inputTokensForCall = 100;
    _internalAI.countPromptTokens = async () => inputTokensForCall;
    _internalAI.generateAIResponseWithUsage = async () => ({
      text: "Multi-turn assistant output",
      model: PRIMARY_MODEL,
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
    });

    try {
      // Turn 1
      await sendMessage(testUser.toString(), conv.id, "Turn 1");

      const wallet1 = await TokenWallet.findOne({ userId: testUser });
      assert.equal(wallet1?.reservedTokens, 0, "Reserved tokens must return to 0 after finalization");
      assert.equal(wallet1?.totalUsed, 150, "Total used must equal actual totalTokens");
      assert.equal(wallet1?.balance, 10000 - 150, "Balance must be exactly debited by actual usage");

      // Turn 2 with higher context input tokens
      inputTokensForCall = 250;
      _internalAI.generateAIResponseWithUsage = async () => ({
        text: "Turn 2 output",
        model: PRIMARY_MODEL,
        inputTokens: 250,
        outputTokens: 50,
        totalTokens: 300,
      });

      await sendMessage(testUser.toString(), conv.id, "Turn 2");

      const wallet2 = await TokenWallet.findOne({ userId: testUser });
      assert.equal(wallet2?.reservedTokens, 0);
      assert.equal(wallet2?.totalUsed, 450); // 150 + 300
      assert.equal(wallet2?.balance, 10000 - 450);

      // Verify TokenUsage documents
      const usages = await TokenUsage.find({ userId: testUser });
      assert.equal(usages.length, 2);
      assert.equal(usages[0].totalTokens, 150);
      assert.equal(usages[1].totalTokens, 300);
    } finally {
      _internalAI.countPromptTokens = origCount;
      _internalAI.generateAIResponseWithUsage = origGen;
      await TokenWallet.deleteOne({ userId: testUser });
      await TokenUsage.deleteMany({ userId: testUser });
      await Conversation.deleteMany({ userId: testUser });
      await Message.deleteMany({ userId: testUser });
    }
  });

  test("11. Context window sliding logic limits max history to MAX_CONTEXT_MESSAGES without corrupting roles", async () => {
    const conv = await createConversation(userAId.toString(), "Test 11 Context Window");

    // Pre-populate 60 messages in MongoDB
    const dummyMessages = [];
    for (let i = 1; i <= 60; i++) {
      dummyMessages.push({
        conversationId: new mongoose.Types.ObjectId(conv.id),
        userId: userAId,
        role: i % 2 === 1 ? "user" : "assistant",
        content: `Message ${i}`,
        createdAt: new Date(Date.now() - (61 - i) * 1000),
      });
    }
    await Message.insertMany(dummyMessages);

    let passedContents: any = null;
    const origCount = _internalAI.countPromptTokens;
    const origGen = _internalAI.generateAIResponseWithUsage;

    _internalAI.countPromptTokens = async () => 20;
    _internalAI.generateAIResponseWithUsage = async (prompt) => {
      passedContents = prompt;
      return {
        text: "Context window reply",
        model: PRIMARY_MODEL,
        inputTokens: 20,
        outputTokens: 10,
        totalTokens: 30,
      };
    };

    try {
      await sendMessage(userAId.toString(), conv.id, "Message 61");

      assert(Array.isArray(passedContents));
      // Window should be <= 51 (max 50 history + 1 new user message)
      assert(passedContents.length <= 51);
      // First turn must start with a valid 'user' turn, not orphaned 'model'
      assert.equal(passedContents[0].role, "user");
      // Last turn is the new user message
      assert.equal(passedContents[passedContents.length - 1].parts[0].text, "Message 61");
      assert.equal(passedContents[passedContents.length - 1].role, "user");
    } finally {
      _internalAI.countPromptTokens = origCount;
      _internalAI.generateAIResponseWithUsage = origGen;
    }
  });
});

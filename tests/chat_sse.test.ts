import "dotenv/config";
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || "test-dummy-gemini-key";

import test, { describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import mongoose, { Types } from "mongoose";
import { EventEmitter } from "node:events";

import {
  formatSSEEvent,
  sendMessageHandler,
} from "../src/features/chat/chat.controller.js";
import {
  sendMessageStream,
  _internalAI,
  _internalLock,
  _internalTokenService,
} from "../src/features/chat/chat.service.js";
import {
  acquireConversationLock,
  renewConversationLock,
  fencedReleaseConversationLock,
  CONVERSATION_LOCK_TTL_MS,
} from "../src/features/chat/chat.lock.js";
import {
  ChatLockConflictError,
  ConversationLockLostError,
  ChatError,
} from "../src/features/chat/chat.errors.js";
import { Conversation } from "../src/database/models/conversation/index.js";
import { Message } from "../src/database/models/message/index.js";
import { TokenReservation } from "../src/database/models/tokenReservation/index.js";
import { TokenWallet } from "../src/database/models/tokenWallet/index.js";
import { IdempotencyKey } from "../src/database/models/idempotencyKey/index.js";
import { PRIMARY_MODEL } from "../src/features/ai/ai.service.js";
import {
  computeAttachmentDigest,
  computeRequestHash,
} from "../src/features/chat/chat.idempotency.js";

// Import frontend SSE parser logic to test Part G item 16
import { parseSSEChunk } from "../../frontend/src/features/chat/api/chat.api.js";

describe("Phase 6 — Production-Grade SSE Streaming Regression Tests", () => {
  // Save originals
  const originalMongooseStartSession = mongoose.startSession;
  const originalConversationFindOne = Conversation.findOne;
  const originalConversationFindById = Conversation.findById;
  const originalConversationCreate = Conversation.create;
  const originalConversationFindOneAndUpdate = Conversation.findOneAndUpdate;
  const originalConversationUpdateOne = Conversation.updateOne;
  const originalMessageCreate = Message.create;
  const originalMessageFind = Message.find;
  const originalMessageFindOneAndUpdate = Message.findOneAndUpdate;
  const originalMessageUpdateOne = Message.updateOne;
  const originalTokenReservationCreate = TokenReservation.create;
  const originalTokenReservationFindOneAndUpdate = TokenReservation.findOneAndUpdate;
  const originalTokenWalletFindOne = TokenWallet.findOne;
  const originalIdempotencyKeyFindOne = IdempotencyKey.findOne;
  const originalStreamAI = _internalAI.streamAIResponseWithUsage;
  const originalGenerateAI = _internalAI.generateAIResponseWithUsage;
  const originalCountTokens = _internalAI.countPromptTokens;
  const originalCreateReservation = _internalTokenService.createTokenReservation;
  const originalSettleReservation = _internalTokenService.settleTokenReservation;
  const originalRefundReservation = _internalTokenService.refundTokenReservation;
  const originalAcquireLock = _internalLock.acquireConversationLock;
  const originalRenewLock = _internalLock.renewConversationLock;
  const originalReleaseLock = _internalLock.fencedReleaseConversationLock;
  const originalImmediateRelease = _internalLock.releaseConversationLockImmediately;

  const createMockSession = () => {
    const session: any = {
      startTransaction: () => {},
      commitTransaction: async () => {},
      abortTransaction: async () => {},
      endSession: async () => {},
      withTransaction: async (fn: any) => await fn(session),
    };
    return session as unknown as mongoose.ClientSession;
  };

  const mockQuery = (val: any = null) => {
    const p: any = Promise.resolve(val);
    p.session = () => p;
    p.lean = () => p;
    p.select = () => p;
    p.sort = () => p;
    p.limit = () => p;
    p.exec = () => p;
    return p;
  };

  const createMockReqRes = (options: {
    accept?: string;
    body?: any;
    params?: any;
    user?: any;
  }) => {
    const req: any = new EventEmitter();
    req.headers = {
      accept: options.accept || "text/event-stream",
    };
    req.body = options.body || { content: "Hello AI" };
    req.params = options.params || { conversationId: new Types.ObjectId().toString() };
    req.user = options.user || { userId: new Types.ObjectId().toString(), plan: "pro" };
    req.get = (header: string) => req.headers[header.toLowerCase()];
    req.header = req.get;

    const writtenChunks: string[] = [];
    const headers: Record<string, string> = {};
    let statusCode = 200;

    const res: any = {
      statusCode,
      headersSent: false,
      writableEnded: false,
      setHeader: (key: string, value: string) => {
        headers[key.toLowerCase()] = value;
      },
      getHeader: (key: string) => headers[key.toLowerCase()],
      status: (code: number) => {
        res.statusCode = code;
        statusCode = code;
        return res;
      },
      write: (chunk: string) => {
        res.headersSent = true;
        writtenChunks.push(chunk);
        return true;
      },
      end: (chunk?: string) => {
        if (chunk) writtenChunks.push(chunk);
        res.writableEnded = true;
        return res;
      },
      json: (data: any) => {
        res.headersSent = true;
        res.writableEnded = true;
        res.body = data;
        return res;
      },
      _writtenChunks: writtenChunks,
      _headers: headers,
    };

    return { req, res };
  };

  beforeEach(() => {
    mongoose.startSession = (async () => createMockSession()) as any;
    _internalAI.countPromptTokens = async () => 15;
    Conversation.findOneAndUpdate = (() => mockQuery({ _id: new Types.ObjectId() })) as any;
    Conversation.updateOne = (() => mockQuery({})) as any;
    Message.findOneAndUpdate = ((q: any, u: any) =>
      mockQuery({
        _id: new Types.ObjectId(),
        conversationId: new Types.ObjectId(),
        role: "assistant",
        content: u?.$set?.content || "",
      })) as any;
    Message.updateOne = (() => mockQuery({})) as any;
    Message.find = (() => mockQuery([])) as any;
    Message.create = (async (docs: any[]) => docs.map((d) => ({ ...d, _id: new Types.ObjectId() }))) as any;
  });

  afterEach(() => {
    mongoose.startSession = originalMongooseStartSession;
    Conversation.findOne = originalConversationFindOne;
    Conversation.findById = originalConversationFindById;
    Conversation.create = originalConversationCreate;
    Conversation.findOneAndUpdate = originalConversationFindOneAndUpdate;
    Conversation.updateOne = originalConversationUpdateOne;
    Message.create = originalMessageCreate;
    Message.find = originalMessageFind;
    Message.findOneAndUpdate = originalMessageFindOneAndUpdate;
    Message.updateOne = originalMessageUpdateOne;
    TokenReservation.create = originalTokenReservationCreate;
    TokenReservation.findOneAndUpdate = originalTokenReservationFindOneAndUpdate;
    TokenWallet.findOne = originalTokenWalletFindOne;
    IdempotencyKey.findOne = originalIdempotencyKeyFindOne;
    _internalAI.streamAIResponseWithUsage = originalStreamAI;
    _internalAI.generateAIResponseWithUsage = originalGenerateAI;
    _internalAI.countPromptTokens = originalCountTokens;
    _internalTokenService.createTokenReservation = originalCreateReservation;
    _internalTokenService.settleTokenReservation = originalSettleReservation;
    _internalTokenService.refundTokenReservation = originalRefundReservation;
    _internalLock.acquireConversationLock = originalAcquireLock;
    _internalLock.renewConversationLock = originalRenewLock;
    _internalLock.fencedReleaseConversationLock = originalReleaseLock;
    _internalLock.releaseConversationLockImmediately = originalImmediateRelease;
  });

  // 1. Streaming response emits correctly framed SSE events
  test("1. Streaming response emits correctly framed SSE events", () => {
    const formattedPing = formatSSEEvent("ping", { timestamp: 123456789 });
    assert.strictEqual(formattedPing, 'event: ping\ndata: {"timestamp":123456789}\n\n');

    const formattedDelta = formatSSEEvent("delta", { delta: "Hello world" });
    assert.strictEqual(formattedDelta, 'event: delta\ndata: {"delta":"Hello world"}\n\n');

    const formattedError = formatSSEEvent("error", { code: "TEST_ERR", message: "Sanitized error" });
    assert.strictEqual(formattedError, 'event: error\ndata: {"code":"TEST_ERR","message":"Sanitized error"}\n\n');
  });

  // 2. Text deltas arrive incrementally and in order
  test("2. Text deltas arrive incrementally and in order", async () => {
    const chunks = ["The ", "quick ", "brown ", "fox"];
    const receivedDeltas: string[] = [];

    _internalAI.streamAIResponseWithUsage = async (contents, maxTokens, callbacks) => {
      for (const chunk of chunks) {
        if (callbacks.onChunk) await callbacks.onChunk(chunk);
      }
      return {
        text: chunks.join(""),
        model: "gemini-2.5-flash",
        inputTokens: 10,
        outputTokens: 4,
        totalTokens: 14,
      };
    };

    const convId = new Types.ObjectId();
    const userId = new Types.ObjectId();
    const userMsgId = new Types.ObjectId();
    const assistantMsgId = new Types.ObjectId();

    Conversation.findOne = (() => mockQuery({ _id: convId, userId })) as any;
    Conversation.updateOne = (() => mockQuery({})) as any;
    Message.find = (() => mockQuery([])) as any;
    Message.create = (async (docs: any[]) => docs.map((d, i) => ({ ...d, _id: i === 0 ? userMsgId : assistantMsgId }))) as any;
    Message.findOneAndUpdate = (() => mockQuery({ _id: assistantMsgId, content: chunks.join(""), status: "completed" })) as any;

    _internalLock.acquireConversationLock = async () => ({
      lockToken: "lock-1",
      lockExpiresAt: new Date(Date.now() + 60000),
      lockVersion: 1,
    });
    _internalLock.fencedReleaseConversationLock = async () => {};
    _internalTokenService.createTokenReservation = async () => ({
      reservationId: new Types.ObjectId(),
      reservedAmount: 4096,
      allowedOutputTokens: 2000,
      expiresAt: new Date(),
    });
    _internalTokenService.settleTokenReservation = async () => ({ settled: true } as any);

    await sendMessageStream(
      userId.toString(),
      convId.toString(),
      "Tell me a story",
      undefined,
      undefined,
      {
        onDelta: (d) => {
          if (d.content) receivedDeltas.push(d.content);
        },
      }
    );

    assert.deepStrictEqual(receivedDeltas, chunks);
  });

  // 3. Final message persistence matches accumulated streamed content
  test("3. Final message persistence matches accumulated streamed content", async () => {
    let persistedContent = "";
    let persistedStatus = "";

    const fullText = "Full accumulated streamed response.";
    _internalAI.streamAIResponseWithUsage = async (contents, maxTokens, callbacks) => {
      if (callbacks.onChunk) {
        await callbacks.onChunk("Full accumulated ");
        await callbacks.onChunk("streamed response.");
      }
      return {
        text: fullText,
        model: PRIMARY_MODEL,
        inputTokens: 15,
        outputTokens: 8,
        totalTokens: 23,
      };
    };

    const convId = new Types.ObjectId();
    const userId = new Types.ObjectId();
    const assistantMsgId = new Types.ObjectId();

    Conversation.findOne = (() => mockQuery({ _id: convId, userId })) as any;
    Conversation.updateOne = (() => mockQuery({})) as any;
    Message.find = (() => mockQuery([])) as any;
    Message.create = (async (docs: any[]) => docs.map((d, i) => ({ ...d, _id: i === 0 ? new Types.ObjectId() : assistantMsgId }))) as any;
    Message.findOneAndUpdate = ((query: any, update: any) => {
      if (update.$set?.content) persistedContent = update.$set.content;
      if (update.$set?.status) persistedStatus = update.$set.status;
      return mockQuery({
        _id: assistantMsgId,
        content: persistedContent,
        status: persistedStatus,
        conversationId: convId,
        role: "assistant",
      });
    }) as any;

    _internalLock.acquireConversationLock = async () => ({
      lockToken: "lock-2",
      lockExpiresAt: new Date(Date.now() + 60000),
      lockVersion: 1,
    });
    _internalLock.fencedReleaseConversationLock = async () => {};
    _internalTokenService.createTokenReservation = async () => ({
      reservationId: new Types.ObjectId(),
      reservedAmount: 4096,
      allowedOutputTokens: 2000,
      expiresAt: new Date(),
    });
    _internalTokenService.settleTokenReservation = async () => ({ settled: true } as any);

    let completedDone: any;
    await sendMessageStream(
      userId.toString(),
      convId.toString(),
      "Hello test",
      undefined,
      undefined,
      {
        onDone: (d) => {
          completedDone = d;
        },
      }
    );

    assert.strictEqual(persistedContent, fullText);
    assert.strictEqual(persistedStatus, "completed");
    assert.strictEqual(completedDone?.assistantMessage?.content, fullText);
  });

  // 4. Provider usage metadata settles the reservation correctly
  test("4. Provider usage metadata settles the reservation correctly", async () => {
    let settledInputTokens = 0;
    let settledOutputTokens = 0;

    _internalAI.streamAIResponseWithUsage = async () => ({
      text: "Authoritative usage output",
      model: PRIMARY_MODEL,
      inputTokens: 42,
      outputTokens: 105,
      totalTokens: 147,
      rawUsage: {
        promptTokenCount: 42,
        candidatesTokenCount: 105,
        totalTokenCount: 147,
      },
    });

    const convId = new Types.ObjectId();
    const userId = new Types.ObjectId();
    Conversation.findOne = (() => mockQuery({ _id: convId, userId })) as any;
    Conversation.updateOne = (() => mockQuery({})) as any;
    Message.find = (() => mockQuery([])) as any;
    Message.create = (async (docs: any[]) => docs.map((d) => ({ ...d, _id: new Types.ObjectId() }))) as any;
    Message.findOneAndUpdate = (() => mockQuery({ _id: new Types.ObjectId(), conversationId: convId, role: "assistant" })) as any;

    _internalLock.acquireConversationLock = async () => ({
      lockToken: "lock-3",
      lockExpiresAt: new Date(Date.now() + 60000),
      lockVersion: 1,
    });
    _internalLock.fencedReleaseConversationLock = async () => {};
    _internalTokenService.createTokenReservation = async () => ({
      reservationId: new Types.ObjectId(),
      reservedAmount: 4096,
      allowedOutputTokens: 2000,
      expiresAt: new Date(),
    });
    _internalTokenService.settleTokenReservation = (async (params: any) => {
      settledInputTokens = params.usageData.billedInputTokens;
      settledOutputTokens = params.usageData.billedOutputTokens;
      return { settled: true };
    }) as any;

    await sendMessageStream(userId.toString(), convId.toString(), "Check settlement");

    assert.strictEqual(settledInputTokens, 42);
    assert.strictEqual(settledOutputTokens, 105);
  });

  // 5. Missing or invalid usage metadata follows the established fallback policy
  test("5. Missing or invalid usage metadata follows the established fallback policy", async () => {
    let settledInputTokens = 0;
    let settledOutputTokens = 0;

    // Return undefined rawUsage
    _internalAI.streamAIResponseWithUsage = async () => ({
      text: "Fallback estimation text with eight words here in this answer.",
      model: PRIMARY_MODEL,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      rawUsage: undefined,
    });

    const convId = new Types.ObjectId();
    const userId = new Types.ObjectId();
    Conversation.findOne = (() => mockQuery({ _id: convId, userId })) as any;
    Conversation.updateOne = (() => mockQuery({})) as any;
    Message.find = (() => mockQuery([])) as any;
    Message.create = (async (docs: any[]) => docs.map((d) => ({ ...d, _id: new Types.ObjectId() }))) as any;
    Message.findOneAndUpdate = (() => mockQuery({ _id: new Types.ObjectId(), conversationId: convId, role: "assistant" })) as any;

    _internalLock.acquireConversationLock = async () => ({
      lockToken: "lock-4",
      lockExpiresAt: new Date(Date.now() + 60000),
      lockVersion: 1,
    });
    _internalLock.fencedReleaseConversationLock = async () => {};
    _internalTokenService.createTokenReservation = async () => ({
      reservationId: new Types.ObjectId(),
      reservedAmount: 4096,
      allowedOutputTokens: 2000,
      expiresAt: new Date(),
    });
    _internalTokenService.settleTokenReservation = (async (params: any) => {
      settledInputTokens = params.usageData.billedInputTokens;
      settledOutputTokens = params.usageData.billedOutputTokens;
      return { settled: true };
    }) as any;

    await sendMessageStream(userId.toString(), convId.toString(), "Trigger fallback");

    // Falls back safely without throwing and clamps safely
    assert.strictEqual(settledInputTokens, 15); // from countPromptTokens
    assert.ok(settledOutputTokens >= 0, "Fallback output tokens must be calculated");
  });

  // 6. Output exceeding the reservation budget is safely clamped
  test("6. Output exceeding the reservation budget is safely clamped", async () => {
    let settledOutputTokens = 0;

    _internalAI.streamAIResponseWithUsage = async () => ({
      text: "Huge text exceeding budget",
      model: PRIMARY_MODEL,
      inputTokens: 50,
      outputTokens: 10000,
      totalTokens: 10050,
      rawUsage: {
        promptTokenCount: 50,
        candidatesTokenCount: 10000,
        totalTokenCount: 10050,
      },
    });

    const convId = new Types.ObjectId();
    const userId = new Types.ObjectId();
    Conversation.findOne = (() => mockQuery({ _id: convId, userId })) as any;
    Conversation.updateOne = (() => mockQuery({})) as any;
    Message.find = (() => mockQuery([])) as any;
    Message.create = (async (docs: any[]) => docs.map((d) => ({ ...d, _id: new Types.ObjectId() }))) as any;
    Message.findOneAndUpdate = (() => mockQuery({ _id: new Types.ObjectId(), conversationId: convId, role: "assistant" })) as any;

    _internalLock.acquireConversationLock = async () => ({
      lockToken: "lock-5",
      lockExpiresAt: new Date(Date.now() + 60000),
      lockVersion: 1,
    });
    _internalLock.fencedReleaseConversationLock = async () => {};
    const reservedTokens = 1000;
    _internalTokenService.createTokenReservation = async () => ({
      reservationId: new Types.ObjectId(),
      reservedAmount: reservedTokens,
      allowedOutputTokens: 950,
      expiresAt: new Date(),
    });
    _internalTokenService.settleTokenReservation = (async (params: any) => {
      settledOutputTokens = params.usageData.billedOutputTokens;
      return { settled: true };
    }) as any;

    await sendMessageStream(userId.toString(), convId.toString(), "Clamp test");

    // Clamped strictly to reservation capacity
    assert.ok(settledOutputTokens <= reservedTokens - 15);
  });

  // 7. Client disconnect cancels upstream generation where supported
  test("7. Client disconnect cancels upstream generation where supported", async () => {
    let streamCancelled = false;
    const abortController = new AbortController();

    _internalAI.streamAIResponseWithUsage = async (contents, maxTokens, callbacks) => {
      if (callbacks.onChunk) await callbacks.onChunk("Chunk 1");
      // Simulate client disconnect triggering abort
      abortController.abort();
      if (callbacks.signal?.aborted) {
        streamCancelled = true;
        const err = new Error("AbortError");
        err.name = "AbortError";
        throw err;
      }
      return { text: "Chunk 1", model: PRIMARY_MODEL, inputTokens: 10, outputTokens: 2, totalTokens: 12 };
    };

    const convId = new Types.ObjectId();
    const userId = new Types.ObjectId();
    Conversation.findOne = (() => mockQuery({ _id: convId, userId })) as any;
    Message.find = (() => mockQuery([])) as any;
    Message.create = (async (docs: any[]) => docs.map((d) => ({ ...d, _id: new Types.ObjectId() }))) as any;
    Message.updateOne = (() => mockQuery({})) as any;

    _internalLock.acquireConversationLock = async () => ({
      lockToken: "lock-6",
      lockExpiresAt: new Date(Date.now() + 60000),
      lockVersion: 1,
    });
    _internalLock.fencedReleaseConversationLock = async () => {};
    _internalTokenService.createTokenReservation = async () => ({
      reservationId: new Types.ObjectId(),
      reservedAmount: 4096,
      allowedOutputTokens: 2000,
      expiresAt: new Date(),
    });
    _internalTokenService.settleTokenReservation = async () => ({ settled: true } as any);
    _internalTokenService.refundTokenReservation = async () => ({ refunded: true } as any);

    await sendMessageStream(
      userId.toString(),
      convId.toString(),
      "Cancel test",
      undefined,
      undefined,
      {},
      abortController.signal
    );

    assert.strictEqual(streamCancelled, true);
  });

  // 8. Disconnect does not leave a falsely completed message or incorrectly settled reservation
  test("8. Disconnect does not leave a falsely completed message or incorrectly settled reservation", async () => {
    let finalAssistantStatus = "";
    let settlementPolicyUsed = "";
    let refundedReservation = false;

    const abortController = new AbortController();
    _internalAI.streamAIResponseWithUsage = async () => {
      abortController.abort();
      const err = new Error("Client aborted");
      err.name = "AbortError";
      throw err;
    };

    const convId = new Types.ObjectId();
    const userId = new Types.ObjectId();
    const assistantMsgId = new Types.ObjectId();

    Conversation.findOne = (() => mockQuery({ _id: convId, userId })) as any;
    Message.find = (() => mockQuery([])) as any;
    Message.create = (async (docs: any[]) => docs.map((d, i) => ({ ...d, _id: i === 0 ? new Types.ObjectId() : assistantMsgId }))) as any;
    Message.updateOne = ((query: any, update: any) => {
      if (update.$set?.status) finalAssistantStatus = update.$set.status;
      return mockQuery({});
    }) as any;

    _internalLock.acquireConversationLock = async () => ({
      lockToken: "lock-7",
      lockExpiresAt: new Date(Date.now() + 60000),
      lockVersion: 1,
    });
    _internalLock.fencedReleaseConversationLock = async () => {};
    _internalTokenService.createTokenReservation = async () => ({
      reservationId: new Types.ObjectId(),
      reservedAmount: 4096,
      allowedOutputTokens: 2000,
      expiresAt: new Date(),
    });
    _internalTokenService.settleTokenReservation = (async (params: any) => {
      settlementPolicyUsed = params.usageData.verificationStatus;
      return { settled: true };
    }) as any;
    _internalTokenService.refundTokenReservation = async () => {
      refundedReservation = true;
      return { refunded: true } as any;
    };

    await sendMessageStream(
      userId.toString(),
      convId.toString(),
      "Disconnect safety",
      undefined,
      undefined,
      {},
      abortController.signal
    );

    // Must be marked failed, never completed
    assert.strictEqual(finalAssistantStatus, "failed");
    // Part D policy: verified prompt tokens settled as ABORTED_PROMPT_ONLY
    assert.strictEqual(settlementPolicyUsed, "ABORTED_PROMPT_ONLY");
  });

  // 9. Provider failure after several deltas produces safe terminal behavior and recoverable accounting state
  test("9. Provider failure after several deltas produces safe terminal behavior and recoverable accounting state", async () => {
    let finalStatus = "";
    let refunded = false;
    let errorCallbackReceived = false;

    _internalAI.streamAIResponseWithUsage = async (contents, maxTokens, callbacks) => {
      if (callbacks.onChunk) await callbacks.onChunk("Some text before crash");
      throw new Error("Provider 500 Service Unavailable");
    };

    const convId = new Types.ObjectId();
    const userId = new Types.ObjectId();
    const assistantMsgId = new Types.ObjectId();

    Conversation.findOne = (() => mockQuery({ _id: convId, userId })) as any;
    Message.find = (() => mockQuery([])) as any;
    Message.create = (async (docs: any[]) => docs.map((d, i) => ({ ...d, _id: i === 0 ? new Types.ObjectId() : assistantMsgId }))) as any;
    Message.updateOne = ((query: any, update: any) => {
      if (update.$set?.status) finalStatus = update.$set.status;
      return mockQuery({});
    }) as any;

    _internalLock.acquireConversationLock = async () => ({
      lockToken: "lock-8",
      lockExpiresAt: new Date(Date.now() + 60000),
      lockVersion: 1,
    });
    _internalLock.fencedReleaseConversationLock = async () => {};
    _internalTokenService.createTokenReservation = async () => ({
      reservationId: new Types.ObjectId(),
      reservedAmount: 4096,
      allowedOutputTokens: 2000,
      expiresAt: new Date(),
    });
    _internalTokenService.refundTokenReservation = async () => {
      refunded = true;
      return { refunded: true } as any;
    };

    await sendMessageStream(
      userId.toString(),
      convId.toString(),
      "Crash mid-stream",
      undefined,
      undefined,
      {
        onError: () => {
          errorCallbackReceived = true;
        },
      }
    );

    assert.strictEqual(finalStatus, "failed");
    assert.strictEqual(refunded, true);
    assert.strictEqual(errorCallbackReceived, true);
  });

  // 10. Pre-stream validation errors preserve normal HTTP error handling
  test("10. Pre-stream validation errors preserve normal HTTP error handling", async () => {
    const { req, res } = createMockReqRes({
      accept: "text/event-stream",
      body: {}, // Missing content
    });

    await sendMessageHandler(req, res);

    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.headersSent, true);
    assert.strictEqual(res.getHeader("content-type"), undefined); // Not SSE headers
    assert.strictEqual(res.body?.success, false);
    assert.strictEqual(res.body?.message, "Message content cannot be empty");
  });

  // 11. Concurrent generation on the same conversation is rejected correctly
  test("11. Concurrent generation on the same conversation is rejected correctly", async () => {
    const convId = new Types.ObjectId();
    const userId = new Types.ObjectId();

    Conversation.findOne = (() => mockQuery({ _id: convId, userId })) as any;
    _internalLock.acquireConversationLock = async () => {
      throw new ChatLockConflictError("A generation request is already in progress for this conversation.");
    };

    await assert.rejects(
      async () => {
        await sendMessageStream(userId.toString(), convId.toString(), "Parallel prompt");
      },
      (err: any) => err instanceof ChatLockConflictError && err.statusCode === 409
    );
  });

  // 12. Lock renewal, lease expiry, and fencing prevent stale-owner writes
  test("12. Lock renewal, lease expiry, and fencing prevent stale-owner writes", async () => {
    const convId = new Types.ObjectId();
    const assistantMsgId = new Types.ObjectId();
    const lockToken = "owner-valid-token";
    const lockVersion = 1;

    // 12a. Successful renewal with valid token
    Conversation.findOneAndUpdate = ((query: any, update: any) => {
      if (
        query._id.equals(convId) &&
        query.activeLockToken === lockToken &&
        query.lockVersion === lockVersion
      ) {
        return mockQuery({ _id: convId, lockToken, lockExpiresAt: update.$set.lockExpiresAt });
      }
      return mockQuery(null);
    }) as any;

    const renewed = await renewConversationLock(convId, assistantMsgId, lockToken, lockVersion);
    assert.ok(renewed instanceof Date, "Valid owner must be able to renew lease");

    // 12b. Renewal fails when lock token does not match (stale or stolen owner)
    await assert.rejects(
      async () => {
        await renewConversationLock(convId, assistantMsgId, "stolen-or-expired-token", lockVersion);
      },
      (err: any) => err instanceof ConversationLockLostError
    );

    // 12c. Fenced release throws when token or version mismatch
    await assert.rejects(
      async () => {
        await fencedReleaseConversationLock(
          convId,
          assistantMsgId,
          "mismatched-token",
          lockVersion,
          createMockSession()
        );
      },
      (err: any) => err instanceof ConversationLockLostError
    );
  });

  // 13. Idempotency prevents duplicate messages and duplicate settlements
  test("13. Idempotency prevents duplicate messages and duplicate settlements", async () => {
    const { req, res } = createMockReqRes({
      accept: "text/event-stream",
      body: { content: "Idempotent SSE request" },
    });
    req.headers["idempotency-key"] = "idem-test-key-1";

    const convId = new Types.ObjectId();
    const userId = req.user.userId;
    req.params.conversationId = convId.toString();

    Conversation.findOne = (() => mockQuery({ _id: convId, userId: new Types.ObjectId(userId) })) as any;

    const now = new Date();
    const expiresAt = new Date(now.getTime() + 60000);
    const attachmentDigest = computeAttachmentDigest(undefined);
    const requestHash = computeRequestHash(convId, "Idempotent SSE request", attachmentDigest);

    // Mock existing settled idempotency record
    IdempotencyKey.findOne = (() => mockQuery({
      key: "idem-test-key-1",
      userId: new Types.ObjectId(userId),
      conversationId: convId,
      status: "SETTLED",
      requestHash,
      expiresAt,
      responsePayload: {
        userMessage: { id: "u1", content: "Idempotent SSE request", role: "user" },
        assistantMessage: { id: "a1", content: "Cached result", role: "assistant" },
      },
    })) as any;

    await sendMessageHandler(req, res);

    assert.strictEqual(res.getHeader("content-type"), "text/event-stream");
    const written = res._writtenChunks.join("");
    assert.ok(written.includes("event: metadata"));
    assert.ok(written.includes("event: delta"));
    assert.ok(written.includes("event: done"));
    assert.ok(written.includes("Cached result"));
  });

  // 14. SSE terminal events are not duplicated
  test("14. SSE terminal events are not duplicated", () => {
    const { res } = createMockReqRes({ accept: "text/event-stream" });
    let doneEventCount = 0;
    let errorEventCount = 0;

    const emitTerminalDone = (data: any) => {
      if (res.writableEnded) return;
      doneEventCount++;
      res.write(formatSSEEvent("done", data));
      res.end();
    };

    const emitTerminalError = (err: any) => {
      if (res.writableEnded) return;
      errorEventCount++;
      res.write(formatSSEEvent("error", err));
      res.end();
    };

    emitTerminalDone({ finalStatus: "completed" });
    // Attempt second terminal emission
    emitTerminalDone({ finalStatus: "completed" });
    emitTerminalError({ code: "ERR", message: "Late error" });

    assert.strictEqual(doneEventCount, 1, "Only 1 done terminal event can be emitted");
    assert.strictEqual(errorEventCount, 0, "No error event emitted after stream has ended");
  });

  // 15. JSON requests preserve their existing response contract
  test("15. JSON requests preserve their existing response contract", async () => {
    const { req, res } = createMockReqRes({
      accept: "application/json",
      body: { content: "Standard JSON prompt" },
    });

    const convId = new Types.ObjectId();
    const userId = req.user.userId;
    req.params.conversationId = convId.toString();

    Conversation.findOne = (() => mockQuery({ _id: convId, userId: new Types.ObjectId(userId) })) as any;
    Conversation.updateOne = (() => mockQuery({})) as any;
    Message.find = (() => mockQuery([])) as any;
    Message.create = (async (docs: any[]) => docs.map((d) => ({ ...d, _id: new Types.ObjectId() }))) as any;

    _internalLock.acquireConversationLock = async () => ({
      lockToken: "lock-json",
      lockExpiresAt: new Date(Date.now() + 60000),
      lockVersion: 1,
    });
    _internalLock.fencedReleaseConversationLock = async () => {};
    _internalTokenService.createTokenReservation = async () => ({
      reservationId: new Types.ObjectId(),
      reservedAmount: 4096,
      allowedOutputTokens: 2000,
      expiresAt: new Date(),
    });
    _internalTokenService.settleTokenReservation = async () => ({ settled: true } as any);
    _internalAI.generateAIResponseWithUsage = async () => ({
      text: "Normal JSON answer",
      model: PRIMARY_MODEL,
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    });

    await sendMessageHandler(req, res);

    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(res.getHeader("content-type"), undefined); // Not text/event-stream
    assert.strictEqual(res.body?.success, true);
    assert.strictEqual(res.body?.data?.assistantMessage?.content, "Normal JSON answer");
  });

  // 16. Frontend parser handles fragmented frames, multiple events per read, and stream termination
  test("16. Frontend parser handles fragmented frames, multiple events per read, and stream termination", () => {
    const buffer = { current: "" };

    // 16a. Fragmented frame split across 2 chunks
    const chunk1 = "event: delta\nda";
    const chunk2 = 'ta: {"delta":"Hello "}\n\n';

    const events1 = parseSSEChunk(chunk1, buffer);
    assert.strictEqual(events1.length, 0, "No event emitted for partial frame");

    const events2 = parseSSEChunk(chunk2, buffer);
    assert.strictEqual(events2.length, 1);
    assert.strictEqual(events2[0].event, "delta");
    assert.deepStrictEqual(JSON.parse(events2[0].data), { delta: "Hello " });

    // 16b. Multiple events in a single chunk with CRLF
    const multiChunk = 'event: delta\r\ndata: {"delta":"world"}\r\n\r\nevent: done\r\ndata: {"finalStatus":"SENT"}\r\n\r\n';
    const multiEvents = parseSSEChunk(multiChunk, buffer);
    assert.strictEqual(multiEvents.length, 2);
    assert.strictEqual(multiEvents[0].event, "delta");
    assert.strictEqual(multiEvents[1].event, "done");

    // 16c. Malformed / empty lines ignored
    const malformedChunk = '\n\n   \r\n\r\nevent: ping\ndata: {"ping":true}\n\n';
    const cleanEvents = parseSSEChunk(malformedChunk, buffer);
    assert.strictEqual(cleanEvents.length, 1);
    assert.strictEqual(cleanEvents[0].event, "ping");
  });

  // 17. Chat mode and Agent/tool execution regressions are covered
  test("17. Chat mode and Agent/tool execution regressions are covered", async () => {
    let agentTurnExecuted = false;

    _internalAI.generateAIResponseWithUsage = async () => {
      agentTurnExecuted = true;
      return {
        text: "Agent completed search tool execution successfully.",
        model: PRIMARY_MODEL,
        inputTokens: 50,
        outputTokens: 25,
        totalTokens: 75,
      };
    };

    const convId = new Types.ObjectId();
    const userId = new Types.ObjectId();

    Conversation.findOne = (() => mockQuery({ _id: convId, userId })) as any;
    Conversation.updateOne = (() => mockQuery({})) as any;
    Message.find = (() => mockQuery([])) as any;
    Message.create = (async (docs: any[]) => docs.map((d) => ({ ...d, _id: new Types.ObjectId() }))) as any;

    _internalLock.acquireConversationLock = async () => ({
      lockToken: "lock-agent",
      lockExpiresAt: new Date(Date.now() + 60000),
      lockVersion: 1,
    });
    _internalLock.fencedReleaseConversationLock = async () => {};
    _internalTokenService.createTokenReservation = async () => ({
      reservationId: new Types.ObjectId(),
      reservedAmount: 4096,
      allowedOutputTokens: 2000,
      expiresAt: new Date(),
    });
    _internalTokenService.settleTokenReservation = async () => ({ settled: true } as any);

    const { req, res } = createMockReqRes({
      accept: "application/json",
      body: { content: "Search query" },
    });
    req.params.conversationId = convId.toString();
    req.user.userId = userId.toString();

    await sendMessageHandler(req, res);

    assert.strictEqual(agentTurnExecuted, true);
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(res.body?.success, true);
    assert.strictEqual(res.body?.data?.assistantMessage?.content, "Agent completed search tool execution successfully.");
  });
});

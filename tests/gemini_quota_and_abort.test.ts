import "dotenv/config";
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || "test-dummy-gemini-key";

import test, { describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import mongoose, { Types } from "mongoose";
import { EventEmitter } from "node:events";

import {
  PRIMARY_MODEL,
  FALLBACK_MODEL,
  SECONDARY_FALLBACK_MODEL,
  CONFIGURED_MODELS,
  GeminiQuotaExhaustedError,
  isGeminiQuotaExhaustedError,
  extractRetryDelay,
  sanitizeErrorMessage,
  generateAIResponseWithUsage,
  streamAIResponseWithUsage,
  countPromptTokens,
  getGeminiClient,
} from "../src/features/ai/ai.service.js";
import {
  formatSSEEvent,
  sendMessageHandler,
} from "../src/features/chat/chat.controller.js";
import {
  sendMessage,
  sendMessageStream,
  _internalAI,
  _internalLock,
  _internalTokenService,
} from "../src/features/chat/chat.service.js";
import { TokenUsage } from "../src/database/models/tokenUsage/TokenUsage.model.js";
import { TokenReservation } from "../src/database/models/tokenReservation/TokenReservation.model.js";
import { TokenWallet } from "../src/database/models/tokenWallet/TokenWallet.model.js";
import { Conversation } from "../src/database/models/conversation/Conversation.model.js";
import { Message } from "../src/database/models/message/Message.model.js";
import {
  settleTokenReservation,
  refundTokenReservation,
} from "../src/features/token/token.service.js";
import { ReservationStateConflictError } from "../src/features/token/token.errors.js";

describe("Confirmed Issue A & B Regression Tests — Quota Exhaustion & Abort Settlement", () => {
  const originalMongooseStartSession = mongoose.startSession;
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

  const originalConversationFindOne = Conversation.findOne;
  const originalConversationFindById = Conversation.findById;
  const originalConversationUpdateOne = Conversation.updateOne;
  const originalConversationFindOneAndUpdate = Conversation.findOneAndUpdate;
  const originalMessageFind = Message.find;
  const originalMessageCreate = Message.create;
  const originalMessageUpdateOne = Message.updateOne;
  const originalMessageFindOneAndUpdate = Message.findOneAndUpdate;

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

  const createMockReqRes = (options: {
    accept?: string;
    body?: any;
    params?: any;
    user?: any;
  }) => {
    const req: any = new EventEmitter();
    req.headers = {
      accept: options.accept || "application/json",
    };
    req.body = options.body || {};
    req.params = options.params || {};
    req.user = options.user || { userId: new Types.ObjectId().toString() };
    req.header = (name: string) => req.headers[name.toLowerCase()];

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
    Conversation.updateOne = (() => mockQuery({})) as any;
    Conversation.findOneAndUpdate = (() => mockQuery({ _id: new Types.ObjectId() })) as any;
    Message.updateOne = (() => mockQuery({})) as any;
    Message.findOneAndUpdate = (() => mockQuery({})) as any;
    Message.find = (() => mockQuery([])) as any;
    Message.create = (async (docs: any[]) => docs.map((d) => ({ ...d, _id: new Types.ObjectId() }))) as any;

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

  afterEach(() => {
    mongoose.startSession = originalMongooseStartSession;
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

    Conversation.findOne = originalConversationFindOne;
    Conversation.findById = originalConversationFindById;
    Conversation.updateOne = originalConversationUpdateOne;
    Conversation.findOneAndUpdate = originalConversationFindOneAndUpdate;
    Message.find = originalMessageFind;
    Message.create = originalMessageCreate;
    Message.updateOne = originalMessageUpdateOne;
    Message.findOneAndUpdate = originalMessageFindOneAndUpdate;
  });

  const create429QuotaError = (message = "Resource has been exhausted (e.g. check quota).") => {
    const err: any = new Error(
      `[GoogleGenerativeAI Error]: ${message} Please retry in 45s. [429 RESOURCE_EXHAUSTED]`
    );
    err.status = 429;
    err.errorDetails = [
      {
        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
        reason: "RATE_LIMIT_EXCEEDED",
        domain: "googleapis.com",
        metadata: { retryDelay: "45s" },
      },
    ];
    return err;
  };

  // ==========================================
  // ISSUE A: GEMINI QUOTA EXHAUSTION TESTS
  // ==========================================

  test("1. Error classification correctly identifies HTTP 429 and RESOURCE_EXHAUSTED", () => {
    const quotaErr1 = create429QuotaError();
    assert.strictEqual(isGeminiQuotaExhaustedError(quotaErr1), true);
    assert.strictEqual(extractRetryDelay(quotaErr1), 45);

    const quotaErr2 = new Error("RESOURCE_EXHAUSTED: quota exceeded");
    assert.strictEqual(isGeminiQuotaExhaustedError(quotaErr2), true);

    const normalErr = new Error("Network connection dropped");
    assert.strictEqual(isGeminiQuotaExhaustedError(normalErr), false);
    assert.strictEqual(extractRetryDelay(normalErr), undefined);
  });

  test("2. Sensitive API keys and query parameters are redacted via sanitizeErrorMessage", () => {
    const sensitiveMsg =
      "Request failed with status 429: https://generativelanguage.googleapis.com/v1beta/models?key=AIzaSySecretApiKey1234567890&alt=json";
    const sanitized = sanitizeErrorMessage(sensitiveMsg);
    assert.strictEqual(sanitized.includes("AIzaSySecretApiKey1234567890"), false);

    const standaloneMsg = "Failed auth for key=AIzaSySecretApiKey1234567890 in header";
    const sanitizedStandalone = sanitizeErrorMessage(standaloneMsg);
    assert.strictEqual(sanitizedStandalone.includes("AIzaSySecretApiKey1234567890"), false);
    assert.strictEqual(sanitizedStandalone.includes("[REDACTED]"), true);
  });

  test("3. Primary model quota exhaustion falls back to fallback model and succeeds", async () => {
    const gemini = getGeminiClient();
    const originalModelsGenerateContent = gemini.models.generateContent;
    const attemptedModels: string[] = [];

    gemini.models.generateContent = async (params: any) => {
      attemptedModels.push(params.model);
      if (params.model === PRIMARY_MODEL) {
        throw create429QuotaError("Primary quota exhausted");
      }
      return {
        text: "Response from fallback model",
        usageMetadata: {
          promptTokenCount: 15,
          candidatesTokenCount: 20,
          totalTokenCount: 35,
        },
      } as any;
    };

    try {
      const exhaustedTracker = new Set<string>();
      const result = await generateAIResponseWithUsage(
        [{ role: "user", parts: [{ text: "Hello" }] }],
        1000,
        exhaustedTracker
      );

      assert.strictEqual(result.text, "Response from fallback model");
      assert.strictEqual(result.model, FALLBACK_MODEL);
      assert.deepStrictEqual(attemptedModels, [PRIMARY_MODEL, FALLBACK_MODEL]);
      assert.strictEqual(exhaustedTracker.has(PRIMARY_MODEL), true);
      assert.strictEqual(exhaustedTracker.has(FALLBACK_MODEL), false);
    } finally {
      gemini.models.generateContent = originalModelsGenerateContent;
    }
  });

  test("4. Exhausted models in tracker are skipped without repeated requests", async () => {
    const gemini = getGeminiClient();
    const originalModelsGenerateContent = gemini.models.generateContent;
    const attemptedModels: string[] = [];

    gemini.models.generateContent = async (params: any) => {
      attemptedModels.push(params.model);
      return {
        text: "Response from fallback directly",
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10, totalTokenCount: 20 },
      } as any;
    };

    try {
      const exhaustedTracker = new Set<string>([PRIMARY_MODEL]);
      const result = await generateAIResponseWithUsage(
        [{ role: "user", parts: [{ text: "Hello" }] }],
        1000,
        exhaustedTracker
      );

      // Primary was in tracker, so it should be skipped immediately
      assert.strictEqual(result.model, FALLBACK_MODEL);
      assert.strictEqual(attemptedModels.includes(PRIMARY_MODEL), false);
      assert.strictEqual(attemptedModels[0], FALLBACK_MODEL);
    } finally {
      gemini.models.generateContent = originalModelsGenerateContent;
    }
  });

  test("5. All configured models exhausted throws GeminiQuotaExhaustedError promptly", async () => {
    const gemini = getGeminiClient();
    const originalModelsGenerateContent = gemini.models.generateContent;
    const attemptedModels: string[] = [];

    gemini.models.generateContent = async (params: any) => {
      attemptedModels.push(params.model);
      throw create429QuotaError(`Model ${params.model} quota exhausted`);
    };

    try {
      const exhaustedTracker = new Set<string>();
      await assert.rejects(
        async () => {
          await generateAIResponseWithUsage(
            [{ role: "user", parts: [{ text: "Hello" }] }],
            1000,
            exhaustedTracker
          );
        },
        (err: any) => {
          assert.strictEqual(err instanceof GeminiQuotaExhaustedError, true);
          assert.strictEqual(err.statusCode, 429);
          assert.strictEqual(err.code, "RESOURCE_EXHAUSTED");
          return true;
        }
      );

      // Every configured model was attempted once, none duplicated
      assert.strictEqual(attemptedModels.length, CONFIGURED_MODELS.length);
      for (const m of CONFIGURED_MODELS) {
        assert.strictEqual(exhaustedTracker.has(m), true);
      }
    } finally {
      gemini.models.generateContent = originalModelsGenerateContent;
    }
  });

  test("6. Streaming fallback succeeds when primary is exhausted", async () => {
    const gemini = getGeminiClient();
    const originalStreamGenerate = gemini.models.generateContentStream;
    const attemptedModels: string[] = [];

    gemini.models.generateContentStream = async function* (params: any) {
      attemptedModels.push(params.model);
      if (params.model === PRIMARY_MODEL) {
        throw create429QuotaError("Primary stream quota exhausted");
      }
      yield {
        text: "Streamed fallback chunk",
        usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 18, totalTokenCount: 30 },
      } as any;
    };

    try {
      const chunks: string[] = [];
      const exhaustedTracker = new Set<string>();
      const result = await streamAIResponseWithUsage(
        [{ role: "user", parts: [{ text: "Hello" }] }],
        1000,
        {
          onChunk: (c) => chunks.push(c),
        },
        exhaustedTracker
      );

      assert.strictEqual(chunks.join(""), "Streamed fallback chunk");
      assert.strictEqual(result.model, FALLBACK_MODEL);
      assert.strictEqual(exhaustedTracker.has(PRIMARY_MODEL), true);
      assert.deepStrictEqual(attemptedModels, [PRIMARY_MODEL, FALLBACK_MODEL]);
    } finally {
      gemini.models.generateContentStream = originalStreamGenerate;
    }
  });

  test("7. All configured models exhausted during stream throws GeminiQuotaExhaustedError promptly", async () => {
    const gemini = getGeminiClient();
    const originalStreamGenerate = gemini.models.generateContentStream;

    gemini.models.generateContentStream = async function* (params: any) {
      throw create429QuotaError(`Stream model ${params.model} quota exhausted`);
    };

    try {
      const exhaustedTracker = new Set<string>();
      await assert.rejects(
        async () => {
          await streamAIResponseWithUsage(
            [{ role: "user", parts: [{ text: "Hello" }] }],
            1000,
            { onChunk: () => {} },
            exhaustedTracker
          );
        },
        (err: any) => {
          assert.strictEqual(err instanceof GeminiQuotaExhaustedError, true);
          assert.strictEqual(err.statusCode, 429);
          return true;
        }
      );
    } finally {
      gemini.models.generateContentStream = originalStreamGenerate;
    }
  });

  test("8. SSE stream emits terminal error event with 429 when AI quota is exhausted", async () => {
    const userId = new Types.ObjectId().toString();
    const conversationId = new Types.ObjectId().toString();
    const userMessageId = new Types.ObjectId();
    const assistantMessageId = new Types.ObjectId();
    const reservationId = new Types.ObjectId();

    Conversation.findOne = () =>
      mockQuery({
        _id: new Types.ObjectId(conversationId),
        userId: new Types.ObjectId(userId),
        isArchived: false,
      });

    _internalLock.acquireConversationLock = async () => ({
      acquired: true,
      lockToken: "lock-token-123",
      lockVersion: 1,
      assistantMessageId,
    });
    _internalLock.renewConversationLock = async () => {};
    _internalLock.fencedReleaseConversationLock = async () => {};

    _internalTokenService.createTokenReservation = async () => ({
      reservationId,
      reservedAmount: 1000,
      allowedOutputTokens: 500,
      userMessage: { _id: userMessageId },
      assistantPlaceholder: { _id: assistantMessageId },
    });
    let refundCalled = false;
    _internalTokenService.refundTokenReservation = async () => {
      refundCalled = true;
      return {} as any;
    };

    _internalAI.countPromptTokens = async () => 20;
    _internalAI.streamAIResponseWithUsage = async () => {
      throw new GeminiQuotaExhaustedError("All configured models exhausted: quota exceeded", 45);
    };

    const emittedEvents: { event: string; data: any }[] = [];
    await sendMessageStream(
      userId,
      conversationId,
      "What is the meaning of life?",
      undefined,
      undefined,
      {
        onMetadata: (data) => emittedEvents.push({ event: "metadata", data }),
        onDelta: (data) => emittedEvents.push({ event: "delta", data }),
        onError: (err) => emittedEvents.push({ event: "error", data: err }),
        onDone: (data) => emittedEvents.push({ event: "done", data }),
      }
    );

    const errorEvent = emittedEvents.find((e) => e.event === "error");
    assert.ok(errorEvent, "Expected terminal error event to be emitted");
    assert.strictEqual(errorEvent.data.code, "RESOURCE_EXHAUSTED");
    assert.strictEqual(errorEvent.data.statusCode, 429);
    assert.strictEqual(errorEvent.data.retryAfter, 45);
    assert.strictEqual(refundCalled, true, "Tokens should be refunded on quota failure");
  });

  test("9. JSON request receives HTTP 429 response promptly when quota is exhausted", async () => {
    const userId = new Types.ObjectId().toString();
    const conversationId = new Types.ObjectId().toString();

    const { req, res } = createMockReqRes({
      accept: "application/json",
      user: { userId },
      params: { conversationId },
      body: { content: "Test prompt" },
    });

    Conversation.findOne = () =>
      mockQuery({
        _id: new Types.ObjectId(conversationId),
        userId: new Types.ObjectId(userId),
        isArchived: false,
      });

    _internalLock.acquireConversationLock = async () => ({
      acquired: true,
      lockToken: "lock-token-456",
      lockVersion: 1,
      assistantMessageId: new Types.ObjectId(),
    });
    _internalLock.fencedReleaseConversationLock = async () => {};

    _internalTokenService.createTokenReservation = async () => ({
      reservationId: new Types.ObjectId(),
      reservedAmount: 500,
      allowedOutputTokens: 250,
      userMessage: { _id: new Types.ObjectId() },
      assistantPlaceholder: { _id: new Types.ObjectId() },
    });
    _internalTokenService.refundTokenReservation = async () => ({} as any);

    _internalAI.countPromptTokens = async () => 15;
    _internalAI.generateAIResponseWithUsage = async () => {
      throw new GeminiQuotaExhaustedError("All models quota exhausted", 30);
    };

    await sendMessageHandler(req, res);

    assert.strictEqual(res.statusCode, 429);
    assert.strictEqual(res.body?.code, "RESOURCE_EXHAUSTED");
    assert.strictEqual(res.body?.retryAfter, 30);
    assert.strictEqual(res.body?.success, false);
  });

  // ==========================================
  // ISSUE B: TOKEN USAGE ENUM & ABORT TESTS
  // ==========================================

  test("10. TokenUsage schema accepts ABORTED_PROMPT_ONLY in usageVerification", async () => {
    const validUsageDoc = new TokenUsage({
      userId: new Types.ObjectId(),
      conversationId: new Types.ObjectId(),
      inputTokens: 50,
      outputTokens: 0,
      totalTokens: 50,
      model: PRIMARY_MODEL,
      type: "chat",
      usageVerification: "ABORTED_PROMPT_ONLY",
      verificationNotes: "Stream cancelled by user; billed verified prompt tokens only",
    });

    const validationError = await validUsageDoc.validate();
    assert.strictEqual(validationError, undefined, "Validation should pass for ABORTED_PROMPT_ONLY");
  });

  test("11. TokenReservation schema accepts ABORTED_PROMPT_ONLY in usageVerification", async () => {
    const validReservationDoc = new TokenReservation({
      userId: new Types.ObjectId(),
      conversationId: new Types.ObjectId(),
      userMessageId: new Types.ObjectId(),
      assistantMessageId: new Types.ObjectId(),
      status: "SETTLED",
      reservedTokens: 200,
      allowedOutputTokens: 100,
      inputTokens: 25,
      actualTokensUsed: 25,
      overrunTokens: 0,
      version: 2,
      lockExpiresAt: new Date(Date.now() + 60000),
      usageVerification: "ABORTED_PROMPT_ONLY",
      model: PRIMARY_MODEL,
    });

    const validationError = await validReservationDoc.validate();
    assert.strictEqual(validationError, undefined, "Validation should pass for ABORTED_PROMPT_ONLY");
  });

  test("12. Invalid verification value is rejected by TokenUsage schema", async () => {
    const invalidUsageDoc = new TokenUsage({
      userId: new Types.ObjectId(),
      conversationId: new Types.ObjectId(),
      inputTokens: 50,
      outputTokens: 0,
      totalTokens: 50,
      model: PRIMARY_MODEL,
      type: "chat",
      usageVerification: "INVALID_UNKNOWN_STATUS_XYZ" as any,
    });

    await assert.rejects(
      async () => {
        await invalidUsageDoc.validate();
      },
      (err: any) => {
        assert.ok(err.errors?.["usageVerification"]);
        return true;
      }
    );
  });

  test("13. Stream abort Transaction 2B executes settlement with ABORTED_PROMPT_ONLY without schema error", async () => {
    const userId = new Types.ObjectId().toString();
    const conversationId = new Types.ObjectId().toString();
    const userMessageId = new Types.ObjectId();
    const assistantMessageId = new Types.ObjectId();
    const reservationId = new Types.ObjectId();

    Conversation.findOne = () =>
      mockQuery({
        _id: new Types.ObjectId(conversationId),
        userId: new Types.ObjectId(userId),
        isArchived: false,
      });

    _internalLock.acquireConversationLock = async () => ({
      acquired: true,
      lockToken: "lock-token-abort-test",
      lockVersion: 1,
      assistantMessageId,
    });
    _internalLock.renewConversationLock = async () => {};
    _internalLock.fencedReleaseConversationLock = async () => {};

    _internalTokenService.createTokenReservation = async () => ({
      reservationId,
      reservedAmount: 500,
      allowedOutputTokens: 250,
      userMessage: { _id: userMessageId },
      assistantPlaceholder: { _id: assistantMessageId },
    });

    let settledWithStatus: string | undefined;
    _internalTokenService.settleTokenReservation = async (params: any) => {
      settledWithStatus = params.usageData?.verificationStatus;
      const doc = new TokenUsage({
        userId: params.userId,
        conversationId: new Types.ObjectId(conversationId),
        inputTokens: params.usageData?.billedInputTokens,
        outputTokens: params.usageData?.billedOutputTokens,
        totalTokens: params.usageData?.billedTokens,
        model: params.usageData?.model,
        type: "chat",
        usageVerification: params.usageData?.verificationStatus,
        verificationNotes: params.usageData?.verificationNotes,
      });
      await doc.validate();
      return { settled: true } as any;
    };

    _internalAI.countPromptTokens = async () => 40;

    const abortController = new AbortController();
    _internalAI.streamAIResponseWithUsage = async (_contents, _maxTokens, options) => {
      await options.onChunk("First partial chunk");
      abortController.abort();
      throw new Error("AbortError: Stream aborted");
    };

    await sendMessageStream(
      userId,
      conversationId,
      "Explain quantum computing",
      undefined,
      undefined,
      undefined,
      abortController.signal
    );

    assert.strictEqual(
      settledWithStatus,
      "ABORTED_PROMPT_ONLY",
      "Should settle reservation with ABORTED_PROMPT_ONLY on abort"
    );
  });

  test("14. Reservation settlement and refund are idempotent against duplicate calls / race conditions", async () => {
    const userId = new Types.ObjectId().toString();
    const conversationId = new Types.ObjectId().toString();
    const assistantMessageId = new Types.ObjectId();

    Conversation.findOne = () =>
      mockQuery({
        _id: new Types.ObjectId(conversationId),
        userId: new Types.ObjectId(userId),
        isArchived: false,
      });

    _internalLock.acquireConversationLock = async () => ({
      acquired: true,
      lockToken: "lock-token-race",
      lockVersion: 1,
      assistantMessageId,
    });
    _internalLock.fencedReleaseConversationLock = async () => {};

    _internalTokenService.createTokenReservation = async () => ({
      reservationId: new Types.ObjectId(),
      reservedAmount: 500,
      allowedOutputTokens: 250,
      userMessage: { _id: new Types.ObjectId() },
      assistantPlaceholder: { _id: assistantMessageId },
    });

    _internalTokenService.settleTokenReservation = async () => {
      throw new ReservationStateConflictError(
        "Reservation is already finalized or in conflicting state"
      );
    };

    _internalAI.countPromptTokens = async () => 30;

    const abortController = new AbortController();
    _internalAI.streamAIResponseWithUsage = async () => {
      abortController.abort();
      throw new Error("Stream cancelled");
    };

    // Should complete cleanly without uncaught exception
    await assert.doesNotReject(async () => {
      await sendMessageStream(
        userId,
        conversationId,
        "Cancelled query",
        undefined,
        undefined,
        undefined,
        abortController.signal
      );
    });
  });
});

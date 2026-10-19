import fs from "node:fs";
import path from "node:path";
import mongoose from "mongoose";
import { Conversation } from "../../database/models/conversation/index.js";
import { Message } from "../../database/models/message/index.js";
import type {
  IMessageAttachment,
  MessageStatus,
} from "../../database/models/message/index.js";
import {
  generateAIResponseWithUsage,
  streamAIResponseWithUsage,
  countPromptTokens,
  createPartFromBase64,
  createPartFromText,
  PRIMARY_MODEL,
  GeminiQuotaExhaustedError,
  isGeminiQuotaExhaustedError,
  extractRetryDelay,
  sanitizeErrorMessage,
  type AIResponseWithUsage,
  type GeminiContent,
} from "../ai/ai.service.js";
import {
  createTokenReservation,
  settleTokenReservation,
  refundTokenReservation,
  validateUsageData,
  ReservationStateConflictError,
} from "../token/index.js";
import { CHAT_CONSTANTS } from "./chat.constants.js";
import { uploadChatImage, deleteChatImage } from "./chat.cloudinary.js";
import type {
  SafeConversation,
  SafeMessage,
  SendMessageResponse,
  SendMessageResult,
  SSEPingEvent,
  SSEMetadataEvent,
  SSEDeltaEvent,
  SSEDoneEvent,
  SSEErrorEvent,
} from "./chat.types.js";
import {
  ChatError,
  ChatLockConflictError,
  ConversationLockLostError,
  IdempotencyConflictError,
  IdempotencyPayloadMismatchError,
  IdempotencyUnresolvedRecoveryError,
} from "./chat.errors.js";
import {
  acquireConversationLock,
  fencedReleaseConversationLock,
  releaseConversationLockImmediately,
  renewConversationLock,
  type AcquiredLock,
} from "./chat.lock.js";
import {
  computeAttachmentDigest,
  computeRequestHash,
  claimOrCheckIdempotencyKey,
  cleanupOrphanedClaim,
  bindReservationToClaim,
  finalizeSettledClaim,
  finalizeFailedClaim,
} from "./chat.idempotency.js";

export {
  ChatError,
  ChatLockConflictError,
  ConversationLockLostError,
  IdempotencyConflictError,
  IdempotencyPayloadMismatchError,
  IdempotencyUnresolvedRecoveryError,
};

export const findUserConversationById = async (
  conversationId: string,
  userId: string
) => {
  if (!mongoose.Types.ObjectId.isValid(conversationId)) {
    throw new ChatError("Invalid conversation ID format", 400);
  }

  const conversation = await Conversation.findOne({
    _id: new mongoose.Types.ObjectId(conversationId),
    userId: new mongoose.Types.ObjectId(userId),
  });

  if (!conversation) {
    throw new ChatError("Conversation not found", 404);
  }

  return conversation;
};

export const createConversation = async (
  userId: string,
  title?: string
): Promise<SafeConversation> => {
  const resolvedTitle =
    title && title.trim().length > 0
      ? title.trim()
      : CHAT_CONSTANTS.DEFAULT_CONVERSATION_TITLE;

  const conversation = await Conversation.create({
    userId: new mongoose.Types.ObjectId(userId),
    title: resolvedTitle,
  });

  return {
    id: conversation._id.toString(),
    title: conversation.title,
    createdAt: (conversation as any).createdAt,
    updatedAt: (conversation as any).updatedAt,
  };
};

export const getUserConversations = async (
  userId: string
): Promise<SafeConversation[]> => {
  const conversations = await Conversation.find({
    userId: new mongoose.Types.ObjectId(userId),
  }).sort({ updatedAt: -1 });

  return conversations.map((conv) => ({
    id: conv._id.toString(),
    title: conv.title,
    createdAt: (conv as any).createdAt,
    updatedAt: (conv as any).updatedAt,
  }));
};

// Track background AI generations in memory: assistantMessageId -> Promise<SafeMessage>
export const inFlightGenerations = new Map<string, Promise<SafeMessage>>();

export const getConversationMessages = async (
  userId: string,
  conversationId: string
): Promise<SafeMessage[]> => {
  await findUserConversationById(conversationId, userId);

  const messages = await Message.find({
    conversationId: new mongoose.Types.ObjectId(conversationId),
  }).sort({ createdAt: 1 });

  return messages.map((msg) => {
    // If a message was marked "generating" more than 2 minutes ago and is not currently in-flight, mark it failed
    const isStale =
      msg.status === "generating" &&
      !inFlightGenerations.has(msg._id.toString()) &&
      Date.now() - new Date((msg as any).createdAt).getTime() > 120000;

    if (isStale) {
      Message.updateOne(
        { _id: msg._id },
        {
          $set: {
            status: "failed",
            errorMessage: "Generation was interrupted due to server timeout or restart",
          },
        }
      ).exec();
      msg.status = "failed";
      msg.errorMessage = "Generation was interrupted due to server timeout or restart";
    }

    return {
      id: msg._id.toString(),
      conversationId: msg.conversationId.toString(),
      role: msg.role,
      content: msg.content,
      status: (msg.status as MessageStatus) || "completed",
      errorMessage: msg.errorMessage,
      attachment:
        msg.attachment && msg.attachment.url
          ? {
              type: msg.attachment.type,
              url: msg.attachment.url,
              publicId: msg.attachment.publicId,
              mimeType: msg.attachment.mimeType,
              name: msg.attachment.name,
              size: msg.attachment.size,
            }
          : undefined,
      createdAt: (msg as any).createdAt,
      updatedAt: (msg as any).updatedAt,
    };
  });
};

export const _internalAI = {
  generateAIResponseWithUsage,
  streamAIResponseWithUsage,
  countPromptTokens,
};

export const _internalTokenService = {
  createTokenReservation,
  settleTokenReservation,
  refundTokenReservation,
};

export const _internalLock = {
  acquireConversationLock,
  renewConversationLock,
  fencedReleaseConversationLock,
  releaseConversationLockImmediately,
};


const formatSafeUserMessage = (msg: any): SafeMessage => ({
  id: msg._id.toString(),
  conversationId: msg.conversationId.toString(),
  role: msg.role,
  content: msg.content,
  status: (msg.status as MessageStatus) || "completed",
  attachment:
    msg.attachment && msg.attachment.url
      ? {
          type: msg.attachment.type,
          url: msg.attachment.url,
          publicId: msg.attachment.publicId,
          mimeType: msg.attachment.mimeType,
          name: msg.attachment.name,
          size: msg.attachment.size,
        }
      : undefined,
  createdAt: (msg as any).createdAt,
  updatedAt: (msg as any).updatedAt,
});

const formatSafeAssistantMessage = (
  msg: any,
  fallbackCreatedAt?: Date
): SafeMessage => ({
  id: msg._id ? msg._id.toString() : msg.id,
  conversationId: msg.conversationId
    ? msg.conversationId.toString()
    : msg.conversationId,
  role: "assistant",
  content: msg.content,
  status: (msg.status as MessageStatus) || "completed",
  errorMessage: msg.errorMessage,
  createdAt: (msg as any).createdAt || fallbackCreatedAt || new Date(),
  updatedAt: (msg as any).updatedAt || new Date(),
});

export const sendMessage = async (
  userId: string,
  conversationId: string,
  content: string,
  file?: Express.Multer.File,
  idempotencyKey?: string
): Promise<SendMessageResult> => {
  const conversation = await findUserConversationById(conversationId, userId);
  const exhaustedModels = new Set<string>();

  // Normalize message content for image-only vs text/image questions
  const resolvedContent =
    content && content.trim().length > 0
      ? content.trim()
      : file
      ? "Describe this image."
      : "";

  // 1. Compute attachment digest and request hash before any external network operations
  const attachmentDigest = computeAttachmentDigest(file);
  const requestHash = computeRequestHash(
    conversation._id,
    content,
    attachmentDigest
  );

  // 2. Pre-upload idempotency check: replay short-circuit without redundant uploads or token holds
  let claimToken: string | undefined;
  if (idempotencyKey) {
    const idempResult = await claimOrCheckIdempotencyKey(
      userId,
      idempotencyKey,
      conversation._id,
      requestHash
    );

    if (idempResult.isReplay) {
      return {
        ...idempResult.payload,
        isReplay: true,
        statusCode: idempResult.statusCode,
      };
    }

    claimToken = idempResult.claimToken;
  }

  // Allocate stable IDs outside transactions
  const userMessageId = new mongoose.Types.ObjectId();
  const assistantMessageId = new mongoose.Types.ObjectId();
  const reservationId = new mongoose.Types.ObjectId();

  // 3. Atomic conversation lock acquisition: reject competing requests before charging or reserving
  let acquiredLock: AcquiredLock;
  try {
    acquiredLock = await _internalLock.acquireConversationLock(
      conversation._id,
      userId,
      assistantMessageId
    );
  } catch (lockError) {
    if (idempotencyKey && claimToken) {
      await cleanupOrphanedClaim(userId, idempotencyKey, claimToken);
    }
    throw lockError;
  }

  // 4. Handle attachment upload to Cloudinary (fenced by acquired lock)
  let attachmentData: IMessageAttachment | undefined;
  let currentImageBase64: string | undefined;
  let newlyUploadedPublicId: string | null = null;

  if (file) {
    try {
      const buffer =
        file.buffer ||
        (file.path && fs.existsSync(file.path)
          ? fs.readFileSync(file.path)
          : undefined);

      if (!buffer) {
        throw new Error("No file buffer available for image processing");
      }

      currentImageBase64 = buffer.toString("base64");

      const uploadResult = await uploadChatImage(
        buffer,
        file.originalname,
        file.mimetype
      );

      newlyUploadedPublicId = uploadResult.publicId;

      attachmentData = {
        type: "image",
        url: uploadResult.secureUrl,
        publicId: uploadResult.publicId,
        mimeType: file.mimetype,
        name: file.originalname,
        size: file.size || uploadResult.bytes,
      };
    } catch (uploadError: any) {
      console.error("[Chat] Cloudinary upload failed:", uploadError);
      await releaseConversationLockImmediately(
        conversation._id,
        acquiredLock.lockToken,
        acquiredLock.lockVersion
      );
      if (idempotencyKey && claimToken) {
        await cleanupOrphanedClaim(userId, idempotencyKey, claimToken);
      }
      throw new ChatError(
        uploadError?.message || "Failed to upload image to Cloudinary",
        500
      );
    }
  }

  // 5. Build conversation history and calculate prompt input tokens
  let inputTokens: number;
  const geminiContents: GeminiContent[] = [];

  try {
    const existingMessages = await Message.find({
      conversationId: conversation._id,
      status: { $nin: ["generating", "failed"] },
    })
      .sort({ createdAt: 1 })
      .lean();

    const historySlice = existingMessages.slice(
      -CHAT_CONSTANTS.MAX_CONTEXT_MESSAGES
    );

    for (const msg of historySlice) {
      if (!msg.content && !msg.attachment) continue;
      const parts: any[] = [];
      if (
        msg.attachment &&
        msg.attachment.type === "image" &&
        msg.attachment.url
      ) {
        if (msg.attachment.url.startsWith("http")) {
          try {
            const fetchRes = await fetch(msg.attachment.url);
            if (fetchRes.ok) {
              const arrayBuffer = await fetchRes.arrayBuffer();
              const imgBuffer = Buffer.from(arrayBuffer);
              parts.push(
                createPartFromBase64(
                  imgBuffer.toString("base64"),
                  msg.attachment.mimeType
                )
              );
            }
          } catch {
            // Gracefully omit image part if remote fetch fails
          }
        } else {
          const localFilePath = path.join(
            process.cwd(),
            msg.attachment.url.replace(/^\//, "")
          );
          if (fs.existsSync(localFilePath)) {
            try {
              const imgBuffer = fs.readFileSync(localFilePath);
              parts.push(
                createPartFromBase64(
                  imgBuffer.toString("base64"),
                  msg.attachment.mimeType
                )
              );
            } catch {
              // Gracefully omit image part if read fails
            }
          }
        }
      }
      parts.push(createPartFromText(msg.content || "Describe this image."));
      geminiContents.push({
        role: msg.role === "assistant" ? "model" : "user",
        parts,
      });
    }

    while (geminiContents.length > 0 && geminiContents[0].role === "model") {
      geminiContents.shift();
    }

    const userTurnParts: any[] = [];
    if (file && currentImageBase64) {
      userTurnParts.push(
        createPartFromBase64(currentImageBase64, file.mimetype)
      );
    }
    userTurnParts.push(createPartFromText(resolvedContent));

    geminiContents.push({
      role: "user",
      parts: userTurnParts,
    });

    inputTokens = await _internalAI.countPromptTokens(geminiContents, PRIMARY_MODEL, exhaustedModels);
  } catch (prepError) {
    if (newlyUploadedPublicId) {
      deleteChatImage(newlyUploadedPublicId).catch(() => {});
    }
    await _internalLock.releaseConversationLockImmediately(
      conversation._id,
      acquiredLock.lockToken,
      acquiredLock.lockVersion
    );
    if (idempotencyKey && claimToken) {
      await cleanupOrphanedClaim(userId, idempotencyKey, claimToken);
    }
    throw prepError;
  }

  // 6. Coordinate Transaction 1: Pre-generation hold and message placeholders
  let reservedAmount: number;
  let allowedOutputTokens: number;
  let userMessage: any;
  let assistantPlaceholder: any;

  const tx1Session = await mongoose.startSession();
  tx1Session.startTransaction();

  try {
    const reservationRes = await _internalTokenService.createTokenReservation(
      {
        userId,
        conversationId: conversation._id,
        userMessageId,
        assistantMessageId,
        reservationId,
        inputTokens,
        model: PRIMARY_MODEL,
      },
      { session: tx1Session }
    );

    reservedAmount = reservationRes.reservedAmount;
    allowedOutputTokens = reservationRes.allowedOutputTokens;

    const [createdUserMsg] = await Message.create(
      [
        {
          _id: userMessageId,
          conversationId: conversation._id,
          userId: new mongoose.Types.ObjectId(userId),
          role: "user",
          content: resolvedContent,
          attachment: attachmentData,
          status: "completed",
        },
      ],
      { session: tx1Session }
    );
    userMessage = createdUserMsg;

    const [createdAssistantMsg] = await Message.create(
      [
        {
          _id: assistantMessageId,
          conversationId: conversation._id,
          userId: new mongoose.Types.ObjectId(userId),
          role: "assistant",
          content: "",
          status: "generating",
        },
      ],
      { session: tx1Session }
    );
    assistantPlaceholder = createdAssistantMsg;

    // Atomically bind reservation and message references to idempotency claim
    if (idempotencyKey && claimToken) {
      await bindReservationToClaim(
        userId,
        idempotencyKey,
        claimToken,
        reservationId,
        assistantMessageId,
        tx1Session
      );
    }

    await tx1Session.commitTransaction();
  } catch (tx1Error) {
    await tx1Session.abortTransaction();
    if (newlyUploadedPublicId) {
      deleteChatImage(newlyUploadedPublicId).catch(() => {});
    }
    await _internalLock.releaseConversationLockImmediately(
      conversation._id,
      acquiredLock.lockToken,
      acquiredLock.lockVersion
    );
    if (idempotencyKey && claimToken) {
      await cleanupOrphanedClaim(userId, idempotencyKey, claimToken);
    }
    throw tx1Error;
  } finally {
    await tx1Session.endSession();
  }

  // 7. Background generation execution: outside DB transaction with fenced finalization
  const executeGeneration = async (): Promise<SafeMessage> => {
    let aiResult: AIResponseWithUsage;

    try {
      const safeOutputTokens = Math.max(
        16,
        Math.floor(allowedOutputTokens * 0.65)
      );

      aiResult = await _internalAI.generateAIResponseWithUsage(
        geminiContents,
        safeOutputTokens,
        exhaustedModels
      );
    } catch (aiError: any) {
      console.error("Gemini invocation failed in chat service:", sanitizeErrorMessage(aiError?.message || ""));

      // Transaction 2B: Confirmed generation failure refund with fenced lock release
      const tx2bSession = await mongoose.startSession();
      tx2bSession.startTransaction();

      try {
        // Fenced lock release: verifies this worker still owns the lock version and token
        await _internalLock.fencedReleaseConversationLock(
          conversation._id,
          assistantMessageId,
          acquiredLock.lockToken,
          acquiredLock.lockVersion,
          tx2bSession
        );

        await _internalTokenService.refundTokenReservation(
          {
            reservationId,
            userId,
            expectedVersion: 1,
            reason: aiError?.message || "Failed to generate AI response",
          },
          { session: tx2bSession }
        );

        await Message.updateOne(
          { _id: assistantMessageId },
          {
            $set: {
              status: "failed",
              errorMessage:
                aiError?.message || "Failed to generate AI response",
              updatedAt: new Date(),
            },
          },
          { session: tx2bSession }
        );

        if (idempotencyKey && claimToken) {
          await finalizeFailedClaim(
            userId,
            idempotencyKey,
            claimToken,
            aiError?.message || "Failed to generate AI response",
            tx2bSession
          );
        }

        await tx2bSession.commitTransaction();
      } catch (refundErr) {
        await tx2bSession.abortTransaction();
        console.error(
          "Failed to execute Transaction 2B (fenced refund aborted):",
          refundErr
        );
      } finally {
        await tx2bSession.endSession();
      }

      if (isGeminiQuotaExhaustedError(aiError)) {
        const retryDelay = extractRetryDelay(aiError);
        const quotaErr = new ChatError(
          "AI model quota or rate limit exceeded. Please try again shortly.",
          429
        );
        (quotaErr as any).retryAfter = retryDelay;
        throw quotaErr;
      }

      throw new ChatError("Failed to generate AI response", 500);
    }

    // Validate usage metadata according to Phase 2 rules
    const rawUsage =
      aiResult.rawUsage ??
      (aiResult.totalTokens > 0
        ? {
            promptTokenCount: aiResult.inputTokens,
            candidatesTokenCount: aiResult.outputTokens,
            totalTokenCount: aiResult.totalTokens,
          }
        : undefined);

    const validatedUsage = validateUsageData(
      rawUsage,
      reservedAmount,
      inputTokens,
      aiResult.model
    );

    // Transaction 2A: Atomic settlement, fenced lock release, and idempotency finalization
    const tx2aSession = await mongoose.startSession();
    tx2aSession.startTransaction();

    let finalizedAssistantMsg: any;

    try {
      // 1. Fenced lock release: strictly verifies lock ownership and version
      await _internalLock.fencedReleaseConversationLock(
        conversation._id,
        assistantMessageId,
        acquiredLock.lockToken,
        acquiredLock.lockVersion,
        tx2aSession
      );

      // 2. Settle token reservation
      await _internalTokenService.settleTokenReservation(
        {
          reservationId,
          userId,
          conversationId: conversation._id,
          assistantMessageId,
          expectedVersion: 1,
          usageData: validatedUsage,
        },
        { session: tx2aSession }
      );

      // 3. Complete assistant message
      const updatedMsg = await Message.findOneAndUpdate(
        { _id: assistantMessageId },
        {
          $set: {
            content: aiResult.text,
            status: "completed",
            inputTokens: validatedUsage.billedInputTokens,
            outputTokens: validatedUsage.billedOutputTokens,
            totalTokens: validatedUsage.billedTokens,
            model: validatedUsage.model,
            updatedAt: new Date(),
          },
        },
        { session: tx2aSession, returnDocument: "after" }
      );

      if (!updatedMsg) {
        throw new ChatError(
          "Assistant message placeholder missing during settlement",
          500
        );
      }
      finalizedAssistantMsg = updatedMsg;

      // 4. Update conversation timestamp
      await Conversation.updateOne(
        { _id: conversation._id },
        { $set: { updatedAt: new Date() } },
        { session: tx2aSession }
      );

      // 5. Finalize idempotency settled state
      if (idempotencyKey && claimToken) {
        const payloadToPersist: SendMessageResponse = {
          userMessage: formatSafeUserMessage(userMessage),
          assistantMessage: formatSafeAssistantMessage(
            updatedMsg,
            (assistantPlaceholder as any).createdAt
          ),
        };

        await finalizeSettledClaim(
          userId,
          idempotencyKey,
          claimToken,
          payloadToPersist,
          201,
          tx2aSession
        );
      }

      await tx2aSession.commitTransaction();
    } catch (error) {
      await tx2aSession.abortTransaction();
      console.error("Chat finalization transaction aborted:", error);
      throw error;
    } finally {
      await tx2aSession.endSession();
    }

    return formatSafeAssistantMessage(
      finalizedAssistantMsg,
      (assistantPlaceholder as any).createdAt
    );
  };

  const generationPromise = executeGeneration().finally(() => {
    inFlightGenerations.delete(assistantMessageId.toString());
  });
  inFlightGenerations.set(assistantMessageId.toString(), generationPromise);

  const assistantResult = await generationPromise;

  return {
    userMessage: formatSafeUserMessage(userMessage),
    assistantMessage: assistantResult,
    isReplay: false,
    statusCode: 201,
  };
};

export interface SendMessageStreamCallbacks {
  onMetadata?: (meta: SSEMetadataEvent) => void | Promise<void>;
  onDelta?: (delta: SSEDeltaEvent) => void | Promise<void>;
  onDone?: (done: SSEDoneEvent) => void | Promise<void>;
  onError?: (err: SSEErrorEvent) => void | Promise<void>;
}

export const sendMessageStream = async (
  userId: string,
  conversationId: string,
  content: string,
  file?: Express.Multer.File,
  idempotencyKey?: string,
  callbacks?: SendMessageStreamCallbacks,
  abortSignal?: AbortSignal
): Promise<void> => {
  const conversation = await findUserConversationById(conversationId, userId);
  const exhaustedModels = new Set<string>();
  const resolvedContent = content?.trim() || "";

  if (!file && resolvedContent.length === 0) {
    throw new ChatError("Message content cannot be empty", 400);
  }

  // 1. Idempotency Check & Claim
  let claimToken: string | undefined;
  const attachmentDigest = computeAttachmentDigest(file);
  const requestHash = computeRequestHash(
    conversation._id,
    content,
    attachmentDigest
  );

  if (idempotencyKey) {
    const idempResult = await claimOrCheckIdempotencyKey(
      userId,
      idempotencyKey,
      conversation._id,
      requestHash
    );

    if (idempResult.isReplay) {
      await callbacks?.onMetadata?.({
        conversationId: conversation._id.toString(),
        userMessageId: idempResult.payload.userMessage.id,
        assistantMessageId: idempResult.payload.assistantMessage.id,
        model: (idempResult.payload.assistantMessage as any).model || PRIMARY_MODEL,
      });
      await callbacks?.onDelta?.({
        content: idempResult.payload.assistantMessage.content,
      });
      await callbacks?.onDone?.({
        conversationId: conversation._id.toString(),
        userMessage: idempResult.payload.userMessage,
        assistantMessage: idempResult.payload.assistantMessage,
        status: "completed",
        isReplay: true,
      });
      return;
    }

    claimToken = idempResult.claimToken;
  }

  const userMessageId = new mongoose.Types.ObjectId();
  const assistantMessageId = new mongoose.Types.ObjectId();
  const reservationId = new mongoose.Types.ObjectId();

  // 2. Lock Acquisition
  let acquiredLock: AcquiredLock;
  try {
    acquiredLock = await _internalLock.acquireConversationLock(
      conversation._id,
      userId,
      assistantMessageId
    );
  } catch (lockError) {
    if (idempotencyKey && claimToken) {
      await cleanupOrphanedClaim(userId, idempotencyKey, claimToken);
    }
    throw lockError;
  }

  // 3. Handle Attachment
  let attachmentData: IMessageAttachment | undefined;
  let currentImageBase64: string | undefined;
  let newlyUploadedPublicId: string | null = null;

  if (file) {
    try {
      const buffer =
        file.buffer ||
        (file.path && fs.existsSync(file.path)
          ? fs.readFileSync(file.path)
          : undefined);

      if (!buffer) {
        throw new Error("No file buffer available for image processing");
      }

      currentImageBase64 = buffer.toString("base64");
      const uploadResult = await uploadChatImage(
        buffer,
        file.originalname,
        file.mimetype
      );

      newlyUploadedPublicId = uploadResult.publicId;
      attachmentData = {
        type: "image",
        url: uploadResult.secureUrl,
        publicId: uploadResult.publicId,
        mimeType: file.mimetype,
        name: file.originalname,
        size: file.size || uploadResult.bytes,
      };
    } catch (uploadError: any) {
      console.error("[Chat] Cloudinary upload failed:", uploadError);
      await _internalLock.releaseConversationLockImmediately(
        conversation._id,
        acquiredLock.lockToken,
        acquiredLock.lockVersion
      );
      if (idempotencyKey && claimToken) {
        await cleanupOrphanedClaim(userId, idempotencyKey, claimToken);
      }
      throw new ChatError(
        uploadError?.message || "Failed to upload image to Cloudinary",
        500
      );
    }
  }

  // 4. Build Context & Precompute Input Tokens
  let inputTokens: number;
  const geminiContents: GeminiContent[] = [];

  try {
    const existingMessages = await Message.find({
      conversationId: conversation._id,
      status: { $nin: ["generating", "failed"] },
    })
      .sort({ createdAt: 1 })
      .lean();

    const historySlice = existingMessages.slice(
      -CHAT_CONSTANTS.MAX_CONTEXT_MESSAGES
    );

    for (const msg of historySlice) {
      if (!msg.content && !msg.attachment) continue;
      const parts: any[] = [];
      if (
        msg.attachment &&
        msg.attachment.type === "image" &&
        msg.attachment.url
      ) {
        if (msg.attachment.url.startsWith("http")) {
          try {
            const fetchRes = await fetch(msg.attachment.url);
            if (fetchRes.ok) {
              const arrayBuffer = await fetchRes.arrayBuffer();
              parts.push(
                createPartFromBase64(
                  Buffer.from(arrayBuffer).toString("base64"),
                  msg.attachment.mimeType
                )
              );
            }
          } catch {}
        } else {
          const localFilePath = path.join(
            process.cwd(),
            msg.attachment.url.replace(/^\//, "")
          );
          if (fs.existsSync(localFilePath)) {
            try {
              const imgBuffer = fs.readFileSync(localFilePath);
              parts.push(
                createPartFromBase64(
                  imgBuffer.toString("base64"),
                  msg.attachment.mimeType
                )
              );
            } catch {}
          }
        }
      }
      parts.push(createPartFromText(msg.content || "Describe this image."));
      geminiContents.push({
        role: msg.role === "assistant" ? "model" : "user",
        parts,
      });
    }

    while (geminiContents.length > 0 && geminiContents[0].role === "model") {
      geminiContents.shift();
    }

    const userTurnParts: any[] = [];
    if (file && currentImageBase64) {
      userTurnParts.push(
        createPartFromBase64(currentImageBase64, file.mimetype)
      );
    }
    userTurnParts.push(createPartFromText(resolvedContent));

    geminiContents.push({
      role: "user",
      parts: userTurnParts,
    });

    inputTokens = await _internalAI.countPromptTokens(
      geminiContents,
      PRIMARY_MODEL,
      exhaustedModels
    );
  } catch (prepError) {
    if (newlyUploadedPublicId) {
      deleteChatImage(newlyUploadedPublicId).catch(() => {});
    }
    await _internalLock.releaseConversationLockImmediately(
      conversation._id,
      acquiredLock.lockToken,
      acquiredLock.lockVersion
    );
    if (idempotencyKey && claimToken) {
      await cleanupOrphanedClaim(userId, idempotencyKey, claimToken);
    }
    throw prepError;
  }

  // 5. Transaction 1: Pre-generation hold and message placeholders
  let reservedAmount: number;
  let allowedOutputTokens: number;
  let userMessage: any;
  let assistantPlaceholder: any;

  const tx1Session = await mongoose.startSession();
  tx1Session.startTransaction();

  try {
    const reservationRes = await _internalTokenService.createTokenReservation(
      {
        userId,
        conversationId: conversation._id,
        userMessageId,
        assistantMessageId,
        reservationId,
        inputTokens,
        model: PRIMARY_MODEL,
      },
      { session: tx1Session }
    );

    reservedAmount = reservationRes.reservedAmount;
    allowedOutputTokens = reservationRes.allowedOutputTokens;

    const [createdUserMsg] = await Message.create(
      [
        {
          _id: userMessageId,
          conversationId: conversation._id,
          userId: new mongoose.Types.ObjectId(userId),
          role: "user",
          content: resolvedContent,
          attachment: attachmentData,
          status: "completed",
        },
      ],
      { session: tx1Session }
    );
    userMessage = createdUserMsg;

    const [createdAssistantMsg] = await Message.create(
      [
        {
          _id: assistantMessageId,
          conversationId: conversation._id,
          userId: new mongoose.Types.ObjectId(userId),
          role: "assistant",
          content: "",
          status: "generating",
        },
      ],
      { session: tx1Session }
    );
    assistantPlaceholder = createdAssistantMsg;

    if (idempotencyKey && claimToken) {
      await bindReservationToClaim(
        userId,
        idempotencyKey,
        claimToken,
        reservationId,
        assistantMessageId,
        tx1Session
      );
    }

    await tx1Session.commitTransaction();
  } catch (tx1Error) {
    await tx1Session.abortTransaction();
    if (newlyUploadedPublicId) {
      deleteChatImage(newlyUploadedPublicId).catch(() => {});
    }
    await _internalLock.releaseConversationLockImmediately(
      conversation._id,
      acquiredLock.lockToken,
      acquiredLock.lockVersion
    );
    if (idempotencyKey && claimToken) {
      await cleanupOrphanedClaim(userId, idempotencyKey, claimToken);
    }
    throw tx1Error;
  } finally {
    await tx1Session.endSession();
  }

  // 6. Pre-generation completed: Emit metadata event
  await callbacks?.onMetadata?.({
    conversationId: conversation._id.toString(),
    userMessageId: userMessageId.toString(),
    assistantMessageId: assistantMessageId.toString(),
    model: PRIMARY_MODEL,
  });

  // 7. Streaming Execution with Bounded Lease Renewal & Fencing
  const abortController = new AbortController();
  if (abortSignal) {
    if (abortSignal.aborted) {
      abortController.abort();
    } else {
      abortSignal.addEventListener("abort", () => abortController.abort(), {
        once: true,
      });
    }
  }

  const renewalInterval = setInterval(async () => {
    try {
      await _internalLock.renewConversationLock(
        conversation._id,
        assistantMessageId,
        acquiredLock.lockToken,
        acquiredLock.lockVersion
      );
    } catch (renewErr) {
      console.warn("[ChatLock] Lease renewal failed, aborting stream:", renewErr);
      clearInterval(renewalInterval);
      abortController.abort();
    }
  }, 30000);

  let aiResult: AIResponseWithUsage | undefined;
  let generationError: any = undefined;

  try {
    const safeOutputTokens = Math.max(
      16,
      Math.floor(allowedOutputTokens * 0.65)
    );

    aiResult = await _internalAI.streamAIResponseWithUsage(
      geminiContents,
      safeOutputTokens,
      {
        onChunk: async (chunkText) => {
          if (abortController.signal.aborted) return;
          await callbacks?.onDelta?.({ content: chunkText });
        },
        signal: abortController.signal,
      },
      exhaustedModels
    );
  } catch (err) {
    generationError = err;
  } finally {
    clearInterval(renewalInterval);
  }

  // 8. Handle Aborted / Cancelled Stream (Transaction 2B)
  if (
    abortController.signal.aborted ||
    (generationError && abortSignal?.aborted)
  ) {
    const tx2bSession = await mongoose.startSession();
    tx2bSession.startTransaction();

    try {
      await _internalLock.fencedReleaseConversationLock(
        conversation._id,
        assistantMessageId,
        acquiredLock.lockToken,
        acquiredLock.lockVersion,
        tx2bSession
      );

      if (inputTokens > 0) {
        const abortUsage = {
          billedTokens: Math.min(inputTokens, reservedAmount),
          billedInputTokens: Math.min(inputTokens, reservedAmount),
          billedOutputTokens: 0,
          overrunTokens: 0,
          verificationStatus: "ABORTED_PROMPT_ONLY" as const,
          verificationNotes:
            "Stream cancelled by user; billed verified prompt tokens only, output waived",
          model: PRIMARY_MODEL,
        };

        await _internalTokenService.settleTokenReservation(
          {
            reservationId,
            userId,
            conversationId: conversation._id,
            assistantMessageId,
            expectedVersion: 1,
            usageData: abortUsage,
          },
          { session: tx2bSession }
        );
      } else {
        await _internalTokenService.refundTokenReservation(
          {
            reservationId,
            userId,
            expectedVersion: 1,
            reason: "Stream cancelled by user with unverified prompt tokens",
          },
          { session: tx2bSession }
        );
      }

      await Message.updateOne(
        { _id: assistantMessageId },
        {
          $set: {
            content: aiResult?.text || "",
            status: "failed",
            errorMessage: "Generation cancelled by user",
            updatedAt: new Date(),
          },
        },
        { session: tx2bSession }
      );

      if (idempotencyKey && claimToken) {
        await finalizeFailedClaim(
          userId,
          idempotencyKey,
          claimToken,
          "Generation cancelled by user",
          tx2bSession
        );
      }

      await tx2bSession.commitTransaction();
    } catch (abortCleanupErr) {
      await tx2bSession.abortTransaction();
      if (abortCleanupErr instanceof ReservationStateConflictError) {
        console.warn(
          `[Chat] Reservation ${reservationId} already finalized; abort settlement skipped idempotently.`
        );
      } else {
        console.error(
          "[Chat] Failed to execute Transaction 2B for cancelled stream:",
          abortCleanupErr
        );
      }
    } finally {
      await tx2bSession.endSession();
    }
    return;
  }

  // 9. Handle Provider Error during Stream (Transaction 2B)
  if (generationError || !aiResult) {
    const isQuota = isGeminiQuotaExhaustedError(generationError);
    const errorMsg = isQuota
      ? "AI model quota or rate limit exceeded. Please try again shortly."
      : sanitizeErrorMessage(generationError?.message || "Failed to generate AI response");
    const tx2bSession = await mongoose.startSession();
    tx2bSession.startTransaction();

    try {
      await _internalLock.fencedReleaseConversationLock(
        conversation._id,
        assistantMessageId,
        acquiredLock.lockToken,
        acquiredLock.lockVersion,
        tx2bSession
      );

      await _internalTokenService.refundTokenReservation(
        {
          reservationId,
          userId,
          expectedVersion: 1,
          reason: errorMsg,
        },
        { session: tx2bSession }
      );

      await Message.updateOne(
        { _id: assistantMessageId },
        {
          $set: {
            status: "failed",
            errorMessage: errorMsg,
            updatedAt: new Date(),
          },
        },
        { session: tx2bSession }
      );

      if (idempotencyKey && claimToken) {
        await finalizeFailedClaim(
          userId,
          idempotencyKey,
          claimToken,
          errorMsg,
          tx2bSession
        );
      }

      await tx2bSession.commitTransaction();
    } catch (refundErr) {
      await tx2bSession.abortTransaction();
      console.error(
        "[Chat] Failed to execute Transaction 2B for failed stream:",
        refundErr
      );
    } finally {
      await tx2bSession.endSession();
    }

    const retryDelay = isQuota ? extractRetryDelay(generationError) : undefined;
    await callbacks?.onError?.({
      code: isQuota ? "RESOURCE_EXHAUSTED" : "GENERATION_FAILED",
      message: errorMsg,
      statusCode: isQuota ? 429 : 500,
      ...(retryDelay ? { retryAfter: retryDelay } : {}),
    });
    return;
  }

  // 10. Successful Stream Completion: Transaction 2A
  const rawUsage =
    aiResult.rawUsage ??
    (aiResult.totalTokens > 0
      ? {
          promptTokenCount: aiResult.inputTokens,
          candidatesTokenCount: aiResult.outputTokens,
          totalTokenCount: aiResult.totalTokens,
        }
      : undefined);

  const validatedUsage = validateUsageData(
    rawUsage,
    reservedAmount,
    inputTokens,
    aiResult.model
  );

  const tx2aSession = await mongoose.startSession();
  tx2aSession.startTransaction();
  let finalizedAssistantMsg: any;

  try {
    await _internalLock.fencedReleaseConversationLock(
      conversation._id,
      assistantMessageId,
      acquiredLock.lockToken,
      acquiredLock.lockVersion,
      tx2aSession
    );

    await _internalTokenService.settleTokenReservation(
      {
        reservationId,
        userId,
        conversationId: conversation._id,
        assistantMessageId,
        expectedVersion: 1,
        usageData: validatedUsage,
      },
      { session: tx2aSession }
    );

    const updatedMsg = await Message.findOneAndUpdate(
      { _id: assistantMessageId },
      {
        $set: {
          content: aiResult.text,
          status: "completed",
          inputTokens: validatedUsage.billedInputTokens,
          outputTokens: validatedUsage.billedOutputTokens,
          totalTokens: validatedUsage.billedTokens,
          model: validatedUsage.model,
          updatedAt: new Date(),
        },
      },
      { session: tx2aSession, returnDocument: "after" }
    );

    if (!updatedMsg) {
      throw new ChatError(
        "Assistant message placeholder missing during settlement",
        500
      );
    }
    finalizedAssistantMsg = updatedMsg;

    await Conversation.updateOne(
      { _id: conversation._id },
      { $set: { updatedAt: new Date() } },
      { session: tx2aSession }
    );

    const formattedUser = formatSafeUserMessage(userMessage);
    const formattedAssistant = formatSafeAssistantMessage(
      updatedMsg,
      (assistantPlaceholder as any).createdAt
    );

    if (idempotencyKey && claimToken) {
      const payloadToPersist: SendMessageResponse = {
        userMessage: formattedUser,
        assistantMessage: formattedAssistant,
      };

      await finalizeSettledClaim(
        userId,
        idempotencyKey,
        claimToken,
        payloadToPersist,
        201,
        tx2aSession
      );
    }

    await tx2aSession.commitTransaction();

    await callbacks?.onDone?.({
      conversationId: conversation._id.toString(),
      userMessage: formattedUser,
      assistantMessage: formattedAssistant,
      usage: {
        promptTokens: validatedUsage.billedInputTokens,
        completionTokens: validatedUsage.billedOutputTokens,
        totalTokens: validatedUsage.billedTokens,
        model: validatedUsage.model,
      },
      status: "completed",
    });
  } catch (error) {
    await tx2aSession.abortTransaction();
    console.error("[Chat] Stream finalization transaction aborted:", error);
    await callbacks?.onError?.({
      code: "FINALIZATION_FAILED",
      message: "Failed to finalize chat message and token settlement",
      statusCode: 500,
    });
    throw error;
  } finally {
    await tx2aSession.endSession();
  }
};

export const deleteConversation = async (
  userId: string,
  conversationId: string
): Promise<void> => {
  if (!mongoose.Types.ObjectId.isValid(conversationId)) {
    throw new ChatError("Invalid conversation ID format", 400);
  }

  const convIdObj = new mongoose.Types.ObjectId(conversationId);

  // 1. Find conversation by ID
  const conversation = await Conversation.findById(convIdObj);

  if (conversation) {
    // 2. Validate ownership safely
    const convUserIdStr = conversation.userId?.toString();
    const currentUserIdStr = userId.toString();

    if (convUserIdStr && convUserIdStr !== currentUserIdStr) {
      throw new ChatError("Unauthorized to delete this conversation", 403);
    }

    // 3. Find messages with attachments to clean up Cloudinary assets (and legacy disk files)
    try {
      const messagesWithAttachments = await Message.find({
        conversationId: conversation._id,
        "attachment.url": { $exists: true, $ne: null },
      });

      for (const msg of messagesWithAttachments) {
        if (msg.attachment?.publicId) {
          try {
            await deleteChatImage(msg.attachment.publicId);
          } catch (err) {
            console.error(`Failed to delete Cloudinary image:`, err);
          }
        } else if (msg.attachment?.url) {
          const localFilePath = path.join(
            process.cwd(),
            msg.attachment.url.replace(/^\//, "")
          );
          if (fs.existsSync(localFilePath)) {
            fs.promises.unlink(localFilePath).catch(() => {});
          }
        }
      }
    } catch (err) {
      console.error("Error inspecting attachments for deletion:", err);
    }

    // 4. Delete all messages belonging to this conversation
    await Message.deleteMany({ conversationId: conversation._id });

    // 5. Delete the conversation document
    await Conversation.deleteOne({ _id: conversation._id });
  } else {
    // Idempotent cleanup: ensure no orphaned messages remain
    await Message.deleteMany({ conversationId: convIdObj });
  }
};


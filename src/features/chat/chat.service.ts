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
  countPromptTokens,
  createPartFromBase64,
  createPartFromText,
  type AIResponseWithUsage,
  type GeminiContent,
} from "../ai/ai.service.js";
import {
  reserveTokenBudget,
  releaseTokenReservation,
  finalizeTokenUsage,
  TokenInvariantViolationError,
} from "../token/index.js";
import { CHAT_CONSTANTS } from "./chat.constants.js";
import { uploadChatImage, deleteChatImage } from "./chat.cloudinary.js";
import type {
  SafeConversation,
  SafeMessage,
  SendMessageResponse,
} from "./chat.types.js";

export class ChatError extends Error {
  statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "ChatError";
    this.statusCode = statusCode;
  }
}

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
  countPromptTokens,
};

export const sendMessage = async (
  userId: string,
  conversationId: string,
  content: string,
  file?: Express.Multer.File
): Promise<SendMessageResponse> => {
  const conversation = await findUserConversationById(conversationId, userId);

  // Normalize message content for image-only vs text/image questions
  const resolvedContent =
    content && content.trim().length > 0
      ? content.trim()
      : file
      ? "Describe this image."
      : "";

  let attachmentData: IMessageAttachment | undefined;
  let currentImageBase64: string | undefined;

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
      throw new ChatError(
        uploadError?.message || "Failed to upload image to Cloudinary",
        500
      );
    }
  }

  // 1. Fetch persisted conversation history from MongoDB in chronological order
  // Exclude placeholder generating/failed messages so they don't corrupt Gemini context
  const existingMessages = await Message.find({
    conversationId: conversation._id,
    status: { $nin: ["generating", "failed"] },
  })
    .sort({ createdAt: 1 })
    .lean();

  // Apply deterministic context window (newest messages up to MAX_CONTEXT_MESSAGES)
  const historySlice = existingMessages.slice(-CHAT_CONSTANTS.MAX_CONTEXT_MESSAGES);
  const geminiContents: GeminiContent[] = [];

  for (const msg of historySlice) {
    if (!msg.content && !msg.attachment) continue;
    const parts: any[] = [];
    if (msg.attachment && msg.attachment.type === "image" && msg.attachment.url) {
      if (msg.attachment.url.startsWith("http")) {
        try {
          const fetchRes = await fetch(msg.attachment.url);
          if (fetchRes.ok) {
            const arrayBuffer = await fetchRes.arrayBuffer();
            const imgBuffer = Buffer.from(arrayBuffer);
            parts.push(
              createPartFromBase64(imgBuffer.toString("base64"), msg.attachment.mimeType)
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
              createPartFromBase64(imgBuffer.toString("base64"), msg.attachment.mimeType)
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

  // Ensure window does not start with an orphaned model message if history was truncated
  while (geminiContents.length > 0 && geminiContents[0].role === "model") {
    geminiContents.shift();
  }

  // Append new user message with optional multimodal image part as the latest turn
  const userTurnParts: any[] = [];
  if (file && currentImageBase64) {
    userTurnParts.push(createPartFromBase64(currentImageBase64, file.mimetype));
  }
  userTurnParts.push(createPartFromText(resolvedContent));

  geminiContents.push({
    role: "user",
    parts: userTurnParts,
  });

  // 2. Count exact input tokens for the prompt including conversation context and image
  const inputTokens = await _internalAI.countPromptTokens(geminiContents);

  // 3. Atomically reserve token budget based on actual context
  let reservedAmount: number;
  let allowedOutputTokens: number;

  try {
    const reservation = await reserveTokenBudget(userId, inputTokens);
    reservedAmount = reservation.reservedAmount;
    allowedOutputTokens = reservation.allowedOutputTokens;
  } catch (resError) {
    // If token reservation fails (e.g. 402 exhausted), clean up Cloudinary asset so it is not orphaned
    if (attachmentData?.publicId) {
      deleteChatImage(attachmentData.publicId).catch(() => {});
    }
    throw resError;
  }

  // 4. Persist user message with optional attachment metadata and status: "completed"
  const userMessage = await Message.create({
    conversationId: conversation._id,
    userId: new mongoose.Types.ObjectId(userId),
    role: "user",
    content: resolvedContent,
    attachment: attachmentData,
    status: "completed",
  });

  // 5. Persist assistant message placeholder with status: "generating"
  const assistantMessageId = new mongoose.Types.ObjectId();
  const [assistantPlaceholder] = await Message.create([
    {
      _id: assistantMessageId,
      conversationId: conversation._id,
      userId: new mongoose.Types.ObjectId(userId),
      role: "assistant",
      content: "",
      status: "generating",
    },
  ]);

  // 6. Background generation task: resilient to client refresh / disconnect
  const executeGeneration = async (): Promise<SafeMessage> => {
    let aiResult: AIResponseWithUsage;

    try {
      aiResult = await _internalAI.generateAIResponseWithUsage(
        geminiContents,
        allowedOutputTokens
      );
    } catch (aiError: any) {
      console.error("Gemini invocation failed in chat service:", aiError);
      // Release reservation on AI generation failure
      try {
        await releaseTokenReservation(userId, reservedAmount);
      } catch (relErr) {
        console.error("Failed to release token reservation:", relErr);
      }
      await Message.updateOne(
        { _id: assistantMessageId },
        {
          $set: {
            status: "failed",
            errorMessage: aiError?.message || "Failed to generate AI response",
            updatedAt: new Date(),
          },
        }
      );
      throw new ChatError("Failed to generate AI response", 500);
    }

    // Invariant check: actual usage must not exceed reservation
    if (aiResult.totalTokens > reservedAmount) {
      console.error(
        `Token accounting invariant violation: actual usage (${aiResult.totalTokens}) exceeded reserved amount (${reservedAmount}) for user ${userId}`
      );
      try {
        await releaseTokenReservation(userId, reservedAmount);
      } catch (relErr) {
        console.error("Failed to release token reservation:", relErr);
      }
      if (file && file.path && fs.existsSync(file.path)) {
        fs.promises.unlink(file.path).catch(() => {});
      }
      await Message.updateOne(
        { _id: assistantMessageId },
        {
          $set: {
            status: "failed",
            errorMessage: "Token accounting limit exceeded",
            updatedAt: new Date(),
          },
        }
      );
      throw new TokenInvariantViolationError(
        `Actual token usage (${aiResult.totalTokens}) exceeded reserved amount (${reservedAmount})`
      );
    }

    // Atomic finalization and assistant message persistence transaction
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      await finalizeTokenUsage(
        userId,
        reservedAmount,
        {
          inputTokens: aiResult.inputTokens,
          outputTokens: aiResult.outputTokens,
          totalTokens: aiResult.totalTokens,
          model: aiResult.model,
          conversationId: conversation._id.toString(),
          messageId: assistantMessageId.toString(),
          type: "chat",
        },
        { session }
      );

      await Message.updateOne(
        { _id: assistantMessageId },
        {
          $set: {
            content: aiResult.text,
            status: "completed",
            inputTokens: aiResult.inputTokens,
            outputTokens: aiResult.outputTokens,
            totalTokens: aiResult.totalTokens,
            model: aiResult.model,
            updatedAt: new Date(),
          },
        },
        { session }
      );

      await Conversation.updateOne(
        { _id: conversation._id },
        { $set: { updatedAt: new Date() } },
        { session }
      );

      await session.commitTransaction();
    } catch (error) {
      await session.abortTransaction();
      console.error("Chat finalization transaction aborted:", error);

      try {
        await releaseTokenReservation(userId, reservedAmount);
      } catch (releaseErr) {
        console.error("Failed to release token reservation after transaction abort:", releaseErr);
      }

      await Message.updateOne(
        { _id: assistantMessageId },
        {
          $set: {
            status: "failed",
            errorMessage: "Failed to persist response finalization",
            updatedAt: new Date(),
          },
        }
      );

      throw error;
    } finally {
      await session.endSession();
    }

    return {
      id: assistantMessageId.toString(),
      conversationId: conversation._id.toString(),
      role: "assistant",
      content: aiResult.text,
      status: "completed",
      createdAt: (assistantPlaceholder as any).createdAt,
      updatedAt: new Date(),
    };
  };

  // Register promise in inFlightGenerations
  const generationPromise = executeGeneration().finally(() => {
    inFlightGenerations.delete(assistantMessageId.toString());
  });
  inFlightGenerations.set(assistantMessageId.toString(), generationPromise);

  // Await the generation so active connections receive the response directly
  const assistantResult = await generationPromise;

  return {
    userMessage: {
      id: userMessage._id.toString(),
      conversationId: userMessage.conversationId.toString(),
      role: userMessage.role,
      content: userMessage.content,
      status: (userMessage.status as MessageStatus) || "completed",
      attachment:
        userMessage.attachment && userMessage.attachment.url
          ? {
              type: userMessage.attachment.type,
              url: userMessage.attachment.url,
              publicId: userMessage.attachment.publicId,
              mimeType: userMessage.attachment.mimeType,
              name: userMessage.attachment.name,
              size: userMessage.attachment.size,
            }
          : undefined,
      createdAt: (userMessage as any).createdAt,
      updatedAt: (userMessage as any).updatedAt,
    },
    assistantMessage: assistantResult,
  };
};

export const deleteConversation = async (
  userId: string,
  conversationId: string
): Promise<void> => {
  const conversation = await findUserConversationById(conversationId, userId);

  // Find messages with attachments to clean up Cloudinary assets (and legacy disk files)
  const messagesWithAttachments = await Message.find({
    conversationId: conversation._id,
    "attachment.url": { $exists: true, $ne: null },
  });

  for (const msg of messagesWithAttachments) {
    if (msg.attachment?.publicId) {
      try {
        await deleteChatImage(msg.attachment.publicId);
      } catch (err) {
        console.error(`Failed to delete Cloudinary image ${msg.attachment.publicId}:`, err);
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

  // Delete all messages belonging to this conversation
  await Message.deleteMany({ conversationId: conversation._id });

  // Delete the conversation document
  await Conversation.deleteOne({ _id: conversation._id });
};


import mongoose from "mongoose";
import { Conversation } from "../../database/models/conversation/index.js";
import { Message } from "../../database/models/message/index.js";
import {
  generateAIResponseWithUsage,
  countPromptTokens,
  type AIResponseWithUsage,
} from "../ai/ai.service.js";
import {
  reserveTokenBudget,
  releaseTokenReservation,
  finalizeTokenUsage,
  TokenInvariantViolationError,
} from "../token/index.js";
import { CHAT_CONSTANTS } from "./chat.constants.js";
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

export const getConversationMessages = async (
  userId: string,
  conversationId: string
): Promise<SafeMessage[]> => {
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

  const messages = await Message.find({
    conversationId: new mongoose.Types.ObjectId(conversationId),
  }).sort({ createdAt: 1 });

  return messages.map((msg) => ({
    id: msg._id.toString(),
    conversationId: msg.conversationId.toString(),
    role: msg.role,
    content: msg.content,
    createdAt: (msg as any).createdAt,
    updatedAt: (msg as any).updatedAt,
  }));
};

export const _internalAI = {
  generateAIResponseWithUsage,
  countPromptTokens,
};

export const sendMessage = async (
  userId: string,
  conversationId: string,
  content: string
): Promise<SendMessageResponse> => {
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

  // 1. Count exact input tokens for the prompt
  const inputTokens = await _internalAI.countPromptTokens(content);

  // 2. Atomically reserve token budget
  const { reservedAmount, allowedOutputTokens } = await reserveTokenBudget(
    userId,
    inputTokens
  );

  // 3. Persist user message
  const userMessage = await Message.create({
    conversationId: conversation._id,
    userId: new mongoose.Types.ObjectId(userId),
    role: "user",
    content,
  });

  // 4. Call Gemini with exact allowedOutputTokens
  let aiResult: AIResponseWithUsage;

  try {
    aiResult = await _internalAI.generateAIResponseWithUsage(content, allowedOutputTokens);
  } catch (aiError) {
    console.error("Gemini invocation failed in chat service:", aiError);
    // Release reservation on AI generation failure
    await releaseTokenReservation(userId, reservedAmount);
    throw new ChatError("Failed to generate AI response", 500);
  }

  // 5. Invariant check: actual usage must not exceed reservation
  if (aiResult.totalTokens > reservedAmount) {
    console.error(
      `Token accounting invariant violation: actual usage (${aiResult.totalTokens}) exceeded reserved amount (${reservedAmount}) for user ${userId}`
    );
    await releaseTokenReservation(userId, reservedAmount);
    throw new TokenInvariantViolationError(
      `Actual token usage (${aiResult.totalTokens}) exceeded reserved amount (${reservedAmount})`
    );
  }

  // 6. Atomic finalization and assistant message persistence transaction
  const session = await mongoose.startSession();
  session.startTransaction();

  let assistantMessageDoc: any;

  try {
    // Generate deterministic ID for assistant message so TokenUsage can reference it
    const assistantMessageId = new mongoose.Types.ObjectId();

    // A. Finalize token usage and wallet atomically under this caller-owned session
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

    // B. Persist assistant message within the same transaction
    const [assistantMessage] = await Message.create(
      [
        {
          _id: assistantMessageId,
          conversationId: conversation._id,
          userId: new mongoose.Types.ObjectId(userId),
          role: "assistant",
          content: aiResult.text,
        },
      ],
      { session }
    );
    assistantMessageDoc = assistantMessage;

    // C. Update conversation timestamp within the transaction
    await Conversation.updateOne(
      { _id: conversation._id },
      { $set: { updatedAt: new Date() } },
      { session }
    );

    // Commit all changes atomically
    await session.commitTransaction();
  } catch (error) {
    await session.abortTransaction();
    console.error("Chat finalization transaction aborted:", error);

    // Safely release reservation since transaction aborted and all writes were rolled back
    try {
      await releaseTokenReservation(userId, reservedAmount);
    } catch (releaseErr) {
      console.error("Failed to release token reservation after transaction abort:", releaseErr);
    }

    throw error;
  } finally {
    await session.endSession();
  }

  return {
    userMessage: {
      id: userMessage._id.toString(),
      conversationId: userMessage.conversationId.toString(),
      role: userMessage.role,
      content: userMessage.content,
      createdAt: (userMessage as any).createdAt,
      updatedAt: (userMessage as any).updatedAt,
    },
    assistantMessage: {
      id: assistantMessageDoc._id.toString(),
      conversationId: assistantMessageDoc.conversationId.toString(),
      role: assistantMessageDoc.role,
      content: assistantMessageDoc.content,
      createdAt: (assistantMessageDoc as any).createdAt,
      updatedAt: (assistantMessageDoc as any).updatedAt,
    },
  };
};


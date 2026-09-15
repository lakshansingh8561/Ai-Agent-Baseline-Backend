import mongoose from "mongoose";
import { Conversation } from "../../database/models/conversation/index.js";
import { Message } from "../../database/models/message/index.js";
import { generateAIResponse } from "../ai/ai.service.js";
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

  const userMessage = await Message.create({
    conversationId: conversation._id,
    userId: new mongoose.Types.ObjectId(userId),
    role: "user",
    content,
  });

  let aiResponse: string;

  try {
    aiResponse = await generateAIResponse(content);
  } catch (aiError) {
    console.error("Gemini invocation failed in chat service:", aiError);
    throw new ChatError("Failed to generate AI response", 500);
  }

  const assistantMessage = await Message.create({
    conversationId: conversation._id,
    userId: new mongoose.Types.ObjectId(userId),
    role: "assistant",
    content: aiResponse,
  });

  await Conversation.updateOne(
    { _id: conversation._id },
    { $set: { updatedAt: new Date() } }
  );

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
      id: assistantMessage._id.toString(),
      conversationId: assistantMessage.conversationId.toString(),
      role: assistantMessage.role,
      content: assistantMessage.content,
      createdAt: (assistantMessage as any).createdAt,
      updatedAt: (assistantMessage as any).updatedAt,
    },
  };
};

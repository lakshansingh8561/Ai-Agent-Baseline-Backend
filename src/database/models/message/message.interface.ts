import type { HydratedDocument, Types } from "mongoose";

export type MessageRole = "user" | "assistant";

export interface IMessage {
  conversationId: Types.ObjectId;
  userId: Types.ObjectId;
  role: MessageRole;
  content: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  model?: string;
}

export type IMessageDocument = HydratedDocument<IMessage>;
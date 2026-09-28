import type { HydratedDocument, Types } from "mongoose";

export type MessageRole = "user" | "assistant";

export interface IMessageAttachment {
  type: "image";
  url: string;
  publicId?: string;
  mimeType: string;
  name: string;
  size: number;
}

export type MessageStatus = "pending" | "generating" | "completed" | "failed";

export interface IMessage {
  conversationId: Types.ObjectId;
  userId: Types.ObjectId;
  role: MessageRole;
  content: string;
  status?: MessageStatus;
  errorMessage?: string;
  attachment?: IMessageAttachment;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  model?: string;
}

export type IMessageDocument = HydratedDocument<IMessage>;
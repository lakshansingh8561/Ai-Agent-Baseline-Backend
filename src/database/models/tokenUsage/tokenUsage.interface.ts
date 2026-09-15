import type { HydratedDocument, Types } from "mongoose";

export type TokenUsageType = "chat";

export interface ITokenUsage {
  userId: Types.ObjectId;
  conversationId?: Types.ObjectId;
  messageId?: Types.ObjectId;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  model: string;
  type: TokenUsageType;
}

export type ITokenUsageDocument = HydratedDocument<ITokenUsage>;
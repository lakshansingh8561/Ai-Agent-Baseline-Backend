import type { HydratedDocument, Types } from "mongoose";
import type { UsageVerificationStatus } from "../tokenReservation/tokenReservation.interface.js";

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
  usageVerification?: UsageVerificationStatus;
  providerTotalTokens?: number;
}

export type ITokenUsageDocument = HydratedDocument<ITokenUsage>;
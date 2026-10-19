import type { ClientSession, Types } from "mongoose";
import type {
  UsageVerificationStatus,
  IProviderUsage,
} from "../../database/models/tokenReservation/tokenReservation.interface.js";

export type { UsageVerificationStatus, IProviderUsage };

export interface TokenReservation {
  reservedAmount: number;
  allowedOutputTokens: number;
  inputTokens: number;
}

export interface TokenReservationResult extends TokenReservation {
  reservationId: Types.ObjectId;
  version: number;
}

export interface CreateReservationParams {
  userId: string | Types.ObjectId;
  conversationId: string | Types.ObjectId;
  userMessageId: string | Types.ObjectId;
  assistantMessageId: string | Types.ObjectId;
  reservationId?: Types.ObjectId;
  inputTokens: number;
  maxOutputBudget?: number;
  model?: string;
  lockDurationSeconds?: number;
}

export interface RawProviderUsage {
  promptTokenCount?: number | null;
  candidatesTokenCount?: number | null;
  thoughtsTokenCount?: number | null;
  totalTokenCount?: number | null;
}

export interface ValidatedUsageResult {
  billedTokens: number;
  billedInputTokens: number;
  billedOutputTokens: number;
  providerUsage?: IProviderUsage;
  overrunTokens: number;
  verificationStatus: UsageVerificationStatus;
  verificationNotes?: string;
  model: string;
}

export interface SettleReservationParams {
  reservationId: string | Types.ObjectId;
  userId: string | Types.ObjectId;
  conversationId?: string | Types.ObjectId;
  assistantMessageId: string | Types.ObjectId;
  expectedVersion: number;
  usageData: ValidatedUsageResult;
}

export interface RefundReservationParams {
  reservationId: string | Types.ObjectId;
  userId: string | Types.ObjectId;
  expectedVersion: number;
  reason?: string;
}

export interface ActualUsageData {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  model: string;
  conversationId?: string;
  messageId?: string;
  type?: "chat";
}

export interface FinalizeUsageResult {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  refundedTokens: number;
  model: string;
}

export interface FinalizeTokenUsageOptions {
  session?: ClientSession;
}

export interface AllocateTokensForPlanOptions {
  allocationKey?: string;
  checkoutId?: string | null;
  provider?: "none" | "polar";
  providerSubscriptionId?: string | null;
  periodStart?: Date | null;
  periodEnd?: Date | null;
  session?: ClientSession;
}


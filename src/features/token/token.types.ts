import type { ClientSession } from "mongoose";

export interface TokenReservation {
  reservedAmount: number;
  allowedOutputTokens: number;
  inputTokens: number;
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

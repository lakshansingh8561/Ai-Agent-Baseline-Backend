import type { HydratedDocument, Types } from "mongoose";

export type TokenReservationStatus =
  | "RESERVED"
  | "RECOVERING"
  | "SETTLED"
  | "REFUNDED"
  | "QUARANTINED";

export type UsageVerificationStatus =
  | "AUTHORITATIVE"
  | "UNVERIFIED_INPUT_ONLY"
  | "INVALID_METADATA_FALLBACK"
  | "EXCESS_CLAMPED"
  | "ABORTED_PROMPT_ONLY";

export interface IProviderUsage {
  promptTokens?: number;
  candidatesTokens?: number;
  thoughtsTokens?: number;
  totalTokens?: number;
}

export interface IActualTokens {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface ITokenReservation {
  userId: Types.ObjectId;
  conversationId: Types.ObjectId;
  userMessageId: Types.ObjectId;
  assistantMessageId: Types.ObjectId;
  reservedTokens: number;
  actualTokens?: IActualTokens;
  providerUsage?: IProviderUsage;
  billedTokens?: number;
  overrunTokens?: number;
  usageVerification?: UsageVerificationStatus;
  verificationNotes?: string;
  model?: string;
  status: TokenReservationStatus;
  version: number;
  lockExpiresAt: Date;
  claimOwner?: string | null;
  recoveryExpiresAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}

export type ITokenReservationDocument = HydratedDocument<ITokenReservation>;

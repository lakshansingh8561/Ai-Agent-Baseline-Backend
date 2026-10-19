import type { HydratedDocument, Types } from "mongoose";

export type IdempotencyKeyStatus = "IN_PROGRESS" | "SETTLED" | "FAILED";

export interface IIdempotencyKey {
  userId: Types.ObjectId;
  key: string;
  conversationId: Types.ObjectId;
  reservationId?: Types.ObjectId | null;
  assistantMessageId?: Types.ObjectId | null;
  status: IdempotencyKeyStatus;
  claimToken?: string | null;
  requestHash?: string | null;
  statusCode?: number | null;
  responsePayload?: unknown;
  expiresAt: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

export type IIdempotencyKeyDocument = HydratedDocument<IIdempotencyKey>;

import { Schema, model } from "mongoose";
import type { IIdempotencyKey } from "./idempotencyKey.interface.js";

const idempotencyKeySchema = new Schema<IIdempotencyKey>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    key: {
      type: String,
      required: true,
      trim: true,
    },

    conversationId: {
      type: Schema.Types.ObjectId,
      ref: "Conversation",
      required: true,
      index: true,
    },

    reservationId: {
      type: Schema.Types.ObjectId,
      ref: "TokenReservation",
      default: null,
    },

    assistantMessageId: {
      type: Schema.Types.ObjectId,
      ref: "Message",
      default: null,
    },

    status: {
      type: String,
      enum: ["IN_PROGRESS", "SETTLED", "FAILED"],
      default: "IN_PROGRESS",
      required: true,
    },

    claimToken: {
      type: String,
      default: null,
    },

    requestHash: {
      type: String,
      default: null,
    },

    statusCode: {
      type: Number,
      default: 201,
    },

    responsePayload: {
      type: Schema.Types.Mixed,
      default: null,
    },

    expiresAt: {
      type: Date,
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

// Compound unique index ensuring at most one operation per key per user
idempotencyKeySchema.index({ userId: 1, key: 1 }, { unique: true });

// Native MongoDB TTL index: automatically drops expired key records without deleting financial reservations
idempotencyKeySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const IdempotencyKey = model<IIdempotencyKey>(
  "IdempotencyKey",
  idempotencyKeySchema
);

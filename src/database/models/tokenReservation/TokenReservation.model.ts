import { Schema, model } from "mongoose";
import type { ITokenReservation } from "./tokenReservation.interface.js";

const actualTokensSchema = new Schema(
  {
    inputTokens: {
      type: Number,
      min: 0,
    },
    outputTokens: {
      type: Number,
      min: 0,
    },
    totalTokens: {
      type: Number,
      min: 0,
    },
  },
  { _id: false }
);

const providerUsageSchema = new Schema(
  {
    promptTokens: { type: Number, min: 0 },
    candidatesTokens: { type: Number, min: 0 },
    thoughtsTokens: { type: Number, min: 0 },
    totalTokens: { type: Number, min: 0 },
  },
  { _id: false }
);

const tokenReservationSchema = new Schema<ITokenReservation>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    conversationId: {
      type: Schema.Types.ObjectId,
      ref: "Conversation",
      required: true,
      index: true,
    },

    userMessageId: {
      type: Schema.Types.ObjectId,
      ref: "Message",
      required: true,
    },

    assistantMessageId: {
      type: Schema.Types.ObjectId,
      ref: "Message",
      required: true,
      unique: true,
    },

    reservedTokens: {
      type: Number,
      required: true,
      min: [1, "reservedTokens must be a positive integer"],
      validate: {
        validator: Number.isInteger,
        message: "{VALUE} is not an integer value for reservedTokens",
      },
    },

    actualTokens: {
      type: actualTokensSchema,
      default: undefined,
    },

    providerUsage: {
      type: providerUsageSchema,
      default: undefined,
    },

    billedTokens: {
      type: Number,
      min: 0,
    },

    overrunTokens: {
      type: Number,
      min: 0,
      default: 0,
    },

    usageVerification: {
      type: String,
      enum: [
        "AUTHORITATIVE",
        "UNVERIFIED_INPUT_ONLY",
        "INVALID_METADATA_FALLBACK",
        "EXCESS_CLAMPED",
        "ABORTED_PROMPT_ONLY",
      ],
      default: "AUTHORITATIVE",
    },

    verificationNotes: {
      type: String,
      trim: true,
    },

    model: {
      type: String,
      trim: true,
    },

    status: {
      type: String,
      enum: ["RESERVED", "RECOVERING", "SETTLED", "REFUNDED", "QUARANTINED"],
      default: "RESERVED",
      required: true,
      index: true,
    },

    version: {
      type: Number,
      default: 1,
      required: true,
      min: 1,
    },

    lockExpiresAt: {
      type: Date,
      required: true,
      index: true,
    },

    claimOwner: {
      type: String,
      default: null,
      trim: true,
    },

    recoveryExpiresAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

tokenReservationSchema.index({ status: 1, lockExpiresAt: 1 });
tokenReservationSchema.index({ conversationId: 1, status: 1 });

export const TokenReservation = model<ITokenReservation>(
  "TokenReservation",
  tokenReservationSchema
);

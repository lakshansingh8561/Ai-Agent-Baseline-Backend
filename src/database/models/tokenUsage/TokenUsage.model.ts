import { Schema, model } from "mongoose";
import type { ITokenUsage, ITokenUsageDocument } from "./tokenUsage.interface.js";

const tokenUsageSchema = new Schema<ITokenUsage>(
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
      index: true,
    },

    messageId: {
      type: Schema.Types.ObjectId,
      ref: "Message",
      index: true,
    },

    inputTokens: {
      type: Number,
      required: true,
      min: 0,
    },

    outputTokens: {
      type: Number,
      required: true,
      min: 0,
    },

    totalTokens: {
      type: Number,
      required: true,
      min: 0,
    },

    model: {
      type: String,
      required: true,
      trim: true,
    },

    type: {
      type: String,
      enum: ["chat"],
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

export const TokenUsage = model<ITokenUsage>(
  "TokenUsage",
  tokenUsageSchema
);
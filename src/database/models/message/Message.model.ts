import { Schema, model } from "mongoose";
import type { IMessage } from "./message.interface.js";

const messageSchema = new Schema<IMessage>(
  {
    conversationId: {
      type: Schema.Types.ObjectId,
      ref: "Conversation",
      required: true,
      index: true,
    },

    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    role: {
      type: String,
      enum: ["user", "assistant"],
      required: true,
    },

    content: {
      type: String,
      required: true,
      trim: true,
    },

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

    model: {
      type: String,
      trim: true,
    },
  },
  {
    timestamps: true,
  }
);

messageSchema.index({ conversationId: 1, createdAt: 1 });

export const Message = model<IMessage>("Message", messageSchema);
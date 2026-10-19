import { Schema, model } from "mongoose";
import type { IConversation } from "./conversation.interface.js";

const conversationSchema = new Schema<IConversation>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    title: {
      type: String,
      required: true,
      trim: true,
      maxlength: 200,
    },

    activeGenerationId: {
      type: Schema.Types.ObjectId,
      ref: "Message",
      default: null,
    },

    activeLockToken: {
      type: String,
      default: null,
      trim: true,
    },

    lockVersion: {
      type: Number,
      default: 0,
      required: true,
      min: 0,
    },

    lockExpiresAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

conversationSchema.index({ userId: 1, updatedAt: -1 });
conversationSchema.index({ activeGenerationId: 1, lockExpiresAt: 1 });

export const Conversation = model<IConversation>(
  "Conversation",
  conversationSchema
);
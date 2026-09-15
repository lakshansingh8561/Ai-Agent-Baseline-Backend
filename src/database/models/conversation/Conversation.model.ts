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
  },
  {
    timestamps: true,
  }
);

conversationSchema.index({ userId: 1, updatedAt: -1 });

export const Conversation = model<IConversation>(
  "Conversation",
  conversationSchema
);
import { Schema, model } from "mongoose";
import type { IMessage } from "./message.interface.js";

const attachmentSchema = new Schema(
  {
    type: {
      type: String,
      enum: ["image"],
      required: true,
    },
    url: {
      type: String,
      required: true,
      trim: true,
    },
    publicId: {
      type: String,
      required: false,
      trim: true,
    },
    mimeType: {
      type: String,
      required: true,
      trim: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    size: {
      type: Number,
      required: true,
      min: 0,
    },
  },
  { _id: false }
);

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
      required: function (this: any) {
        return (
          !this.attachment &&
          this.status !== "generating" &&
          this.status !== "pending"
        );
      },
      default: "",
      trim: true,
    },

    status: {
      type: String,
      enum: ["pending", "generating", "completed", "failed"],
      default: "completed",
      index: true,
    },

    errorMessage: {
      type: String,
      trim: true,
    },

    attachment: {
      type: attachmentSchema,
      default: undefined,
      required: false,
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
import { z } from "zod";
import mongoose from "mongoose";
import { CHAT_CONSTANTS } from "./chat.constants.js";

export const objectIdSchema = z
  .string()
  .refine((val) => mongoose.Types.ObjectId.isValid(val), {
    message: "Invalid ID format",
  });

export const createConversationSchema = z.object({
  title: z
    .string()
    .trim()
    .max(
      CHAT_CONSTANTS.MAX_TITLE_LENGTH,
      `Title must not exceed ${CHAT_CONSTANTS.MAX_TITLE_LENGTH} characters`
    )
    .optional(),
});

export const sendMessageSchema = z.object({
  content: z
    .string()
    .trim()
    .min(
      CHAT_CONSTANTS.MIN_MESSAGE_LENGTH,
      "Message content cannot be empty"
    )
    .max(
      CHAT_CONSTANTS.MAX_MESSAGE_LENGTH,
      `Message content must not exceed ${CHAT_CONSTANTS.MAX_MESSAGE_LENGTH} characters`
    ),
});

export const conversationIdParamSchema = z.object({
  conversationId: objectIdSchema,
});

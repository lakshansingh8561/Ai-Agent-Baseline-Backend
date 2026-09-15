import { z } from "zod";

export const generateAIRequestSchema = z.object({
  prompt: z
    .string()
    .trim()
    .min(1, "Prompt is required")
    .max(10000, "Prompt is too long"),
});
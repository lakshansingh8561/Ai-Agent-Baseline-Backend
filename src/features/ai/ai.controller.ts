import type { Request, Response } from "express";
import { generateAIResponse } from "./ai.service.js";
import { generateAIRequestSchema } from "./ai.validation.js";

export const generateAI = async (
  req: Request,
  res: Response
): Promise<void> => {
  const result = generateAIRequestSchema.safeParse(req.body);

  if (!result.success) {
    res.status(400).json({
      success: false,
      message: "Invalid request",
      errors: result.error.flatten(),
    });

    return;
  }

  try {
    const response = await generateAIResponse(result.data.prompt);

    res.status(200).json({
      success: true,
      data: {
        response,
      },
    });
  } catch (error) {
    console.error("AI generation error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to generate AI response",
    });
  }
};
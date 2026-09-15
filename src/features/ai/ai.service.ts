import { GoogleGenAI } from "@google/genai";

const apiKey = process.env.GEMINI_API_KEY;

if (!apiKey) {
  throw new Error("GEMINI_API_KEY is not configured");
}

const ai = new GoogleGenAI({
  apiKey,
});

const PRIMARY_MODEL = "gemini-3.8-flash";
const FALLBACK_MODEL = "gemini-3.7-flash";

export const generateAIResponse = async (
  prompt: string
): Promise<string> => {
  try {
    const response = await ai.models.generateContent({
      model: PRIMARY_MODEL,
      contents: prompt,
    });

    return response.text ?? "";
  } catch (error) {
    console.error(`${PRIMARY_MODEL} failed:`, error);

    try {
      console.log(`Trying fallback model: ${FALLBACK_MODEL}`);

      const fallbackResponse = await ai.models.generateContent({
        model: FALLBACK_MODEL,
        contents: prompt,
      });

      return fallbackResponse.text ?? "";
    } catch (fallbackError) {
      console.error(`${FALLBACK_MODEL} failed:`, fallbackError);

      throw fallbackError;
    }
  }
};
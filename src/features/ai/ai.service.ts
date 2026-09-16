import { GoogleGenAI } from "@google/genai";

const apiKey = process.env.GEMINI_API_KEY;

if (!apiKey) {
  throw new Error("GEMINI_API_KEY is not configured");
}

const ai = new GoogleGenAI({
  apiKey,
});

export const PRIMARY_MODEL = "gemini-3.8-flash";
export const FALLBACK_MODEL = "gemini-3.7-flash";
export const SECONDARY_FALLBACK_MODEL = "gemini-3.6-flash";

export interface AIResponseWithUsage {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/**
 * Counts exact input tokens for the prompt using Gemini's countTokens API.
 */
export const countPromptTokens = async (
  prompt: string,
  model: string = PRIMARY_MODEL
): Promise<number> => {
  try {
    const response = await ai.models.countTokens({
      model,
      contents: prompt,
    });
    return response.totalTokens ?? 1;
  } catch (error) {
    if (model !== FALLBACK_MODEL) {
      try {
        const fallbackResponse = await ai.models.countTokens({
          model: FALLBACK_MODEL,
          contents: prompt,
        });
        return fallbackResponse.totalTokens ?? 1;
      } catch {
        const secondaryFallbackResponse = await ai.models.countTokens({
          model: SECONDARY_FALLBACK_MODEL,
          contents: prompt,
        });
        return secondaryFallbackResponse.totalTokens ?? 1;
      }
    }
    throw error;
  }
};

/**
 * Generates AI content and captures authoritative token usage metadata.
 */
export const generateAIResponseWithUsage = async (
  prompt: string,
  maxOutputTokens?: number
): Promise<AIResponseWithUsage> => {
  const config = maxOutputTokens ? { maxOutputTokens } : undefined;

  try {
    const response = await ai.models.generateContent({
      model: PRIMARY_MODEL,
      contents: prompt,
      config,
    });

    const promptTokens = response.usageMetadata?.promptTokenCount ?? 0;
    const candidatesTokens = response.usageMetadata?.candidatesTokenCount ?? 0;
    const totalTokens = response.usageMetadata?.totalTokenCount ?? (promptTokens + candidatesTokens);

    return {
      text: response.text ?? "",
      model: PRIMARY_MODEL,
      inputTokens: promptTokens,
      outputTokens: candidatesTokens,
      totalTokens,
    };
  } catch (error) {
    console.error(`${PRIMARY_MODEL} failed:`, error);

    try {
      console.log(`Trying fallback model: ${FALLBACK_MODEL}`);

      const fallbackResponse = await ai.models.generateContent({
        model: FALLBACK_MODEL,
        contents: prompt,
        config,
      });

      const promptTokens = fallbackResponse.usageMetadata?.promptTokenCount ?? 0;
      const candidatesTokens = fallbackResponse.usageMetadata?.candidatesTokenCount ?? 0;
      const totalTokens = fallbackResponse.usageMetadata?.totalTokenCount ?? (promptTokens + candidatesTokens);

      return {
        text: fallbackResponse.text ?? "",
        model: FALLBACK_MODEL,
        inputTokens: promptTokens,
        outputTokens: candidatesTokens,
        totalTokens,
      };
    } catch (fallbackError) {
      console.error(`${FALLBACK_MODEL} failed:`, fallbackError);

      try {
        console.log(`Trying secondary fallback model: ${SECONDARY_FALLBACK_MODEL}`);

        const secResponse = await ai.models.generateContent({
          model: SECONDARY_FALLBACK_MODEL,
          contents: prompt,
          config,
        });

        const promptTokens = secResponse.usageMetadata?.promptTokenCount ?? 0;
        const candidatesTokens = secResponse.usageMetadata?.candidatesTokenCount ?? 0;
        const totalTokens = secResponse.usageMetadata?.totalTokenCount ?? (promptTokens + candidatesTokens);

        return {
          text: secResponse.text ?? "",
          model: SECONDARY_FALLBACK_MODEL,
          inputTokens: promptTokens,
          outputTokens: candidatesTokens,
          totalTokens,
        };
      } catch (secError) {
        console.error(`${SECONDARY_FALLBACK_MODEL} failed:`, secError);
        throw secError;
      }
    }
  }
};

/**
 * Backward compatible helper for callers expecting only the text response.
 */
export const generateAIResponse = async (
  prompt: string
): Promise<string> => {
  const result = await generateAIResponseWithUsage(prompt);
  return result.text;
};
import { GoogleGenAI } from "@google/genai";

const apiKey = process.env.GEMINI_API_KEY;

if (!apiKey) {
  throw new Error("GEMINI_API_KEY is not configured");
}

export const ai = new GoogleGenAI({
  apiKey,
});

export const getGeminiClient = () => ai;

export const PRIMARY_MODEL = "gemini-3.6-flash";
export const FALLBACK_MODEL = "gemini-3.1-flash-lite";
export const SECONDARY_FALLBACK_MODEL = "gemini-3.5-flash";

export const CONFIGURED_MODELS = [
  PRIMARY_MODEL,
  FALLBACK_MODEL,
  SECONDARY_FALLBACK_MODEL,
] as const;

export const AI_REQUEST_TIMEOUT_MS = 25_000;
export const AI_COUNT_TOKENS_TIMEOUT_MS = 8_000;

export class GeminiQuotaExhaustedError extends Error {
  public readonly statusCode = 429;
  public readonly code = "RESOURCE_EXHAUSTED";
  public readonly isQuotaExhausted = true;
  public readonly retryAfterSeconds?: number;

  constructor(
    message: string = "AI model quota or rate limit exceeded. Please try again shortly.",
    retryAfterSeconds?: number
  ) {
    super(message);
    this.name = "GeminiQuotaExhaustedError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * Classifies whether an error from Google GenAI is an HTTP 429 / RESOURCE_EXHAUSTED error.
 */
export const isGeminiQuotaExhaustedError = (err: any): boolean => {
  if (!err) return false;
  if (err instanceof GeminiQuotaExhaustedError || err.isQuotaExhausted === true) return true;

  const status = err.status ?? err.statusCode ?? err.code ?? err.error?.code ?? err.error?.status;
  if (status === 429 || status === "429" || status === "RESOURCE_EXHAUSTED") return true;
  if (err.error?.status === "RESOURCE_EXHAUSTED") return true;

  const msg = typeof err.message === "string" ? err.message : "";
  const errDetails = Array.isArray(err.error?.details) ? JSON.stringify(err.error.details) : "";
  const combined = `${msg} ${errDetails}`;

  return (
    combined.includes("429") ||
    combined.includes("RESOURCE_EXHAUSTED") ||
    /quota.*exhausted|resource.*exhausted|rate.*limit.*exceeded|resource_exhausted/i.test(combined)
  );
};

/**
 * Extracts recommended retry-after delay in seconds if provided by Gemini error response.
 */
export const extractRetryDelay = (err: any): number | undefined => {
  try {
    if (typeof err?.retryAfterSeconds === "number" && !isNaN(err.retryAfterSeconds)) {
      return err.retryAfterSeconds;
    }
    if (typeof err?.retryAfter === "number" && !isNaN(err.retryAfter)) {
      return err.retryAfter;
    }
    const details = err?.error?.details || err?.details || err?.errorDetails;
    if (Array.isArray(details)) {
      for (const d of details) {
        if (typeof d?.metadata?.retryDelay === "string") {
          const match = d.metadata.retryDelay.match(/(\d+)/);
          if (match) return parseInt(match[1], 10);
        }
        if (d?.["@type"]?.includes("RetryInfo") && typeof d?.retryDelay === "string") {
          const match = d.retryDelay.match(/(\d+)/);
          if (match) return parseInt(match[1], 10);
        }
      }
    }
    const msg = String(err?.message || "");
    const match = msg.match(/retry(?:ing)?\s+after\s+(\d+)/i) || msg.match(/retry\s+in\s+(\d+)s/i) || msg.match(/(\d+)s/);
    if (match) return parseInt(match[1], 10);
  } catch {}
  return undefined;
};

/**
 * Identifies non-retryable errors such as bad requests (400) or authentication failures (401/403).
 */
export const isNonRetryableError = (err: any): boolean => {
  if (!err) return false;
  const status = err.status ?? err.statusCode ?? err.code ?? err.error?.code;
  if (status === 400 || status === 401 || status === 403) return true;
  const msg = typeof err.message === "string" ? err.message : "";
  return /invalid.*api.*key|unauthorized|permission.*denied|api_key_invalid/i.test(msg);
};

/**
 * Redacts API keys and internal credentials from error messages before exposure.
 */
export const sanitizeErrorMessage = (msg: string): string => {
  if (!msg) return "";
  return msg
    .replace(/key=[A-Za-z0-9_-]+/gi, "key=[REDACTED]")
    .replace(/AIzaSy[A-Za-z0-9_-]+/gi, "[REDACTED]")
    .replace(/https?:\/\/[^\s"]+/gi, (url) => {
      try {
        const u = new URL(url);
        return `${u.origin}${u.pathname}`;
      } catch {
        return "[URL]";
      }
    });
};

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number, operationName: string): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err: any = new Error(`${operationName} timed out after ${timeoutMs}ms`);
      err.code = "ETIMEDOUT";
      reject(err);
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

export interface GeminiInlineData {
  data: string;
  mimeType: string;
}

export interface GeminiContentPart {
  text?: string;
  inlineData?: GeminiInlineData;
}

export interface GeminiContent {
  role: "user" | "model";
  parts: (GeminiContentPart | any)[];
}

export { createPartFromBase64, createPartFromText } from "@google/genai";

export interface AIResponseWithUsage {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  rawUsage?: {
    promptTokenCount?: number | null;
    candidatesTokenCount?: number | null;
    thoughtsTokenCount?: number | null;
    totalTokenCount?: number | null;
  };
}

/**
 * Counts exact input tokens for the prompt or multi-turn contents using Gemini's countTokens API.
 * Skips previously exhausted models within the same request and bounds execution with timeout.
 */
export const countPromptTokens = async (
  prompt: string | GeminiContent[],
  model: string = PRIMARY_MODEL,
  exhaustedModelsTracker?: Set<string>
): Promise<number> => {
  const modelsToTry = [
    model,
    ...CONFIGURED_MODELS.filter((m) => m !== model),
  ];

  let lastError: any;
  let allQuotaExhausted = true;
  let maxRetryDelay: number | undefined;

  for (const candidateModel of modelsToTry) {
    if (exhaustedModelsTracker?.has(candidateModel)) {
      continue;
    }

    try {
      const response = await withTimeout(
        ai.models.countTokens({
          model: candidateModel,
          contents: prompt,
        }),
        AI_COUNT_TOKENS_TIMEOUT_MS,
        `countTokens(${candidateModel})`
      );
      return response.totalTokens ?? 1;
    } catch (err: any) {
      lastError = err;
      if (isGeminiQuotaExhaustedError(err)) {
        exhaustedModelsTracker?.add(candidateModel);
        const retryDelay = extractRetryDelay(err);
        if (retryDelay && (!maxRetryDelay || retryDelay > maxRetryDelay)) {
          maxRetryDelay = retryDelay;
        }
        console.warn(`[AI] ${candidateModel} quota exhausted during countPromptTokens, attempting fallback...`);
      } else {
        allQuotaExhausted = false;
        console.warn(`[AI] ${candidateModel} countPromptTokens failed:`, sanitizeErrorMessage(err?.message || ""));
        if (isNonRetryableError(err)) {
          throw err;
        }
      }
    }
  }

  if (allQuotaExhausted || (exhaustedModelsTracker && CONFIGURED_MODELS.every((m) => exhaustedModelsTracker.has(m)))) {
    throw new GeminiQuotaExhaustedError(
      "AI model quota or rate limit exceeded. Please try again shortly.",
      maxRetryDelay
    );
  }

  throw lastError || new Error("Failed to count prompt tokens on all configured models");
};

/**
 * Generates AI content and captures authoritative token usage metadata.
 * Uses bounded timeouts, skips already-exhausted models, and handles fallbacks cleanly.
 */
export const generateAIResponseWithUsage = async (
  prompt: string | GeminiContent[],
  maxOutputTokens?: number,
  exhaustedModelsTracker?: Set<string>
): Promise<AIResponseWithUsage> => {
  const config = maxOutputTokens
    ? { maxOutputTokens, thinkingConfig: { thinkingBudget: 0 } }
    : undefined;

  let lastError: any;
  let allQuotaExhausted = true;
  let maxRetryDelay: number | undefined;

  for (const candidateModel of CONFIGURED_MODELS) {
    if (exhaustedModelsTracker?.has(candidateModel)) {
      continue;
    }

    try {
      console.log(`[AI] Generating content with model: ${candidateModel}`);
      const response = await withTimeout(
        ai.models.generateContent({
          model: candidateModel,
          contents: prompt,
          config,
        }),
        AI_REQUEST_TIMEOUT_MS,
        `generateContent(${candidateModel})`
      );

      const usage = response.usageMetadata;
      const promptTokens = usage?.promptTokenCount ?? 0;
      const candidatesTokens = usage?.candidatesTokenCount ?? 0;
      const totalTokens = usage?.totalTokenCount ?? (promptTokens + candidatesTokens);

      return {
        text: response.text ?? "",
        model: candidateModel,
        inputTokens: promptTokens,
        outputTokens: candidatesTokens,
        totalTokens,
        rawUsage: usage
          ? {
              promptTokenCount: usage.promptTokenCount,
              candidatesTokenCount: usage.candidatesTokenCount,
              thoughtsTokenCount: usage.thoughtsTokenCount,
              totalTokenCount: usage.totalTokenCount,
            }
          : undefined,
      };
    } catch (err: any) {
      lastError = err;
      if (isGeminiQuotaExhaustedError(err)) {
        exhaustedModelsTracker?.add(candidateModel);
        const retryDelay = extractRetryDelay(err);
        if (retryDelay && (!maxRetryDelay || retryDelay > maxRetryDelay)) {
          maxRetryDelay = retryDelay;
        }
        console.warn(`[AI] ${candidateModel} quota exhausted, attempting fallback...`);
      } else {
        allQuotaExhausted = false;
        console.warn(`[AI] ${candidateModel} generation failed:`, sanitizeErrorMessage(err?.message || ""));
        if (isNonRetryableError(err)) {
          throw err;
        }
      }
    }
  }

  if (allQuotaExhausted || (exhaustedModelsTracker && CONFIGURED_MODELS.every((m) => exhaustedModelsTracker.has(m)))) {
    throw new GeminiQuotaExhaustedError(
      "AI model quota or rate limit exceeded. Please try again shortly.",
      maxRetryDelay
    );
  }

  throw lastError || new Error("Failed to generate AI response on all configured models");
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

export interface StreamChunkCallbacks {
  onChunk: (chunkText: string) => void | Promise<void>;
  signal?: AbortSignal;
}

/**
 * Streams AI content incrementally using native provider streaming
 * and captures authoritative token usage metadata.
 * Bounds connection timeouts, skips exhausted models, preserves abort behavior,
 * and emits prompt terminal errors when all models are exhausted.
 */
export const streamAIResponseWithUsage = async (
  prompt: string | GeminiContent[],
  maxOutputTokens?: number,
  callbacks?: StreamChunkCallbacks,
  exhaustedModelsTracker?: Set<string>
): Promise<AIResponseWithUsage> => {
  const config = maxOutputTokens
    ? { maxOutputTokens, thinkingConfig: { thinkingBudget: 0 } }
    : undefined;

  let lastError: any;
  let allQuotaExhausted = true;
  let maxRetryDelay: number | undefined;

  for (const candidateModel of CONFIGURED_MODELS) {
    if (exhaustedModelsTracker?.has(candidateModel)) {
      continue;
    }

    if (callbacks?.signal?.aborted) {
      const abortErr = new Error("Generation cancelled by user");
      abortErr.name = "AbortError";
      throw abortErr;
    }

    let fullText = "";
    let lastUsage: any = undefined;
    let chunksEmitted = false;

    try {
      console.log(`[AI] Streaming content with model: ${candidateModel}`);
      const responseStream = await withTimeout(
        ai.models.generateContentStream({
          model: candidateModel,
          contents: prompt,
          config,
        }),
        AI_REQUEST_TIMEOUT_MS,
        `generateContentStream(${candidateModel})`
      );

      for await (const chunk of responseStream) {
        if (callbacks?.signal?.aborted) {
          try {
            await responseStream.return(undefined);
          } catch {}
          break;
        }

        const text = chunk.text ?? "";
        if (text) {
          fullText += text;
          chunksEmitted = true;
          await callbacks?.onChunk?.(text);
        }

        if (chunk.usageMetadata) {
          lastUsage = chunk.usageMetadata;
        }
      }

      if (callbacks?.signal?.aborted) {
        return {
          text: fullText,
          model: candidateModel,
          inputTokens: lastUsage?.promptTokenCount ?? 0,
          outputTokens: lastUsage?.candidatesTokenCount ?? 0,
          totalTokens: lastUsage?.totalTokenCount ?? 0,
          rawUsage: lastUsage,
        };
      }

      const promptTokens = lastUsage?.promptTokenCount ?? 0;
      const candidatesTokens = lastUsage?.candidatesTokenCount ?? 0;
      const totalTokens = lastUsage?.totalTokenCount ?? (promptTokens + candidatesTokens);

      return {
        text: fullText,
        model: candidateModel,
        inputTokens: promptTokens,
        outputTokens: candidatesTokens,
        totalTokens,
        rawUsage: lastUsage
          ? {
              promptTokenCount: lastUsage.promptTokenCount,
              candidatesTokenCount: lastUsage.candidatesTokenCount,
              thoughtsTokenCount: lastUsage.thoughtsTokenCount,
              totalTokenCount: lastUsage.totalTokenCount,
            }
          : undefined,
      };
    } catch (err: any) {
      lastError = err;

      if (callbacks?.signal?.aborted) {
        throw err;
      }

      // If text chunks were already emitted to the user, we cannot switch models mid-generation
      if (chunksEmitted) {
        throw err;
      }

      if (isGeminiQuotaExhaustedError(err)) {
        exhaustedModelsTracker?.add(candidateModel);
        const retryDelay = extractRetryDelay(err);
        if (retryDelay && (!maxRetryDelay || retryDelay > maxRetryDelay)) {
          maxRetryDelay = retryDelay;
        }
        console.warn(`[AI] ${candidateModel} quota exhausted during streaming connection, attempting fallback...`);
      } else {
        allQuotaExhausted = false;
        console.warn(`[AI] ${candidateModel} streaming failed:`, sanitizeErrorMessage(err?.message || ""));
        if (isNonRetryableError(err)) {
          throw err;
        }
      }
    }
  }

  if (allQuotaExhausted || (exhaustedModelsTracker && CONFIGURED_MODELS.every((m) => exhaustedModelsTracker.has(m)))) {
    throw new GeminiQuotaExhaustedError(
      "AI model quota or rate limit exceeded. Please try again shortly.",
      maxRetryDelay
    );
  }

  throw lastError || new Error("Failed to stream AI response on all configured models");
};
import type { Request, Response } from "express";
import {
  createConversation,
  getUserConversations,
  getConversationMessages,
  sendMessage,
  sendMessageStream,
  deleteConversation,
  ChatError,
} from "./chat.service.js";
import { TokenError, InsufficientTokensError } from "../token/index.js";
import {
  isGeminiQuotaExhaustedError,
  extractRetryDelay,
  sanitizeErrorMessage,
} from "../ai/ai.service.js";
import {
  createConversationSchema,
  sendMessageSchema,
  conversationIdParamSchema,
} from "./chat.validation.js";

export const createConversationHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  if (!req.user) {
    res.status(401).json({
      success: false,
      message: "Unauthorized",
    });
    return;
  }

  const result = createConversationSchema.safeParse(req.body);

  if (!result.success) {
    res.status(400).json({
      success: false,
      message: "Invalid conversation data",
      errors: result.error.flatten(),
    });
    return;
  }

  try {
    const conversation = await createConversation(
      req.user.userId,
      result.data.title
    );

    res.status(201).json({
      success: true,
      message: "Conversation created successfully",
      data: {
        conversation,
      },
    });
  } catch (error) {
    console.error("Create conversation error:", error);

    if (error instanceof ChatError) {
      res.status(error.statusCode).json({
        success: false,
        message: error.message,
      });
      return;
    }

    res.status(500).json({
      success: false,
      message: "Failed to create conversation",
    });
  }
};

export const getUserConversationsHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  if (!req.user) {
    res.status(401).json({
      success: false,
      message: "Unauthorized",
    });
    return;
  }

  try {
    const conversations = await getUserConversations(req.user.userId);

    res.status(200).json({
      success: true,
      data: {
        conversations,
      },
    });
  } catch (error) {
    console.error("Get user conversations error:", error);

    if (error instanceof ChatError) {
      res.status(error.statusCode).json({
        success: false,
        message: error.message,
      });
      return;
    }

    res.status(500).json({
      success: false,
      message: "Failed to retrieve conversations",
    });
  }
};

export const getConversationMessagesHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  if (!req.user) {
    res.status(401).json({
      success: false,
      message: "Unauthorized",
    });
    return;
  }

  const paramResult = conversationIdParamSchema.safeParse(req.params);

  if (!paramResult.success) {
    res.status(400).json({
      success: false,
      message: "Invalid conversation ID",
      errors: paramResult.error.flatten(),
    });
    return;
  }

  try {
    const messages = await getConversationMessages(
      req.user.userId,
      paramResult.data.conversationId
    );

    res.status(200).json({
      success: true,
      data: {
        messages,
      },
    });
  } catch (error) {
    if (error instanceof ChatError) {
      if (error.statusCode >= 500) {
        console.error("Get conversation messages error:", error);
      } else {
        console.warn(`[Chat] ${error.message} (${error.statusCode})`);
      }
      res.status(error.statusCode).json({
        success: false,
        message: error.message,
      });
      return;
    }

    console.error("Get conversation messages error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to retrieve messages",
    });
  }
};

export const formatSSEEvent = (event: string, data: any): string => {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
};

export const sendMessageHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  if (!req.user) {
    res.status(401).json({
      success: false,
      message: "Unauthorized",
    });
    return;
  }

  const paramResult = conversationIdParamSchema.safeParse(req.params);

  if (!paramResult.success) {
    res.status(400).json({
      success: false,
      message: "Invalid conversation ID",
      errors: paramResult.error.flatten(),
    });
    return;
  }

  const bodyResult = sendMessageSchema.safeParse(req.body);

  if (!bodyResult.success) {
    res.status(400).json({
      success: false,
      message: "Invalid message data",
      errors: bodyResult.error.flatten(),
    });
    return;
  }

  const uploadedFile = req.file;
  const content = bodyResult.data.content?.trim() || "";

  if (!uploadedFile && content.length === 0) {
    res.status(400).json({
      success: false,
      message: "Message content cannot be empty",
    });
    return;
  }

  const rawIdempotencyKey =
    req.header("Idempotency-Key") || req.header("X-Idempotency-Key");
  const idempotencyKey =
    typeof rawIdempotencyKey === "string" && rawIdempotencyKey.trim().length > 0
      ? rawIdempotencyKey.trim()
      : undefined;

  const isSSE = (req.headers.accept || "").includes("text/event-stream");

  if (isSSE) {
    const abortController = new AbortController();

    if (typeof (res as any).on === "function") {
      res.on("close", () => {
        if (!res.writableEnded) {
          abortController.abort();
        }
      });
    }

    try {
      res.status(200);
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      if ((res as any).flushHeaders) {
        (res as any).flushHeaders();
      }

      // Establish stream with initial ping
      res.write(formatSSEEvent("ping", { timestamp: Date.now() }));

      await sendMessageStream(
        req.user.userId,
        paramResult.data.conversationId,
        content,
        uploadedFile,
        idempotencyKey,
        {
          onMetadata: (meta) => {
            if (!res.writableEnded) {
              res.write(formatSSEEvent("metadata", meta));
            }
          },
          onDelta: (delta) => {
            if (!res.writableEnded) {
              res.write(formatSSEEvent("delta", delta));
            }
          },
          onDone: (done) => {
            if (!res.writableEnded) {
              res.write(formatSSEEvent("done", done));
              res.end();
            }
          },
          onError: (err) => {
            if (!res.writableEnded) {
              res.write(formatSSEEvent("error", err));
              res.end();
            }
          },
        },
        abortController.signal
      );
      if (!res.writableEnded) {
        res.end();
      }
      return;
    } catch (error) {
      console.error("Send message stream error:", sanitizeErrorMessage((error as any)?.message || ""));

      if (res.headersSent || res.writableEnded) {
        if (!res.writableEnded) {
          const isQuota =
            isGeminiQuotaExhaustedError(error) ||
            (error as any)?.statusCode === 429;
          const retryDelay = extractRetryDelay(error);
          const message = isQuota
            ? "AI model quota or rate limit exceeded. Please try again shortly."
            : error instanceof Error
            ? sanitizeErrorMessage(error.message)
            : "Internal stream error";
          const statusCode = isQuota ? 429 : (error as any).statusCode || 500;
          res.write(
            formatSSEEvent("error", {
              code: isQuota ? "RESOURCE_EXHAUSTED" : "STREAM_ERROR",
              message,
              statusCode,
              ...(retryDelay ? { retryAfter: retryDelay } : {}),
            })
          );
          res.end();
        }
        return;
      }
      // If headers were not yet sent, fall through to standard error handler below
    }
  }

  try {
    const response = await sendMessage(
      req.user.userId,
      paramResult.data.conversationId,
      content,
      uploadedFile,
      idempotencyKey
    );

    if (response.isReplay) {
      res.setHeader("Idempotent-Replay", "true");
    }

    if (!res.headersSent && !res.writableEnded) {
      const statusCode = response.statusCode || 201;
      res.status(statusCode).json({
        success: true,
        message: response.isReplay
          ? "Message retrieved from idempotent cache"
          : "Message processed successfully",
        data: {
          userMessage: response.userMessage,
          assistantMessage: response.assistantMessage,
        },
      });
    }
  } catch (error) {
    console.error("Send message error:", sanitizeErrorMessage((error as any)?.message || ""));

    if (res.headersSent || res.writableEnded) {
      return;
    }

    if (
      isGeminiQuotaExhaustedError(error) ||
      (error as any)?.statusCode === 429 ||
      (error instanceof ChatError && error.statusCode === 429)
    ) {
      const retryDelay = extractRetryDelay(error);
      res.status(429).json({
        success: false,
        code: "RESOURCE_EXHAUSTED",
        message: "AI model quota or rate limit exceeded. Please try again shortly.",
        ...(retryDelay ? { retryAfter: retryDelay } : {}),
      });
      return;
    }

    if (
      error instanceof InsufficientTokensError ||
      (error as any).statusCode === 402
    ) {
      res.status(402).json({
        success: false,
        message: "Token balance exhausted",
      });
      return;
    }

    if (error instanceof TokenError) {
      res.status(error.statusCode).json({
        success: false,
        message: error.message,
      });
      return;
    }

    if (error instanceof ChatError) {
      res.status(error.statusCode).json({
        success: false,
        message: error.message,
      });
      return;
    }

    res.status(500).json({
      success: false,
      message: "Failed to send message",
    });
  }
};

export const deleteConversationHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  if (!req.user) {
    res.status(401).json({
      success: false,
      message: "Unauthorized",
    });
    return;
  }

  const paramResult = conversationIdParamSchema.safeParse(req.params);

  if (!paramResult.success) {
    res.status(400).json({
      success: false,
      message: "Invalid conversation ID",
      errors: paramResult.error.flatten(),
    });
    return;
  }

  try {
    await deleteConversation(req.user.userId, paramResult.data.conversationId);

    res.status(200).json({
      success: true,
      message: "Conversation deleted successfully",
    });
  } catch (error) {
    console.error("Delete conversation error:", error);

    if (error instanceof ChatError) {
      res.status(error.statusCode).json({
        success: false,
        message: error.message,
      });
      return;
    }

    res.status(500).json({
      success: false,
      message: "Failed to delete conversation",
    });
  }
};

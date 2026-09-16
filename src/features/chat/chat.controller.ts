import type { Request, Response } from "express";
import {
  createConversation,
  getUserConversations,
  getConversationMessages,
  sendMessage,
  ChatError,
} from "./chat.service.js";
import { TokenError, InsufficientTokensError } from "../token/index.js";
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
    console.error("Get conversation messages error:", error);

    if (error instanceof ChatError) {
      res.status(error.statusCode).json({
        success: false,
        message: error.message,
      });
      return;
    }

    res.status(500).json({
      success: false,
      message: "Failed to retrieve messages",
    });
  }
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

  try {
    const response = await sendMessage(
      req.user.userId,
      paramResult.data.conversationId,
      bodyResult.data.content
    );

    res.status(201).json({
      success: true,
      message: "Message processed successfully",
      data: response,
    });
  } catch (error) {
    console.error("Send message error:", error);

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

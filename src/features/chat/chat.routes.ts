import { Router } from "express";
import {
  createConversationHandler,
  getUserConversationsHandler,
  getConversationMessagesHandler,
  sendMessageHandler,
  deleteConversationHandler,
} from "./chat.controller.js";
import { authMiddleware } from "../../constants/middleware/auth.middleware.js";

const router = Router();

router.use(authMiddleware);

router.post("/conversations", createConversationHandler);
router.get("/conversations", getUserConversationsHandler);
router.delete("/conversations/:conversationId", deleteConversationHandler);
router.get("/conversations/:conversationId/messages", getConversationMessagesHandler);
router.post("/conversations/:conversationId/messages", sendMessageHandler);

export default router;

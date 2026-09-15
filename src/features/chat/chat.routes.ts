import { Router } from "express";
import {
  createConversationHandler,
  getUserConversationsHandler,
  getConversationMessagesHandler,
  sendMessageHandler,
} from "./chat.controller.js";
import { authMiddleware } from "../../middlewares/auth.middleware.js";

const router = Router();

router.use(authMiddleware);

router.post("/conversations", createConversationHandler);
router.get("/conversations", getUserConversationsHandler);
router.get("/conversations/:conversationId/messages", getConversationMessagesHandler);
router.post("/conversations/:conversationId/messages", sendMessageHandler);

export default router;

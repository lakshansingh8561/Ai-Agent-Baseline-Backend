import { Router } from "express";
import { getUserSubscriptionHandler } from "./subscription.controller.js";
import { handlePolarWebhook } from "./subscription.webhook.js";
import { authMiddleware } from "../../constants/middleware/auth.middleware.js";

const router = Router();

// POST /api/subscriptions/webhook - Public endpoint secured via Polar cryptographic signature
router.post("/webhook", handlePolarWebhook);

// Protected subscription endpoints requiring user JWT
router.get("/me", authMiddleware, getUserSubscriptionHandler);

export default router;

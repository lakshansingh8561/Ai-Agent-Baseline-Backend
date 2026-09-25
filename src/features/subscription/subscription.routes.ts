import { Router } from "express";
import {
  getUserSubscriptionHandler,
  createCheckoutSessionHandler,
  getSubscriptionCatalogHandler,
  confirmCheckoutSessionHandler,
} from "./subscription.controller.js";
import { handlePolarWebhook } from "./subscription.webhook.js";
import { authMiddleware } from "../../constants/middleware/auth.middleware.js";

const router = Router();

// Public plan catalog endpoint (no auth required)
router.get("/plans", getSubscriptionCatalogHandler);
router.get("/catalog", getSubscriptionCatalogHandler);

// POST /api/subscriptions/webhook - Public endpoint secured via Polar cryptographic signature
router.post("/webhook", handlePolarWebhook);

// Protected subscription endpoints requiring user JWT
router.get("/me", authMiddleware, getUserSubscriptionHandler);
router.post("/checkout", authMiddleware, createCheckoutSessionHandler);
router.post("/confirm", authMiddleware, confirmCheckoutSessionHandler);
router.get("/confirm", authMiddleware, confirmCheckoutSessionHandler);

export default router;


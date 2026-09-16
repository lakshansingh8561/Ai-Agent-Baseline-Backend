import { Router } from "express";
import { getTokenBalanceHandler } from "./token.controller.js";
import { authMiddleware } from "../../constants/middleware/auth.middleware.js";

const router = Router();

// Protect all token routes with JWT authentication
router.use(authMiddleware);

// GET /api/tokens/balance
router.get("/balance", getTokenBalanceHandler);

export default router;

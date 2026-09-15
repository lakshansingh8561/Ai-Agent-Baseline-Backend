import { Router } from "express";
import {
  registerUser,
  loginUser,
  getMe,
} from "./auth.controller.js";
import { authMiddleware } from "../../middlewares/auth.middleware.js";

const router = Router();

router.post("/register", registerUser);
router.post("/login", loginUser);
router.get("/me", authMiddleware, getMe);

export default router;
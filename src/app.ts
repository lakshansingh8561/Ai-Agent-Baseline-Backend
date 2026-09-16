import express from "express";
import cors from "cors";
import aiRoutes from "./features/ai/ai.routes.js";
import authRoutes from "./features/auth/auth.routes.js";
import chatRoutes from "./features/chat/chat.routes.js";
import tokenRoutes from "./features/token/token.routes.js";

const app = express();

app.use(cors());
app.use(express.json());

app.get("/api/health", (_req, res) => {
  res.status(200).json({
    success: true,
    message: "AI Agent API is running",
  });
});

app.use("/api/ai", aiRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/chat", chatRoutes);
app.use("/api/tokens", tokenRoutes);

export default app;
import express from "express";
import cors from "cors";
import aiRoutes from "./features/ai/ai.routes.js";
import authRoutes from "./features/auth/auth.routes.js";
import chatRoutes from "./features/chat/chat.routes.js";
import tokenRoutes from "./features/token/token.routes.js";
import subscriptionRoutes from "./features/subscription/subscription.routes.js";

const app = express();

app.use(cors());

// Webhook raw body parser mounted before general JSON parsing
app.use("/api/subscriptions/webhook", express.raw({ type: "*/*" }));

// General JSON parser with raw body buffer retention for signature validation
app.use(
  express.json({
    verify: (req: any, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

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
app.use("/api/subscriptions", subscriptionRoutes);

export default app;
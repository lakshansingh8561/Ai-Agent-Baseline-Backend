import "dotenv/config";
import app from "./app.js";
import { connectDatabase } from "./config/database.js";
import { startTokenSweeper, stopTokenSweeper } from "./features/token/token.sweeper.js";

const PORT = process.env.PORT || 5000;

const startServer = async (): Promise<void> => {
  try {
    await connectDatabase();

    const server = app.listen(PORT, () => {
      console.log(`AI Agent API running on port ${PORT}`);
    });

    // Start background recovery sweeper
    startTokenSweeper();

    // Graceful shutdown hooks
    const handleShutdown = async (signal: string) => {
      console.log(`Received ${signal}. Shutting down gracefully...`);
      try {
        await stopTokenSweeper();
        server.close(() => {
          console.log("HTTP server closed.");
          process.exit(0);
        });
      } catch (err) {
        console.error("Error during graceful shutdown:", err);
        process.exit(1);
      }
    };

    process.on("SIGTERM", () => handleShutdown("SIGTERM"));
    process.on("SIGINT", () => handleShutdown("SIGINT"));
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
};

startServer();
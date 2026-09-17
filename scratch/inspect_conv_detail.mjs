import mongoose from "mongoose";
import dotenv from "dotenv";

dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI;

async function run() {
  await mongoose.connect(MONGODB_URI);

  const db = mongoose.connection.db;
  
  // Inspect user 6aaa601a75be0d216feb7d25
  const user = await db.collection("users").findOne({ _id: new mongoose.Types.ObjectId("6aaa601a75be0d216feb7d25") });
  console.log("User:", user ? { _id: user._id, email: user.email, name: user.name } : "Not found");

  // Inspect conversation 6aaa605c75be0d216feb7d2c
  const conv1 = await db.collection("conversations").findOne({ _id: new mongoose.Types.ObjectId("6aaa605c75be0d216feb7d2c") });
  console.log("\nConv 6aaa605c75be0d216feb7d2c:", conv1);

  const msgs1 = await db.collection("messages").find({ conversationId: new mongoose.Types.ObjectId("6aaa605c75be0d216feb7d2c") }).sort({ createdAt: 1 }).toArray();
  console.log("\nMessages for conv1:");
  msgs1.forEach((m, idx) => {
    console.log(`[${idx}] id: ${m._id} role: ${m.role} createdAt: ${m.createdAt}\nContent:\n${m.content}\n---`);
  });

  // Also check token usages for this user
  const usages = await db.collection("tokenusages").find({ userId: new mongoose.Types.ObjectId("6aaa601a75be0d216feb7d25") }).sort({ timestamp: -1 }).limit(10).toArray();
  console.log(`\nToken usages for user (last ${usages.length}):`);
  usages.forEach(u => console.log(`${u.timestamp} prompt: ${u.promptTokens} output: ${u.outputTokens} total: ${u.totalTokens} model: ${u.model}`));

  await mongoose.disconnect();
}

run().catch(console.error);

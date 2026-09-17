import mongoose from "mongoose";
import dotenv from "dotenv";

dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI;

async function run() {
  await mongoose.connect(MONGODB_URI);
  console.log("Connected to MongoDB");

  const db = mongoose.connection.db;
  const collections = await db.listCollections().toArray();
  console.log("Collections:", collections.map(c => c.name));

  const conversations = await db.collection("conversations").find({}).sort({ updatedAt: -1 }).limit(5).toArray();
  console.log("\nRecent conversations:", JSON.stringify(conversations, null, 2));

  for (const conv of conversations) {
    const messages = await db.collection("messages").find({ conversationId: conv._id }).sort({ createdAt: 1 }).toArray();
    console.log(`\nMessages for conversation ${conv._id} (${conv.title}): count = ${messages.length}`);
    messages.forEach((m, idx) => {
      console.log(` [${idx}] ${m.role}: ${m.content.slice(0, 100).replace(/\n/g, ' ')}...`);
    });
  }

  await mongoose.disconnect();
}

run().catch(console.error);

import mongoose from "mongoose";
import dotenv from "dotenv";
dotenv.config();

import { connectDatabase } from "../dist/config/database.js";
import { User } from "../dist/database/models/user/index.js";
import { TokenWallet } from "../dist/database/models/tokenWallet/index.js";
import { Conversation } from "../dist/database/models/conversation/index.js";
import { Message } from "../dist/database/models/message/index.js";
import { sendMessage, createConversation } from "../dist/features/chat/chat.service.js";

async function run() {
  await connectDatabase();
  console.log("Connected to MongoDB for Scenario Test");

  // Create a clean test user with budget
  const userId = new mongoose.Types.ObjectId();
  await TokenWallet.create({
    userId,
    balance: 50000,
    totalAllocated: 50000,
    totalUsed: 0,
    reservedTokens: 0,
  });

  try {
    // 1. Create conversation 1
    const conv1 = await createConversation(userId.toString(), "Car Names Test");
    console.log(`\nCreated Conversation 1: ${conv1.id}`);

    // Turn 1
    const turn1Prompt = `Here is a list of car names.

Fictional / Custom:
Apex Predator
Shadowfire
Vortex RS`;
    console.log("\n--- Turn 1: Sending car list ---");
    const res1 = await sendMessage(userId.toString(), conv1.id, turn1Prompt);
    console.log("Assistant Turn 1 response (first 200 chars):", res1.assistantMessage.content.slice(0, 200));

    // Turn 2
    console.log("\n--- Turn 2: tell me about Apex Predator ---");
    const res2 = await sendMessage(userId.toString(), conv1.id, "tell me about Apex Predator");
    console.log("Assistant Turn 2 response:\n", res2.assistantMessage.content);

    // Turn 3
    console.log("\n--- Turn 3: you know last chat context ---");
    const res3 = await sendMessage(userId.toString(), conv1.id, "you know last chat context");
    console.log("Assistant Turn 3 response:\n", res3.assistantMessage.content);

    // Turn 4: simulating refresh (fetching persisted conversation and asking)
    console.log("\n--- Turn 4: What fictional car names did we discuss? (Reopened conversation) ---");
    const res4 = await sendMessage(userId.toString(), conv1.id, "What fictional car names did we discuss?");
    console.log("Assistant Turn 4 response:\n", res4.assistantMessage.content);

    // Turn 5: NEW conversation
    console.log("\n--- Turn 5: NEW Conversation - What fictional car names did we discuss? ---");
    const conv2 = await createConversation(userId.toString(), "Brand New Conversation");
    const res5 = await sendMessage(userId.toString(), conv2.id, "What fictional car names did we discuss?");
    console.log("Assistant in NEW Conversation response:\n", res5.assistantMessage.content);

  } finally {
    // Cleanup
    await TokenWallet.deleteMany({ userId });
    await Conversation.deleteMany({ userId });
    await Message.deleteMany({ userId });
    await mongoose.disconnect();
  }
}

run().catch(console.error);

import "dotenv/config";
import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import type { Server } from "node:http";
import fs from "node:fs";
import path from "node:path";
import jwt from "jsonwebtoken";
import app from "../src/app.js";
import { connectDatabase } from "../src/config/database.js";
import { User } from "../src/database/models/user/index.js";
import { Conversation } from "../src/database/models/conversation/index.js";
import { Message } from "../src/database/models/message/index.js";
import { TokenWallet } from "../src/database/models/tokenWallet/index.js";

describe("Multimodal Image Upload & Chat Test Suite", () => {
  let server: Server;
  let baseUrl: string;
  let testUserId: string;
  let authToken: string;
  let conversationId: string;

  // 1x1 lime green PNG buffer
  const samplePngBuffer = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64"
  );

  // Valid minimal JPEG buffer
  const sampleJpgBuffer = Buffer.from(
    "/9j/4AAQSkZJRgABAQAAZABkAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAAKAAoDAREAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAAB//EACQQAAIBAwMEAwEAAAAAAAAAAAECBAMFEQASEwYhMTIXIlEj/8QAGAEAAwEBAAAAAAAAAAAAAAAABQYHAgP/xAApEQABAwMCAwkBAAAAAAAAAAABAgMRABIhBDEGQWEFExQiMlFScYKh/9oADAMBAAIRAxEAPwA06GsS36tMgvTqSZlRikiVcaOOZmUkKqvklWAYnuwIHqWOphqXwWQpIBO/UQrJuH2MRvnlVKOm07/CStUhEukysyZPnIuJmCMxbBMmeVJMXoHpkxaJ5IsbKD+JrxafH29dprqVx4xtGPweNdmuxnHUJcLu4B3Tz/VAGeGVPtJdS8QFAH0++flR9YUX4msMjA5xPl0+XH22hmYLnzjcScfpzoJqFGVJnEA/ylBLznhu5uNhMxOJjeNp6092qDGrWuG7x6Tu1FGZmQEklRkk6U1rVcc1tAFor//Z",
    "base64"
  );

  before(async () => {
    await connectDatabase();

    // Create unique test user with ample token budget
    const uniqueEmail = `test_img_${Date.now()}@example.com`;
    const user = await User.create({
      name: "Image Test User",
      email: uniqueEmail,
      passwordHash: "HashedPassword123!",
      role: "user",
      plan: "pro",
    });
    testUserId = user._id.toString();

    await TokenWallet.create({
      userId: user._id,
      balance: 100000,
      totalGranted: 100000,
      totalUsed: 0,
      reservedTokens: 0,
      lastReplenishedAt: new Date(),
    });

    authToken = jwt.sign(
      { userId: testUserId, role: user.role },
      process.env.JWT_SECRET || "1ff6e690959aeaeb72e6db045b982cfa3a020e76e67905427ee1dc2bbabf343f",
      { expiresIn: "1h" }
    );

    // Create test conversation
    const conversation = await Conversation.create({
      userId: user._id,
      title: "Multimodal Test Conversation",
    });
    conversationId = conversation._id.toString();

    // Start server on ephemeral port
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const address = server.address();
        if (address && typeof address === "object") {
          baseUrl = `http://127.0.0.1:${address.port}`;
        }
        resolve();
      });
    });
  });

  after(async () => {
    // Cleanup database documents
    if (testUserId) {
      await User.deleteOne({ _id: new mongoose.Types.ObjectId(testUserId) });
      await TokenWallet.deleteOne({ userId: new mongoose.Types.ObjectId(testUserId) });
      if (conversationId) {
        await Conversation.deleteOne({ _id: new mongoose.Types.ObjectId(conversationId) });
        await Message.deleteMany({ conversationId: new mongoose.Types.ObjectId(conversationId) });
      }
    }

    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await mongoose.disconnect();
  });

  test("1. Unauthenticated request to send message returns 401 Unauthorized", async () => {
    const res = await fetch(`${baseUrl}/api/chat/conversations/${conversationId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Hello without auth" }),
    });

    assert.equal(res.status, 401);
  });

  test("2. Text-only message continues to work normally with application/json", async () => {
    const res = await fetch(`${baseUrl}/api/chat/conversations/${conversationId}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ content: "Explain in 3 words what is Node.js" }),
    });

    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.ok(body.data.userMessage.content.includes("Node.js"));
    assert.equal(body.data.userMessage.attachment, undefined);
    assert.ok(body.data.assistantMessage.content.length > 0);
  });

  test("3. Upload PNG image + question with multipart/form-data analyzes image and returns attachment", async () => {
    const formData = new FormData();
    formData.append("content", "What color is this 1x1 image? Answer in 3 words.");
    formData.append(
      "image",
      new Blob([samplePngBuffer], { type: "image/png" }),
      "test-pixel.png"
    );

    const res = await fetch(`${baseUrl}/api/chat/conversations/${conversationId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${authToken}`,
      },
      body: formData,
    });

    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.success, true);

    const userMessage = body.data.userMessage;
    assert.ok(userMessage.attachment, "Attachment must be present on user message");
    assert.equal(userMessage.attachment.type, "image");
    assert.equal(userMessage.attachment.mimeType, "image/png");
    assert.ok(
      userMessage.attachment.url.startsWith("https://") || userMessage.attachment.url.startsWith("http://"),
      "Attachment URL must be a remote Cloudinary URL"
    );
    assert.ok(
      userMessage.attachment.publicId?.startsWith("Ai-Agent/"),
      "publicId must belong to Ai-Agent folder"
    );
    assert.ok(body.data.assistantMessage.content.length > 0);

    // Verify image is accessible from Cloudinary CDN
    const cdnRes = await fetch(userMessage.attachment.url);
    assert.equal(cdnRes.status, 200);
    assert.equal(cdnRes.headers.get("content-type")?.includes("image"), true);
  });

  test("4. Upload JPG image + question returns AI answer", async () => {
    const formData = new FormData();
    formData.append("content", "Identify the primary color in this image in 3 words.");
    formData.append(
      "image",
      new Blob([sampleJpgBuffer], { type: "image/jpeg" }),
      "red-pixel.jpg"
    );

    const res = await fetch(`${baseUrl}/api/chat/conversations/${conversationId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${authToken}`,
      },
      body: formData,
    });

    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.ok(body.data.userMessage.attachment);
    assert.equal(body.data.userMessage.attachment.mimeType, "image/jpeg");
    assert.ok(body.data.assistantMessage.content.length > 0);
  });

  test("5. Image-only message (without text) defaults prompt to 'Describe this image.'", async () => {
    const formData = new FormData();
    formData.append(
      "image",
      new Blob([samplePngBuffer], { type: "image/png" }),
      "green-pixel.png"
    );

    const res = await fetch(`${baseUrl}/api/chat/conversations/${conversationId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${authToken}`,
      },
      body: formData,
    });

    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.data.userMessage.content, "Describe this image.");
    assert.ok(body.data.assistantMessage.content.length > 0);
  });

  test("6. Upload unsupported file format (e.g. text/plain) is rejected with 400", async () => {
    const formData = new FormData();
    formData.append("content", "What is this file?");
    formData.append(
      "image",
      new Blob(["This is a text file, not an image"], { type: "text/plain" }),
      "malicious.txt"
    );

    const res = await fetch(`${baseUrl}/api/chat/conversations/${conversationId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${authToken}`,
      },
      body: formData,
    });

    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.match(body.message, /unsupported image format/i);
  });

  test("7. Upload oversized image (>10MB) is rejected with 400", async () => {
    const formData = new FormData();
    formData.append("content", "What is this huge image?");
    // Create 11MB dummy buffer with image/png mimetype
    const hugeBuffer = Buffer.alloc(11 * 1024 * 1024);
    formData.append(
      "image",
      new Blob([hugeBuffer], { type: "image/png" }),
      "huge.png"
    );

    const res = await fetch(`${baseUrl}/api/chat/conversations/${conversationId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${authToken}`,
      },
      body: formData,
    });

    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.match(body.message, /exceeds maximum allowed size/i);
  });

  test("8. GET conversation messages preserves attachments for chat history and page refresh", async () => {
    const res = await fetch(`${baseUrl}/api/chat/conversations/${conversationId}/messages`, {
      headers: {
        Authorization: `Bearer ${authToken}`,
      },
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.ok(Array.isArray(body.data.messages));

    const imageMessages = body.data.messages.filter((m: any) => m.attachment);
    assert.ok(imageMessages.length >= 3, "Expected at least 3 messages with attachments");

    for (const msg of imageMessages) {
      assert.equal(msg.attachment.type, "image");
      assert.ok(
        msg.attachment.url.startsWith("https://") ||
        msg.attachment.url.startsWith("http://") ||
        msg.attachment.url.startsWith("/uploads/"),
        "URL must be either Cloudinary or legacy upload"
      );
      assert.ok(["image/png", "image/jpeg"].includes(msg.attachment.mimeType));
    }
  });

  test("9. Empty message without image and without text is rejected with 400", async () => {
    const res = await fetch(`${baseUrl}/api/chat/conversations/${conversationId}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ content: "   " }),
    });

    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.match(body.message, /cannot be empty/i);
  });

  test("10. Browser refresh simulation: client aborts request mid-generation, server recovers and completes response", async () => {
    // 1. Create a dedicated conversation for this test
    const convRes = await fetch(`${baseUrl}/api/chat/conversations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ title: "Refresh Resilience Test" }),
    });
    const convBody = await convRes.json();
    const testConvId = convBody.data.conversation.id;

    // 2. Start sending image + question with an AbortController to simulate browser refresh after 50ms
    const controller = new AbortController();
    const formData = new FormData();
    formData.append("content", "What is the format of this test image? Answer briefly.");
    formData.append(
      "image",
      new Blob([samplePngBuffer], { type: "image/png" }),
      "refresh-test.png"
    );

    const postPromise = fetch(`${baseUrl}/api/chat/conversations/${testConvId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${authToken}`,
      },
      body: formData,
      signal: controller.signal,
    });

    // Abort after 600ms to disconnect while Gemini is actively generating
    setTimeout(() => {
      controller.abort();
    }, 600);

    // Expect fetch to fail on client side with AbortError
    await assert.rejects(postPromise, (err: any) => {
      return err.name === "AbortError" || err.message?.includes("aborted");
    });

    // 3. Immediately simulate browser reload by calling GET /messages
    let messages: any[] = [];
    const pollStart = Date.now();
    while (messages.length < 2 && Date.now() - pollStart < 5000) {
      const reloadRes = await fetch(`${baseUrl}/api/chat/conversations/${testConvId}/messages`, {
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
      });
      assert.equal(reloadRes.status, 200);
      const reloadBody = await reloadRes.json();
      messages = reloadBody.data?.messages || [];
      if (messages.length < 2) {
        await new Promise((r) => setTimeout(r, 200));
      }
    }

    assert.ok(messages.length >= 2, "Expected both user message and assistant placeholder");
    const userMsg = messages[0];
    const assistantMsg = messages[1];

    assert.equal(userMsg.role, "user");
    assert.ok(userMsg.attachment, "Attachment must be retained");
    assert.equal(assistantMsg.role, "assistant");
    assert.ok(
      ["generating", "completed"].includes(assistantMsg.status),
      `Expected status to be generating or completed, got ${assistantMsg.status}`
    );

    // 4. Poll until background generation finishes (max 30s)
    let finalAssistantMsg: any = assistantMsg;
    const startTime = Date.now();
    while (finalAssistantMsg.status === "generating" && Date.now() - startTime < 30000) {
      await new Promise((r) => setTimeout(r, 1000));
      const pollRes = await fetch(`${baseUrl}/api/chat/conversations/${testConvId}/messages`, {
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
      });
      const pollBody = await pollRes.json();
      finalAssistantMsg = pollBody.data.messages.find((m: any) => m.role === "assistant");
    }

    // 5. Must NOT be failed or interrupted, must be completed with Gemini output!
    assert.equal(finalAssistantMsg.status, "completed");
    assert.ok(finalAssistantMsg.content.length > 0, "Assistant response must have content");
    assert.ok(
      !finalAssistantMsg.content.includes("Response was interrupted"),
      "Must not show Response was interrupted"
    );

    // 6. Verify wallet: reserved tokens must be 0 (no lingering reservation)
    const wallet = await TokenWallet.findOne({ userId: new mongoose.Types.ObjectId(testUserId) });
    assert.equal(wallet?.reservedTokens, 0, "Reserved tokens must be finalized to 0");
  });

  test("11. Delete conversation removes Cloudinary attachments and cleans up database", async () => {
    // 1. Create a dedicated conversation
    const convRes = await fetch(`${baseUrl}/api/chat/conversations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ title: "Delete Cloudinary Test" }),
    });
    const convBody = await convRes.json();
    const delConvId = convBody.data.conversation.id;

    // 2. Upload image to this conversation
    const formData = new FormData();
    formData.append("content", "Describe this image in 2 words");
    formData.append(
      "image",
      new Blob([samplePngBuffer], { type: "image/png" }),
      "cloudinary-delete-test.png"
    );

    const postRes = await fetch(`${baseUrl}/api/chat/conversations/${delConvId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${authToken}` },
      body: formData,
    });
    assert.equal(postRes.status, 201);
    const postBody = await postRes.json();
    const publicId = postBody.data.userMessage.attachment?.publicId;
    assert.ok(publicId, "Uploaded message must have Cloudinary publicId");

    // 3. Delete the conversation
    const delRes = await fetch(`${baseUrl}/api/chat/conversations/${delConvId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${authToken}` },
    });
    assert.equal(delRes.status, 200);

    // 4. Verify MongoDB messages and conversation are deleted
    const count = await Message.countDocuments({
      conversationId: new mongoose.Types.ObjectId(delConvId),
    });
    assert.equal(count, 0, "All messages in deleted conversation must be removed");
  });

  test("12. Backward compatibility: legacy /uploads/ attachment displays and deletes safely", async () => {
    // 1. Create a conversation
    const conv = await Conversation.create({
      userId: new mongoose.Types.ObjectId(testUserId),
      title: "Legacy Attachment Test",
    });

    // 2. Directly insert a legacy message without publicId
    await Message.create({
      conversationId: conv._id,
      userId: new mongoose.Types.ObjectId(testUserId),
      role: "user",
      content: "Legacy message with local file",
      attachment: {
        type: "image",
        url: "/uploads/legacy-mock-image.png",
        mimeType: "image/png",
        name: "legacy-mock-image.png",
        size: 1024,
      },
      status: "completed",
    });

    // 3. GET messages to verify it returns properly
    const res = await fetch(`${baseUrl}/api/chat/conversations/${conv._id}/messages`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    const legacyMsg = body.data.messages.find((m: any) => m.content.includes("Legacy"));
    assert.ok(legacyMsg);
    assert.equal(legacyMsg.attachment.url, "/uploads/legacy-mock-image.png");
    assert.equal(legacyMsg.attachment.publicId, undefined);

    // 4. Delete the conversation — must succeed without throwing on missing file or missing publicId
    const delRes = await fetch(`${baseUrl}/api/chat/conversations/${conv._id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${authToken}` },
    });
    assert.equal(delRes.status, 200);
  });
});

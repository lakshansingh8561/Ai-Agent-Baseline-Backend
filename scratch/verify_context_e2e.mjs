import fetch from "node:child_process";

const BASE_URL = "http://localhost:5000";

async function run() {
  const email = `context_test_${Date.now()}@example.com`;
  const password = "Password123!";

  console.log(`1. Registering user: ${email}`);
  const regRes = await fetchReg(email, password);
  if (!regRes.success) {
    throw new Error(`Registration failed: ${JSON.stringify(regRes)}`);
  }

  console.log("2. Logging in...");
  const loginRes = await fetchLogin(email, password);
  const token = loginRes.token;
  console.log("Logged in, token acquired.");

  console.log("3. Creating conversation...");
  const convRes = await fetchCreateConv(token, "Cars Conversation");
  const convId = convRes.data.conversation.id;
  console.log(`Conversation created: ${convId}`);

  // Scenario Turn 1
  const prompt1 = `Here is a list of car names categorized by style, personality, and type.

Include:
Apex Predator`;
  console.log("\n--- USER TURN 1 ---");
  console.log(prompt1);
  const msg1Res = await fetchSendMessage(token, convId, prompt1);
  console.log("\n--- ASSISTANT TURN 1 ---");
  console.log(msg1Res.data.assistantMessage.content.slice(0, 300) + "...");

  // Scenario Turn 2
  const prompt2 = "tell me about this Apex Predator";
  console.log("\n--- USER TURN 2 ---");
  console.log(prompt2);
  const msg2Res = await fetchSendMessage(token, convId, prompt2);
  console.log("\n--- ASSISTANT TURN 2 ---");
  console.log(msg2Res.data.assistantMessage.content);

  // Scenario Turn 3
  const prompt3 = "you know the previous context";
  console.log("\n--- USER TURN 3 ---");
  console.log(prompt3);
  const msg3Res = await fetchSendMessage(token, convId, prompt3);
  console.log("\n--- ASSISTANT TURN 3 ---");
  console.log(msg3Res.data.assistantMessage.content);

  // Check Token Balance
  const balanceRes = await fetchTokenBalance(token);
  console.log("\n--- TOKEN WALLET STATUS ---");
  console.log(balanceRes);
}

async function fetchReg(email, password) {
  const res = await fetchApi("/api/auth/register", "POST", { name: "Context Tester", email, password });
  return res;
}

async function fetchLogin(email, password) {
  const res = await fetchApi("/api/auth/login", "POST", { email, password });
  return res.data;
}

async function fetchCreateConv(token, title) {
  return await fetchApi("/api/chat/conversations", "POST", { title }, token);
}

async function fetchSendMessage(token, convId, content) {
  return await fetchApi(`/api/chat/conversations/${convId}/messages`, "POST", { content }, token);
}

async function fetchTokenBalance(token) {
  return await fetchApi("/api/tokens/balance", "GET", null, token);
}

async function fetchApi(path, method, body, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await globalThis.fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const json = await res.json();
  if (!res.ok) {
    throw new Error(`API ${method} ${path} returned ${res.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

run().catch((err) => {
  console.error("Test error:", err);
  process.exit(1);
});

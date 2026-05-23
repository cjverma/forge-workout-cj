import express from "express";
import dotenv from "dotenv";
import { timingSafeEqual } from "crypto";

dotenv.config();

const app = express();
app.use(express.json({ limit: "1mb" }));

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const PORT = Number(process.env.PORT || 8787);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const FORGE_API_TOKEN = process.env.FORGE_API_TOKEN || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.5";
const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";

const HARD_RULES = [
  "Never prescribe overhead press.",
  "Never prescribe standard lat pulldown.",
  "Never prescribe barbell squat, deadlift, or good mornings.",
  "Never prescribe standing loaded exercises.",
  "Never prescribe axial compression exercises.",
  "Never prescribe stairmaster.",
  "Always begin gym sessions with stationary bike.",
  "If left calf pain triggers 3 or more times, instruct user to sit and end or modify session.",
  "Core gently braced throughout exercises."
].join(" ");

function auth(req, res, next) {
  if (!FORGE_API_TOKEN) {
    return res.status(500).json({ error: "Server misconfigured: missing FORGE_API_TOKEN" });
  }

  const header = req.get("authorization") || "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : "";

  let valid = false;
  try {
    const a = Buffer.from(provided.padEnd(FORGE_API_TOKEN.length, "\0"));
    const b = Buffer.from(FORGE_API_TOKEN.padEnd(provided.length, "\0"));
    valid = a.length === b.length && timingSafeEqual(a, b);
  } catch { valid = false; }

  if (!valid) return res.status(401).json({ error: "Unauthorized" });
  return next();
}

function requireOpenAIKey(res) {
  if (!OPENAI_API_KEY) {
    res.status(500).json({ error: "Server misconfigured: missing OPENAI_API_KEY" });
    return false;
  }
  return true;
}

async function callOpenAI({ system, user, maxOutputTokens }) {
  const response = await fetch(OPENAI_RESPONSES_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      instructions: system,
      input: user,
      max_output_tokens: maxOutputTokens
    })
  });

  const data = await response.json();

  if (!response.ok) {
    const msg = data?.error?.message || "OpenAI API error";
    throw new Error(msg);
  }

  return extractResponseText(data);
}

function extractResponseText(data) {
  if (typeof data?.output_text === "string" && data.output_text.trim()) {
    return data.output_text;
  }

  const chunks = [];
  for (const item of data?.output || []) {
    for (const content of item?.content || []) {
      if (typeof content?.text === "string") chunks.push(content.text);
      if (typeof content?.output_text === "string") chunks.push(content.output_text);
    }
  }

  return chunks.join("\n").trim();
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "forge-backend", model: OPENAI_MODEL, provider: "openai" });
});

app.post("/api/coach", auth, async (req, res) => {
  if (!requireOpenAIKey(res)) return;

  const { prompt = "", context = {} } = req.body || {};
  if (!prompt || typeof prompt !== "string") {
    return res.status(400).json({ error: "Invalid payload: prompt is required" });
  }

  const system = `You are a careful strength coach for one user. Follow these hard restrictions at all times: ${HARD_RULES}. Keep answers concise, practical, and safe.`;

  const user = JSON.stringify({
    task: "Coach response",
    prompt,
    context
  });

  try {
    const text = await callOpenAI({ system, user, maxOutputTokens: 1000 });
    return res.json({ text });
  } catch (error) {
    return res.status(502).json({ error: String(error.message || error) });
  }
});

app.post("/api/weekly-plan", auth, async (req, res) => {
  if (!requireOpenAIKey(res)) return;

  const { weekSummary = {}, profile = {}, rules = {} } = req.body || {};

  const system = `Generate a complete 6-day weekly programme plus 1 rest day for this specific user. Apply progressive overload carefully and obey these hard restrictions at all times: ${HARD_RULES}. Return valid JSON only with keys: week_plan, coaching_notes, flags.`;

  const user = JSON.stringify({
    task: "Generate next week plan",
    weekSummary,
    profile,
    rules
  });

  try {
    const text = await callOpenAI({ system, user, maxOutputTokens: 2000 });
    return res.json({ text });
  } catch (error) {
    return res.status(502).json({ error: String(error.message || error) });
  }
});

app.listen(PORT, () => {
  console.log(`[forge-backend] listening on http://localhost:${PORT}`);
});

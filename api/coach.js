import { HARD_RULES, setCors, checkAuth, callOpenAI } from "./_shared.js";

const MAX_PROMPT = 5000; // raised to accommodate AI-chat context injection (~2-3k) + user question

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!checkAuth(req, res)) return;

  const { prompt = "", context = {} } = req.body || {};
  if (!prompt || typeof prompt !== "string") {
    return res.status(400).json({ error: "prompt is required" });
  }
  if (prompt.length > MAX_PROMPT) {
    return res.status(400).json({ error: `prompt must be ${MAX_PROMPT} characters or fewer` });
  }

  // Only forward known, bounded fields — never pass raw user object to OpenAI
  const safeContext = {
    day: typeof context.day === "string" ? context.day.slice(0, 20) : "",
    program: typeof context.program === "string" ? context.program.slice(0, 60) : ""
  };

  const system = `You are a careful strength coach for one user. Follow these hard restrictions at all times: ${HARD_RULES}. Keep answers concise, practical, and safe. Formatting: plain text only. You may use simple bullets ("- ") and **bold** for emphasis. Never use headers (#), tables, code fences, or nested lists.`;
  const user = JSON.stringify({ task: "Coach response", prompt, context: safeContext });

  try {
    const text = await callOpenAI({ system, user, maxOutputTokens: 1000 });
    return res.json({ text });
  } catch (e) {
    console.error("[coach]", e.message);
    return res.status(502).json({ error: "AI service unavailable" });
  }
}

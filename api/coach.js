import { HARD_RULES, setCors, checkAuth, callOpenAI } from "./_shared.js";

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!checkAuth(req, res)) return;

  const { prompt = "", context = {} } = req.body || {};
  if (!prompt || typeof prompt !== "string") {
    return res.status(400).json({ error: "prompt is required" });
  }

  const system = `You are a careful strength coach for one user. Follow these hard restrictions at all times: ${HARD_RULES}. Keep answers concise, practical, and safe.`;
  const user = JSON.stringify({ task: "Coach response", prompt, context });

  try {
    const text = await callOpenAI({ system, user, maxOutputTokens: 1000 });
    return res.json({ text });
  } catch (e) {
    return res.status(502).json({ error: String(e.message || e) });
  }
}

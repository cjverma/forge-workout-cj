import { HARD_RULES, setCors, checkAuth, callOpenAI } from "./_shared.js";

const MAX_BODY_BYTES = 8_000;

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!checkAuth(req, res)) return;

  const bodyStr = JSON.stringify(req.body || {});
  if (bodyStr.length > MAX_BODY_BYTES) {
    return res.status(400).json({ error: "Request body too large" });
  }

  const { weekSummary = {}, profile = {}, rules = {} } = req.body || {};

  const system = `Generate a complete 6-day weekly programme plus 1 rest day for this specific user. Apply progressive overload carefully and obey these hard restrictions at all times: ${HARD_RULES}. Return valid JSON only with keys: week_plan, coaching_notes, flags.`;
  const user = JSON.stringify({ task: "Generate next week plan", weekSummary, profile, rules });

  try {
    const text = await callOpenAI({ system, user, maxOutputTokens: 2000 });
    return res.json({ text });
  } catch (e) {
    console.error("[weekly-plan]", e.message);
    return res.status(502).json({ error: "AI service unavailable" });
  }
}

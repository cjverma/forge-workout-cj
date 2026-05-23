import { HARD_RULES, setCors, checkAuth, callOpenAI } from "./_shared.js";

const MAX_BODY_BYTES = 32_000;

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

  const system = `You are a careful strength coach. Review the user's session history and current program, then produce next week's updates with progressive overload. Obey these hard restrictions at all times: ${HARD_RULES}

Return ONLY valid JSON with exactly these keys:
{
  "week_plan": { "Monday": [{"id":"ex_id","sets":3,"reps":12,"hint":"35-40 kg"}], ... },
  "coaching_notes": "2-3 sentence summary of key changes and reasoning",
  "flags": ["any safety warnings or observations"]
}

Rules: Only include exercises that need updating in week_plan. Use the exact exercise IDs from profile.currentPlan. Progressive overload: ONLY increase a weight hint if the exercise has completed=true AND sets_logged is non-empty with actual weights recorded. If an exercise was skipped, not started, or sets_logged is empty — keep its parameters exactly unchanged. Never change physio exercise parameters (cat === "physio"). Every training day (Mon-Sat) must cover at least 2 distinct body-part groups. Omit exercises that stay the same.`;
  const user = JSON.stringify({ task: "Generate next week plan", weekSummary, profile, rules });

  try {
    const text = await callOpenAI({ system, user, maxOutputTokens: 2000 });
    return res.json({ text });
  } catch (e) {
    console.error("[weekly-plan]", e.message);
    return res.status(502).json({ error: "AI service unavailable" });
  }
}

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
  "week_plan": {
    "Monday": [
      {"id":"ex_id","sets":3,"reps":12,"hint":"35-40 kg"},
      {"action":"remove","id":"ex_id2"},
      {"action":"add","id":"ai_mon_lowrow","name":"Low Cable Row","cat":"gym","sets":3,"reps":12,"hint":"35-45 kg","cue":"Sit tall. Row to belly button. Squeeze mid-back.","muscles":["mid back","biceps"]}
    ]
  },
  "coaching_notes": "2-3 sentence summary of key changes and reasoning",
  "flags": ["any safety warnings or observations"]
}

Rules:
- Updates (no action field): use exact exercise IDs from profile.currentPlan. Only include if sets/reps/hint actually change.
- Progressive overload: ONLY increase weight hint if completed=true AND sets_logged has actual weights recorded. Skipped or unlogged exercises → no changes at all.
- Adds (action:"add"): you MAY introduce a new exercise to replace something stale or add variety for a muscle group. Provide a unique id prefixed with "ai_", name, cat, sets, reps, hint, cue, muscles array. Must respect all spine restrictions.
- Removes (action:"remove"): you MAY remove an exercise that has been plateauing, is redundant, or is being replaced by an add. Only remove gym exercises — never physio or cardio.
- Never modify physio (cat="physio") or cardio exercises.
- Never add overhead, barbell, standing-loaded, or axial-compression movements.
- Max 4 gym exercises per body-part group per day.
- Every training day (Mon-Sat) must cover exactly 2 distinct body-part groups.
- Omit days with no changes.`;
  const user = JSON.stringify({ task: "Generate next week plan", weekSummary, profile, rules });

  try {
    const text = await callOpenAI({ system, user, maxOutputTokens: 2000 });
    return res.json({ text });
  } catch (e) {
    console.error("[weekly-plan]", e.message);
    return res.status(502).json({ error: "AI service unavailable" });
  }
}

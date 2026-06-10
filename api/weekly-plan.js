import { HARD_RULES, setCors, checkAuth, callOpenAI } from "./_shared.js";

const MAX_BODY_BYTES = 64_000;

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!checkAuth(req, res)) return;

  const bodyStr = JSON.stringify(req.body || {});
  if (bodyStr.length > MAX_BODY_BYTES) {
    return res.status(400).json({ error: "Request body too large" });
  }

  const { sessionHistory = [], profile = {} } = req.body || {};

  const weeksProvided = sessionHistory.length;

  const system = `You are a careful strength coach analysing up to ${weeksProvided} weeks of training history to plan next week with intelligent progressive overload.

Hard restrictions (non-negotiable): ${HARD_RULES}

Your job:
1. ANALYSE THE TREND across all provided weeks — not just the most recent one. Look for:
   - Consistent completion vs repeated skips (skipping 2+ weeks = stall, consider swapping)
   - Weight progression trajectory (is it stalling, improving, regressing?)
   - Volume tolerance (session durations, sets completed)
   - Session notes from this week (keys ending in "_notes") — use these for context on how the user felt, any pain, fatigue, or standout performances
   - Any exercise that has been at the same weight for 3+ weeks despite full completion → time to increase or swap
   - profile.weightLog shows recent body-weight readings: the user is in an aggressive cut (goal in profile.goal). Rapid weight loss reduces strength capacity — if body weight is dropping fast, favour holding weights and adding reps over adding load, and flag fatigue risk in coaching_notes
2. APPLY PROGRESSIVE OVERLOAD conservatively:
   - Only increase weight hint if the exercise was completed=true with actual weights logged in the MOST RECENT week
   - Increase by the smallest sensible increment (usually 2.5–5 kg for machines)
   - If an exercise was skipped or unlogged in the most recent week → no change
3. VARIETY: You MAY swap a stalled or repeatedly-skipped exercise for a different movement targeting the same muscle group
4. FORMAT: Return ONLY valid JSON — no markdown, no explanation:
{
  "week_plan": {
    "Monday": [
      {"id":"ex_id","sets":3,"reps":12,"hint":"37.5-42.5 kg"},
      {"action":"remove","id":"ex_id2"},
      {"action":"add","id":"ai_mon_lowrow","name":"Low Cable Row","cat":"gym","sets":3,"reps":12,"hint":"35-45 kg","cue":"Sit tall. Row to belly button.","muscles":["mid back","biceps"]}
    ]
  },
  "coaching_notes": "3-4 sentence summary covering trend observations and key changes",
  "flags": ["any safety warnings, plateaus detected, or observations"]
}

Rules:
- Updates (no action field): use exact exercise IDs from profile.currentPlan. Only include if something actually changes.
- Adds must have a unique id prefixed "ai_", name, cat, sets, reps, hint, cue, muscles. Must respect all spine restrictions.
- Removes: only gym exercises — never physio or cardio.
- Max 4 gym exercises per body-part group per day.
- Every training day (Mon–Sat) must cover exactly 2 distinct body-part groups.
- Omit days with no changes.`;

  const user = JSON.stringify({
    task: `Generate next week plan. ${weeksProvided} week(s) of history provided — analyse all of it before deciding.`,
    sessionHistory,
    profile
  });

  try {
    const text = await callOpenAI({ system, user, maxOutputTokens: 3000 });
    // Validate the AI output server-side before handing it to the client
    let parsed;
    try {
      parsed = JSON.parse(text.replace(/```[a-z]*\n?/gi, "").replace(/```/g, "").trim());
    } catch {
      console.error("[weekly-plan] AI returned invalid JSON:", text.slice(0, 300));
      return res.status(502).json({ error: "AI returned invalid plan JSON" });
    }
    if (!parsed.week_plan || typeof parsed.week_plan !== "object") {
      console.error("[weekly-plan] missing week_plan key:", text.slice(0, 300));
      return res.status(502).json({ error: "AI plan missing week_plan" });
    }
    return res.json({ text: JSON.stringify(parsed) });
  } catch (e) {
    console.error("[weekly-plan]", e.message);
    return res.status(502).json({ error: "AI service unavailable" });
  }
}

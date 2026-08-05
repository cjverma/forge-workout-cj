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

  // The schedule is data, not a constant. It used to be written into the prompt
  // as a fixed six-day week with one named rest day; when the rest day moved,
  // the prompt kept describing the old week and the AI planned work on it.
  const prog = profile.program || {};
  const training = Array.isArray(prog.trainingDays) && prog.trainingDays.length
    ? prog.trainingDays : ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
  const rest = Array.isArray(prog.restDays) ? prog.restDays : ["Sunday"];
  const schedule = `The user is on the ${prog.name || "current program"}${prog.weekStarting ? `, and you are planning the week starting ${prog.weekStarting}` : ""}. Training days: ${training.join(", ")}. Rest day(s): ${rest.join(", ") || "none"}. profile.currentPlan is that exact week and is the ONLY plan you may edit — build every change from it, not from any program you have seen before.`;

  const system = `You are a careful strength coach analysing up to ${weeksProvided} weeks of training history to plan next week with intelligent progressive overload.

${schedule}

Hard restrictions (non-negotiable): ${HARD_RULES}

Your job:
1. ANALYSE THE TREND across all provided weeks — not just the most recent one. Look for:
   - Consistent completion vs repeated skips (skipping 2+ weeks = stall, consider swapping)
   - Weight progression trajectory (is it stalling, improving, regressing?)
   - Volume tolerance (session durations, sets completed)
   - Session notes from this week (keys ending in "_notes") — use these for context on how the user felt, any pain, fatigue, or standout performances
   - Any exercise that has been at the same weight for 3+ weeks despite full completion → time to increase or swap
   - profile.weightLog shows recent body-weight readings: the user is in an aggressive cut (goal in profile.goal). Rapid weight loss reduces strength capacity — if body weight is dropping fast, favour holding weights and adding reps over adding load, and flag fatigue risk in coaching_notes
2. ANCHOR EVERY WEIGHT HINT TO THE PR. profile.prs is the user's best recorded lift per exercise in next week's plan, joined to the plan by "id". All weights are KILOGRAMS, as are all sets_logged (.kg) and every hint you write. Fields: bestKg × reps is the best set, est1RM its Epley estimate, date/daysAgo when it was set, setThisWeek true if it landed in the last 7 days, hasPR false if the exercise has never been logged.
   - The hint is a working range, not a 1RM. Build it around bestKg, the weight actually lifted for reps — never around est1RM, which is a heavier number the user has never touched.
   - setThisWeek true → the user just hit a PR on it. Step up: the new range should sit around bestKg at its bottom, one increment above at its top, so the PR weight becomes the working weight rather than the ceiling.
   - PR set recently (daysAgo <= 21) but not this week, and the most recent sets are at or near bestKg → normal small increment.
   - daysAgo > 21, or recent logged sets well below bestKg → do NOT jump back to the PR. That lift is stale or was a one-off. Set the hint from recent actual performance and say so in the reason; the PR is the target to work back toward, not next week's load.
   - NEVER write a hint whose bottom exceeds bestKg. A range the user has never lifted for a single rep is not progressive overload, it is an injury.
   - hasPR false → leave the existing hint alone.
   - When a hint changes because of a PR, say the numbers in the reason ("hit 45kg × 10 on Tuesday, new PR").
   Then, on top of that anchor:
   - Only increase weight hint if the exercise was completed=true with actual weights logged in the MOST RECENT week
   - Increase by the smallest sensible increment (usually 2.5–5 kg for machines)
   - If an exercise was skipped or unlogged in the most recent week → no change
   - If logged weights are consistently below the bottom of the hint range across 2+ weeks, lower the hint to match actual performance — don't leave an aspirational range the user isn't reaching
3. VARIETY: You MAY swap a stalled or repeatedly-skipped exercise for a different movement targeting the same muscle group. When using action:"add", you MUST only use exercises from profile.approvedExercises — do not invent movements outside this list. Pick the closest muscle-group match from the approved list.
4. FORMAT: Return ONLY valid JSON — no markdown, no explanation:
{
  "week_plan": {
    "Monday": [
      {"id":"ex_id","sets":3,"reps":12,"hint":"40-45 kg","reason":"New PR at 40kg x 10 on Wednesday, so 40kg becomes the working weight"},
      {"action":"remove","id":"ex_id2","reason":"Skipped 3 weeks in a row — removing to reduce friction"},
      {"action":"add","id":"ai_mon_lowrow","name":"Low Cable Row","cat":"gym","sets":3,"reps":12,"hint":"35-45 kg","cue":"Sit tall. Row to belly button.","muscles":["mid back","biceps"],"reason":"Adding variety for mid-back after Cable Row plateau"}
    ]
  },
  "coaching_notes": "3-4 sentence summary covering trend observations and key changes",
  "flags": ["any safety warnings, plateaus detected, or observations"]
}

Every entry in week_plan MUST include a "reason" field — one concise sentence explaining why this change was made based on the data.

Rules:
- Updates (no action field): use exact exercise IDs from profile.currentPlan. Only include if something actually changes.
- Adds must have a unique id prefixed "ai_", name, cat, sets, reps, hint, cue, muscles. Must respect all spine restrictions.
- Removes: only gym exercises — never physio or cardio.
- Max 4 gym exercises per body-part group per day.
- Every training day (${training.join(", ")}) must cover exactly 2 distinct body-part groups.
- NEVER put any exercise on a rest day (${rest.join(", ") || "none"}), and never remove or alter what is already there. A day marked "rest":true in profile.currentPlan is off-limits. Its physio block returns on its own schedule and is not yours to plan.
- Do not restructure the split. Keep each day's body-part pairing as it is in profile.currentPlan; your changes are loads, reps, sets, and same-muscle swaps.
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
    // Spine safety net: strip any AI "add" that violates the hard rules
    const BANNED = [
      /overhead/i, /military/i, /shoulder\s*press/i, /arnold/i, /push\s*press/i,
      /\bsquat\b/i, /deadlift/i, /good\s*morning/i, /\blunge/i, /split\s*squat/i,
      /step[\s-]?up/i, /stair/i, /box\s*jump/i, /\bjump/i, /burpee/i,
      /\bstanding\b/i, /upright\s*row/i, /barbell\s*row/i, /bent[\s-]?over/i,
      /\bclean\b/i, /snatch/i, /thruster/i, /farmer/i, /\bcarr(y|ies)\b/i, /\brunning?\b/i
    ];
    const banned = name => {
      const n = String(name || "");
      if (/lat\s*pulldown/i.test(n) && !/neutral|close/i.test(n)) return true;
      return BANNED.some(rx => rx.test(n));
    };
    const stripped = [];
    for (const [day, exs] of Object.entries(parsed.week_plan)) {
      if (!Array.isArray(exs)) continue;
      parsed.week_plan[day] = exs.filter(e => {
        if (e && e.action === "add" && banned(e.name)) { stripped.push(e.name); return false; }
        return true;
      });
    }
    if (stripped.length) {
      console.warn("[weekly-plan] blocked unsafe suggestions:", stripped.join(", "));
      parsed.flags = parsed.flags || [];
      parsed.flags.unshift("Blocked unsafe AI suggestions (spine rules): " + stripped.join(", "));
    }
    return res.json({ text: JSON.stringify(parsed) });
  } catch (e) {
    console.error("[weekly-plan]", e.message);
    return res.status(502).json({ error: "AI service unavailable" });
  }
}

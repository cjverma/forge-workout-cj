import { HARD_RULES, setCors, checkAuth, checkRateLimit, callOpenAI } from "./_shared.js";

const MAX_BODY_BYTES = 8_000;

const BANNED = [
  /overhead/i, /military/i, /shoulder\s*press/i, /arnold/i, /push\s*press/i,
  /\bsquat\b/i, /deadlift/i, /good\s*morning/i, /\blunge/i, /split\s*squat/i,
  /step[\s-]?up/i, /stair/i, /box\s*jump/i, /\bjump/i, /burpee/i,
  /\bstanding\b/i, /upright\s*row/i, /barbell\s*row/i, /bent[\s-]?over/i,
  /\bclean\b/i, /snatch/i, /thruster/i, /farmer/i, /\bcarr(y|ies)\b/i, /\brunning?\b/i
];
function isBanned(name) {
  const n = String(name || "");
  if (/lat\s*pulldown/i.test(n) && !/neutral|close/i.test(n)) return true;
  return BANNED.some(rx => rx.test(n));
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!checkAuth(req, res)) return;
  if (!checkRateLimit(req, res, { name: "suggest-alt" })) return;

  const bodyStr = JSON.stringify(req.body || {});
  if (bodyStr.length > MAX_BODY_BYTES) return res.status(400).json({ error: "Request body too large" });

  const { exerciseName, muscles, cat } = req.body || {};
  if (!exerciseName || typeof exerciseName !== "string") {
    return res.status(400).json({ error: "Missing exerciseName" });
  }
  const safeName = exerciseName.replace(/[<>{}[\]]/g, "").slice(0, 80);
  const safeMuscles = Array.isArray(muscles) ? muscles.slice(0, 6).map(m => String(m).slice(0, 30)) : [];

  const system = `You are a careful strength coach. The user tried to add an exercise that is blocked by hard spine-safety restrictions.

Hard restrictions (non-negotiable): ${HARD_RULES}

Your job: suggest exactly ONE safe substitute exercise that trains the same muscle group(s), seated or lying only, that fully complies with the restrictions above.

Return ONLY valid JSON, no markdown, no explanation:
{"name":"Exercise Name","cat":"gym","sets":3,"reps":12,"hint":"weight range e.g. 20-30 kg","cue":"one short coaching cue","muscles":["muscle1","muscle2"]}`;

  const user = JSON.stringify({
    blockedExercise: safeName,
    category: cat || "gym",
    targetMuscles: safeMuscles,
    task: "Suggest one safe substitute exercise as JSON."
  });

  try {
    const text = await callOpenAI({ system, user, maxOutputTokens: 300 });
    let parsed;
    try {
      parsed = JSON.parse(text.replace(/```[a-z]*\n?/gi, "").replace(/```/g, "").trim());
    } catch {
      console.error("[suggest-alt] AI returned invalid JSON:", text.slice(0, 300));
      return res.status(502).json({ error: "AI returned invalid suggestion" });
    }
    if (!parsed.name || typeof parsed.name !== "string") {
      return res.status(502).json({ error: "AI suggestion missing name" });
    }
    if (isBanned(parsed.name)) {
      console.warn("[suggest-alt] AI suggested a banned exercise, rejecting:", parsed.name);
      return res.status(502).json({ error: "AI suggestion failed the safety check — try a different search term" });
    }
    return res.json({
      name: String(parsed.name).slice(0, 80),
      cat: String(parsed.cat || "gym").toLowerCase().slice(0, 20),
      sets: Number(parsed.sets) || 3,
      reps: parsed.reps ?? 12,
      hint: String(parsed.hint || "").slice(0, 40),
      cue: String(parsed.cue || "Focus on controlled movement.").slice(0, 200),
      muscles: Array.isArray(parsed.muscles) ? parsed.muscles.slice(0, 6).map(m => String(m).slice(0, 30)) : []
    });
  } catch (e) {
    console.error("[suggest-alt]", e.message);
    return res.status(502).json({ error: "AI service unavailable" });
  }
}

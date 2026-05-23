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
  // Medical context — always present in every AI call
  "This user has a lumbar spine condition (disc herniation with nerve impingement) causing left-leg sciatica and chronic left calf nerve pain.",
  "All recommendations must account for this condition at all times — safety over performance, always.",
  // Absolute exercise restrictions
  "Never prescribe overhead press or any overhead loaded movement.",
  "Never prescribe standard lat pulldown.",
  "Never prescribe barbell squat, deadlift, good mornings, or any hip-hinge under axial load.",
  "Never prescribe standing loaded exercises — all resistance work must be seated or lying.",
  "Never prescribe axial compression exercises (no load directed through the spine).",
  "Never prescribe stairmaster or step-climbing under load.",
  // Session structure
  "Always begin every gym session with stationary bike (minimum 15 minutes) — hip flexion decompresses the spine before any loading.",
  "Always end gym sessions with easy treadmill walking at low incline — no running.",
  "Core gently braced throughout all exercises to protect the lumbar spine.",
  // Nerve symptom protocol
  "Left calf pain or tingling is a nerve symptom, not muscle fatigue. If it triggers 3 or more times in one session, instruct the user to sit down immediately and end or significantly modify the session.",
  "Never push through left calf nerve pain."
].join(" ");

function auth(req, res, next) {
  if (!FORGE_API_TOKEN) {
    return res.status(500).json({ error: "Server misconfigured: missing FORGE_API_TOKEN" });
  }

  const header = req.get("authorization") || "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : "";

  let valid = false;
  try {
    const a = Buffer.from(provided);
    const b = Buffer.from(FORGE_API_TOKEN);
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
  res.json({ ok: true });
});

app.post("/api/coach", auth, async (req, res) => {
  if (!requireOpenAIKey(res)) return;

  const { prompt = "", context = {} } = req.body || {};
  if (!prompt || typeof prompt !== "string") {
    return res.status(400).json({ error: "Invalid payload: prompt is required" });
  }
  if (prompt.length > 2000) {
    return res.status(400).json({ error: "prompt must be 2000 characters or fewer" });
  }

  const safeContext = {
    day: typeof context.day === "string" ? context.day.slice(0, 20) : "",
    program: typeof context.program === "string" ? context.program.slice(0, 60) : ""
  };

  const system = `You are a careful strength coach for one user. Follow these hard restrictions at all times: ${HARD_RULES}. Keep answers concise, practical, and safe.`;
  const user = JSON.stringify({ task: "Coach response", prompt, context: safeContext });

  try {
    const text = await callOpenAI({ system, user, maxOutputTokens: 1000 });
    return res.json({ text });
  } catch (error) {
    console.error("[coach]", error.message);
    return res.status(502).json({ error: "AI service unavailable" });
  }
});

app.post("/api/weekly-plan", auth, async (req, res) => {
  if (!requireOpenAIKey(res)) return;

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
    console.error("[weekly-plan]", error.message);
    return res.status(502).json({ error: "AI service unavailable" });
  }
});

app.listen(PORT, () => {
  console.log(`[forge-backend] listening on http://localhost:${PORT}`);
});

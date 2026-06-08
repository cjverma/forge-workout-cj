import { timingSafeEqual } from "crypto";

export const HARD_RULES = [
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

export function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

export function checkAuth(req, res) {
  const token = process.env.FORGE_API_TOKEN;
  if (!token) {
    res.status(500).json({ error: "Server misconfigured: FORGE_API_TOKEN not set" });
    return false;
  }
  const header = req.headers["authorization"] || "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
  let valid = false;
  try {
    const a = Buffer.from(provided);
    const b = Buffer.from(token);
    valid = a.length === b.length && timingSafeEqual(a, b);
  } catch { valid = false; }
  if (!valid) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

function extractText(data) {
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

export async function callOpenAI({ system, user, maxOutputTokens = 1000 }) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("Missing OPENAI_API_KEY");

  const model = process.env.OPENAI_MODEL || "gpt-4o";
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, instructions: system, input: user, max_output_tokens: maxOutputTokens })
  });

  const data = await response.json();
  if (!response.ok) throw new Error(data?.error?.message || "OpenAI API error");
  return extractText(data);
}

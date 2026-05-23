import { timingSafeEqual } from "crypto";

export const HARD_RULES = [
  "Never prescribe overhead press.",
  "Never prescribe standard lat pulldown.",
  "Never prescribe barbell squat, deadlift, or good mornings.",
  "Never prescribe standing loaded exercises.",
  "Never prescribe axial compression exercises.",
  "Never prescribe stairmaster.",
  "Always begin gym sessions with stationary bike.",
  "If left calf pain triggers 3 or more times, instruct user to sit and end or modify session.",
  "Core gently braced throughout exercises."
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

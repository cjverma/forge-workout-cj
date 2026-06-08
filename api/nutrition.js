import { setCors, callOpenAI } from "./_shared.js";

const SYSTEM = `You are a nutrition estimator. Respond ONLY with valid JSON — no markdown, no explanation, no code fences.
Format: {"name":"<short name>","kcal":<number>,"protein":<number>,"carbs":<number>,"fat":<number>}
All numbers are integers. Estimate realistic UK/Australian portion sizes if not specified.
If you cannot estimate (e.g. input is not food-related), respond: {"error":"could not estimate"}`;

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { text = "" } = req.body || {};
  if (!text.trim()) return res.status(400).json({ error: "No food description provided" });
  if (text.length > 400) return res.status(400).json({ error: "Description too long" });

  console.log("[nutrition] request text:", text);

  try {
    const raw = await callOpenAI({ system: SYSTEM, user: text, maxOutputTokens: 150 });
    console.log("[nutrition] raw AI response:", raw);

    let parsed;
    try {
      const clean = raw.replace(/```[a-z]*\n?/gi, "").trim();
      parsed = JSON.parse(clean);
    } catch (parseErr) {
      console.error("[nutrition] JSON parse failed:", parseErr.message, "raw:", raw);
      return res.status(502).json({ error: "AI returned invalid JSON", raw });
    }

    if (parsed.error) {
      console.log("[nutrition] AI returned error:", parsed.error);
      return res.status(422).json({ error: parsed.error });
    }

    const { name, kcal, protein, carbs, fat } = parsed;
    if (!name || kcal == null) {
      console.error("[nutrition] missing fields in parsed:", parsed);
      return res.status(502).json({ error: "Incomplete nutrition data", parsed });
    }

    console.log("[nutrition] success:", { name, kcal, protein, carbs, fat });
    return res.status(200).json({ name, kcal: Number(kcal), protein: Number(protein||0), carbs: Number(carbs||0), fat: Number(fat||0) });
  } catch (e) {
    console.error("[nutrition] callOpenAI error:", e.message);
    return res.status(502).json({ error: "AI service unavailable", detail: e.message });
  }
}

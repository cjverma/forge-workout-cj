import { setCors } from "./_shared.js";

const SYSTEM = `You are a nutrition estimator. Respond ONLY with valid JSON — no markdown, no explanation, no code fences.
Format: {"name":"<short name>","kcal":<number>,"protein":<number>,"carbs":<number>,"fat":<number>}
All numbers are integers. Estimate realistic UK/Australian portion sizes if not specified.
If the input is a full day of food, sum all items into a single JSON object with a name like "Today's meals".
If you cannot estimate, respond: {"error":"could not estimate"}`;

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { text = "" } = req.body || {};
  if (!text.trim()) return res.status(400).json({ error: "No food description provided" });
  if (text.length > 1000) return res.status(400).json({ error: "Description too long" });

  console.log("[nutrition] request:", text.slice(0, 200));

  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    console.error("[nutrition] missing OPENAI_API_KEY");
    return res.status(500).json({ error: "Server misconfigured" });
  }

  const model = process.env.OPENAI_MODEL || "gpt-4o";

  let apiRes, data;
  try {
    apiRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: "user", content: SYSTEM + "\n\nFood: " + text }
        ],
        max_completion_tokens: 300
      })
    });
    data = await apiRes.json();
  } catch (e) {
    console.error("[nutrition] fetch error:", e.message);
    return res.status(502).json({ error: "AI service unavailable" });
  }

  console.log("[nutrition] openai status:", apiRes.status);
  console.log("[nutrition] full response:", JSON.stringify(data).slice(0, 1000));
  if (!apiRes.ok) {
    console.error("[nutrition] openai error:", JSON.stringify(data?.error));
    return res.status(502).json({ error: "AI service error" });
  }

  const msg = data?.choices?.[0]?.message;
  const raw = msg?.content || msg?.refusal || "";
  console.log("[nutrition] raw:", raw, "finish_reason:", data?.choices?.[0]?.finish_reason);

  if (!raw) {
    console.error("[nutrition] empty response from AI. choices:", JSON.stringify(data?.choices));
    return res.status(502).json({ error: "Empty AI response" });
  }

  let parsed;
  try {
    const clean = raw.replace(/```[a-z]*\n?/gi, "").replace(/```/g, "").trim();
    parsed = JSON.parse(clean);
  } catch (e) {
    console.error("[nutrition] JSON parse failed:", e.message, "raw:", raw);
    return res.status(502).json({ error: "AI returned invalid JSON" });
  }

  if (parsed.error) {
    console.log("[nutrition] AI could not estimate:", parsed.error);
    return res.status(422).json({ error: parsed.error });
  }

  const { name, kcal, protein, carbs, fat } = parsed;
  if (!name || kcal == null) {
    console.error("[nutrition] missing fields:", parsed);
    return res.status(502).json({ error: "Incomplete nutrition data" });
  }

  console.log("[nutrition] success:", { name, kcal, protein, carbs, fat });
  return res.status(200).json({
    name,
    kcal: Math.round(Number(kcal)),
    protein: Math.round(Number(protein || 0)),
    carbs: Math.round(Number(carbs || 0)),
    fat: Math.round(Number(fat || 0))
  });
}

export default function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const model = process.env.OPENAI_MODEL || "gpt-4o";
  res.json({ ok: true, service: "forge-backend", model, provider: "openai" });
}

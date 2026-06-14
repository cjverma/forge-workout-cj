import { setCors, checkAuth } from "./_shared.js";

const RECIPIENT = "chiranjay.verma@gmail.com";

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!checkAuth(req, res)) return;

  const { filename, content } = req.body || {};
  if (!filename || !content) return res.status(400).json({ error: "filename and content required" });

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return res.status(503).json({ error: "Email not configured" });

  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: "FORGE <onboarding@resend.dev>",
      to: [RECIPIENT],
      subject: `FORGE Data Export — ${new Date().toISOString().slice(0, 10)}`,
      text: "Your FORGE data export is attached.",
      attachments: [{ filename, content }],
    }),
  });

  if (!r.ok) {
    const err = await r.text();
    return res.status(502).json({ error: err });
  }
  return res.status(200).json({ ok: true });
}

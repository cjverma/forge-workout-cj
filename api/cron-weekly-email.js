// Vercel Cron: runs every Monday at 12:00 UTC (8 AM Toronto, 7 AM in winter).
// Reads state from Postgres, builds the weekly report for the week that just
// ended (api/_weeklyReport.js) and emails it via Resend. No attachment: the
// user found the CSV useless, and the full detail lives in the app.
import { assembleState } from "./state.js";
import { buildWeeklyReport } from "./_weeklyReport.js";

const RECIPIENT = "chiranjay.verma@gmail.com";

async function fetchState() {
  try {
    return await assembleState();
  } catch (e) {
    console.error("[cron-weekly-email] assembleState failed:", e.message);
    return null;
  }
}

export default async function handler(req, res) {
  // Vercel cron endpoints are publicly routable. Vercel sends
  // `Authorization: Bearer ${CRON_SECRET}` with scheduled invocations when the
  // CRON_SECRET env var is set — require it so outsiders can't trigger DB
  // reads + Resend sends at will. Also accept the app's own FORGE_API_TOKEN
  // so the email can still be triggered manually from an authenticated client.
  const auth = req.headers["authorization"] || "";
  const provided = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const cronSecret = process.env.CRON_SECRET;
  const appToken = process.env.FORGE_API_TOKEN;
  const ok = (cronSecret && provided === cronSecret) || (appToken && provided === appToken);
  if (!ok) return res.status(401).json({ error: "Unauthorized" });

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return res.status(503).json({ error: "RESEND_API_KEY not set" });

  const S = await fetchState();
  if (!S) return res.status(503).json({ error: "No synced state found — sync from the app first" });

  const rep = buildWeeklyReport({ state: S });
  const date = new Date().toISOString().slice(0, 10);

  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: "FORGE <onboarding@resend.dev>",
      to: [RECIPIENT],
      subject: rep.subject,
      html: rep.html,
      text: rep.text,
    }),
  });

  if (!r.ok) {
    const err = await r.text();
    console.error("[cron-weekly-email] Resend error:", err);
    return res.status(502).json({ error: err });
  }
  return res.status(200).json({ ok: true, date });
}

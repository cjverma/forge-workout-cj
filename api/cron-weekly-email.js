// Vercel Cron: runs every Sunday at 20:00 UTC (~1:30 AM IST Monday)
// Reads state from Upstash Redis, builds CSV, emails to recipient via Resend.

const RECIPIENT = "chiranjay.verma@gmail.com";
const SYNC_KEY = process.env.SYNC_KEY || "forge:state";

function kvCfg() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url, token } : null;
}

async function fetchState() {
  const kv = kvCfg();
  if (!kv) return null;
  const r = await fetch(`${kv.url}/get/${SYNC_KEY}`, {
    headers: { authorization: `Bearer ${kv.token}` },
  });
  const d = await r.json();
  if (!d.result) return null;
  try {
    const parsed = JSON.parse(d.result);
    return parsed.state || null;
  } catch {
    return null;
  }
}

function buildCSV(S) {
  const rows = [];

  rows.push("=== WORKOUTS ===", "Date,Exercise,Set,Weight(kg),Reps");
  for (const [dayKey, exMap] of Object.entries(S.sessions || {})) {
    // dayKey format: "Monday_2026W24" — extract date from week key
    const wkMatch = dayKey.match(/(\d{4})W(\d{2})$/);
    const dayName = dayKey.split("_")[0];
    let date = "";
    if (wkMatch) {
      const [, year, week] = wkMatch;
      const jan4 = new Date(Date.UTC(Number(year), 0, 4));
      const mon = new Date(jan4);
      mon.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() + 6) % 7) + (Number(week) - 1) * 7);
      const days = ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"];
      const idx = days.indexOf(dayName);
      if (idx >= 0) { mon.setUTCDate(mon.getUTCDate() + idx); date = mon.toISOString().slice(0, 10); }
    }
    for (const [exId, ed] of Object.entries(exMap)) {
      if (!ed || !ed.sets) continue;
      (ed.sets || []).forEach((s, i) => {
        if (s.weight || s.reps) rows.push(`${date},${exId},${i + 1},${s.weight || ""},${s.reps || ""}`);
      });
    }
  }
  rows.push("");

  rows.push("=== NUTRITION ===", "Date,Item,kcal,Protein(g),Carbs(g),Fat(g),Fibre(g),Sugar(g),Sodium(mg)");
  for (const [date, day] of Object.entries(S.nutrition?.days || {})) {
    for (const item of (day.items || [])) {
      rows.push(`${date},${String(item.name || "").replace(/,/g, " ")},${item.kcal || 0},${item.protein || 0},${item.carbs || 0},${item.fat || 0},${item.fibre || 0},${item.sugar || 0},${item.sodium || 0}`);
    }
  }
  rows.push("");

  rows.push("=== WEIGHT ===", "Date,Weight(kg)");
  for (const [date, kg] of Object.entries(S.nutrition?.weights || {}).sort()) rows.push(`${date},${kg}`);
  rows.push("");

  rows.push("=== PERSONAL RECORDS ===", "ExerciseId,Weight(kg),Reps,Est1RM(kg),Date");
  for (const [exId, entries] of Object.entries(S.prs || {})) {
    for (const e of entries) rows.push(`${exId},${e.weight},${e.reps},${e.est},${e.date}`);
  }

  return rows.join("\n");
}

export default async function handler(req, res) {
  // Vercel cron requests arrive as GET with the CRON_SECRET header
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers["authorization"] !== `Bearer ${secret}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return res.status(503).json({ error: "RESEND_API_KEY not set" });

  const S = await fetchState();
  if (!S) return res.status(503).json({ error: "No synced state found — sync from the app first" });

  const csv = buildCSV(S);
  const date = new Date().toISOString().slice(0, 10);
  const filename = `forge-weekly-${date}.csv`;
  // base64-encode (Node Buffer available in Vercel serverless)
  const content = Buffer.from(csv, "utf-8").toString("base64");

  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: "FORGE <onboarding@resend.dev>",
      to: [RECIPIENT],
      subject: `FORGE Weekly Summary — ${date}`,
      text: "Your weekly FORGE data export is attached. Keep pushing! 💪",
      attachments: [{ filename, content }],
    }),
  });

  if (!r.ok) {
    const err = await r.text();
    console.error("[cron-weekly-email] Resend error:", err);
    return res.status(502).json({ error: err });
  }
  return res.status(200).json({ ok: true, date });
}

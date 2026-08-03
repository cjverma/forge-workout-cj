// Vercel Cron: runs every Sunday at 20:00 UTC (~1:30 AM IST Monday)
// Reads state from Postgres, builds CSV, emails to recipient via Resend.
import { assembleState } from "./state.js";
import { EX_DB, PROG_V1, PROG_V2, PROG_V3, PROG_V4, PR_ALIAS, prSlug, kg1 } from "../src/constants.js";

const RECIPIENT = "chiranjay.verma@gmail.com";

// Built from the programs themselves, not hand-maintained. The old literal was
// keyed by day-prefixed ids (m_cp, t2_scr) and had 166 entries, none of them
// from V4 and none of them name-slugs. S.prs was migrated to name-slug keys
// long ago, so every lookup missed and the CSV fell through to the raw key,
// emailing slugs like "outer_thigh_machine" as the exercise name.
const EX_NAMES = (() => {
  const out = {};
  const put = (k, v) => { if (k && !out[k]) out[k] = v; };
  // Current program first so a renamed exercise wins over its legacy name.
  for (const P of [PROG_V4, PROG_V3, PROG_V2, PROG_V1]) {
    for (const day of Object.values(P)) {
      for (const ex of (day.exercises || [])) {
        put(ex.id, ex.name);
        const raw = prSlug(ex.name);
        put(PR_ALIAS[raw] || raw, ex.name);
      }
    }
  }
  for (const ex of EX_DB) {
    const raw = prSlug(ex.name);
    put(PR_ALIAS[raw] || raw, ex.name);
  }
  return out;
})();

// Mirrors prName() in src/main.js. The de-slug fallback is what guarantees a
// readable label for ANY key, so an exercise that has left the program can
// never surface in an email or export as "tricep_extension_machine".
function exName(S, id) {
  if (!id) return "";
  const canon = PR_ALIAS[String(id).replace(/^_+|_+$/g, "")] || String(id).replace(/^_+|_+$/g, "");
  if (EX_NAMES[canon]) return EX_NAMES[canon];
  const custom = customName(S, id);
  if (custom) return custom;
  if (String(id).startsWith("c_")) return "Custom exercise";
  return String(id).replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}


function customName(S, exId) {
  for (const arr of Object.values(S.custom || {})) {
    if (!Array.isArray(arr)) continue;
    const ex = arr.find(e => e.id === exId);
    if (ex) return ex.name;
  }
  return null;
}

async function fetchState() {
  try {
    return await assembleState();
  } catch (e) {
    console.error("[cron-weekly-email] assembleState failed:", e.message);
    return null;
  }
}

function buildCSV(S) {
  const rows = [];

  rows.push("WORKOUTS", "Date,Exercise,Set,Weight(kg),Reps");
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
      const name = exName(S, exId);
      (ed.sets || []).forEach((s, i) => {
        if (s.weight || s.reps) rows.push(`${date},${name},${i + 1},${s.weight || ""},${s.reps || ""}`);
      });
    }
  }
  rows.push("");

  rows.push("NUTRITION", "Date,Item,kcal,Protein(g),Carbs(g),Fat(g),Fibre(g),Sugar(g),Sodium(mg)");
  for (const [date, day] of Object.entries(S.nutrition?.days || {})) {
    for (const item of (day.items || [])) {
      rows.push(`${date},${String(item.name || "").replace(/,/g, " ")},${item.kcal || 0},${item.protein || 0},${item.carbs || 0},${item.fat || 0},${item.fibre || 0},${item.sugar || 0},${item.sodium || 0}`);
    }
  }
  rows.push("");

  rows.push("WEIGHT", "Date,Weight(kg)");
  for (const [date, kg] of Object.entries(S.nutrition?.weights || {}).sort()) rows.push(`${date},${kg1(kg)}`);
  rows.push("");

  rows.push("PERSONAL RECORDS", "Exercise,Weight(kg),Reps,Est1RM(kg),Date");
  for (const [exId, entries] of Object.entries(S.prs || {})) {
    const name = exName(S, exId);
    for (const e of entries) rows.push(`${name},${e.weight},${e.reps},${e.est},${e.date}`);
  }

  return rows.join("\n");
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

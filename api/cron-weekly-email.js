// Vercel Cron: runs every Sunday at 20:00 UTC (~1:30 AM IST Monday)
// Reads state from Upstash Redis, builds CSV, emails to recipient via Resend.

const RECIPIENT = "chiranjay.verma@gmail.com";
const SYNC_KEY = process.env.SYNC_KEY || "forge:state";

const EX_NAMES = {
  m_bike:"Stationary Bike",m_cp:"Chest Press Machine",m_pf:"Pec Fly Machine",m_te:"Tricep Extension Machine",m_lr:"Seated Lateral Raise",m_cr:"Seated Cable Row",m_dc:"Seated Dumbbell Curl",m_fp:"Cable Face Pull",m_tr:"Treadmill Cool-Down",m_k2c:"Knee-to-Chest Stretch",m_gb:"Glute Bridge",m_bd:"Bird Dog",
  t_bike:"Stationary Bike",t_cp:"Chest Press Machine",t_pf:"Pec Fly Machine",t_te:"Tricep Extension Machine",t_lp:"Leg Press Machine",t_lc:"Seated Leg Curl",t_ha:"Hip Abduction Machine",t_sc:"Seated Calf Raise",t_tr:"Treadmill Cool-Down",t_k2c:"Knee-to-Chest Stretch",t_gb:"Glute Bridge",t_bd:"Bird Dog",
  w_bike:"Stationary Bike",w_cr:"Seated Cable Row",w_fp:"Cable Face Pull",w_dc:"Seated Dumbbell Curl",w_lp:"Leg Press Machine",w_lc:"Seated Leg Curl",w_ha:"Hip Abduction Machine",w_sc:"Seated Calf Raise",w_tr:"Treadmill Cool-Down",w_k2c:"Knee-to-Chest Stretch",w_gb:"Glute Bridge",w_bd:"Bird Dog",w_dbg:"Dead Bug",w_hf:"Hip Flexor Stretch",w_cc:"Cat-Cow",w_nf:"Nerve Floss Left Leg",
  th_bike:"Stationary Bike",th_cp:"Chest Press Machine",th_pf:"Pec Fly Machine",th_te:"Tricep Extension Machine",th_lr:"Seated Lateral Raise",th_cr:"Seated Cable Row",th_dc:"Seated Dumbbell Curl",th_fp:"Cable Face Pull",th_tr:"Treadmill Cool-Down",th_k2c:"Knee-to-Chest Stretch",th_gb:"Glute Bridge",th_bd:"Bird Dog",
  f_bike:"Stationary Bike",f_cp:"Chest Press Machine",f_pf:"Pec Fly Machine",f_te:"Tricep Extension Machine",f_lp:"Leg Press Machine",f_lc:"Seated Leg Curl",f_ha:"Hip Abduction Machine",f_sc:"Seated Calf Raise",f_tr:"Treadmill Cool-Down",f_k2c:"Knee-to-Chest Stretch",f_gb:"Glute Bridge",f_bd:"Bird Dog",
  sa_bike:"Stationary Bike",sa_cr:"Seated Cable Row",sa_fp:"Cable Face Pull",sa_dc:"Seated Dumbbell Curl",sa_lp:"Leg Press Machine",sa_lc:"Seated Leg Curl",sa_ha:"Hip Abduction Machine",sa_sc:"Seated Calf Raise",sa_tw:"Treadmill Walk",sa_k2c:"Knee-to-Chest Stretch",sa_gb:"Glute Bridge",sa_bd:"Bird Dog",sa_dbg:"Dead Bug",sa_hf:"Hip Flexor Stretch",sa_cc:"Cat-Cow",sa_nf:"Nerve Floss Left Leg",
  su_k2c:"Knee-to-Chest Stretch",su_gb:"Glute Bridge",su_bd:"Bird Dog",su_dbg:"Dead Bug",su_hf:"Hip Flexor Stretch",su_cc:"Cat-Cow",su_nf:"Nerve Floss Left Leg",
  m2_bike:"Stationary Bike",m2_cp:"Chest Press Machine",m2_icp:"Incline Chest Press",m2_pf:"Pec Fly Machine",m2_lr:"Seated Lateral Raise",m2_rdf:"Rear Delt Fly",m2_fp:"Cable Face Pull",m2_tcp:"Tricep Cable Pushdown",m2_tr:"Treadmill Cool-Down",m2_k2c:"Knee-to-Chest Stretch",m2_gb:"Glute Bridge",m2_bd:"Bird Dog",
  t2_bike:"Stationary Bike",t2_scr:"Seated Cable Row",t2_csr:"Chest Supported Row",t2_sap:"Seated Arnold Press",t2_tex:"Tricep Extension",t2_tcp:"Tricep Cable Pushdown",t2_sdc:"Seated Dumbbell Curl",t2_hc:"Hammer Curl",t2_tr:"Treadmill Cool-Down",t2_k2c:"Knee-to-Chest Stretch",t2_gb:"Glute Bridge",t2_bd:"Bird Dog",
  w2_bike:"Stationary Bike",w2_lp:"Leg Press Machine",w2_lc:"Seated Leg Curl",w2_ha:"Hip Abduction Machine",w2_le:"Leg Extension",w2_sc:"Seated Calf Raise",w2_pp:"Leg Press (Partial)",w2_hiad:"Hi-Ad Machine",w2_tr:"Treadmill Cool-Down",w2_k2c:"Knee-to-Chest Stretch",w2_gb:"Glute Bridge",w2_bd:"Bird Dog",w2_dbg:"Dead Bug",w2_hf:"Hip Flexor Stretch",w2_cc:"Cat-Cow",w2_nf:"Nerve Floss Left Leg",
  th2_bike:"Stationary Bike",th2_icp:"Incline Chest Press",th2_cp:"Chest Press Machine",th2_pf:"Pec Fly Machine",th2_slr:"Seated Lateral Raise",th2_rdf:"Rear Delt Fly",th2_fp:"Cable Face Pull",th2_tr:"Treadmill Cool-Down",th2_k2c:"Knee-to-Chest Stretch",th2_gb:"Glute Bridge",th2_bd:"Bird Dog",
  f2_bike:"Stationary Bike",f2_lcr:"Low Cable Row",f2_ngld:"Neutral Grip Lat",f2_csr:"Chest Supported Row",f2_hc:"Hammer Curl",f2_bc:"Barbell Curl",f2_tcpr:"Tricep Cable Pushdown",f2_tr:"Treadmill Cool-Down",f2_k2c:"Knee-to-Chest Stretch",f2_gb:"Glute Bridge",f2_bd:"Bird Dog",
  sa2_bike:"Stationary Bike",sa2_lp:"Leg Press Machine",sa2_glk:"Glute Kickback Machine",sa2_sc:"Seated Calf Raise",sa2_lc:"Seated Leg Curl",sa2_ha:"Hip Abduction Machine",sa2_pp:"Leg Press (Partial)",sa2_hiad:"Hi-Ad Machine",sa2_tw:"Treadmill Walk",sa2_k2c:"Knee-to-Chest Stretch",sa2_gb:"Glute Bridge",sa2_bd:"Bird Dog",sa2_dbg:"Dead Bug",sa2_hf:"Hip Flexor Stretch",sa2_cc:"Cat-Cow",sa2_nf:"Nerve Floss Left Leg",
  su2_k2c:"Knee-to-Chest Stretch",
};

function kvCfg() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url, token } : null;
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
      const name = EX_NAMES[exId] || customName(S, exId) || exId;
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
  for (const [date, kg] of Object.entries(S.nutrition?.weights || {}).sort()) rows.push(`${date},${kg}`);
  rows.push("");

  rows.push("PERSONAL RECORDS", "Exercise,Weight(kg),Reps,Est1RM(kg),Date");
  for (const [exId, entries] of Object.entries(S.prs || {})) {
    const name = EX_NAMES[exId] || (S.custom?.[exId]?.name) || exId;
    for (const e of entries) rows.push(`${name},${e.weight},${e.reps},${e.est},${e.date}`);
  }

  return rows.join("\n");
}

export default async function handler(req, res) {
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

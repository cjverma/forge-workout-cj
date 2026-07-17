import { setCors, checkAuth } from "./_shared.js";
import { sql, ensureSchema } from "./db.js";

const KNOWN_FIELDS = new Set(["date", "active", "resting", "weightKg"]);

let testSql = null;
export function __setHealthKitSqlForTests(fn) {
  testSql = fn;
}

export function __resetHealthKitSqlForTests() {
  testSql = null;
}

function todayToronto() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Toronto" });
}

function validDate(date) {
  return typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date);
}

function numberInRange(value, min, max) {
  if (value == null) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return n;
}

export function normalizeHealthKitPayload(body = {}, fallbackDate = todayToronto()) {
  const errors = [];
  const ignored = Object.keys(body).filter(k => !KNOWN_FIELDS.has(k));
  const date = body.date == null || body.date === "" ? fallbackDate : body.date;
  if (!validDate(date)) errors.push("date must be YYYY-MM-DD");

  const active = numberInRange(body.active, 0, 6000);
  const resting = numberInRange(body.resting, 200, 6000);
  const weightKg = numberInRange(body.weightKg, 30, 300);

  if (active === null) errors.push("active must be 0-6000");
  if (resting === null) errors.push("resting must be 200-6000");
  if (weightKg === null) errors.push("weightKg must be 30-300");

  const applied = {};
  if (active !== undefined && active !== null) applied.active = active;
  if (resting !== undefined && resting !== null) applied.resting = resting;
  if (weightKg !== undefined && weightKg !== null) applied.weightKg = weightKg;
  const anyProvided = body.active != null || body.resting != null || body.weightKg != null;
  if (!anyProvided) errors.push("at least one metric is required");

  return { ok: errors.length === 0, date, applied, ignored, errors };
}

function dayMetaUpsertSql({ date, active, resting }) {
  const cols = ["date"];
  const vals = [date];
  const updates = [];

  if (active !== undefined) {
    cols.push("active");
    vals.push(active);
    updates.push("active=EXCLUDED.active");
  }
  if (resting !== undefined) {
    cols.push("resting_override");
    vals.push(resting);
    updates.push("resting_override=EXCLUDED.resting_override");
  }

  if (!updates.length) return null;
  return {
    text: `INSERT INTO nutrition_day_meta(${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}) ON CONFLICT (date) DO UPDATE SET ${updates.join(", ")}`,
    values: vals
  };
}

export function buildHealthKitSql(payload) {
  const statements = [];
  const dayMeta = dayMetaUpsertSql({
    date: payload.date,
    active: payload.applied.active,
    resting: payload.applied.resting
  });
  if (dayMeta) statements.push(dayMeta);
  if (payload.applied.weightKg !== undefined) {
    statements.push({
      text: "INSERT INTO weights(date, kg, updated_at) VALUES ($1, $2, now()) ON CONFLICT (date) DO UPDATE SET kg=EXCLUDED.kg, updated_at=now()",
      values: [payload.date, payload.applied.weightKg]
    });
  }
  return statements;
}

async function applyHealthKitPayload(q, payload) {
  for (const st of buildHealthKitSql(payload)) {
    // Neon v1+ only accepts tagged-template calls or .query(text, params) —
    // a bare q(text, params) throws at runtime. (Test stubs may be plain fns.)
    if (typeof q.query === "function") await q.query(st.text, st.values);
    else await q(st.text, st.values);
  }
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!checkAuth(req, res)) return;

  const parsed = normalizeHealthKitPayload(req.body || {});
  if (!parsed.ok) return res.status(400).json({ error: parsed.errors.join("; ") });

  try {
    if (!testSql) await ensureSchema();
    const q = testSql || sql();
    await applyHealthKitPayload(q, parsed);
    return res.status(200).json({ ok: true, date: parsed.date, applied: parsed.applied });
  } catch (e) {
    console.error("[healthkit]", e.message);
    return res.status(502).json({ error: "HealthKit sync failed" });
  }
}

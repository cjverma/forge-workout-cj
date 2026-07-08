import { neon } from "@neondatabase/serverless";

// Vercel sets VERCEL_ENV to "production" | "preview" | "development" on its
// platform; it's undefined when running locally (node server.js).
// Preview deployments — every feature branch, including keen-ritchie — must
// NEVER fall back to the production DATABASE_URL. That would mean testing on
// a branch silently reads/writes real production data. A dedicated
// DATABASE_URL_PREVIEW is required for preview/dev; if it's missing, this
// throws instead of guessing, so misconfiguration fails loudly instead of
// quietly corrupting production data.
function resolveDatabaseUrl() {
  const env = process.env.VERCEL_ENV;
  if (env === "preview" || env === "development") {
    return process.env.DATABASE_URL_PREVIEW || null;
  }
  return process.env.DATABASE_URL || null; // production, or local dev
}

let _sql = null;
export function sql() {
  if (!_sql) {
    const url = resolveDatabaseUrl();
    if (!url) {
      const env = process.env.VERCEL_ENV;
      throw new Error(
        env === "preview" || env === "development"
          ? "DATABASE_URL_PREVIEW not configured — refusing to fall back to the production DATABASE_URL on a non-production deployment"
          : "DATABASE_URL not configured"
      );
    }
    _sql = neon(url);
  }
  return _sql;
}

// Idempotent — safe to call on every cold start. CREATE TABLE IF NOT EXISTS is cheap.
export async function ensureSchema() {
  const q = sql();
  await q`CREATE TABLE IF NOT EXISTS sessions(
    session_key text NOT NULL,
    ex_id text NOT NULL,
    done boolean DEFAULT false,
    skipped boolean DEFAULT false,
    unit text,
    sets jsonb DEFAULT '[]',
    updated_at timestamptz DEFAULT now(),
    PRIMARY KEY(session_key, ex_id)
  )`;
  await q`CREATE TABLE IF NOT EXISTS session_meta(
    session_key text PRIMARY KEY,
    calf_twinges jsonb DEFAULT '[]',
    notes text,
    duration numeric,
    stopped boolean,
    updated_at timestamptz DEFAULT now()
  )`;
  await q`ALTER TABLE session_meta ADD COLUMN IF NOT EXISTS duration numeric`;
  await q`ALTER TABLE session_meta ADD COLUMN IF NOT EXISTS stopped boolean`;
  await q`CREATE TABLE IF NOT EXISTS nutrition_items(
    id serial PRIMARY KEY,
    client_id text,
    date date NOT NULL,
    name text, kcal numeric, protein numeric, carbs numeric,
    fat numeric, fibre numeric, sugar numeric, sodium numeric,
    time text, canonical text,
    created_at timestamptz DEFAULT now()
  )`;
  await q`ALTER TABLE nutrition_items ADD COLUMN IF NOT EXISTS client_id text`;
  await q`CREATE TABLE IF NOT EXISTS nutrition_day_meta(
    date date PRIMARY KEY,
    active numeric,
    resting_override numeric,
    shock boolean
  )`;
  await q`ALTER TABLE nutrition_day_meta ADD COLUMN IF NOT EXISTS shock boolean`;
  await q`CREATE TABLE IF NOT EXISTS weights(
    date date PRIMARY KEY,
    kg numeric NOT NULL,
    updated_at timestamptz DEFAULT now()
  )`;
  await q`CREATE TABLE IF NOT EXISTS prs(
    id serial PRIMARY KEY,
    exercise_id text NOT NULL,
    date date NOT NULL,
    weight numeric, reps int, est numeric,
    created_at timestamptz DEFAULT now()
  )`;
  await q`CREATE TABLE IF NOT EXISTS custom_exercises(
    id text PRIMARY KEY,
    day_name text NOT NULL,
    name text, cat text, sets int, reps text,
    hint text, url text, cue text, muscles jsonb DEFAULT '[]'
  )`;
  await q`CREATE TABLE IF NOT EXISTS week_plan_updates(
    id serial PRIMARY KEY,
    week_key text NOT NULL,
    day_name text NOT NULL,
    update jsonb NOT NULL,
    created_at timestamptz DEFAULT now()
  )`;
  await q`CREATE TABLE IF NOT EXISTS milestones(
    id int PRIMARY KEY DEFAULT 1,
    shown_protein7 jsonb DEFAULT '[]',
    shown_weight5kg jsonb DEFAULT '[]',
    shown_week6 jsonb DEFAULT '[]',
    longest_streak int DEFAULT 0
  )`;
  await q`CREATE TABLE IF NOT EXISTS ai_chat(
    id serial PRIMARY KEY,
    role text, content text,
    created_at timestamptz DEFAULT now()
  )`;
  await q`CREATE TABLE IF NOT EXISTS app_settings(
    id int PRIMARY KEY DEFAULT 1,
    theme text,
    ai_deficit_modifier numeric DEFAULT 0,
    weekly_snapshots jsonb DEFAULT '[]',
    weekly_verdict jsonb,
    demo_cache jsonb DEFAULT '{}',
    demo_cache_v text,
    last_backup timestamptz
  )`;
  await q`INSERT INTO milestones(id) VALUES (1) ON CONFLICT (id) DO NOTHING`;
  await q`INSERT INTO app_settings(id) VALUES (1) ON CONFLICT (id) DO NOTHING`;
}

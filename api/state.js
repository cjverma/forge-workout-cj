import { setCors, checkAuth } from "./_shared.js";
import { sql, ensureSchema } from "./db.js";

export async function assembleState() {
  await ensureSchema();
  const q = sql();

  const [sessRows, metaRows, itemRows, dayMetaRows, weightRows, prRows,
    customRows, planRows, milestoneRows, chatRows, settingsRows] = await Promise.all([
    q`SELECT session_key, ex_id, done, skipped, unit, sets FROM sessions`,
    q`SELECT session_key, calf_twinges, notes FROM session_meta`,
    q`SELECT id, client_id, date, name, kcal, protein, carbs, fat, fibre, sugar, sodium, time, canonical FROM nutrition_items ORDER BY id`,
    q`SELECT date, active, resting_override FROM nutrition_day_meta`,
    q`SELECT date, kg FROM weights`,
    q`SELECT exercise_id, date, weight, reps, est FROM prs ORDER BY id`,
    q`SELECT id, day_name, name, cat, sets, reps, hint, url, cue, muscles FROM custom_exercises`,
    q`SELECT week_key, day_name, update FROM week_plan_updates ORDER BY id`,
    q`SELECT shown_protein7, shown_weight5kg, shown_week6, longest_streak FROM milestones WHERE id=1`,
    q`SELECT role, content FROM ai_chat ORDER BY id`,
    q`SELECT theme, ai_deficit_modifier, weekly_snapshots, weekly_verdict, demo_cache, demo_cache_v, last_backup FROM app_settings WHERE id=1`
  ]);

  const sessions = {};
  for (const r of sessRows) {
    (sessions[r.session_key] ??= {})[r.ex_id] = { done: r.done, skipped: r.skipped, unit: r.unit || undefined, sets: r.sets || [] };
  }
  for (const r of metaRows) {
    (sessions[r.session_key] ??= {})._calfTwinges = r.calf_twinges || [];
    if (r.notes) sessions[r.session_key]._notes = r.notes;
  }

  const days = {};
  for (const r of itemRows) {
    const d = r.date.toISOString ? r.date.toISOString().slice(0, 10) : r.date;
    (days[d] ??= { items: [] }).items.push({
      id: r.client_id || String(r.id), name: r.name, kcal: r.kcal, protein: r.protein, carbs: r.carbs,
      fat: r.fat, fibre: r.fibre, sugar: r.sugar, sodium: r.sodium, time: r.time, canonical: r.canonical
    });
  }
  for (const r of dayMetaRows) {
    const d = r.date.toISOString ? r.date.toISOString().slice(0, 10) : r.date;
    days[d] ??= { items: [] };
    if (r.active != null) days[d].active = Number(r.active);
    if (r.resting_override != null) days[d].restingOverride = Number(r.resting_override);
  }
  const weights = {};
  for (const r of weightRows) {
    const d = r.date.toISOString ? r.date.toISOString().slice(0, 10) : r.date;
    weights[d] = Number(r.kg);
  }

  const prs = {};
  for (const r of prRows) {
    (prs[r.exercise_id] ??= []).push({
      date: r.date.toISOString ? r.date.toISOString().slice(0, 10) : r.date,
      weight: Number(r.weight), reps: r.reps, est: Number(r.est)
    });
  }

  const custom = {};
  for (const r of customRows) {
    (custom[r.day_name] ??= []).push({
      id: r.id, name: r.name, cat: r.cat, sets: r.sets, reps: r.reps,
      hint: r.hint, url: r.url, cue: r.cue, muscles: r.muscles || [], custom: true
    });
  }

  const weekPlans = {};
  for (const r of planRows) {
    ((weekPlans[r.week_key] ??= {})[r.day_name] ??= []).push(r.update);
  }

  const m = milestoneRows[0] || {};
  const milestones = {
    shownProtein7: m.shown_protein7 || [],
    shownWeight5kg: m.shown_weight5kg || [],
    shownWeek6: m.shown_week6 || [],
    longestStreak: m.longest_streak || 0
  };

  const aiChat = chatRows.map(r => ({ role: r.role, content: r.content }));

  const s = settingsRows[0] || {};
  return {
    sessions, custom, weekPlans, prs, milestones, aiChat,
    nutrition: {
      days, weights,
      aiDeficitModifier: s.ai_deficit_modifier != null ? Number(s.ai_deficit_modifier) : 0,
      weeklySnapshots: s.weekly_snapshots || [],
      weeklyVerdict: s.weekly_verdict || undefined
    },
    theme: s.theme || undefined,
    demoCache: s.demo_cache || {},
    demoCacheV: s.demo_cache_v || undefined,
    _lastBackup: s.last_backup ? new Date(s.last_backup).getTime() : undefined
  };
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (!checkAuth(req, res)) return;
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  try {
    const state = await assembleState();
    return res.json({ state, updatedAt: Date.now() });
  } catch (e) {
    console.error("[state]", e.message);
    return res.status(502).json({ error: "Failed to load state: " + e.message });
  }
}

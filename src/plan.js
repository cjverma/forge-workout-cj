// Everything the weekly plan needs, shared by the app (Generate / Sunday
// auto-plan) and the server cron (api/cron-weekly-plan.js) so the plan is
// produced even when the app is never opened. Pure functions of the state S:
// no ctx, no DOM, no localStorage, so they run in Node as well.
import { programFor, programKeyFor, PROG_NAME, prSlug, PR_ALIAS, kg1, weekKeyOf, GYM, DAYS } from "./constants.js";
import { USER, isoDate } from "./phase.js";

// Private names: every src file is inlined into ONE script, so these must not
// collide with workout.js's LB_TO_KG / toKg.
const PLAN_LB_TO_KG = 0.45359237;
const planToKg = (w, unit) => { const n = Number(w); if (!Number.isFinite(n)) return null; return unit === "lbs" ? Math.round(n * PLAN_LB_TO_KG * 10) / 10 : n; };
// Fallback canonical id for a program exercise when the app's name map is not
// available (server): strip the day prefix. PR lookup is by name-slug first.
const planStripPrefix = id => String(id).replace(/^(?:su|sa|th|[mtwf])\d?_/, "");

// The week a plan is FOR: on Monday the week just starting, otherwise the
// coming Monday (Sunday -> tomorrow).
export function planMonFor(now = new Date()) {
  const d = new Date(now); d.setHours(0, 0, 0, 0);
  const dow = d.getDay();
  if (dow !== 1) d.setDate(d.getDate() + (dow === 0 ? 1 : 8 - dow));
  return d;
}

// Spine safety net: never trust the AI with these.
export const BANNED_EX = [
  /overhead/i, /military/i, /shoulder\s*press/i, /arnold/i, /push\s*press/i,
  /\bsquat\b/i, /deadlift/i, /good\s*morning/i, /\blunge/i, /split\s*squat/i,
  /step[\s-]?up/i, /stair/i, /box\s*jump/i, /\bjump/i, /burpee/i,
  /\bstanding\b/i, /upright\s*row/i, /barbell\s*row/i, /bent[\s-]?over/i,
  /\bclean\b/i, /snatch/i, /thruster/i, /farmer/i, /\bcarr(y|ies)\b/i, /\brunning?\b/i
];
export function isBannedExercise(name) {
  const n = String(name || "");
  if (/lat\s*pulldown/i.test(n) && !/neutral|close/i.test(n)) return true;
  return BANNED_EX.some(rx => rx.test(n));
}

// planMon is midnight in the RUNTIME's zone. isoDate() converts to Toronto,
// which on the UTC server turns "Monday 00:00" into Sunday evening. Format the
// calendar date the Date was built for instead.
const planYmd = d => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");

function planWeekLabel(weekKey) {
  const m = /(\d{4})W(\d+)/.exec(weekKey); if (!m) return weekKey;
  const yr = +m[1], wn = +m[2], jan1 = new Date(yr, 0, 1), dow = jan1.getDay() || 7;
  return planYmd(new Date(yr, 0, 1 + (wn - 1) * 7 - (dow - 1)));
}

// Set-to-set trend at one weight: how far reps fell from the first to the last
// set at the most-used weight. Big drop = load at the limit; none = too light.
//
// Weight dropped from set to set (60, 55, 50) is a different signal, in the
// user's words: "drop means I'm not able to work hard and the first set wasn't
// right". The opening weight was too heavy to hold for the programmed sets, so
// it is NOT a working weight to progress from. Flagged as pattern:"descending"
// with the weight you could hold the most reps at, so the AI starts lower.
export function setFatigue(sets) {
  const kgs = sets.map((s) => Number(s.kg)), reps0 = sets.map((s) => Number(s.reps) || 0);
  if (sets.length >= 2 && kgs.every((k, i) => i === 0 || k < kgs[i - 1])) {
    return { pattern: "descending", weights: kgs, reps: reps0, topKg: kgs[0], lastKg: kgs[kgs.length - 1],
      weightDropPct: kgs[0] ? Math.round((kgs[0] - kgs[kgs.length - 1]) / kgs[0] * 100) : 0,
      repsFellToo: reps0[reps0.length - 1] < reps0[0] };
  }
  const by = {};
  for (const s of sets) { const k = String(s.kg); (by[k] ??= []).push(Number(s.reps) || 0); }
  const top = Object.entries(by).sort((a, b) => b[1].length - a[1].length || Number(b[0]) - Number(a[0]))[0];
  if (!top || top[1].length < 2) return null;
  const reps = top[1], first = reps[0], last = reps[reps.length - 1];
  return { kg: Number(top[0]), reps, first, last, repDropPct: first ? Math.round((first - last) / first * 100) : 0 };
}

export function buildSessionHistory(S, now = new Date(), maxWeeks = 4) {
  const prog = programFor(now), history = [];
  for (let w = 0; w < maxWeeks; w++) {
    const d = new Date(now); d.setDate(d.getDate() - w * 7);
    const weekKey = weekKeyOf(d);
    const weekData = { weekKey, weekLabel: planWeekLabel(weekKey), sessions: {}, sessionDurationMin: {}, sessionNotes: {} };
    let hasData = false;
    for (const [day, dayData] of Object.entries(prog)) {
      const sessData = (S.sessions || {})[day + "_" + weekKey];
      if (!sessData) continue;
      // The user's own words about a session (pain, a busy or broken machine,
      // how a lift felt, a change they want). Sent for EVERY week, and even on
      // a day with nothing logged: it used to be this week only, and only on
      // days with logged exercises, so most notes never reached the AI.
      const note = String(sessData._notes || "").trim();
      const twinges = (sessData._calfTwinges || []).filter(Number.isFinite).length;
      if (note || twinges) { weekData.sessionNotes[day] = { note: note || null, calfTwinges: twinges }; hasData = true; }
      const exs = [];
      for (const ex of (dayData.exercises || [])) {
        const ed = sessData[ex.id];
        if (!ed) continue;
        // Always kg: the hint the AI writes back is kg, and a 120 lbs set read
        // as 120 kg got "progressed" to a weight never lifted.
        const setsDone = (ed.sets || []).filter(s => s.done).map(s => ({ kg: planToKg(s.weight, ed.unit), reps: s.reps })).filter(s => s.kg != null);
        if (setsDone.length || ed.done || ed.skipped) {
          exs.push({ id: ex.id, name: ex.name, target_sets: ex.sets, target_reps: ex.reps, current_hint: ex.hint, sets_logged: setsDone, fatigue: setFatigue(setsDone), completed: !!ed.done, skipped: !!ed.skipped });
          hasData = true;
        }
      }
      if (exs.length) {
        weekData.sessions[day] = exs;
        if (sessData._duration) weekData.sessionDurationMin[day] = Math.round(sessData._duration / 60);
      }
    }
    if (hasData) history.push(weekData);
  }
  return history;
}

// Built from the week being PLANNED (planMon), never today's program: on a
// program boundary today's ids match none of next week's.
export function buildApprovedExercises(planMon) {
  const seen = new Set(), list = [];
  for (const [, dayData] of Object.entries(programFor(planMon))) for (const ex of (dayData.exercises || [])) {
    if (ex.cat === "cardio" || ex.cat === "physio") continue;
    const key = ex.name.toLowerCase().trim();
    if (seen.has(key)) continue;
    seen.add(key);
    list.push({ name: ex.name, muscles: ex.muscles || [], hint: ex.hint || "" });
  }
  return list;
}

// Rest days are sent with rest:true, never dropped, or the AI schedules work.
export function buildPlanSnapshot(planMon) {
  const snap = {};
  for (const [day, dayData] of Object.entries(programFor(planMon))) {
    const exs = dayData.exercises || [];
    snap[day] = { label: dayData.label, rest: !exs.some(e => e.cat === "gym"),
      exercises: exs.map(ex => ({ id: ex.id, name: ex.name, cat: ex.cat, sets: ex.sets, reps: ex.reps, hint: ex.hint, muscles: ex.muscles || [] })) };
  }
  return snap;
}

// Best lift per gym exercise in the planned week, joined by the plan's id AND
// the canonical PR slug (S.prs is keyed by name-slug). Always kg.
export function buildPRRecords(S, planMon, todayIso, canonicalId = planStripPrefix) {
  const prs = S.prs || {}, today = new Date(todayIso + "T00:00:00").getTime(), out = [], seen = new Set();
  for (const [, dayData] of Object.entries(programFor(planMon))) for (const ex of (dayData.exercises || [])) {
    if (ex.cat !== "gym") continue;
    const raw = prSlug(ex.name), slug = PR_ALIAS[raw] || raw;
    if (seen.has(slug)) continue;
    seen.add(slug);
    const entries = prs[slug] || prs[canonicalId(ex.id)] || [];
    if (!entries.length) { out.push({ id: ex.id, name: ex.name, slug, hasPR: false }); continue; }
    const best = entries.reduce((b, e) => e.est > b.est ? e : b, entries[0]);
    const days = Math.round((today - new Date(best.date + "T00:00:00").getTime()) / 86400000);
    out.push({ id: ex.id, name: ex.name, slug, hasPR: true, bestKg: kg1(best.weight), reps: best.reps, est1RM: best.est, date: best.date, daysAgo: days, setThisWeek: days <= 7, prCount: entries.length });
  }
  return out;
}

export function buildProgramMeta(planMon) {
  const prog = programFor(planMon);
  const rest = Object.keys(prog).filter(d => !(prog[d].exercises || []).some(e => e.cat === "gym"));
  return { name: PROG_NAME[programKeyFor(planMon)] || "current program", version: programKeyFor(planMon), weekStarting: planYmd(planMon), restDays: rest, trainingDays: Object.keys(prog).filter(d => !rest.includes(d)) };
}

// The full request body for /api/weekly-plan (and the cron).
export function buildPlanPayload(S, { now = new Date(), canonicalId } = {}) {
  const planMon = planMonFor(now), todayIso = isoDate(now), ws = (S.nutrition || {}).weights || {};
  return {
    sessionHistory: buildSessionHistory(S, now, 4),
    profile: {
      equipment: GYM, program: buildProgramMeta(planMon), currentPlan: buildPlanSnapshot(planMon),
      prs: buildPRRecords(S, planMon, todayIso, canonicalId), approvedExercises: buildApprovedExercises(planMon),
      weightLog: Object.keys(ws).sort().slice(-8).map(d => ({ date: d, kg: ws[d] })),
      goal: { targetKg: USER.targetKg, byDate: isoDate(USER.goalDate) }
    }
  };
}

export function sanitizePlan(parsed) {
  const stripped = [];
  for (const [day, exs] of Object.entries(parsed.week_plan || {})) {
    if (!Array.isArray(exs)) continue;
    parsed.week_plan[day] = exs.filter(e => { if (e && e.action === "add" && isBannedExercise(e.name)) { stripped.push(e.name); return false; } return true; });
  }
  if (stripped.length) { parsed.flags = parsed.flags || []; parsed.flags.unshift("Blocked unsafe AI suggestions (spine rules): " + stripped.join(", ")); }
  return parsed;
}

// The AI's week_plan as the stored per-day update lists for the planned week,
// validated against THAT week's program: updates and removes only for ids that
// exist in it, adds kept whole. Same rules applyPendingPlan uses in the app.
export function planToUpdates(parsed, planMon) {
  const prog = programFor(planMon), days = {};
  for (const [day, exercises] of Object.entries(parsed.week_plan || {})) {
    if (!Array.isArray(exercises) || !prog[day] || !DAYS.includes(day)) continue;
    const list = [];
    for (const upd of exercises) {
      if (!upd || !upd.id) continue;
      if (upd.action === "add") { if (!list.find(e => e.id === upd.id)) list.push({ ...upd }); }
      else if (upd.action === "remove") { if (prog[day].exercises.some(e => e.id === upd.id) && !list.find(e => e.id === upd.id)) list.push({ action: "remove", id: upd.id }); }
      else if (prog[day].exercises.some(e => e.id === upd.id)) {
        const stored = list.find(e => e.id === upd.id);
        if (stored) Object.assign(stored, upd); else list.push({ ...upd });
      }
    }
    if (list.length) days[day] = list;
  }
  return { weekKey: weekKeyOf(planMon), prog: programKeyFor(planMon), days };
}

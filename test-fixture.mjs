/**
 * The seeded data the e2e flows (e2e-flows.mjs) and the layout audit
 * (verify-layout.mjs) both run on: a synthetic but realistic state built on
 * top of a fresh install (kg and lbs, this and last week's sessions, PRs,
 * food, weights). E2E_STATE=path/to/backup.json swaps in a real backup
 * ({state:{...}} or the state itself). Never commit a real backup.
 */
import { readFileSync } from "fs";
import { programFor, weekKeyOf, prSlug, PR_ALIAS } from "./src/constants.js";

// Wednesday evening, mid-week: there is a past day (Mon/Tue), today, and future.
export const NOW = new Date("2026-10-21T18:00:00-04:00");
export const TODAY = "2026-10-21", WK = weekKeyOf(new Date("2026-10-21T12:00:00"));

// ── Fixture ────────────────────────────────────────────────────────────────
export const dayIso = (n) => { const d = new Date("2026-10-21T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
export function fixture(fresh) {
  if (process.env.E2E_STATE) { const j = JSON.parse(readFileSync(process.env.E2E_STATE, "utf8")); return j.state || j; }
  const S = JSON.parse(JSON.stringify(fresh));
  const prog = (iso) => programFor(new Date(iso + "T12:00:00"));
  const gym = (iso, day) => (prog(iso)[day]?.exercises || []).filter((e) => e.cat === "gym");
  S.sessions = S.sessions || {}; S.prs = S.prs || {};
  const lastWed = dayIso(-7), lastWk = weekKeyOf(new Date(lastWed + "T12:00:00"));
  // Last Wednesday: today's exercises at 40 kg x 10 (Beat targets), one in lbs.
  const lw = {};
  gym(lastWed, "Wednesday").forEach((e, i) => {
    const lbs = i === 2;
    lw[e.id] = { done: true, skipped: false, unit: lbs ? "lbs" : "kg", sets: [1, 2, 3].map(() => ({ weight: lbs ? "90" : "40", reps: "10", done: true })) };
    const slug = PR_ALIAS[prSlug(e.name)] || prSlug(e.name);
    S.prs[slug] = [{ date: lastWed, weight: lbs ? 40.8 : 40, reps: 10, est: lbs ? 54 : 53 }];
  });
  S.sessions["Wednesday_" + lastWk] = lw;
  // Monday this week: trained (two exercises logged, a note).
  const mon = {}; gym(dayIso(-2), "Monday").slice(0, 2).forEach((e) => { mon[e.id] = { done: true, skipped: false, unit: "kg", sets: [{ weight: "60", reps: "12", done: true }] }; });
  mon._notes = "Felt fine.";
  S.sessions["Monday_" + WK] = mon;
  S.nutrition = S.nutrition || {}; S.nutrition.days = S.nutrition.days || {}; S.nutrition.weights = S.nutrition.weights || {};
  for (let i = -3; i <= 0; i++) S.nutrition.days[dayIso(i)] = { items: i === 0 ? [] : [{ id: "n_" + (1000 + i), name: "Chicken rice bowl", kcal: 650, protein: 55, carbs: 70, fat: 14, fibre: 6, sugar: 4, sodium: 900, time: 1 }], restingOverride: 2800, active: 700 };
  for (let i = -12; i <= -1; i++) S.nutrition.weights[dayIso(i)] = Math.round((131 - (i + 12) * 0.15) * 10) / 10;
  return S;
}


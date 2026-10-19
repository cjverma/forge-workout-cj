// The Sunday weekly report email. Pure: build({ state, now }) -> { subject,
// html, text, data }. No network, no DB, so it is unit-tested in test.js.
// "_" prefix: a helper, not a Vercel function (the Hobby plan caps those at 12).
//
// Modelled on what the better weekly check-ins do:
//  - MacroFactor: weight TREND vs the goal line, intake, expenditure, and
//    whether the plan is still on schedule (projected finish date).
//  - Whoop / Garmin weekly reports: one verdict up top, then the handful of
//    numbers that explain it, each compared with last week.
//  - Strava / Hevy weekly summaries: sessions done vs planned, total volume,
//    PRs with the actual weight x reps, week-over-week change.
//  - A short "focus for next week" list built from the user's own numbers.
//
// Every number comes from the SAME engine the app uses (src/phase.js,
// src/constants.js), so the email can never disagree with the screen.
import { ctx } from "../src/runtime.js";
import { PHASES, phaseFor, phaseCurveKg, phaseRequiredDeficit, phaseActiveTargets, restingFor, actualDeficit,
  weightVsCurve, projectedFinish, proteinTargetG, isRestDay, isoDate, addDaysIso, daysBetween, ACTIVE_MULT } from "../src/phase.js";
import { programFor, weekKeyOf, DAYS, PR_ALIAS, prSlug, kg1, EX_DB, PROG_V1, PROG_V2, PROG_V3, PROG_V4, PROG_V5, PROG_V6, PROG_V7 } from "../src/constants.js";

const LB = 0.45359237;
const toKg = (w, unit) => { const n = Number(w); return Number.isFinite(n) ? (unit === "lbs" ? n * LB : n) : null; };
const r0 = (x) => Math.round(x), r1 = (x) => Math.round(x * 10) / 10;
const fmt = (n) => Number(n).toLocaleString("en-US");
const sgn = (x, d = 1) => (x > 0 ? "+" : x < 0 ? "−" : "±") + Math.abs(Number(x)).toFixed(d);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dShort = (iso) => { const [y, m, d] = iso.split("-").map(Number); return `${MON[m - 1]} ${d}`; };
const mondayOf = (iso) => { const dow = new Date(iso + "T12:00:00Z").getUTCDay(); return addDaysIso(iso, dow === 0 ? -6 : 1 - dow); };
const e1rm = (kg, reps) => (reps === 1 ? kg : kg * (1 + reps / 30));

// Exercise names for PR keys (name-slugs) and session ids, current program first.
const NAMES = (() => {
  const out = {};
  const put = (k, v) => { if (k && !out[k]) out[k] = v; };
  for (const P of [PROG_V7, PROG_V6, PROG_V5, PROG_V4, PROG_V3, PROG_V2, PROG_V1])
    for (const day of Object.values(P)) for (const ex of (day.exercises || [])) { put(ex.id, ex.name); const s = prSlug(ex.name); put(PR_ALIAS[s] || s, ex.name); }
  for (const ex of EX_DB) { const s = prSlug(ex.name); put(PR_ALIAS[s] || s, ex.name); }
  return out;
})();
const nameOf = (S, key) => {
  if (NAMES[key]) return NAMES[key];
  for (const arr of Object.values(S.custom || {})) for (const e of (arr || [])) if (e.id === key) return e.name;
  return String(key).replace(/^c_\d+$/, "Custom exercise").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
};

function sessionStats(S, dates) {
  let sets = 0, volume = 0, trained = 0;
  for (const d of dates) {
    const day = DAYS[(new Date(d + "T12:00:00Z").getUTCDay() + 6) % 7];
    const sess = (S.sessions || {})[day + "_" + weekKeyOf(new Date(d + "T12:00:00"))] || {};
    let any = false;
    for (const [id, ed] of Object.entries(sess)) {
      if (id.startsWith("_") || !ed || typeof ed !== "object") continue;
      for (const s of (ed.sets || [])) {
        if (!s || !s.done) continue;
        const kg = toKg(s.weight, ed.unit), reps = Number(s.reps);
        any = true;
        if (kg && reps) { sets++; volume += kg * reps; }
      }
      if (ed.done) any = true;
    }
    if (any) trained++;
  }
  return { sets, volume: r0(volume), trained };
}

export function buildWeeklyReport({ state, now = new Date() }) {
  const S = state;
  S.nutrition = S.nutrition || { days: {}, weights: {} };
  S.nutrition.days = S.nutrition.days || {}; S.nutrition.weights = S.nutrition.weights || {};
  // The phase engine reads state through ctx. Put back whatever was there so a
  // caller sharing the module (the test suite, a warm function) is unaffected.
  const prevGetS = ctx.getS;
  ctx.getS = () => S;
  try { return build(S, now); } finally { ctx.getS = prevGetS; }
}

function build(S, now) {

  // Report on COMPLETE days only: the week containing yesterday, through
  // yesterday. Sent on Monday morning that is the whole of last week; a manual
  // send mid-week covers the days so far, and a half-eaten today never drags
  // the averages down or inflates the deficit.
  const today = addDaysIso(isoDate(now), -1);
  const mon = mondayOf(today);
  const week = Array.from({ length: 7 }, (_, i) => addDaysIso(mon, i));
  const elapsed = week.filter((d) => d <= today);
  const lastWeek = week.map((d) => addDaysIso(d, -7));
  const goal = phaseFor(today) || PHASES[PHASES.length - 1];
  const ws = S.nutrition.weights;

  // ── Weight vs the goal line ─────────────────────────────────────────────
  const wKeys = Object.keys(ws).filter((d) => ws[d] != null).sort();
  const latestDate = wKeys.filter((d) => d <= today).pop() || null;
  const latest = latestDate ? kg1(ws[latestDate]) : null;
  const before = wKeys.filter((d) => d < mon).pop();
  const weekStartKg = before ? kg1(ws[before]) : (wKeys.find((d) => d >= mon && d <= today) ? kg1(ws[wKeys.find((d) => d >= mon)]) : null);
  const weekChange = latest != null && weekStartKg != null ? r1(latest - weekStartKg) : null;
  const avg = (ds) => { const v = ds.map((d) => ws[d]).filter((x) => x != null).map(Number); return v.length ? r1(v.reduce((a, b) => a + b, 0) / v.length) : null; };
  const avgThis = avg(week), avgLast = avg(lastWeek);
  const vs = goal ? weightVsCurve(goal, today) : null;                 // {date,kg,expected,diff}: diff>0 = ahead
  const lineToday = goal ? r1(phaseCurveKg(goal, today)) : null;
  const totalDays = goal ? daysBetween(goal.start, goal.plannedEnd) : 0;
  const daysLeft = goal ? Math.max(0, daysBetween(today, goal.plannedEnd)) : 0;
  const needPerWeek = goal ? r1(((latest ?? goal.startKg) - goal.targetKg) / Math.max(1, daysLeft) * 7) : null;
  const lost = goal && latest != null ? r1(goal.startKg - latest) : null;
  const pct = goal && lost != null ? Math.max(0, Math.min(100, r0(lost / (goal.startKg - goal.targetKg) * 100))) : 0;
  const proj = projectedFinish(today);

  // ── Nutrition + energy ──────────────────────────────────────────────────
  const protTarget = proteinTargetG();
  const eatTarget = goal?.eatKcal ?? null;
  const req = goal ? phaseRequiredDeficit(goal) : null;
  const daysN = elapsed.map((d) => {
    const nd = S.nutrition.days[d] || {}, items = nd.items || [];
    const kcal = items.reduce((a, i) => a + (i.kcal || 0), 0), prot = items.reduce((a, i) => a + (i.protein || 0), 0);
    const tgt = goal ? phaseActiveTargets(goal, d) : null;
    return { d, logged: kcal > 0, kcal: r0(kcal), prot: r0(prot), active: nd.active || 0, activeTarget: tgt ? (isRestDay(d) ? tgt.rest : tgt.workout) : null,
      resting: restingFor(d, nd), deficit: actualDeficit(d) };
  });
  const logged = daysN.filter((x) => x.logged);
  const mean = (arr, f) => (arr.length ? r0(arr.reduce((a, x) => a + f(x), 0) / arr.length) : null);
  const nut = {
    daysLogged: logged.length, daysElapsed: elapsed.length,
    avgKcal: mean(logged, (x) => x.kcal), onTarget: eatTarget ? logged.filter((x) => x.kcal <= eatTarget).length : 0,
    avgProt: mean(logged, (x) => x.prot), protHit: logged.filter((x) => x.prot >= protTarget).length,
    avgDeficit: mean(logged.filter((x) => x.deficit != null), (x) => x.deficit),
    weekDeficit: logged.reduce((a, x) => a + (x.deficit || 0), 0),
    avgActive: mean(daysN.filter((x) => x.active), (x) => x.active), activeHit: daysN.filter((x) => x.activeTarget != null && x.active >= x.activeTarget).length,
    avgActiveTarget: mean(daysN.filter((x) => x.activeTarget != null), (x) => x.activeTarget),
    avgResting: mean(daysN, (x) => x.resting),
  };
  nut.impliedKg = r1(nut.weekDeficit / 7700);

  // ── Training ────────────────────────────────────────────────────────────
  const dayRows = week.map((d) => {
    const day = DAYS[(new Date(d + "T12:00:00Z").getUTCDay() + 6) % 7];
    const prog = programFor(new Date(d + "T12:00:00"))[day] || {};
    const gym = (prog.exercises || []).filter((e) => e.cat === "gym");
    const sess = (S.sessions || {})[day + "_" + weekKeyOf(new Date(d + "T12:00:00"))] || {};
    const doneEx = Object.entries(sess).filter(([id, ed]) => !id.startsWith("_") && ed && (ed.done || (ed.sets || []).some((s) => s && s.done))).length;
    const status = !gym.length ? "rest" : doneEx ? (doneEx >= gym.length ? "done" : "partial") : d > today ? "upcoming" : d === today ? "today" : "missed";
    return { d, day, label: prog.label || "", planned: gym.length, doneEx, status, note: (sess._notes || "").trim(), twinges: (sess._calfTwinges || []).length };
  });
  // Same days of last week, so a mid-week send compares like with like.
  const thisT = sessionStats(S, elapsed), lastT = sessionStats(S, elapsed.map((d) => addDaysIso(d, -7)));
  const plannedSessions = dayRows.filter((r) => r.planned && r.d <= today).length;
  const volChange = lastT.volume ? r0((thisT.volume - lastT.volume) / lastT.volume * 100) : null;

  const prs = [];
  for (const [key, list] of Object.entries(S.prs || {})) {
    if (!Array.isArray(list)) continue;
    const inWeek = list.filter((e) => e.date >= mon && e.date <= today);
    if (!inWeek.length) continue;
    const best = inWeek.reduce((b, e) => (e.est > b.est ? e : b));
    const prior = list.filter((e) => e.date < mon).reduce((b, e) => (!b || e.est > b.est ? e : b), null);
    prs.push({ name: nameOf(S, key), weight: kg1(best.weight), reps: best.reps, est: best.est, gain: prior ? best.est - prior.est : null });
  }
  prs.sort((a, b) => (b.gain ?? 999) - (a.gain ?? 999));

  // ── Verdict + focus for next week (rule-based, from the numbers above) ──
  let verdict, tone;
  const target = goal ? goal.targetKg : 95;
  if (!vs || vs.date < mon) { verdict = latestDate ? "No weigh-in this week, so progress can't be measured." : "No weigh-in yet, so progress can't be measured."; tone = "warn"; }
  else if (vs.diff >= 0) { verdict = vs.diff === 0 ? `Exactly on plan for ${target} kg.` : `${vs.diff.toFixed(1)} kg ahead of plan. On track for ${target} kg.`; tone = "good"; }
  else if (vs.diff > -1) { verdict = `${Math.abs(vs.diff).toFixed(1)} kg behind plan. Easy to recover this week.`; tone = "warn"; }
  else { verdict = `${Math.abs(vs.diff).toFixed(1)} kg behind plan. Time to tighten up.`; tone = "bad"; }

  const focus = [];
  // Ordered by impact on the goal; the email shows the first three.
  const missedFood = nut.daysElapsed - nut.daysLogged;
  if (eatTarget && nut.avgKcal != null && nut.avgKcal > eatTarget) focus.push(`Eat ${fmt(eatTarget)} a day. You averaged ${fmt(nut.avgKcal)}.`);
  else if (req && nut.avgDeficit != null && nut.avgDeficit < req) focus.push(`Move more: the deficit was ${fmt(req - nut.avgDeficit)} kcal a day short.`);
  const missed = dayRows.filter((r) => r.status === "missed");
  // Same rule as the app's streak: 5 workouts a week (or all the plan has).
  const weekNeed = Math.min(5, dayRows.filter((r) => r.planned).length);
  const trainedN = dayRows.filter((r) => r.status === "done" || r.status === "partial").length;
  if (missed.length && trainedN < weekNeed) focus.push(`Get to ${weekNeed} workouts to keep your streak. Missed: ${missed.map((r) => r.day.slice(0, 3)).join(", ")}.`);
  if (nut.avgProt != null && nut.avgProt < protTarget) focus.push(`Get ${protTarget} g protein a day. You averaged ${nut.avgProt} g.`);
  if (nut.avgActiveTarget && nut.avgActive != null && nut.avgActive < nut.avgActiveTarget) focus.push(`Hit ${fmt(nut.avgActiveTarget)} active kcal a day. You averaged ${fmt(nut.avgActive)}.`);
  if (missedFood > 0) focus.push(`Log food every day. ${missedFood} day${missedFood === 1 ? "" : "s"} missing.`);
  if (wKeys.filter((d) => d >= mon && d <= today).length < 4) focus.push("Weigh in at least 4 mornings.");
  if (!focus.length) focus.push("Everything is on plan. Repeat this week.");

  const data = { mon, today, goal: goal && { start: goal.start, end: goal.plannedEnd, startKg: goal.startKg, targetKg: goal.targetKg }, latest, latestDate, weekChange, avgThis, avgLast, vs, lineToday,
    lost, pct, daysLeft, totalDays, needPerWeek, proj, nut, protTarget, eatTarget, req, dayRows, thisT, lastT, plannedSessions, volChange, prs, verdict, tone, focus };
  return { subject: subjectOf(data), html: renderHtml(data), text: renderText(data), data };
}

// Plain on purpose: numbers in a subject line read like a bank alert.
function subjectOf(x) {
  return `Your FORGE week · ${dShort(x.mon)} to ${dShort(addDaysIso(x.mon, 6))}`;
}

// ── HTML (email-safe: tables + inline styles, light paper like the PDF) ────
// Deliberately short: a verdict, three numbers, the week at a glance, PRs and
// at most three things to do. The full detail lives in the app and the CSV.
const C = { ink: "#18181B", mid: "#52525B", dim: "#A1A1AA", line: "#E4E4E7", card: "#FAFAF9", moss: "#55700B", good: "#15803D", warn: "#B45309", bad: "#B91C1C", hero: "#0A0A0B", volt: "#C8F135" };
const toneCol = (t) => (t === "good" ? C.good : t === "warn" ? C.warn : C.bad);
function tile(label, value, sub, col) {
  return `<td width="33%" valign="top" style="padding:5px"><div style="background:${C.card};border:1px solid ${C.line};border-radius:10px;padding:12px 10px;text-align:center">
    <div style="font-size:12px;color:${C.mid}">${esc(label)}</div>
    <div style="font-size:22px;font-weight:700;color:${col || C.ink};margin-top:2px;white-space:nowrap">${esc(value)}</div>
    <div style="font-size:11px;color:${C.dim};margin-top:2px">${esc(sub)}</div></div></td>`;
}
const section = (title, body) => `<tr><td style="padding:16px 22px 0"><div style="font-size:11px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:${C.moss};margin-bottom:8px">${esc(title)}</div>${body}</td></tr>`;
const bar = (pct, col) => `<div style="background:${C.line};border-radius:99px;height:8px;overflow:hidden"><div style="width:${Math.max(0, Math.min(100, pct))}%;background:${col};height:8px"></div></div>`;

// Ideal (the plan's line for that day) next to the actual weigh-in, so the
// verdict's "ahead/behind" is visible as two numbers rather than a claim.
function planVsActual(x, onTrack) {
  const ideal = onTrack ? x.vs.expected : x.lineToday, actual = onTrack ? x.vs.kg : x.latest;
  if (ideal == null) return "";
  const cell = (label, v, col) => `<td width="50%" align="center" style="padding:4px"><div style="font-size:12px;color:${C.mid}">${label}</div><div style="font-size:18px;font-weight:700;color:${col}">${v != null ? `${v} kg` : "·"}</div></td>`;
  const when = onTrack ? ` on ${dShort(x.vs.date)}` : "";
  return `<tr><td style="padding:10px 17px 0"><table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${C.line};border-radius:10px"><tr>${cell(`Ideal weight${when}`, ideal, C.mid)}${cell("Actual weight", actual, onTrack ? toneCol(x.tone) : C.ink)}</tr></table></td></tr>`;
}

function renderHtml(x) {
  const n = x.nut;
  const statusCell = { done: ["✓", C.good], partial: ["◐", C.warn], missed: ["✕", C.bad], rest: ["·", C.dim], upcoming: ["○", C.dim], today: ["○", C.mid] };
  const days = x.dayRows.map((r) => { const [g, col] = statusCell[r.status]; return `<td align="center" width="14%" style="padding:2px"><div style="font-size:11px;color:${C.mid}">${r.day.slice(0, 3)}</div><div style="font-size:18px;font-weight:700;color:${col}">${g}</div></td>`; }).join("");
  const prs = x.prs.slice(0, 3).map((p) => `<div style="font-size:14px;color:${C.ink};margin:4px 0">${esc(p.name)} <span style="color:${C.good};font-weight:600">${p.weight} kg × ${p.reps}</span></div>`).join("")
    + (x.prs.length > 3 ? `<div style="font-size:12px;color:${C.dim}">and ${x.prs.length - 3} more</div>` : "");
  const onTrack = x.vs && x.vs.date >= x.mon;
  return `<!doctype html><html><body style="margin:0;padding:0;background:#F4F4F5;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#F4F4F5"><tr><td align="center" style="padding:16px 8px">
<table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#FFFFFF;border-radius:14px;overflow:hidden">
<tr><td style="background:${C.hero};padding:22px">
  <div style="font-size:12px;letter-spacing:2px;color:${C.volt};font-weight:700">FORGE · WEEK OF ${dShort(x.mon).toUpperCase()}</div>
  <div style="font-size:21px;font-weight:700;color:#FFFFFF;margin-top:10px;line-height:1.3">${esc(x.verdict)}</div>
</td></tr>
<tr><td style="padding:12px 17px 0"><table width="100%" cellpadding="0" cellspacing="0"><tr>
  ${tile("Weight", x.weekChange != null ? `${sgn(x.weekChange)} kg` : "·", x.latest != null ? `now ${x.latest} kg` : "no weigh-in", x.weekChange != null && x.weekChange < 0 ? C.good : C.warn)}
  ${tile("Workouts", `${x.thisT.trained}/${x.plannedSessions}`, "this week", x.thisT.trained >= Math.min(5, x.plannedSessions) ? C.good : C.warn)}
  ${tile("Calories/day", n.avgKcal != null ? fmt(n.avgKcal) : "·", `goal ${fmt(x.eatTarget)}`, n.avgKcal != null && n.avgKcal <= x.eatTarget ? C.good : C.warn)}
</tr></table></td></tr>
${planVsActual(x, onTrack)}
<tr><td style="padding:14px 22px 0"><div style="font-size:13px;color:${C.mid};margin-bottom:6px">${x.lost ?? 0} of ${x.goal ? r1(x.goal.startKg - x.goal.targetKg) : "·"} kg lost · ${x.daysLeft} days to go</div>${bar(x.pct, onTrack ? toneCol(x.tone) : C.moss)}</td></tr>
<tr><td style="padding:14px 17px 0"><table width="100%" cellpadding="0" cellspacing="0" style="table-layout:fixed"><tr>${days}</tr></table></td></tr>
${x.prs.length ? section(`New PRs · ${x.prs.length}`, prs) : ""}
${section("Next week", `<ol style="margin:0;padding-left:18px">${x.focus.slice(0, 3).map((f) => `<li style="font-size:14px;color:${C.ink};margin:6px 0;line-height:1.45">${esc(f)}</li>`).join("")}</ol>`)}
<tr><td style="padding:18px 22px 22px;font-size:11px;color:${C.dim}">The full week is in the app, and attached as a CSV.</td></tr>
</table></td></tr></table></body></html>`;
}

function renderText(x) {
  const n = x.nut, L = [];
  L.push(`FORGE · week of ${dShort(x.mon)}`, "", x.verdict, "");
  L.push(`Weight ${x.weekChange != null ? `${sgn(x.weekChange)} kg` : "·"} · workouts ${x.thisT.trained}/${x.plannedSessions} · calories ${n.avgKcal != null ? fmt(n.avgKcal) : "·"}/day (goal ${fmt(x.eatTarget)})`);
  if (x.lineToday != null) L.push(x.vs && x.vs.date >= x.mon ? `Ideal weight ${x.vs.expected} kg · actual ${x.vs.kg} kg (${dShort(x.vs.date)})` : `Ideal weight today ${x.lineToday} kg · last weigh-in ${x.latest ?? "·"} kg`);
  if (x.prs.length) L.push(`New PRs: ${x.prs.slice(0, 3).map((p) => `${p.name} ${p.weight} kg x ${p.reps}`).join(", ")}`);
  L.push("", "Next week:", ...x.focus.slice(0, 3).map((f, i) => `${i + 1}. ${f}`));
  return L.join("\n");
}

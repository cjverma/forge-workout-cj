// Daily logging reminders (Oct 27, user): 9:30 AM weigh-in, 11 AM food,
// 7 PM workout, 8:30 PM active short of target, 11:30 PM calories, each only
// when that thing isn't done.
// Runs inside api/cron-weekly-plan.js (the 12-function limit). Web Push needs VAPID_PUBLIC_KEY and
// VAPID_PRIVATE_KEY in Vercel's environment; without them it skips quietly.
// iPhone receives these only for the Home Screen app (iOS 16.4+).
import webpush from "web-push";
import { weekKeyOf, DAYS, isGymRestDay } from "../src/constants.js";
import { isoDate, phaseFor, phaseActiveTarget, eatKcalFor, activeMult } from "../src/phase.js";
import { ctx } from "../src/runtime.js";

// The four daily reminders (user, Oct 27), by Toronto local hour. Vercel
// Hobby runs a cron somewhere within its hour, and Toronto shifts between
// UTC-4 and UTC-5, so each slot has two crons (one per offset) and only the
// one landing in the slot's local hour sends.
export const SLOTS = {
  weight:   { hour: 9,  label: "9:30 AM" },   // weigh-in
  food:     { hour: 11, label: "11 AM" },     // nothing eaten logged
  workout:  { hour: 19, label: "7 PM" },      // training day, workout not started
  active:   { hour: 20, label: "8:30 PM" },   // Watch active short of today's target
  calories: { hour: 23, label: "11:30 PM" },  // Watch active / resting not entered
};
export function torontoHour(now = new Date()) {
  return Number(new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", hour: "2-digit", hourCycle: "h23" }).format(now));
}

// What a slot should say for today (Toronto), or null when there is nothing
// to nag about. Pure, so it is unit-tested.
export function nudgeFor(state, now = new Date(), slot = "calories") {
  const d = isoDate(now);
  const nd = state?.nutrition?.days?.[d] || {};
  const food = (nd.items || []).some((i) => Number(i.kcal) > 0);
  const active = Number(nd.active) > 0, resting = Number(nd.restingOverride) > 0;
  const weighed = state?.nutrition?.weights?.[d] != null;
  const dt = new Date(d + "T12:00:00");
  const sess = state?.sessions?.[DAYS[(dt.getDay() + 6) % 7] + "_" + weekKeyOf(dt)] || {};
  const trained = !!sess._complete || Object.entries(sess).some(([id, ed]) => !id.startsWith("_") && ed && (ed.done || (ed.sets || []).some((s) => s && s.done)));
  const rest = isGymRestDay(d);
  const base = { date: d, slot };
  if (slot === "weight")
    return weighed ? null : { ...base, title: "Weigh in", body: "Step on the scale before you eat and log it in Forge." };
  if (slot === "food")
    return food ? null : { ...base, title: "No food logged yet", body: "Log what you've eaten so far so today counts toward your weekly deficit." };
  if (slot === "workout") {
    if (rest || trained) return null;
    return { ...base, title: "Workout not started", body: food ? "Today's a training day and nothing's ticked off yet. Start it in Forge." : "Today's a training day and nothing's logged yet, food or workout. Start the workout in Forge." };
  }
  if (slot === "active") {
    // Today's Watch target, re-solved for what was eaten (eating over the
    // food target raises it), the same number the Food tab shows.
    const before = ctx.getS;
    ctx.getS = () => state;
    try {
      const p = phaseFor(d);
      if (!p) return null;
      const eaten = (nd.items || []).reduce((a, i) => a + (Number(i.kcal) || 0), 0);
      const target = Math.round(phaseActiveTarget(p, d) + Math.max(0, eaten - eatKcalFor(p, d)) / activeMult(d));
      const got = Number(nd.active) || 0, gap = target - got;
      if (gap <= 0) return null;
      const mins = Math.max(10, Math.ceil(gap / 10 / 5) * 5);   // ~10 kcal/min brisk walking at this weight
      return { ...base, title: "Active calories short",
        body: got ? `You're ${gap.toLocaleString("en-US")} active calories short of today's ${target.toLocaleString("en-US")}. About ${mins} minutes of walking closes it.`
                  : `No Watch active calories logged yet. Today's target is ${target.toLocaleString("en-US")}.`, gap, target };
    } finally { ctx.getS = before; }
  }
  if (slot === "calories") {
    const miss = [!active && "Watch active", !resting && "resting"].filter(Boolean);
    if (!miss.length && food) return null;
    const parts = [...(food ? [] : ["food"]), ...miss.map((m) => m + " calories")];
    const list = parts.length === 1 ? parts[0] : parts.slice(0, -1).join(", ") + " and " + parts[parts.length - 1];
    return { ...base, title: "Log today's calories", body: `Add ${list} before midnight so today counts toward your weekly deficit.` };
  }
  return null;
}

// Sends the reminder to every saved subscription; drops ones the push
// service says are gone (404/410). `q` is the Neon tagged-template client.
export async function runNudge({ state, q, now = new Date(), env = process.env, send, slot } = {}) {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return { skipped: "no VAPID keys" };
  if (!SLOTS[slot]) return { skipped: "unknown slot" };
  if (torontoHour(now) !== SLOTS[slot].hour) return { skipped: "other daylight-saving twin" };
  const n = nudgeFor(state, now, slot);
  if (!n) return { sent: 0, reason: "already logged" };
  const subject = env.VAPID_SUBJECT || (env.VERCEL_PROJECT_PRODUCTION_URL ? "https://" + env.VERCEL_PROJECT_PRODUCTION_URL : "https://forge.app");
  webpush.setVapidDetails(subject, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
  const push = send || ((sub, body) => webpush.sendNotification(sub, body));
  const subs = await q`SELECT endpoint, sub FROM push_subscriptions`;
  let sent = 0, dropped = 0;
  for (const r of subs) {
    try { await push(r.sub, JSON.stringify(n)); sent++; }
    catch (e) { if (e.statusCode === 404 || e.statusCode === 410) { await q`DELETE FROM push_subscriptions WHERE endpoint=${r.endpoint}`; dropped++; } }
  }
  return { sent, dropped, slot: n.slot, title: n.title };
}

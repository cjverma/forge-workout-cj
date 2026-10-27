// Twice-daily "still to log" reminder (Oct 27, user: "when some days are
// missing, I want notifications twice a day letting me know nothing has been
// logged"). Runs inside api/cron-weekly-plan.js (the 12-function limit) at
// ~1 PM and ~8 PM Toronto. Web Push needs VAPID_PUBLIC_KEY and
// VAPID_PRIVATE_KEY in Vercel's environment; without them it skips quietly.
// iPhone receives these only for the Home Screen app (iOS 16.4+).
import webpush from "web-push";
import { weekKeyOf, DAYS, isGymRestDay } from "../src/constants.js";
import { isoDate } from "../src/phase.js";

// What still needs logging today (Toronto): food, the workout on a training
// day, Watch active. The same pieces a day needs to count toward the weekly
// deficit. Pure, so it is unit-tested. null when nothing is missing.
export function nudgeFor(state, now = new Date()) {
  const d = isoDate(now);
  const nd = state?.nutrition?.days?.[d] || {};
  const food = (nd.items || []).some((i) => Number(i.kcal) > 0);
  const active = Number(nd.active) > 0;
  const dt = new Date(d + "T12:00:00");
  const sess = state?.sessions?.[DAYS[(dt.getDay() + 6) % 7] + "_" + weekKeyOf(dt)] || {};
  const trained = !!sess._complete || Object.entries(sess).some(([id, ed]) => !id.startsWith("_") && ed && (ed.done || (ed.sets || []).some((s) => s && s.done)));
  const rest = isGymRestDay(d);
  const missing = [];
  if (!food) missing.push("food");
  if (!rest && !trained) missing.push("your workout");
  if (!active) missing.push("Watch active calories");
  if (!missing.length) return null;
  const list = missing.length === 1 ? missing[0] : missing.slice(0, -1).join(", ") + " and " + missing[missing.length - 1];
  const nothing = !food && !active && (rest || !trained);
  return {
    title: nothing ? "Nothing logged today" : "Still to log today",
    body: `Log ${list} so today counts toward your weekly deficit.`,
    date: d, missing,
  };
}

// Sends the reminder to every saved subscription; drops ones the push
// service says are gone (404/410). `q` is the Neon tagged-template client.
export async function runNudge({ state, q, now = new Date(), env = process.env, send } = {}) {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return { skipped: "no VAPID keys" };
  const n = nudgeFor(state, now);
  if (!n) return { sent: 0, reason: "everything logged" };
  const subject = env.VAPID_SUBJECT || (env.VERCEL_PROJECT_PRODUCTION_URL ? "https://" + env.VERCEL_PROJECT_PRODUCTION_URL : "https://forge.app");
  webpush.setVapidDetails(subject, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
  const push = send || ((sub, body) => webpush.sendNotification(sub, body));
  const subs = await q`SELECT endpoint, sub FROM push_subscriptions`;
  let sent = 0, dropped = 0;
  for (const r of subs) {
    try { await push(r.sub, JSON.stringify(n)); sent++; }
    catch (e) { if (e.statusCode === 404 || e.statusCode === 410) { await q`DELETE FROM push_subscriptions WHERE endpoint=${r.endpoint}`; dropped++; } }
  }
  return { sent, dropped, missing: n.missing };
}

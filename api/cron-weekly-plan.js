import { assembleState } from "./state.js";
import { sql, ensureSchema } from "./_db.js";
import { generateWeeklyPlan } from "./weekly-plan.js";
import { buildPlanPayload, planMonFor, planToUpdates } from "../src/plan.js";
import { programKeyFor } from "../src/constants.js";
import { runNudge } from "./_nudge.js";

// Generates next week's plan on the server every Sunday evening, so the week
// is planned even if the app is never opened (the in-app Sunday auto-plan only
// runs when FORGE is launched). Writes the same week_plan_updates rows the app
// writes, so the next sync delivers it. Never overwrites a plan that already
// exists for that week and matches the program (generated in the app first).
export function hasCurrentPlan(state, weekKey, progKey) {
  const wp = state?.weekPlans?.[weekKey];
  if (!wp) return false;
  return !wp._prog || wp._prog === progKey;
}

export async function runWeeklyPlan({ now = new Date(), state, generate = generateWeeklyPlan, write } = {}) {
  const planMon = planMonFor(now);
  const progKey = programKeyFor(planMon);
  const { weekKey } = planToUpdates({ week_plan: {} }, planMon);
  if (hasCurrentPlan(state, weekKey, progKey)) return { skipped: true, weekKey, reason: "plan already exists" };
  const { sessionHistory, profile } = buildPlanPayload(state, { now });
  const parsed = await generate(sessionHistory, profile);
  const upd = planToUpdates(parsed, planMon);
  await write(upd, parsed);
  return { skipped: false, weekKey, prog: upd.prog, days: Object.keys(upd.days), notes: parsed.coaching_notes || "" };
}

async function writePlan(upd) {
  await ensureSchema();
  const q = sql();
  // Replace the week wholesale, the same shape applyPendingPlan produces.
  await q`DELETE FROM week_plan_updates WHERE week_key=${upd.weekKey}`;
  for (const [day, list] of Object.entries(upd.days))
    for (const u of list)
      await q`INSERT INTO week_plan_updates(week_key, day_name, update) VALUES (${upd.weekKey}, ${day}, ${JSON.stringify(u)})`;
  await q`INSERT INTO week_plan_updates(week_key, day_name, update) VALUES (${upd.weekKey}, ${"_prog"}, ${JSON.stringify(upd.prog)})`;
}

export default async function handler(req, res) {
  // Same auth as the other crons: Vercel's CRON_SECRET, or the app's token
  // for a manual run.
  const auth = req.headers["authorization"] || "";
  const provided = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const cronSecret = process.env.CRON_SECRET, appToken = process.env.FORGE_API_TOKEN;
  if (!((cronSecret && provided === cronSecret) || (appToken && provided === appToken))) return res.status(401).json({ error: "Unauthorized" });
  // The same function sends the daily logging reminders (vercel.json:
  // ?job=nudge&slot=weight|food|workout|calories, two crons per slot for
  // daylight saving).
  if (req.query?.job === "nudge") {
    try {
      await ensureSchema();
      const out = await runNudge({ state: await assembleState(), q: sql(), slot: String(req.query.slot || "") });
      console.log("[cron-nudge]", JSON.stringify(out));
      return res.status(200).json(out);
    } catch (e) {
      console.error("[cron-nudge]", e.message);
      return res.status(502).json({ error: "Reminder failed" });
    }
  }
  try {
    const state = await assembleState();
    const out = await runWeeklyPlan({ state, write: writePlan });
    console.log("[cron-weekly-plan]", JSON.stringify(out));
    return res.status(200).json(out);
  } catch (e) {
    console.error("[cron-weekly-plan]", e.message);
    return res.status(502).json({ error: "Weekly plan generation failed" });
  }
}

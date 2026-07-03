import { setCors, checkAuth } from "./_shared.js";
import { sql, ensureSchema } from "./db.js";

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (!checkAuth(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { entity, payload } = req.body || {};
  if (!entity || !payload) return res.status(400).json({ error: "Missing entity or payload" });

  try {
    await ensureSchema();
    const q = sql();

    switch (entity) {
      case "session_set": {
        const { sessionKey, exId, done, skipped, unit, sets } = payload;
        await q`INSERT INTO sessions(session_key, ex_id, done, skipped, unit, sets, updated_at)
                VALUES (${sessionKey}, ${exId}, ${!!done}, ${!!skipped}, ${unit || null}, ${JSON.stringify(sets || [])}, now())
                ON CONFLICT (session_key, ex_id) DO UPDATE SET
                  done=EXCLUDED.done, skipped=EXCLUDED.skipped, unit=EXCLUDED.unit,
                  sets=EXCLUDED.sets, updated_at=now()`;
        break;
      }
      case "session_meta": {
        const { sessionKey, calfTwinges, notes } = payload;
        await q`INSERT INTO session_meta(session_key, calf_twinges, notes, updated_at)
                VALUES (${sessionKey}, ${JSON.stringify(calfTwinges || [])}, ${notes || null}, now())
                ON CONFLICT (session_key) DO UPDATE SET
                  calf_twinges=EXCLUDED.calf_twinges, notes=EXCLUDED.notes, updated_at=now()`;
        break;
      }
      case "nutrition_item_add": {
        const { date, item } = payload;
        await q`INSERT INTO nutrition_items(client_id, date, name, kcal, protein, carbs, fat, fibre, sugar, sodium, time, canonical)
                VALUES (${item.id != null ? String(item.id) : null}, ${date}, ${item.name || null}, ${item.kcal || 0}, ${item.protein || 0}, ${item.carbs || 0},
                        ${item.fat || 0}, ${item.fibre || 0}, ${item.sugar || 0}, ${item.sodium || 0}, ${item.time || null}, ${item.canonical || null})`;
        break;
      }
      case "nutrition_item_delete": {
        const { id, date } = payload;
        await q`DELETE FROM nutrition_items WHERE client_id=${String(id)} AND date=${date}`;
        break;
      }
      case "nutrition_day_meta": {
        const { date, active, restingOverride } = payload;
        await q`INSERT INTO nutrition_day_meta(date, active, resting_override)
                VALUES (${date}, ${active ?? null}, ${restingOverride ?? null})
                ON CONFLICT (date) DO UPDATE SET active=EXCLUDED.active, resting_override=EXCLUDED.resting_override`;
        break;
      }
      case "weight": {
        const { date, kg } = payload;
        await q`INSERT INTO weights(date, kg, updated_at) VALUES (${date}, ${kg}, now())
                ON CONFLICT (date) DO UPDATE SET kg=EXCLUDED.kg, updated_at=now()`;
        break;
      }
      case "weight_delete": {
        const { date } = payload;
        await q`DELETE FROM weights WHERE date=${date}`;
        break;
      }
      case "pr": {
        const { exerciseId, date, weight, reps, est } = payload;
        await q`INSERT INTO prs(exercise_id, date, weight, reps, est) VALUES (${exerciseId}, ${date}, ${weight}, ${reps}, ${est})`;
        break;
      }
      case "custom_exercise": {
        const { id, dayName, name, cat, sets, reps, hint, url, cue, muscles } = payload;
        await q`INSERT INTO custom_exercises(id, day_name, name, cat, sets, reps, hint, url, cue, muscles)
                VALUES (${id}, ${dayName}, ${name || null}, ${cat || null}, ${sets || null}, ${reps || null},
                        ${hint || null}, ${url || null}, ${cue || null}, ${JSON.stringify(muscles || [])})
                ON CONFLICT (id) DO UPDATE SET
                  day_name=EXCLUDED.day_name, name=EXCLUDED.name, cat=EXCLUDED.cat, sets=EXCLUDED.sets,
                  reps=EXCLUDED.reps, hint=EXCLUDED.hint, url=EXCLUDED.url, cue=EXCLUDED.cue, muscles=EXCLUDED.muscles`;
        break;
      }
      case "week_plan_update": {
        const { weekKey, dayName, update } = payload;
        await q`INSERT INTO week_plan_updates(week_key, day_name, update) VALUES (${weekKey}, ${dayName}, ${JSON.stringify(update)})`;
        break;
      }
      case "week_plan_reset": {
        const { weekKey } = payload;
        if (weekKey) await q`DELETE FROM week_plan_updates WHERE week_key=${weekKey}`;
        else await q`DELETE FROM week_plan_updates`;
        break;
      }
      case "milestones": {
        const { shownProtein7, shownWeight5kg, shownWeek6, longestStreak } = payload;
        await q`UPDATE milestones SET
                  shown_protein7=${JSON.stringify(shownProtein7 || [])},
                  shown_weight5kg=${JSON.stringify(shownWeight5kg || [])},
                  shown_week6=${JSON.stringify(shownWeek6 || [])},
                  longest_streak=${longestStreak || 0}
                WHERE id=1`;
        break;
      }
      case "ai_chat_add": {
        const { role, content } = payload;
        await q`INSERT INTO ai_chat(role, content) VALUES (${role}, ${content})`;
        break;
      }
      case "ai_chat_clear": {
        await q`DELETE FROM ai_chat`;
        break;
      }
      case "settings": {
        const { theme, aiDeficitModifier, weeklySnapshots, weeklyVerdict, demoCache, demoCacheV, lastBackup } = payload;
        await q`UPDATE app_settings SET
                  theme=${theme ?? null},
                  ai_deficit_modifier=${aiDeficitModifier ?? 0},
                  weekly_snapshots=${JSON.stringify(weeklySnapshots || [])},
                  weekly_verdict=${weeklyVerdict ? JSON.stringify(weeklyVerdict) : null},
                  demo_cache=${JSON.stringify(demoCache || {})},
                  demo_cache_v=${demoCacheV ?? null},
                  last_backup=${lastBackup ? new Date(lastBackup).toISOString() : null}
                WHERE id=1`;
        break;
      }
      case "wipe_all": {
        // Destructive — requires an explicit sentinel so a stray/malformed
        // request elsewhere in the app can't accidentally trigger it. The
        // real safety gate is the client's confirm-your-name UX; this is
        // just a backstop against bugs, not the security boundary.
        if (payload.confirm !== "WIPE_ALL") return res.status(400).json({ error: "Missing confirmation" });
        await q`DELETE FROM sessions`;
        await q`DELETE FROM session_meta`;
        await q`DELETE FROM nutrition_items`;
        await q`DELETE FROM nutrition_day_meta`;
        await q`DELETE FROM weights`;
        await q`DELETE FROM prs`;
        await q`DELETE FROM custom_exercises`;
        await q`DELETE FROM week_plan_updates`;
        await q`DELETE FROM ai_chat`;
        await q`UPDATE milestones SET shown_protein7='[]', shown_weight5kg='[]', shown_week6='[]', longest_streak=0 WHERE id=1`;
        await q`UPDATE app_settings SET theme=NULL, ai_deficit_modifier=0, weekly_snapshots='[]', weekly_verdict=NULL, demo_cache='{}', demo_cache_v=NULL, last_backup=NULL WHERE id=1`;
        break;
      }
      default:
        return res.status(400).json({ error: "Unknown entity: " + entity });
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error("[mutate]", entity, e.message);
    return res.status(502).json({ error: "Mutation failed: " + e.message });
  }
}

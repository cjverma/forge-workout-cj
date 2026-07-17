import { ctx } from "./runtime.js";
import { save } from "./state.js";
import { showToast } from "./ui.js";

export const API_CFG = window.FORGE_API_CFG || { baseUrl: "", token: localStorage.getItem("forge_key") || "" };

function dataWeight(st) {
  let n = 0;
  for (const sess of Object.values(st.sessions || {}))
    for (const e of Object.values(sess))
      if (e && typeof e === "object" && (e.sets || []).some(s => s && s.done))
        n += e.sets.filter(s => s.done).length;
  n += Object.keys(st.nutrition?.days || {}).length * 3;
  n += Object.keys(st.nutrition?.weights || {}).length * 3;
  return n;
}

function pushSnapshot(state) {
  try {
    const list = JSON.parse(localStorage.getItem("f5_snapshots") || "[]");
    list.unshift({ ts: Date.now(), weight: dataWeight(state), state });
    localStorage.setItem("f5_snapshots", JSON.stringify(list.slice(0, 5)));
  } catch (e) {}
}

export function listSnapshots() {
  try { return JSON.parse(localStorage.getItem("f5_snapshots") || "[]"); } catch { return []; }
}

export function restoreSnapshot(ts) {
  const list = listSnapshots();
  const snap = list.find(s => s.ts === ts);
  if (!snap) { showToast("Snapshot not found"); return; }
  if (!confirm(`Restore snapshot from ${new Date(snap.ts).toLocaleString()} (~${snap.weight} entries)?\n\nThis REPLACES all current data on this device.`)) return;
  ctx.setS(snap.state);
  save();
  queueMutation("restore_all", { state: ctx.getS() });
  showToast("Snapshot restored ✓");
  location.reload();
}

export function setSyncDot() {
  const el = document.getElementById("syncDot");
  if (!el) return;
  const pending = getOutbox().length;
  const _syncAvailable = ctx.syncAvailable;
  el.className = "sync-dot " + (_syncAvailable === true ? (pending ? "" : "on") : _syncAvailable === false ? "off" : "");
}

export function getOutbox() {
  try { return JSON.parse(localStorage.getItem("f5_outbox") || "[]"); } catch { return []; }
}

function setOutbox(list) { localStorage.setItem("f5_outbox", JSON.stringify(list)); }

export function queueMutation(entity, payload, dedupeKey) {
  const list = getOutbox();
  if (dedupeKey) {
    const i = list.findIndex(m => m.dedupeKey === dedupeKey);
    if (i >= 0) { list[i] = { entity, payload, dedupeKey, ts: Date.now() }; setOutbox(list); scheduleFlush(); return; }
  }
  list.push({ entity, payload, dedupeKey, ts: Date.now() });
  setOutbox(list);
  scheduleFlush();
}

function scheduleFlush() {
  if (!API_CFG.token) return;
  clearTimeout(ctx.syncTimer);
  ctx.syncTimer = setTimeout(flushOutbox, 3000);
}

export async function flushOutbox() {
  if (ctx.syncBusy || !API_CFG.token) return;
  let list = getOutbox();
  if (!list.length) return;
  ctx.syncBusy = true;
  try {
    while (list.length) {
      const m = list[0];
      let ok = false;
      try {
        const r = await fetch(API_CFG.baseUrl + "/api/mutate", { method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + API_CFG.token }, body: JSON.stringify({ entity: m.entity, payload: m.payload }) });
        if (r.status === 501) { ctx.syncAvailable = false; break; }
        ok = r.ok;
        if (r.ok) ctx.syncAvailable = true;
      } catch (e) { break; }
      if (!ok) break;
      list.shift();
      setOutbox(list);
    }
  } finally { ctx.syncBusy = false; setSyncDot(); }
}

export async function loadServerState(showStatus) {
  if (!API_CFG.token) return;
  if (showStatus) showToast("Checking database…");
  try {
    const r = await fetch(API_CFG.baseUrl + "/api/state", { headers: { "Authorization": "Bearer " + API_CFG.token } });
    if (r.status === 501) { ctx.syncAvailable = false; setSyncDot(); if (showStatus) showToast("❌ Database not configured · add DATABASE_URL in Vercel, then redeploy"); return; }
    if (r.status === 401) { if (showStatus) showToast("❌ Auth failed · app token doesn't match FORGE_API_TOKEN"); return; }
    if (!r.ok) { if (showStatus) showToast("❌ Sync error (HTTP " + r.status + ")"); return; }
    ctx.syncAvailable = true; setSyncDot();
    const d = await r.json();
    if (getOutbox().length) {
      flushOutbox();
      if (showStatus) showToast("⏳ Finishing pending sync first…");
      return;
    }
    pushSnapshot(ctx.getS());
    ctx.setS(d.state);
    localStorage.setItem("f5", JSON.stringify(ctx.getS()));
    ctx.applyTheme();
    const cTab = ctx.getTab();
    if (cTab === "workout") ctx.renderW();
    else if (cTab === "nutrition") ctx.renderNutrition();
    else ctx.renderST();
    ctx.lastSyncAt = Date.now();
    if (showStatus) showToast("✓ Synced from database");
  } catch (e) { if (showStatus) showToast("❌ Network error · is the deployment live?"); }
}

export function queueSession(key, exId) {
  const S = ctx.getS();
  const ed = S.sessions[key]?.[exId];
  if (!ed) return;
  queueMutation("session_set", { sessionKey: key, exId, done: !!ed.done, skipped: !!ed.skipped, unit: ed.unit, sets: ed.sets || [] }, "session_set:" + key + ":" + exId);
}

export function queueSessionMeta(key) {
  const S = ctx.getS();
  const sess = S.sessions[key];
  if (!sess) return;
  queueMutation("session_meta", { sessionKey: key, calfTwinges: sess._calfTwinges || [], notes: sess._notes || null, duration: sess._duration ?? null, stopped: sess._stopped ?? null }, "session_meta:" + key);
}

export function queueDayMeta(date) {
  const S = ctx.getS();
  const dm = S.nutrition.days[date] || {};
  queueMutation("nutrition_day_meta", { date, active: dm.active ?? null, restingOverride: dm.restingOverride ?? null, shock: dm.shockProtocol ?? null }, "nutrition_day_meta:" + date);
}

export function queueSettings() {
  const S = ctx.getS();
  queueMutation("settings", { theme: S.theme ?? null, aiDeficitModifier: S.nutrition?.aiDeficitModifier ?? 0, weeklySnapshots: S.nutrition?.weeklySnapshots || [], weeklyVerdict: S.nutrition?.weeklyVerdict || null, demoCache: S.demoCache || {}, demoCacheV: S.demoCacheV ?? null, lastBackup: S._lastBackup ?? null }, "settings");
}

export function queueMilestones() {
  const S = ctx.getS();
  const m = S.milestones || {};
  queueMutation("milestones", { shownProtein7: m.shownProtein7 || [], shownWeight5kg: m.shownWeight5kg || [], shownWeek6: m.shownWeek6 || [], longestStreak: m.longestStreak || 0 }, "milestones");
}

export function checkSyncNow() { loadServerState(true); }

window.restoreSnapshot = restoreSnapshot;
window.listSnapshots = listSnapshots;
window.checkSyncNow = checkSyncNow;

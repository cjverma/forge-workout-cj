import { ctx } from "./runtime.js";
import { isoToday } from "./phase.js";
import { showToast } from "./ui.js";

// Every write to the phone's storage goes through lsSet (Nov 26, "Add button
// not working"). The device keeps the state, a daily full copy for 14 days and
// five snapshots, all in one ~5 MB browser quota. Once it filled, the bare
// setItem in save() threw mid-handler: the food was pushed in memory but no
// toast, no re-render, so Add looked dead (and the Food tab could not even
// render). On a full quota lsSet frees space, oldest copies first (daily
// backups, never today's, then snapshots), retries, and never throws: the
// change still reaches the server through the outbox.
let _lsFullWarned = false;
function lsFreeOne(keep) {
  const days = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith("f5_daily_") && k !== keep) days.push(k);
  }
  days.sort();
  const today = "f5_daily_" + isoToday();
  const old = days.filter(k => k !== today);
  if (old.length) { localStorage.removeItem(old[0]); return true; }
  try {
    const list = JSON.parse(localStorage.getItem("f5_snapshots") || "[]");
    if (list.length) {
      list.pop();
      if (list.length) localStorage.setItem("f5_snapshots", JSON.stringify(list));
      else localStorage.removeItem("f5_snapshots");
      return true;
    }
  } catch (_) { localStorage.removeItem("f5_snapshots"); return true; }
  if (days.length) { localStorage.removeItem(days[0]); return true; }
  return false;
}
export function lsSet(key, val) {
  for (let n = 0; n < 40; n++) {
    try { localStorage.setItem(key, val); return true; }
    catch (e) {
      let freed = false;
      try { freed = lsFreeOne(key); } catch (_) {}
      if (!freed) break;
    }
  }
  if (!_lsFullWarned) {
    _lsFullWarned = true;
    try { showToast("Phone storage is full. Changes still sync, but this phone could not keep a copy."); } catch (_) {}
  }
  return false;
}

export function save() {
  const S = ctx.getS();
  S._syncTs = Date.now();
  lsSet("f5", JSON.stringify(S));
  autoBackupTick();
}

export function autoBackupTick() {
  const S = ctx.getS();
  const today = isoToday();
  if (S._lastAutoBackupDay === today) return;
  try {
    // A backup only takes room the state does not need: on a full quota it is
    // skipped (tried again on the next save), never written by evicting others.
    localStorage.setItem("f5_daily_" + today, JSON.stringify(S));
    S._lastAutoBackupDay = today;
    lsSet("f5", JSON.stringify(S));
    const cutoff = Date.now() - 14 * 86400000;
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith("f5_daily_")) {
        const d = new Date(k.slice(9));
        if (!isNaN(d) && d.getTime() < cutoff) localStorage.removeItem(k);
      }
    }
  } catch (e) {}
}

export function listDailyBackups() {
  const out = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith("f5_daily_")) out.push(k.slice(9));
  }
  return out.sort().reverse();
}

window.listDailyBackups = listDailyBackups;

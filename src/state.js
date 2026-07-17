import { ctx } from "./runtime.js";
import { isoToday } from "./phase.js";

export function save() {
  const S = ctx.getS();
  S._syncTs = Date.now();
  localStorage.setItem("f5", JSON.stringify(S));
  autoBackupTick();
}

export function autoBackupTick() {
  const S = ctx.getS();
  const today = isoToday();
  if (S._lastAutoBackupDay === today) return;
  try {
    localStorage.setItem("f5_daily_" + today, JSON.stringify(S));
    S._lastAutoBackupDay = today;
    localStorage.setItem("f5", JSON.stringify(S));
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

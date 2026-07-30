import { ctx } from "./runtime.js";

// ── ICON SET ────────────────────────────────────────────────────────────────
// Inline SVG, one consistent 1.5px stroke weight, no fills, everything drawn on
// a 24 grid. Replaces emoji-as-iconography: emoji render differently on every
// platform (so the app's look wasn't ours to control) and read as informal.
// stroke:currentColor means an icon themes for free — set colour on the parent.
// No CDN, no icon font, no dependency, no network payload.
const ICON_PATHS = {
  // ── exercise categories ──
  // strength: dumbbell. Doubles for the gym section header and volume card.
  gym: '<path d="M6.5 6.5v11M17.5 6.5v11M3.5 9v6M20.5 9v6M6.5 12h11"/>',
  // cardio: pulse trace
  cardio: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  // physio / recovery: heart. Doubles for the physio section header.
  physio: '<path d="M12 20s-7-4.4-7-9a4 4 0 0 1 7-2.6A4 4 0 0 1 19 11c0 4.6-7 9-7 9z"/>',

  // ── AI ──
  // Four-point sparkle: the conventional AI mark. Deliberately not the nav's
  // speech bubble, which already means "Ask Forge" one row below.
  spark: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z"/>'
       + '<path d="M18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2z"/>',

  // ── section / accordion headers ──
  trophy: '<path d="M7 4h10v5a5 5 0 0 1-10 0V4zM7 6H4v1a3 3 0 0 0 3 3M17 6h3v1a3 3 0 0 1-3 3M9 20h6M12 14v6"/>',
  shield: '<path d="M12 3l7 3v5c0 4.4-3 8.3-7 9.5C8 19.3 5 15.4 5 11V6l7-3z"/>',
  bowl: '<path d="M3 11h18a9 9 0 0 1-18 0zM8 8c0-1.5 1.5-2 2-3M13 8c0-1.5 1.5-2 2-3"/>',
  scale: '<path d="M12 4v16M7 8h10M5 20h14M8 8L5 14a3 3 0 0 0 6 0L8 8zM16 8l-3 6a3 3 0 0 0 6 0l-3-6z"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M8 3v4M16 3v4M3.5 10h17"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  // Same path the bottom nav already uses, so the two gears match exactly.
  gear: '<circle cx="12" cy="12" r="3.2"/><path d="M19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.4-2.3.9a7 7 0 0 0-2-1.2L14.2 3h-4l-.4 2.6a7 7 0 0 0-2 1.2l-2.3-.9-2 3.4 2 1.5a7 7 0 0 0 0 2.4l-2 1.5 2 3.4 2.3-.9a7 7 0 0 0 2 1.2l.4 2.6h4l.4-2.6a7 7 0 0 0 2-1.2l2.3.9 2-3.4-2-1.5c.07-.4.1-.8.1-1.2z"/>',
  database: '<ellipse cx="12" cy="6" rx="7.5" ry="3"/><path d="M4.5 6v12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3V6M4.5 12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3"/>',
  folder: '<path d="M3.5 7a2 2 0 0 1 2-2h3.4l2 2.5h7.6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2V7z"/>',
  target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="1"/>',
  syringe: '<path d="M18 3l3 3M19.5 4.5L14 10M14 10l-1.5-1.5M14 10l1.5 1.5M12.5 8.5L4 17v3h3l8.5-8.5M9 13l2 2"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v4h-4"/>',
  moon: '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  // theme = auto: half sun, half moon
  moonHalf: '<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" stroke="none"/>',

  // ── settings rows / actions ──
  play: '<circle cx="12" cy="12" r="8.5"/><path d="M10 8.5l6 3.5-6 3.5v-7z"/>',
  cloud: '<path d="M17.5 19a4.5 4.5 0 0 0 .3-9 6 6 0 0 0-11.6 1.6A3.7 3.7 0 0 0 6.8 19h10.7z"/>',
  save: '<path d="M12 3v12M7.5 10.5L12 15l4.5-4.5M4 17v2.5A1.5 1.5 0 0 0 5.5 21h13a1.5 1.5 0 0 0 1.5-1.5V17"/>',
  upload: '<path d="M12 21V9M7.5 13.5L12 9l4.5 4.5M4 5V3.5A1.5 1.5 0 0 1 5.5 2h13A1.5 1.5 0 0 1 20 3.5V5"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M3.5 7l8.5 6 8.5-6"/>',
  clipboard: '<rect x="8" y="3" width="8" height="4" rx="1.3"/><path d="M9 5H6.5A1.5 1.5 0 0 0 5 6.5v13A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5v-13A1.5 1.5 0 0 0 17.5 5H15"/>',
  lock: '<rect x="4.5" y="10" width="15" height="10.5" rx="2.2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  unlock: '<rect x="4.5" y="10" width="15" height="10.5" rx="2.2"/><path d="M8 10V7a4 4 0 0 1 7.5-2"/>',
  trash: '<path d="M4 7h16M9.5 7V5.2A1.2 1.2 0 0 1 10.7 4h2.6a1.2 1.2 0 0 1 1.2 1.2V7M6.5 7l.8 12.3A1.7 1.7 0 0 0 9 21h6a1.7 1.7 0 0 0 1.7-1.7L17.5 7M10 11v6M14 11v6"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5z"/><path d="M14 3v5h5"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.2 15.2L21 21"/>',
  pencil: '<path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4 11.5-11.5z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  bolt: '<path d="M13 2L4.5 13.5H11l-1 8.5L19.5 10H13l0-8z"/>',
  flame: '<path d="M12 22a6.5 6.5 0 0 0 6.5-6.5c0-5-4-6-5.5-10.5-3 2-4 4.5-4 6.5-1-.5-1.5-1.5-1.5-2.5A6.9 6.9 0 0 0 5.5 15 6.5 6.5 0 0 0 12 22z"/>',
  flag: '<path d="M5 21V4M5 4.5h11l-2 3.5 2 3.5H5"/>',
  ban: '<circle cx="12" cy="12" r="8.5"/><path d="M6 6l12 12"/>',
  alert: '<path d="M12 4.5L21 19.5H3L12 4.5z"/><path d="M12 10v4M12 17h.01"/>',
};

// Returns an inline <svg> string. Size is the px box; colour comes from the
// parent's `color` via currentColor.
export function icon(name, size = 22) {
  const d = ICON_PATHS[name];
  if (!d) return "";
  return `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" `
    + `fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" `
    + `stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
}

// "Aug 27th" — year only when 2027 (the goal year)
export function fmtDate(iso){
  const d=new Date(iso+"T12:00:00Z");
  const month=d.toLocaleDateString("en-US",{month:"short",timeZone:"UTC"});
  const day=d.getUTCDate();
  const year=d.getUTCFullYear();
  const v=day%100;
  const sfx=["th","st","nd","rd"];
  const ord=day+(sfx[(v-20)%10]||sfx[v]||sfx[0]);
  return year===2027?`${month} ${ord}, 2027`:`${month} ${ord}`;
}

export function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, ch => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[ch]));
}

export function mdLite(t) {
  let h = esc(t);
  // No em dashes anywhere in the UI. AI replies are full of them, and mdLite is
  // the single choke point for every AI-rendered string (chat, diet review,
  // phase review), so normalise here.
  //   em dash → " · "  a middot is neutral in prose, list labels AND headings.
  //     ", " would be wrong in "### Phase 1 — Upper Focus" (comma splice).
  //   en dash → "-"    these are numeric ranges ("8–12 reps"), where a hyphen
  //     is correct and a middot would be nonsense.
  // [ \t]* not \s* on purpose: \s matches \n and would join separate lines.
  h = h.replace(/[ \t]*—[ \t]*/g, " · ").replace(/[ \t]*–[ \t]*/g, "-");
  h = h.replace(/^#{1,3} (.+)$/gm, "<b>$1</b>");
  h = h.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  h = h.replace(/(^|\s)\*([^*\n]+)\*(?=\s|$|[.,;:!?])/g, "$1<i>$2</i>");
  h = h.replace(/^\s*[-*] /gm, "• ");
  h = h.replace(/^\s*(\d+)\. /gm, "$1. ");
  return h;
}

export function showToast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.remove("toast-big");
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2200);
}

export function showToastBig(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("toast-big", "show");
  setTimeout(() => {
    t.classList.remove("show");
    setTimeout(() => t.classList.remove("toast-big"), 300);
  }, 3500);
}

export function showMilestone(icon, title, sub) {
  document.getElementById("msIcon").textContent = icon;
  document.getElementById("msTitle").textContent = title;
  document.getElementById("msSub").textContent = sub;
  document.getElementById("milestoneModal").classList.add("show");
}

export function closeMilestone() {
  document.getElementById("milestoneModal").classList.remove("show");
}

export function applyTheme() {
  const S = ctx.getS();
  const t = S.theme;
  if (t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t);
  else document.documentElement.removeAttribute("data-theme");
  const dark = t === "dark" || (t !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#0A0A0B" : "#F4F4F5");
}

export function toggleTheme() {
  const S = ctx.getS();
  S.theme = S.theme === "light" ? "dark" : S.theme === "dark" ? "auto" : "light";
  ctx.save();
  ctx.queueSettings();
  applyTheme();
  if (ctx.getTab() === "workout") ctx.renderW();
  else if (ctx.getTab() === "nutrition") ctx.renderNutrition();
  ctx.renderST();
}

window.toggleTheme = toggleTheme;
window.closeMilestone = closeMilestone;

import { ctx } from "./runtime.js";

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
  h = h.replace(/—|–/g, " - ");
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

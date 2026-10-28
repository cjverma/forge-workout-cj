/**
 * Layout audit: renders every screen, sheet and pop-up of the BUILT app
 * (dist/, served as the site root) at three iPhone widths in both themes and
 * MEASURES the display bugs a screenshot hides. Written after "1,500" in the
 * intake ring touched its stroke on the phone while every contact sheet
 * looked fine.
 *
 * Per screen, on every visible text run inside that screen's root:
 *   offscreen  - text past the viewport edge (outside an intentional scroller)
 *   clipped    - text cut by an overflow:hidden ancestor, or an ellipsis
 *   container  - text outside its filled/bordered box (2px side clearance)
 *   ring       - text inside an SVG ring must clear the stroke (the 1,500 bug)
 *   overlap    - two text runs drawn on top of each other (same layer)
 *   contrast   - < 4.5:1 against the real background (3:1 for large text)
 *   size       - text under 11px (Apple's smallest style); tab bar exempt
 *   tap        - a control smaller than 44x44 with no padded hit area
 *   leftover   - old volt/moss colours, uppercase letterspaced labels in
 *                cards, " · ", em dashes, ${, undefined, NaN, null
 * plus a page-level check that nothing scrolls sideways.
 *
 * Usage: node verify-layout.mjs            (also invoked by node test.js)
 *        E2E_STATE=backup.json node verify-layout.mjs   (real data, local only)
 *        LAYOUT_OUT=dir node verify-layout.mjs          (crop every finding)
 * New screens or sheets must be added to SCREENS below.
 */
import { mkdirSync } from "fs";
import { chromium } from "playwright";
import express from "express";
import { NOW, dayIso, fixture } from "./test-fixture.mjs";

const CHROME = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const PORT = 8795, BASE = `http://127.0.0.1:${PORT}/`;
const OUT = process.env.LAYOUT_OUT || "";
if (OUT) mkdirSync(OUT, { recursive: true });

// Deliberate exceptions, each with its reason. Matched against the finding's
// check + selector path.
const ALLOW = [
  // Apple's tab bar labels are 10pt by design.
  { check: "size", path: /\.bot-nav/ },
  // The date strip scrolls sideways on purpose.
  { check: "offscreen", path: /#dayNav/ },
];

// iPhone screens in CSS points, at their real pixel density, as touch
// devices with Safari's user agent. Chromium stands in for WebKit (the only
// engine installed here), so fonts and safe areas are approximations.
const IOS_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";
const DEVICES = [
  { name: "iPhone mini", w: 375, h: 812, dpr: 3 },
  { name: "iPhone 15", w: 390, h: 844, dpr: 3 },
  { name: "iPhone 17 Pro", w: 402, h: 874, dpr: 3 },
  { name: "iPhone 17 Pro Max", w: 440, h: 956, dpr: 3 },
];

const PAGE = [".hdr", "#dayNav", "#mainScroll", ".bot-nav"];
const SCREENS = [
  { name: "workout: day", root: PAGE, run: async (p) => { await p.evaluate(() => document.getElementById("nav-workout")?.click()); } },
  { name: "workout: past day (locked)", root: PAGE, run: async (p) => { await p.evaluate(() => document.getElementById("p-Monday")?.click()); } },
  { name: "workout: exercise open", root: PAGE, run: async (p) => {
    await p.evaluate(() => { document.getElementById("p-Wednesday")?.click(); });
    await p.waitForTimeout(200);
    await p.evaluate(() => document.querySelector('[onclick*="expand("]')?.click()); } },
  { name: "workout: how was today (review shown)", root: PAGE, run: async (p) => {
    await p.evaluate(() => document.getElementById("p-Wednesday")?.click()); await p.waitForTimeout(150);
    await p.evaluate(() => window.reviewToday?.()); await p.waitForTimeout(600);
    await p.evaluate(() => document.getElementById("dayReviewOut")?.scrollIntoView({ block: "center" })); } },
  { name: "food: top", root: PAGE, run: async (p) => { await p.evaluate(() => document.getElementById("nav-nutrition").click()); } },
  { name: "food: progress cards open", root: PAGE, run: async (p) => { await p.evaluate(() => document.querySelectorAll("#tc details").forEach((d) => (d.open = true))); } },
  { name: "food: meal entry", root: PAGE, run: async (p) => { await p.evaluate(() => window.openFood()); } },
  { name: "food: AI estimate pending", root: PAGE, run: async (p) => {
    await p.evaluate(() => { const t = document.getElementById("foodTa"); if (t) t.value = "Greek yogurt with berries"; });
    await p.evaluate(() => window.askFood()); await p.waitForTimeout(500); } },
  { name: "food: past-food search", root: PAGE, run: async (p) => {
    await p.evaluate(() => { window.dropPending?.(); window.closeFood?.(); });
    await p.waitForTimeout(150);
    await p.evaluate(() => document.querySelector(".add-food-btn")?.nextElementSibling?.click()); } },
  { name: "food: past day", root: PAGE, run: async (p) => { await p.evaluate(() => { window.nutShift(-1); }); await p.waitForTimeout(150);
    await p.evaluate(() => document.querySelectorAll("#tc details").forEach((d) => (d.open = true))); } },
  { name: "settings: everything open", root: PAGE, run: async (p) => {
    await p.evaluate(() => document.getElementById("nav-settings").click()); await p.waitForTimeout(250);
    await p.evaluate(() => document.querySelectorAll("#tc details").forEach((d) => (d.open = true))); } },
  { name: "sheet: export", root: ["#exportSheet .export-sheet-inner"], run: async (p) => { await p.evaluate(() => window.showExportSheet()); },
    after: async (p) => { await p.evaluate(() => document.getElementById("exportSheet")?.classList.remove("open")); } },
  { name: "sheet: weekly plan review", root: ["#planModal"], run: async (p) => { await p.evaluate(() => window.genWeeklyPlan()); await p.waitForTimeout(700); },
    after: async (p) => { await p.evaluate(() => window.closePlanModal?.()); } },
  { name: "drawer: insights", root: ["#drawer"], run: async (p) => { await p.evaluate(() => window.openDrawer()); },
    after: async (p) => { await p.evaluate(() => window.closeDrawer()); } },
  { name: "chat: ask forge", root: ["#forgeChatModal"], run: async (p) => { await p.evaluate(() => window.openForgeChat()); },
    after: async (p) => { await p.evaluate(() => window.closeForgeChat()); } },
  { name: "toast", root: ["#toast"], run: async (p) => {
    await p.evaluate(() => document.getElementById("nav-workout").click());
    await p.evaluate(() => { const t = document.getElementById("toast"); t.textContent = "No recent backup. Export one from Settings."; t.classList.add("show"); }); },
    after: async (p) => { await p.evaluate(() => document.getElementById("toast").classList.remove("show")); } },
  { name: "pop-up: milestone", root: ["#milestoneModal"], run: async (p) => {
    await p.evaluate(() => { document.getElementById("msIcon").textContent = "💪"; document.getElementById("msTitle").textContent = "6 Workouts This Week"; document.getElementById("msSub").textContent = "Elite consistency."; document.getElementById("milestoneModal").classList.add("show"); }); },
    after: async (p) => { await p.evaluate(() => document.getElementById("milestoneModal").classList.remove("show")); } },
  { name: "sheet: swap", root: ["#swapModal .swap-sheet"], run: async (p) => {
    await p.evaluate(() => { document.getElementById("p-Wednesday")?.click(); });
    await p.evaluate(() => window.toggleCF()); await p.waitForTimeout(150);
    await p.fill("#cfSearch", "crossover"); await p.waitForTimeout(350);
    await p.evaluate(() => document.querySelector("#cfDD [data-action='fromdb']")?.click()); await p.waitForTimeout(350); },
    after: async (p) => { await p.evaluate(() => window.closeSwap()); } },
  { name: "workout: running session", root: PAGE, run: async (p) => {
    await p.evaluate(() => window.startSess()); await p.waitForTimeout(200);
    await p.evaluate(() => document.querySelector('[onclick*="expand("]')?.click()); } },
  { name: "sheet: finish workout", root: ["#stopModal .swap-sheet"], run: async (p) => {
    await p.clock.setFixedTime(new Date(NOW.getTime() + 52 * 60000));
    await p.evaluate(() => window.stopSess()); } },
  { name: "pop-up: workout summary", root: ["#sum"], run: async (p) => { await p.evaluate(() => window.stopSess(true)); await p.waitForTimeout(250); },
    after: async (p) => { await p.evaluate(() => window.closeSummary()); await p.clock.setFixedTime(NOW); } },
  { name: "sheet: unit review", root: ["#planModal"], run: async (p) => {
    await p.evaluate(() => {
      const S = JSON.parse(localStorage.f5);
      for (const k of Object.keys(S.sessions).sort()) for (const [id, ed] of Object.entries(S.sessions[k] || {})) {
        if (id.startsWith("_") || !ed?.sets?.[0]?.done || (ed.unit || "kg") !== "kg") continue;
        if (Number(ed.sets[0].weight) > 5 && Number(ed.sets[0].weight) < 45) { ed.sets[0].weight = "120"; delete ed.sets[0].unitOk; localStorage.f5 = JSON.stringify(S); return; }
      } });
    await p.reload({ waitUntil: "networkidle" }); await p.waitForTimeout(600);
    await p.evaluate(() => { window.closeUnitReview?.(); window.openUnitReview(); }); },
    after: async (p) => { await p.evaluate(() => window.closeUnitReview?.()); } },
  { name: "lock screen", root: ["#lockScreen"], run: async (p) => { await p.evaluate(() => { document.getElementById("lockScreen").style.display = "flex"; }); } },
];

// ── In-page measurement ────────────────────────────────────────────────────
function measure(rootSels) {
  const findings = [];
  const vw = window.innerWidth;
  const css = (el) => getComputedStyle(el);
  const visible = (el) => el.checkVisibility ? el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) : true;
  const path = (el) => { const parts = []; for (let e = el, i = 0; e && e !== document.body && i < 4; e = e.parentElement, i++) parts.unshift(e.tagName.toLowerCase() + (e.id ? "#" + e.id : "") + [...e.classList].slice(0, 2).map((c) => "." + c).join("")); return parts.join(" > "); };
  const rgba = (s) => { const m = (s || "").match(/rgba?\(([^)]+)\)/); if (!m) return null; const v = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: v[0], g: v[1], b: v[2], a: v.length > 3 ? v[3] : 1 }; };
  const lum = ({ r, g, b }) => { const f = (x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const over = (top, bot) => ({ r: top.r * top.a + bot.r * (1 - top.a), g: top.g * top.a + bot.g * (1 - top.a), b: top.b * top.a + bot.b * (1 - top.a), a: 1 });
  const bgOf = (el) => {
    const stack = [];
    for (let e = el; e; e = e.parentElement) {
      const cs = css(e);
      if (cs.backgroundImage && cs.backgroundImage !== "none" && !/url\(/.test(cs.backgroundImage)) return null; // gradient: not judged
      const c = rgba(cs.backgroundColor);
      if (c && c.a > 0) { stack.push(c); if (c.a >= 1) break; }
    }
    let base = stack.length && stack[stack.length - 1].a >= 1 ? stack.pop() : rgba(css(document.documentElement).backgroundColor) || { r: 255, g: 255, b: 255, a: 1 };
    while (stack.length) base = over(stack.pop(), base);
    return base;
  };
  const OLD = new Set(["200,241,53", "185,228,37", "85,112,11"]);
  const isOld = (s) => { const c = rgba(s); return c && c.a > 0 && OLD.has(`${c.r},${c.g},${c.b}`); };
  const add = (check, el, text, detail, rect) => findings.push({ check, path: path(el), text: (text || "").trim().slice(0, 60), detail, rect: rect && { x: rect.left, y: rect.top, w: rect.width, h: rect.height } });

  // Page-level: nothing scrolls sideways.
  const se = document.scrollingElement;
  if (se.scrollWidth > se.clientWidth + 1) add("offscreen", document.body, "page scrolls sideways", `${se.scrollWidth} > ${se.clientWidth}`);
  const ms = document.getElementById("mainScroll");
  if (ms && rootSels.includes("#mainScroll") && ms.scrollWidth > ms.clientWidth + 1) add("offscreen", ms, "main view scrolls sideways", `${ms.scrollWidth} > ${ms.clientWidth}`);

  const roots = rootSels.flatMap((s) => [...document.querySelectorAll(s)]).filter(visible);
  const runs = [];
  for (const root of roots) {
    const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = tw.nextNode(); n; n = tw.nextNode()) {
      const text = n.nodeValue; if (!text.trim()) continue;
      const el = n.parentElement; if (!el || !visible(el)) continue;
      if (el.closest("script,style,noscript,svg,option")) continue;
      const range = document.createRange(); range.selectNodeContents(n);
      const rects = [...range.getClientRects()].filter((r) => r.width > 0.5 && r.height > 0.5);
      if (!rects.length) continue;
      const box = range.getBoundingClientRect();
      const fixedLayer = (() => { for (let e = el; e; e = e.parentElement) { const p = css(e).position; if (p === "fixed" || p === "sticky") return e; } return null; })();
      // Scrolled out of a scroll container's view: not on screen, so it can
      // not overlap anything the user sees (it sat "under" the date strip).
      // Only the part inside every scroll container is on screen.
      let clip = { left: -1e9, top: -1e9, right: 1e9, bottom: 1e9 };
      for (let e = el.parentElement; e && e !== document.documentElement; e = e.parentElement) {
        const ec = css(e); if (!/(auto|scroll)/.test(ec.overflowY + ec.overflowX)) continue;
        const r = e.getBoundingClientRect();
        clip = { left: Math.max(clip.left, r.left), top: Math.max(clip.top, r.top), right: Math.min(clip.right, r.right), bottom: Math.min(clip.bottom, r.bottom) };
      }
      const cut = (r) => ({ left: Math.max(r.left, clip.left), top: Math.max(r.top, clip.top), right: Math.min(r.right, clip.right), bottom: Math.min(r.bottom, clip.bottom) });
      const shown = rects.map(cut).filter((r) => r.right - r.left > 0.5 && r.bottom - r.top > 0.5);
      const scrolledAway = !shown.length || shown.some((r, i) => r.top !== rects[i]?.top || r.bottom !== rects[i]?.bottom);
      runs.push({ n, el, text, rects: shown, box, layer: fixedLayer, scrolledAway: !shown.length, partial: scrolledAway });
    }
  }

  const rings = [...document.querySelectorAll("svg circle")].filter((c) => {
    const cs = css(c); return visible(c.ownerSVGElement) && cs.stroke !== "none" && (cs.fill === "none" || /rgba\(0, 0, 0, 0\)/.test(cs.fill)) && Number(c.getAttribute("r")) > 10 && roots.some((r) => r.contains(c));
  }).map((c) => {
    const svg = c.ownerSVGElement, sr = svg.getBoundingClientRect(), vb = svg.viewBox?.baseVal;
    const scale = vb && vb.width ? sr.width / vb.width : 1;
    const r = c.getBoundingClientRect();
    return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, inner: (Number(c.getAttribute("r")) - parseFloat(css(c).strokeWidth) / 2) * scale, outer: r.width / 2 };
  });

  for (const run of runs) {
    const { el, text, box } = run, cs = css(el);
    // Text scrolled (even partly) out of its scroll container's view is
    // measured when it is scrolled into view, not here.
    if (run.scrolledAway || run.partial) {
      if (/\s·\s|—|\$\{|\bundefined\b|\bNaN\b|\bnull\b/.test(text)) add("leftover", el, text, "separator dot, em dash or placeholder in text", box);
      continue;
    }
    // offscreen / clipped
    let clipper = null;
    for (let e = el.parentElement || el; e && e !== document.documentElement; e = e.parentElement) {
      const ox = css(e).overflowX, oy = css(e).overflowY;
      if (ox !== "visible" || oy !== "visible") { clipper = e; break; }
    }
    if (clipper) {
      const cr = clipper.getBoundingClientRect(), co = css(clipper);
      const scrollsX = /(auto|scroll)/.test(co.overflowX), scrollsY = /(auto|scroll)/.test(co.overflowY);
      if (!scrollsX && (box.right > cr.right + 1 || box.left < cr.left - 1)) add("clipped", el, text, `text ${Math.round(box.left)}-${Math.round(box.right)} outside ${Math.round(cr.left)}-${Math.round(cr.right)}`, box);
      if (!scrollsY && (box.bottom > cr.bottom + 1 || box.top < cr.top - 1) && cr.height > 0) add("clipped", el, text, `text ${Math.round(box.top)}-${Math.round(box.bottom)} outside ${Math.round(cr.top)}-${Math.round(cr.bottom)} (vertical)`, box);
      if (!scrollsX && (box.right > vw + 1 || box.left < -1) && !(cr.right <= vw + 1 && cr.left >= -1)) add("offscreen", el, text, `x ${Math.round(box.left)}-${Math.round(box.right)} of ${vw}`, box);
    } else if (box.right > vw + 1 || box.left < -1) add("offscreen", el, text, `x ${Math.round(box.left)}-${Math.round(box.right)} of ${vw}`, box);
    if (cs.textOverflow === "ellipsis" && el.scrollWidth > el.clientWidth + 1) add("clipped", el, text, "cut off with an ellipsis", box);

    // container: the nearest ENCLOSING box, i.e. a fill that differs from
    // what is behind it, or a border on at least three sides. A hairline
    // row divider is not a box, and text sitting on it flush is correct.
    for (let e = el; e && e !== document.body; e = e.parentElement) {
      const ec = css(e), bg = rgba(ec.backgroundColor);
      const sides = ["Top", "Right", "Bottom", "Left"].filter((s) => parseFloat(ec["border" + s + "Width"]) > 0 && ec["border" + s + "Style"] !== "none" && (rgba(ec["border" + s + "Color"])?.a || 0) > 0).length;
      const behind = e.parentElement ? bgOf(e.parentElement) : null;
      const filled = bg && bg.a > 0.05 && !(behind && Math.abs(behind.r - bg.r) + Math.abs(behind.g - bg.g) + Math.abs(behind.b - bg.b) < 3 && bg.a >= 1);
      if (!filled && sides < 3) continue;
      if (["fixed"].includes(ec.position) && e.getBoundingClientRect().width >= vw - 1) break; // full-screen layers are not containers
      const r = e.getBoundingClientRect();
      if (r.width < 1) break;
      const clear = Math.min(box.left - r.left, r.right - box.right);
      if (clear < 2 || box.top < r.top - 1 || box.bottom > r.bottom + 1)
        add("container", el, text, `text ${Math.round(box.left)}-${Math.round(box.right)} x ${Math.round(box.top)}-${Math.round(box.bottom)} in box ${Math.round(r.left)}-${Math.round(r.right)} x ${Math.round(r.top)}-${Math.round(r.bottom)} (${e.className || e.tagName})`, box);
      break;
    }

    // ring: text centred inside a ring must clear the stroke
    for (const g of rings) {
      const mx = box.left + box.width / 2, my = box.top + box.height / 2;
      if (Math.hypot(mx - g.cx, my - g.cy) > g.outer) continue;
      const far = Math.max(...[[box.left, box.top], [box.right, box.top], [box.left, box.bottom], [box.right, box.bottom]].map(([x, y]) => Math.hypot(x - g.cx, y - g.cy)));
      if (far > g.inner - 2) add("ring", el, text, `corner ${far.toFixed(1)}px from centre, opening ${g.inner.toFixed(1)}px`, box);
    }

    // contrast
    const fg = rgba(cs.color);
    let dimmed = false; for (let e = el; e; e = e.parentElement) if (parseFloat(css(e).opacity) < 1 || e.disabled) { dimmed = true; break; }
    // A lone swatch glyph (legend ▮, status ○) is a colour key, not text.
    if (fg && fg.a > 0 && !dimmed && !el.closest("input,textarea,select") && !/^[\s▮■●○◆▲▼]+$/.test(text)) {
      const bg = bgOf(el);
      if (bg) {
        const f = fg.a < 1 ? over(fg, bg) : fg;
        const [hi, lo] = [lum(f), lum(bg)].sort((a, b) => b - a);
        const ratio = (hi + 0.05) / (lo + 0.05);
        const px = parseFloat(cs.fontSize), large = px >= 24 || (px >= 18.66 && Number(cs.fontWeight) >= 700);
        if (ratio < (large ? 3 : 4.5)) add("contrast", el, text, `${ratio.toFixed(2)}:1 (${cs.color} on rgb(${Math.round(bg.r)}, ${Math.round(bg.g)}, ${Math.round(bg.b)}))`, box);
      }
    }
    // size
    if (parseFloat(cs.fontSize) < 11 && !/^[·\s]+$/.test(text)) add("size", el, text, `${cs.fontSize}`, box);
    // leftovers
    if (isOld(cs.color) || isOld(cs.backgroundColor) || isOld(cs.borderTopColor)) add("leftover", el, text, "old volt/moss colour", box);
    if (cs.textTransform === "uppercase" && parseFloat(cs.letterSpacing) > 0.5) add("leftover", el, text, `uppercase letterspaced (${cs.letterSpacing})`, box);
    if (/\s·\s|—|\$\{|\bundefined\b|\bNaN\b|\bnull\b/.test(text)) add("leftover", el, text, "separator dot, em dash or placeholder in text", box);
  }

  // overlap: two text runs on the same layer drawn on top of each other
  for (let i = 0; i < runs.length; i++) for (let j = i + 1; j < runs.length; j++) {
    const a = runs[i], b = runs[j];
    if (a.layer !== b.layer || a.scrolledAway || b.scrolledAway) continue;
    for (const ra of a.rects) for (const rb of b.rects) {
      const w = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left), h = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
      if (w > 2 && h > 2) { add("overlap", a.el, a.text + " / " + b.text.trim().slice(0, 30), `${w.toFixed(0)}x${h.toFixed(0)}px with ${path(b.el)}`, ra); i = i; break; }
    }
  }

  // tap targets
  const ctrls = roots.flatMap((r) => [...r.querySelectorAll("button,a[href],[onclick],summary,select,[data-action]")]).filter((c) => visible(c) && !c.disabled);
  for (const c of new Set(ctrls)) {
    const r = c.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    if (c.closest(".st-row,.ex-row,.food-item") && c.matches(".st-row,.ex-row,.food-item")) continue; // full-width rows
    const parentCtrl = c.parentElement?.closest("button,a[href],[onclick],summary,[data-action]");
    if (parentCtrl && roots.some((rt) => rt.contains(parentCtrl))) continue; // nested inside a bigger control
    if (r.width < 44 - 0.5 || r.height < 44 - 0.5) add("tap", c, c.innerText || c.getAttribute("aria-label") || c.getAttribute("onclick") || "", `${Math.round(r.width)}x${Math.round(r.height)}`, r);
  }
  return findings;
}

// ── Harness ────────────────────────────────────────────────────────────────
const app = express();
app.use(express.static("dist"));
const server = app.listen(PORT);
const browser = await chromium.launch({ executablePath: CHROME });

async function open(dev, theme, state) {
  const ctx = await browser.newContext({ viewport: { width: dev.w, height: dev.h }, deviceScaleFactor: dev.dpr, isMobile: true, hasTouch: true, userAgent: IOS_UA, colorScheme: theme, timezoneId: "America/Toronto", serviceWorkers: "block" });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => d.accept());
  await page.clock.setFixedTime(NOW);
  await page.route("**/api/**", async (r) => {
    const path = new URL(r.request().url()).pathname;
    const json = (status, body) => r.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (path === "/api/state") return json(501, {});
    if (path === "/api/mutate") return json(200, { ok: true });
    if (path === "/api/coach") return json(200, { text: "**Solid week.** Protein hit target on 5 of 7 days.\n\n### Next week\n- Keep food at 1,500 on 6 of 7 days\n- Weigh in every morning" });
    if (path === "/api/nutrition") return json(200, { items: [{ name: "Greek yogurt with mixed berries and honey", kcal: 310, protein: 24, carbs: 38, fat: 6, fibre: 4, sugar: 30, sodium: 90 }] });
    if (path === "/api/weekly-plan") return json(200, { text: JSON.stringify({ week_plan: {}, coaching_notes: "Good week. Hold the leg press at 120 kg and add reps before adding load.", flags: ["Calf twinge on Wednesday during the incline walk"] }) });
    return json(404, { error: "not mocked" });
  });
  await page.addInitScript(([s, th]) => {
    window.FORGE_API_CFG = { baseUrl: "", token: "x" };
    if (s && !sessionStorage.__seeded) { localStorage.f5 = JSON.stringify(s); localStorage.removeItem("f5_outbox"); sessionStorage.__seeded = 1; }
    try { localStorage.setItem("forge_theme", th); } catch (_) {}
  }, [state, theme]);
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  await page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
  await page.evaluate(() => { try { window.closeMilestone?.(); window.closeUnitReview?.(); } catch (_) {} });
  // Boot repairs announce themselves with toasts; let them clear.
  await page.waitForTimeout(400);
  await page.evaluate(() => document.getElementById("toast")?.classList.remove("show"));
  return { ctx, page, errors };
}

// Fresh install -> the shared fixture, plus the states that only exist with data.
const fresh = await (async () => { const { ctx, page } = await open(DEVICES[1], "light", null); const s = await page.evaluate(() => JSON.parse(localStorage.f5)); await ctx.close(); return s; })();
const seeded = fixture(fresh);
if (!process.env.E2E_STATE) {
  seeded.dietReview = { text: "**Good week overall.** Protein averaged 182 g against a 230 g target, and you logged food on 6 of 7 days.\n\n- Add a protein shake on rest days\n- Keep sodium under 2,300 mg", weekStart: dayIso(-9), generatedAt: Date.now() };
  seeded.aiChat = [{ role: "user", text: "How was my week?", ts: 1 }, { role: "ai", text: "Solid. You trained 5 of 6 days and stayed at 1,500 kcal on 5 of them. Hold the leg press at 120 kg next week.", ts: 2 }];
  seeded.nutrition.days[dayIso(0)] = { items: [{ id: "n_a", name: "Overnight oats with peanut butter and banana", kcal: 520, protein: 24, carbs: 70, fat: 16, fibre: 9, sugar: 22, sodium: 180, time: NOW.getTime() - 9e6 }], restingOverride: 2800, active: 640 };
}
const empty = JSON.parse(JSON.stringify(fresh));

const all = [];
const runs = [
  ...DEVICES.flatMap((d) => ["light", "dark"].map((t) => ({ d, t, state: seeded, data: process.env.E2E_STATE ? "backup" : "fixture" }))),
  // Nothing eaten gives the widest numbers; test it on the narrowest and the Pro.
  ...[DEVICES[0], DEVICES[2]].flatMap((d) => ["light", "dark"].map((t) => ({ d, t, state: empty, data: "empty" }))),
];
let jsErrors = [];
// Runs are independent (own context, own storage), so a few go at once.
const JOBS = Number(process.env.LAYOUT_JOBS) || 3;
async function doRun(run) {
  const { ctx, page, errors } = await open(run.d, run.t, run.state);
  for (const sc of SCREENS) {
    if (run.data === "empty" && /unit review|swap/.test(sc.name)) continue;
    try {
      await sc.run(page);
      await page.waitForTimeout(350);
      const f = await page.evaluate(measure, sc.root);
      for (const x of f) {
        if (ALLOW.some((a) => a.check === x.check && a.path.test(x.path))) continue;
        x.where = `${sc.name} @${run.d.name} ${run.t} ${run.data}`;
        if (OUT && x.rect && x.rect.w > 0) {
          const file = `${OUT}/${all.length}-${x.check}.png`;
          try { await page.screenshot({ path: file, clip: { x: Math.max(0, x.rect.x - 14), y: Math.max(0, x.rect.y - 14), width: Math.min(run.d.w, x.rect.w + 28), height: Math.min(run.d.h, x.rect.h + 28) } }); x.crop = file; } catch (_) {}
        }
        all.push(x);
      }
      if (sc.after) await sc.after(page);
      await page.waitForTimeout(120);
    } catch (e) { all.push({ check: "harness", path: sc.name, text: String(e.message).slice(0, 140), detail: "", where: `${sc.name} @${run.d.name} ${run.t} ${run.data}` }); }
  }
  jsErrors.push(...errors);
  await ctx.close();
}
const queue = runs.slice();
await Promise.all(Array.from({ length: JOBS }, async () => { while (queue.length) await doRun(queue.shift()); }));
await browser.close();
server.close();

// Report: one line per check, deduplicated across widths/themes.
const CHECKS = ["offscreen", "clipped", "container", "ring", "overlap", "contrast", "size", "tap", "leftover", "harness"];
let failed = 0;
const LABEL = {
  offscreen: "nothing runs off the screen or scrolls sideways", clipped: "no text is cut off", container: "text stays inside its card, pill or button",
  ring: "numbers inside a ring clear its stroke", overlap: "no text is drawn over other text", contrast: "text is readable (4.5:1, 3:1 large) in both themes",
  size: "no text under 11px (tab bar exempt)", tap: "every control is at least 44x44", leftover: "no old volt colours, shouty labels, '·', em dashes or placeholders",
  harness: "every screen could be opened",
};
for (const c of CHECKS) {
  const hits = all.filter((x) => x.check === c);
  const uniq = new Map();
  for (const h of hits) { const k = h.path + "|" + h.text; if (!uniq.has(k)) uniq.set(k, { ...h, n: 0, wheres: new Set() }); const u = uniq.get(k); u.n++; u.wheres.add(h.where.split(" @")[0] + " on " + h.where.split(" @")[1].replace(/ (light|dark) .*/, "") + (/ dark /.test(h.where) ? " (dark)" : "")); }
  const ok = uniq.size === 0;
  if (!ok) failed++;
  console.log(`  ${ok ? "✓" : "✗"}  layout: ${LABEL[c]}${ok ? "" : ` (${uniq.size})`}`);
  if (!ok) for (const u of [...uniq.values()].slice(0, process.env.LAYOUT_ALL ? 999 : 8)) console.log(`       ${u.path}  "${u.text}"  ${u.detail}  [${[...u.wheres].join(", ")}; ${u.n}x]${u.crop ? "  " + u.crop : ""}`);
}
const errs = [...new Set(jsErrors)];
console.log(`  ${errs.length ? "✗" : "✓"}  layout: no JS errors while opening every screen${errs.length ? " · " + errs.slice(0, 3).join(" | ") : ""}`);
if (errs.length) failed++;
console.log(`\n  layout audit: ${CHECKS.length + 1 - failed} passed, ${failed} failed (${DEVICES.map((d) => d.name).join(", ")}; light + dark; ${runs.length} runs x ${SCREENS.length} screens)`);
process.exit(failed ? 1 : 0);

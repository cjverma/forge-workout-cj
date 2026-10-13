/**
 * Runtime checks: boots the built app in a real headless browser, seeds the
 * states that only exist once there is data, and looks for the class of bug
 * static source/regex checks structurally cannot see — a cascade conflict
 * that loses a hero's gradient, an un-interpolated `${...}` reaching the DOM,
 * or a JS error on render. Invoked by `node test.js` (falls back to a skip
 * line if this file or Playwright is unavailable) or directly via
 * `npm run verify`.
 *
 * Usage: node verify-runtime.mjs      (also invoked by node test.js)
 */
import { spawn } from "child_process";
import { chromium } from "playwright";
import { programFor, FEATURES } from "./src/constants.js";

const PORT = 8791;
const URL = `http://127.0.0.1:${PORT}/dist/index.html`;
const CHROME = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

const fails = [];
const note = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"}  ${label}${!ok && detail ? " — " + detail : ""}`);
  if (!ok) fails.push(label);
};

// Seeds the states that only exist once there is data. The plan-queued string
// is the one that shipped broken: it does not render until a plan exists, so
// every earlier screenshot missed it.
const SEED = (seedEx) => {
  const S = JSON.parse(localStorage.f5);
  // The one-off "mark Mon 28 Sep done" pass would pre-complete the very
  // exercise the toggleSet check taps when the test runs on that Monday.
  S._v6MonDone1 = true;
  const iso = (d) => d.toLocaleDateString("en-CA", { timeZone: "America/Toronto" });
  const j = new Date(new Date().getFullYear(), 0, 1);
  const wk = (y) => (()=>{const _d=new Date(y.getFullYear(),y.getMonth(),y.getDate(),12);_d.setDate(_d.getDate()-((_d.getDay()+6)%7)+2);const _j=new Date(_d.getFullYear(),0,1);return _d.getFullYear()+"W"+Math.ceil(((_d-_j)/86400000+_j.getDay()+1)/7);})(); // Monday-based, as the app
  const now = new Date(), nxt = new Date(); nxt.setDate(nxt.getDate() + 7);
  S.weekPlans = { [wk(now)]: { Monday: [] }, [wk(nxt)]: { Monday: [] } };
  const ago = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return iso(d); };
  // Two PR shapes the plan generator has to tell apart: one set this week
  // (step the hint up) and one two months stale (do not jump back to it).
  S.prs = {
    seated_cable_row: [{ date: iso(now), weight: 40, reps: 10, est: 53 }],
    cable_pallof_press: [{ date: iso(now), weight: 18, reps: 12, est: 25 }],
    leg_press_machine: [{ date: ago(60), weight: 150, reps: 8, est: 190 }],
  };
  // Logged in LBS on purpose: the payload must carry kg, not the typed number.
  // seedEx.day/seedEx.id come from the REAL, currently-active program (passed
  // in from Node via programFor(new Date())) so this keeps working across
  // every program-version boundary instead of rotting at the next one.
  S.sessions = S.sessions || {};
  S.sessions[seedEx.day + "_" + wk(now)] = {
    [seedEx.id]: { done: true, unit: "lbs", sets: [{ done: true, weight: 220, reps: 10 }] },
  };
  S.nutrition = S.nutrition || {};
  S.nutrition.days = S.nutrition.days || {};
  S.nutrition.weights = S.nutrition.weights || {};
  for (let i = 0; i < 6; i++) {
    const d = new Date(); d.setDate(d.getDate() - i);
    S.nutrition.days[iso(d)] = {
      items: [{ name: "Meal", kcal: 1300, protein: 135, carbs: 120, fat: 35, fibre: 30, sugar: 20, sodium: 1500 }],
      active: 900, restingOverride: 3000,
    };
    S.nutrition.weights[iso(d)] = 140 - i * 0.2;
  }
  S.meds = { zepbound: { doses: [{ date: iso(now), mg: 5, clientId: "x" }] } };
  S.milestones = { longestStreak: 5, shownWeek6: [], shownProtein7: [], shownWeight5kg: [] };
  localStorage.f5 = JSON.stringify(S);
};

// A real gym exercise from whichever program is active TODAY, not a hardcoded
// id — the active program changes on a schedule, and this must survive every
// boundary without needing a follow-up edit here.
// In Toronto wall-clock time, because the page under test runs with
// timezoneId America/Toronto: near midnight UTC the two dates differ, and on
// a program boundary that seeded an id the page's PROG did not contain.
const _todayProg = programFor(new Date(new Date().toLocaleString("en-US", { timeZone: "America/Toronto" })));
let SEED_EX = null;
for (const [day, d] of Object.entries(_todayProg)) {
  const gym = (d.exercises || []).find((e) => e.cat === "gym");
  if (gym) { SEED_EX = { day, id: gym.id }; break; }
}
if (!SEED_EX) throw new Error("no gym exercise found in today's active program to seed with");

const srv = spawn("node", ["server.js"], { env: { ...process.env, PORT: String(PORT) }, stdio: "ignore" });
const stop = () => { try { srv.kill("SIGKILL"); } catch {} };
process.on("exit", stop);

let browser;
try {
  // wait for the server
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(URL); if (r.ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }

  browser = await chromium.launch({ executablePath: CHROME });
  const jsErrors = [];

  for (const theme of ["dark", "light"]) {
    const page = await browser.newPage({
      viewport: { width: 412, height: 1200 }, colorScheme: theme, timezoneId: "America/Toronto",
    });
    page.on("pageerror", (e) => jsErrors.push(`${theme}: ${e.message}`));
    await page.addInitScript(() => { window.FORGE_API_CFG = { baseUrl: "", token: "x" }; });
    await page.goto(URL, { waitUntil: "networkidle" });
    await page.waitForTimeout(900);
    await page.evaluate(SEED, SEED_EX);
    await page.reload({ waitUntil: "networkidle" });
    await page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
    await page.waitForTimeout(1300);

    const leaks = [];
    for (const [tab, id] of [["workout", "#nav-workout"], ["nutrition", "#nav-nutrition"], ["settings", "#nav-settings"]]) {
      await page.locator(id).click();
      await page.waitForTimeout(1200);
      await page.evaluate(() => document.querySelectorAll("details").forEach((d) => (d.open = true)));
      await page.waitForTimeout(400);
      for (const m of await page.evaluate(() => document.body.innerText.match(/\$\{[^}\n]{0,60}\}?/g) || [])) {
        leaks.push(`${tab}: ${m}`);
      }
    }
    await page.evaluate(() => window.openDrawer && window.openDrawer());
    await page.waitForTimeout(800);
    for (const m of await page.evaluate(() => document.body.innerText.match(/\$\{[^}\n]{0,60}\}?/g) || [])) {
      leaks.push(`drawer: ${m}`);
    }
    note(`${theme}: no template placeholders in rendered text`, leaks.length === 0, [...new Set(leaks)].join(", "));

    // Est. 1RM is a formula output, least accurate at the 10-12 reps this
    // program lives at, and there will never be a measured single to check it
    // against. The set that actually happened leads; the estimate trails.
    const prRow = await page.evaluate(() => {
      const el = [...document.querySelectorAll(".rule-desc")].find(d => /est\. 1RM/.test(d.textContent));
      return el ? el.textContent.trim() : "";
    });
    // The PR list can be switched off (FEATURES.prList); only check it when on.
    if (FEATURES.prList) note(`${theme}: PR row leads with the set lifted, not the estimate`,
      /^40kg × 10 .*est\. 1RM 53kg$/.test(prRow), prRow);
    else note(`${theme}: PR list is hidden while switched off`, prRow === "", prRow);

    // Close the drawer first: it overlays the nav and swallows the click.
    await page.evaluate(() => window.closeDrawer && window.closeDrawer());
    await page.waitForTimeout(500);

    // Heroes are theme-independent dark surfaces. A same-specificity rule can
    // win and wash them out with the stylesheet still looking correct.
    await page.locator("#nav-nutrition").click();
    await page.waitForTimeout(1200);
    const heroes = await page.evaluate(() => {
      const lum = (c) => { const [r, g, b] = c.map((x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
      const nums = (s) => (s.match(/\d+(\.\d+)?/g) || []).slice(0, 3).map(Number);
      const out = {};
      for (const sel of [".nut-hero", ".quote-card"]) {
        const el = document.querySelector(sel);
        if (!el) continue;
        const cs = getComputedStyle(el);
        const fg = nums(cs.color), bg = nums(cs.backgroundImage);
        if (fg.length < 3 || bg.length < 3) { out[sel] = { contrast: 0 }; continue; }
        const [hi, lo] = lum(fg) > lum(bg) ? [lum(fg), lum(bg)] : [lum(bg), lum(fg)];
        out[sel] = { contrast: +(((hi + 0.05) / (lo + 0.05)).toFixed(2)), gradient: cs.backgroundImage.startsWith("linear-gradient") };
      }
      return out;
    });
    for (const [sel, v] of Object.entries(heroes)) {
      note(`${theme}: ${sel} keeps its gradient and stays legible (${v.contrast}:1)`, v.gradient && v.contrast >= 4.5);
    }
    await page.close();
  }

  // The weekly-plan payload. Progressive overload is only as good as what the
  // AI is handed: PRs have to be joined to next week's exercise ids here, and
  // logged sets have to arrive in kg, since every hint the AI writes is kg.
  {
    const page = await browser.newPage({ viewport: { width: 412, height: 1200 }, timezoneId: "America/Toronto" });
    page.on("pageerror", (e) => jsErrors.push(`plan: ${e.message}`));
    await page.addInitScript(() => { window.FORGE_API_CFG = { baseUrl: "", token: "x" }; });
    let body = null;
    await page.route("**/weekly-plan", (r) => {
      body = JSON.parse(r.request().postData() || "{}");
      r.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ text: '{"week_plan":{},"coaching_notes":"n","flags":[]}' }) });
    });
    await page.goto(URL, { waitUntil: "networkidle" });
    await page.waitForTimeout(900);
    await page.evaluate(SEED, SEED_EX);
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(1300);
    await page.locator("#nav-settings").click();
    await page.waitForTimeout(1000);
    await page.evaluate(() => window.genWeeklyPlan());
    for (let i = 0; i < 40 && !body; i++) await page.waitForTimeout(250);

    const prs = body?.profile?.prs || [];
    const byName = (n) => prs.find((p) => p.name === n);
    const pp = byName("Pallof Press"), lp = byName("Leg Press Machine");
    note(`weekly-plan payload carries a PR row per gym exercise (${prs.length})`, prs.length >= 8);
    note("PR joins to the plan exercise id and is flagged as set this week",
      !!pp && pp.hasPR && pp.bestKg === 18 && pp.setThisWeek === true && /^[a-z0-9]+_pp$/.test(pp.id || ""),
      JSON.stringify(pp));
    note("a stale PR carries its age instead of reading as current",
      !!lp && lp.hasPR && lp.daysAgo >= 55 && lp.setThisWeek === false, JSON.stringify(lp));
    note("an exercise with no history says so rather than being omitted",
      prs.some((p) => p.hasPR === false));
    const logged = body?.sessionHistory?.[0]?.sessions?.[SEED_EX.day]?.find((e) => e.id === SEED_EX.id);
    note("the AI gets each exercise's set-to-set trend (fatigue) alongside its sets",
      !!logged && "fatigue" in logged, JSON.stringify(logged?.fatigue));
    note("logged sets reach the AI in kg, not the typed lbs",
      !!logged && logged.sets_logged?.[0]?.kg === 99.8, JSON.stringify(logged?.sets_logged));
    await page.close();
  }

  // Weekend auto-plan. Clock frozen on Sun 4 Oct 2026: the last day of the
  // V6 deload week, planning Mon 5 Oct, which is full Southpaw. That boundary
  // is the case that used to fail twice over: nothing generated unless tapped,
  // and the plan's Southpaw ids were checked against the ramp week's program
  // and silently dropped. Fixed dates, so the ids below stay valid forever.
  {
    const target = programFor(new Date(2026, 9, 5)).Monday.exercises.find((e) => e.cat === "gym" && !/^Warm-Up/.test(e.name));
    const page = await browser.newPage({ viewport: { width: 412, height: 1200 }, timezoneId: "America/Toronto" });
    page.on("pageerror", (e) => jsErrors.push(`autoplan: ${e.message}`));
    await page.clock.setFixedTime(new Date("2026-10-04T15:00:00-04:00"));
    await page.addInitScript(() => { window.FORGE_API_CFG = { baseUrl: "", token: "x" }; });
    let calls = 0;
    await page.route("**/weekly-plan", (r) => {
      calls++;
      r.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ text: JSON.stringify({ week_plan: { Monday: [{ id: target.id, sets: 5, hint: "41 kg" }] }, coaching_notes: "auto", flags: [] }) }) });
    });
    await page.goto(URL, { waitUntil: "networkidle" });
    await page.waitForTimeout(2500);
    const r = await page.evaluate(() => {
      const S = JSON.parse(localStorage.f5 || "{}");
      const wp = (S.weekPlans || {})["2026W41"] || null;
      return { prog: wp?._prog, monday: wp?.Monday || null, modal: !!document.querySelector("#planModal.show"), notes: S._lastPlanNotes?.notes };
    });
    note("the week's plan generates automatically on Sunday, with no tap and no review modal",
      calls === 1 && r.prog === "v4" && !r.modal && r.notes === "auto", JSON.stringify({ calls, ...r }));
    note("a Sunday plan for a week on a different program keeps its updates (ids checked against the target week)",
      Array.isArray(r.monday) && r.monday.some((u) => u.id === target.id && u.sets === 5), JSON.stringify(r.monday));
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(1500);
    note("auto-plan runs once: a plan already in place is never regenerated", calls === 1, "calls=" + calls);
    await page.close();
  }
  // A plan stamped for another program does not count as planned: it would be
  // refused at apply time, so auto-plan replaces it instead of leaving the
  // week unplanned. Mon 5 Oct 2026 (Southpaw, v4) with a stale v6 plan.
  {
    const page = await browser.newPage({ viewport: { width: 412, height: 1200 }, timezoneId: "America/Toronto" });
    page.on("pageerror", (e) => jsErrors.push(`autoplan-stale: ${e.message}`));
    await page.clock.setFixedTime(new Date("2026-10-05T09:00:00-04:00"));
    await page.addInitScript(() => {
      window.FORGE_API_CFG = { baseUrl: "", token: "x" };
      if (!localStorage.f5) localStorage.f5 = JSON.stringify({ weekPlans: { "2026W41": { _prog: "v6", Monday: [{ id: "m6_csr", sets: 9 }] } }, _planMove41: true });
    });
    let calls = 0;
    await page.route("**/weekly-plan", (r) => { calls++; r.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ text: JSON.stringify({ week_plan: { Monday: [] }, coaching_notes: "n", flags: [] }) }) }); });
    await page.goto(URL, { waitUntil: "networkidle" });
    await page.waitForTimeout(2500);
    const wp = await page.evaluate(() => JSON.parse(localStorage.f5 || "{}").weekPlans?.["2026W41"]);
    note("a plan made for another program is replaced by auto-plan, not kept or merged",
      calls === 1 && wp?._prog === "v4" && !JSON.stringify(wp).includes("m6_csr"), JSON.stringify({ calls, wp }));
    await page.close();
  }

  // kg/lbs mix-ups. History: four past sets at 50 kg on today's first gym
  // exercise, plus one past set logged "120 kg" with a matching inflated PR
  // (the Leg Extension case: 120 lbs typed while the exercise said kg).
  {
    const mk = async (dialogAnswer) => {
      const page = await browser.newPage({ viewport: { width: 412, height: 1400 }, timezoneId: "America/Toronto" });
      page.on("pageerror", (e) => jsErrors.push(`units: ${e.message}`));
      await page.addInitScript(() => { window.FORGE_API_CFG = { baseUrl: "", token: "x" }; });
      await page.goto(URL, { waitUntil: "networkidle" });
      await page.waitForTimeout(800);
      const exId = await page.evaluate(() => {
        const inp = [...document.querySelectorAll(".si")].find((i) => i.id.startsWith("wi-"));
        return inp ? inp.id.replace("wi-", "").replace(/-\d+$/, "") : null;
      });
      const day = await page.evaluate((exId) => {
        const S = JSON.parse(localStorage.f5);
        const wkOf = (d) => (()=>{const _d=new Date(d.getFullYear(),d.getMonth(),d.getDate(),12);_d.setDate(_d.getDate()-((_d.getDay()+6)%7)+2);const _j=new Date(_d.getFullYear(),0,1);return _d.getFullYear()+"W"+Math.ceil(((_d-_j)/86400000+_j.getDay()+1)/7);})();
        const day = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][new Date().getDay()];
        S.sessions = {};
        for (let n = 1; n <= 4; n++) {
          const d = new Date(); d.setDate(d.getDate() - 7 * n);
          S.sessions[day + "_" + wkOf(d)] = { [exId]: { unit: "kg", done: true, sets: [{ weight: "50", reps: "12", done: true }, { weight: n === 2 ? "120" : "50", reps: n === 2 ? "15" : "12", done: true }] } };
        }
        S.prs = {}; S._v6MonDone1 = true; S._planMove41 = true;
        localStorage.f5 = JSON.stringify(S);
        try { localStorage.setItem("f5_unitreview_" + new Date().toLocaleDateString("en-CA", { timeZone: "America/Toronto" }), "1"); } catch {}
        return day;
      }, exId);
      if (dialogAnswer !== undefined) page.on("dialog", (d) => (dialogAnswer ? d.accept() : d.dismiss()));
      await page.reload({ waitUntil: "networkidle" });
      await page.waitForTimeout(900);
      return { page, exId, day };
    };

    // 1. Typing 120 in kg mode on a ~50 kg exercise prompts; OK converts.
    {
      const { page, exId } = await mk(true);
      await page.locator(`#ex-${exId} .ex-top`).click().catch(() => {});
      await page.waitForTimeout(300);
      await page.locator(`#wi-${exId}-0`).fill("120");
      await page.locator(`#ri-${exId}-0`).fill("10");
      await page.locator(`#ex-${exId} .sdone`).first().click();
      await page.waitForTimeout(400);
      const w = await page.evaluate((id) => document.getElementById(`wi-${id}-0`)?.value, exId);
      note("ticking a set ~2.2x heavier than usual asks, and OK logs it converted (120 -> 54.4 kg)", w === "54.4", "value=" + w);
      const unit = await page.evaluate((id) => document.querySelector(`#sr-${id}-0 .wt-wrap`)?.dataset.unit, exId);
      note("every weight box shows its unit inline", unit === "kg", "unit=" + unit);
      await page.close();
    }
    // 2. Cancel keeps the typed number and never asks about that set again.
    {
      const { page, exId } = await mk(false);
      await page.locator(`#ex-${exId} .ex-top`).click().catch(() => {});
      await page.waitForTimeout(300);
      await page.locator(`#wi-${exId}-0`).fill("120");
      await page.locator(`#ri-${exId}-0`).fill("10");
      await page.locator(`#ex-${exId} .sdone`).first().click();
      await page.waitForTimeout(400);
      const r = await page.evaluate(({ id }) => { const S = JSON.parse(localStorage.f5); const k = Object.keys(S.sessions).find((k) => S.sessions[k][id]?.sets?.[0]?.weight === "120" && S.sessions[k][id].sets[0].done); return k ? S.sessions[k][id].sets[0] : null; }, { id: exId });
      note("Cancel keeps the weight as typed and marks it confirmed", !!r && r.unitOk === true, JSON.stringify(r));
      await page.close();
    }
    // 3. Review sheet: the past 120 kg set is listed; Convert fixes it and the PR.
    {
      const { page, exId } = await mk();
      await page.evaluate(() => window.openUnitReview());
      await page.waitForTimeout(300);
      const listed = await page.evaluate(() => document.querySelectorAll("#planModal.show .pm-change").length);
      note("the review sheet lists the one past set that looks like lbs, and nothing else", listed === 1, "rows=" + listed);
      await page.locator("#planModal .uf-btns .pm-apply").first().click();
      await page.waitForTimeout(400);
      const r = await page.evaluate((id) => {
        const S = JSON.parse(localStorage.f5);
        const all = Object.values(S.sessions).flatMap((s) => (s[id]?.sets || []));
        return { weights: all.map((x) => x.weight), maxPR: Math.max(0, ...Object.values(S.prs || {}).flat().map((e) => e.est)) };
      }, exId);
      note("Convert rewrites the set (120 -> 54.4 kg) and the PR is rebuilt from the corrected log",
        r.weights.includes("54.4") && !r.weights.includes("120") && r.maxPR === 82, JSON.stringify(r)); // 54.4 kg x 15 -> 82 est, was 180
      await page.close();
    }
    // 4. A fresh entry starts in the unit last used for that exercise.
    {
      const { page, exId } = await mk();
      await page.evaluate((id) => { const S = JSON.parse(localStorage.f5); for (const s of Object.values(S.sessions)) if (s[id]) s[id].unit = "lbs"; localStorage.f5 = JSON.stringify(S); }, exId);
      await page.reload({ waitUntil: "networkidle" });
      await page.waitForTimeout(800);
      const unit = await page.evaluate((id) => document.querySelector(`#sr-${id}-0 .wt-wrap`)?.dataset.unit, exId);
      note("a new entry defaults to the unit last used on that exercise (lbs)", unit === "lbs", "unit=" + unit);
      await page.close();
    }
  }

  // Inline icons sit on the text baseline by default and poke up above the
  // letters (Start Workout's bolt). Measure the real render: centred within 2px.
  {
    const page = await browser.newPage({ viewport: { width: 412, height: 900 }, timezoneId: "America/Toronto" });
    await page.addInitScript(() => { window.FORGE_API_CFG = { baseUrl: "", token: "x" }; });
    await page.goto(URL, { waitUntil: "networkidle" });
    await page.waitForTimeout(800);
    const r = await page.evaluate(() => {
      const b = document.getElementById("bStart"); if (!b) return null;
      const i = b.querySelector(".icon").getBoundingClientRect();
      const rg = document.createRange(); rg.selectNodeContents(b.lastChild); const t = rg.getBoundingClientRect();
      return Math.abs((i.top + i.bottom) / 2 - (t.top + t.bottom) / 2);
    });
    note("an inline icon is vertically centred on its text (Start Workout)", r === null || r <= 2, "offset=" + r);
    // Sweep EVERY icon on every tab against the text on its line. Leading row
    // icons (.ex-icon, .st-icon) are centred on a two-line block by design.
    const bad = [];
    for (const tab of ["workout", "nutrition", "settings"]) {
      await page.evaluate((t) => document.getElementById("nav-" + t)?.click(), tab);
      await page.waitForTimeout(600);
      await page.evaluate(() => { document.querySelectorAll("details").forEach((d) => (d.open = true)); document.querySelectorAll(".sets-body").forEach((x) => x.classList.add("open")); });
      await page.waitForTimeout(200);
      bad.push(...(await page.evaluate((tab) => {
        const out = [];
        for (const svg of document.querySelectorAll("svg.icon")) {
          if (svg.closest(".ex-icon,.st-icon")) continue;
          const ir = svg.getBoundingClientRect(); if (!ir.width) continue;
          const mid = (ir.top + ir.bottom) / 2;
          const w = document.createTreeWalker(svg.parentElement, NodeFilter.SHOW_TEXT);
          let n, tr = null;
          while ((n = w.nextNode())) { if (!n.textContent.trim()) continue; const rg = document.createRange(); rg.selectNodeContents(n); tr = [...rg.getClientRects()].find((r) => Math.abs((r.top + r.bottom) / 2 - mid) < ir.height); if (tr) break; }
          if (tr && Math.abs((tr.top + tr.bottom) / 2 - mid) > 2) out.push(tab + ":" + (svg.parentElement.className || svg.parentElement.tagName));
        }
        return out;
      }, tab)));
    }
    note("every inline icon on every tab is centred on its text (within 2px)", bad.length === 0, bad.slice(0, 5).join(", "));
    await page.close();
  }

  // Overload badge + hint wording, from two real screenshots. Pec Fly: last
  // week 90 lbs x 12 (40.8 kg), today 36x15 then 52x18 kg showed a DOWN arrow
  // (raw average 44 vs 90, units and reps ignored). Seated DB Curl in lbs
  // showed "7-9 lbs" beside the LBS label: a kg range relabelled, unit doubled.
  {
    const page = await browser.newPage({ viewport: { width: 412, height: 1400 }, timezoneId: "America/Toronto" });
    page.on("pageerror", (e) => jsErrors.push(`overload: ${e.message}`));
    await page.addInitScript(() => { window.FORGE_API_CFG = { baseUrl: "", token: "x" }; });
    await page.goto(URL, { waitUntil: "networkidle" });
    await page.waitForTimeout(800);
    const ex = await page.evaluate(() => {
      // Multi-set exercises only: the "Last:" line and badge skip 1-set warm-ups.
      const ids = [...document.querySelectorAll(".si")].filter((i) => /^wi-.*-1$/.test(i.id)).map((i) => i.id.replace("wi-", "").replace(/-\d+$/, ""));
      return [...new Set(ids)].slice(0, 2);
    });
    await page.evaluate(([a, b]) => {
      const S = JSON.parse(localStorage.f5);
      const wkOf = (d) => (()=>{const _d=new Date(d.getFullYear(),d.getMonth(),d.getDate(),12);_d.setDate(_d.getDate()-((_d.getDay()+6)%7)+2);const _j=new Date(_d.getFullYear(),0,1);return _d.getFullYear()+"W"+Math.ceil(((_d-_j)/86400000+_j.getDay()+1)/7);})();
      const day = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][new Date().getDay()];
      const prev = new Date(); prev.setDate(prev.getDate() - 7);
      S.sessions = {
        [day + "_" + wkOf(prev)]: { [a]: { unit: "lbs", done: true, sets: [{ weight: "90", reps: "12", done: true }] } },
        [day + "_" + wkOf(new Date())]: { [a]: { unit: "kg", sets: [{ weight: "36", reps: "15", done: true }, { weight: "52", reps: "18", done: true }] }, [b]: { unit: "lbs", sets: [] } },
      };
      S._v6MonDone1 = true; S._planMove41 = true;
      localStorage.f5 = JSON.stringify(S);
      try { localStorage.setItem("f5_unitreview_" + new Date().toLocaleDateString("en-CA", { timeZone: "America/Toronto" }), "1"); } catch {}
    }, ex);
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(900);
    const r = await page.evaluate(([a, b]) => ({
      up: !!document.querySelector(`#ex-${a} .ol-up`), down: !!document.querySelector(`#ex-${a} .ol-down`),
      ghost: document.querySelector(`#ex-${a} .last-ghost`)?.textContent || "",
      ph: document.getElementById(`wi-${b}-0`)?.placeholder || "",
    }), ex);
    note("overload badge uses the best set (weight x reps, in kg): a PR set shows up, not down", r.up && !r.down, JSON.stringify(r));
    note("'Last best:' converts the previous session's unit (90 lbs -> 40.8 kg)", /Last best: 40\.8 kg × 12/.test(r.ghost), r.ghost);
    note("an lbs weight box hint is converted numbers only, never a kg range labelled lbs", !/lbs|kg/i.test(r.ph), "placeholder=" + r.ph);
    await page.close();
  }

  // A running workout survives the app being unloaded (iOS kills backgrounded
  // PWAs; it used to come back with Start Workout showing and the timer gone).
  // And the target is last session's best set, pre-filled.
  {
    const page = await browser.newPage({ viewport: { width: 412, height: 1400 }, timezoneId: "America/Toronto" });
    page.on("pageerror", (e) => jsErrors.push(`active: ${e.message}`));
    page.on("dialog", (d) => d.accept());
    // Pinned to a Monday (a gym day) so this does not depend on the day it runs.
    await page.clock.install({ time: new Date("2026-10-12T10:00:00-04:00") });
    await page.addInitScript(() => { window.FORGE_API_CFG = { baseUrl: "", token: "x" }; });
    await page.goto(URL, { waitUntil: "networkidle" });
    await page.waitForTimeout(800);
    // A gym exercise (physio has no weight target), so this works on rest days too.
    const exId = await page.evaluate(() => {
      const ids = [...document.querySelectorAll(".si")].filter((i) => /^wi-.*-1$/.test(i.id)).map((i) => i.id.replace("wi-", "").replace(/-\d+$/, ""));
      return ids.find((id) => document.querySelector(`#ex-${id} .ex-icon.gym`)) || ids[0];
    });
    await page.evaluate((a) => {
      const S = JSON.parse(localStorage.f5);
      const wkOf = (d) => (()=>{const _d=new Date(d.getFullYear(),d.getMonth(),d.getDate(),12);_d.setDate(_d.getDate()-((_d.getDay()+6)%7)+2);const _j=new Date(_d.getFullYear(),0,1);return _d.getFullYear()+"W"+Math.ceil(((_d-_j)/86400000+_j.getDay()+1)/7);})();
      const day = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][new Date().getDay()];
      const prev = new Date(); prev.setDate(prev.getDate() - 7);
      S.sessions = { [day + "_" + wkOf(prev)]: { [a]: { unit: "kg", done: true, sets: [{ weight: "40", reps: "12", done: true }, { weight: "45", reps: "10", done: true }] } } };
      S._v6MonDone1 = true; S._planMove41 = true;
      localStorage.f5 = JSON.stringify(S);
      try { localStorage.setItem("f5_unitreview_" + new Date().toLocaleDateString("en-CA", { timeZone: "America/Toronto" }), "1"); } catch {}
    }, exId);
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(800);
    const t = await page.evaluate((a) => ({ meta: document.querySelector(`#ex-${a} .ex-meta`)?.textContent || "", pre: document.getElementById(`wi-${a}-0`)?.value }), exId);
    note("the suggested weight is last session's best set (Beat 45 kg × 10), pre-filled", /Beat 45 kg × 10/.test(t.meta) && t.pre === "45", JSON.stringify(t));
    await page.evaluate(() => window.startSess());
    await page.waitForTimeout(300);
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(900);
    const on = await page.evaluate(() => ({ stop: document.getElementById("bStop")?.classList.contains("show"), start: !document.getElementById("bStart")?.classList.contains("hide") }));
    note("a running workout survives a reload (iOS unloading the app)", on.stop && !on.start, JSON.stringify(on));
    await page.evaluate(() => window.stopSess());
    await page.waitForTimeout(300);
    await page.evaluate(() => window.closeSummary?.());
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(900);
    const off = await page.evaluate(() => !document.getElementById("bStop")?.classList.contains("show"));
    note("a stopped workout stays stopped after a reload", off);
    await page.close();
  }

  // NOTHING may move logged work automatically. The week repair, re-running
  // after every sync (its flag was never stored server-side), treated a Legs
  // session logged early on the Wednesday Oct 14 screen as "dated in the
  // future" and merged it into the previous Wednesday, overwriting a set.
  // Seed exactly that, reload, then simulate a sync wiping the S._ flags and
  // reload again: the session must stay where it was logged, both times.
  {
    const page = await browser.newPage({ viewport: { width: 412, height: 900 }, timezoneId: "America/Toronto" });
    page.on("pageerror", (e) => jsErrors.push(`nomove: ${e.message}`));
    await page.clock.install({ time: new Date("2026-10-12T20:00:00-04:00") });
    await page.addInitScript(() => {
      window.FORGE_API_CFG = { baseUrl: "", token: "" };
      if (!localStorage.f5) localStorage.f5 = JSON.stringify({ sessions: {
        Wednesday_2026W42: { w7_cp: { done: true, unit: "kg", sets: [{ weight: "50", reps: "10", done: true }] } },
        Wednesday_2026W41: { w4_slc: { done: true, unit: "lbs", sets: [{ weight: "160", reps: "12", done: true }] } } } });
    });
    const keys = () => page.evaluate(() => { const S = JSON.parse(localStorage.f5); return { w42: Object.keys(S.sessions.Wednesday_2026W42 || {}), w41: JSON.stringify(S.sessions.Wednesday_2026W41?.w4_slc?.sets) }; });
    await page.goto(URL, { waitUntil: "networkidle" }); await page.waitForTimeout(800);
    const a = await keys();
    // A sync replaces S wholesale: drop every S._flag as the server would.
    await page.evaluate(() => { const S = JSON.parse(localStorage.f5); for (const k of Object.keys(S)) if (k.startsWith("_")) delete S[k]; localStorage.f5 = JSON.stringify(S); });
    await page.reload({ waitUntil: "networkidle" }); await page.waitForTimeout(800);
    const b = await keys();
    const ok = (k) => k.w42.includes("w7_cp") && /160/.test(k.w41);
    note("a session logged early on a future day's screen stays where it was logged (no auto-move)", ok(a), JSON.stringify(a));
    note("...and still stays after a sync wipes the S._ flags (one-time repairs do not re-run)", ok(b), JSON.stringify(b));
    note("one-time repair flags survive a sync (kept outside the synced state)",
      await page.evaluate(() => JSON.parse(localStorage.f5_once || "[]").includes("_v7Move1")));
    await page.close();
  }

  // The user's Oct 12 data, exactly as the re-running repair left it: Oct 12's
  // Legs exercises inside Wednesday Oct 7, Oct 7's leg curl overwritten, and
  // Monday Oct 12 holding the chest sets logged that day. The one-off repair
  // moves Oct 12's work to Monday (V7 ids), restores Oct 7's leg curl, and
  // leaves Monday's chest sets on Monday (never onto Wednesday Oct 14).
  {
    const page = await browser.newPage({ viewport: { width: 412, height: 900 }, timezoneId: "America/Toronto" });
    page.on("pageerror", (e) => jsErrors.push(`oct12: ${e.message}`));
    await page.clock.install({ time: new Date("2026-10-13T10:00:00-04:00") });
    await page.addInitScript(() => {
      window.FORGE_API_CFG = { baseUrl: "", token: "x" };
      const st = (u, ws) => ({ done: true, skipped: false, unit: u, sets: ws.map(([w, r]) => ({ done: true, reps: String(r), weight: String(w), attempted: true })) });
      if (!localStorage.f5) localStorage.f5 = JSON.stringify({ sessions: {
        Wednesday_2026W41: { w4_lp: st("kg", [[118, 21]]), w4_slc: st("kg", [[60, 15], [70, 17], [70, 17], [70, 18]]), w4_calf: st("kg", [[51, 12]]), w4_hiad: st("kg", [[72, 15]]), w4_slr: st("lbs", [[12.5, 12]]) },
        Monday_2026W42: { m4_cp: st("kg", [[54, 9], [50, 8]]), m4_cpwu: st("kg", [[50, 12]]) } },
        weekPlans: {} });
    });
    await page.goto(URL, { waitUntil: "networkidle" }); await page.waitForTimeout(900);
    const r = await page.evaluate(() => { const S = JSON.parse(localStorage.f5); return { w41: Object.keys(S.sessions.Wednesday_2026W41).sort(), slc: S.sessions.Wednesday_2026W41.w4_slc, mon: Object.keys(S.sessions.Monday_2026W42).sort(), wed42: Object.keys(S.sessions.Wednesday_2026W42 || {}) }; });
    note("Oct 12's legs move from Wed Oct 7 to Mon Oct 12 (V7 ids), Oct 7's leg curl restored (160x12, 145x10 lbs)",
      ["m7_calf", "m7_hiad", "m7_slc", "m7_slr"].every((k) => r.mon.includes(k)) && !r.w41.includes("w4_calf") &&
      r.slc.unit === "lbs" && r.slc.sets.map((x) => x.weight + "x" + x.reps).join() === "160x12,145x10", JSON.stringify(r));
    note("Monday's chest sets stay on Monday, never moved onto Wednesday Oct 14", r.mon.includes("m4_cp") && !r.wed42.includes("w7_cp"), JSON.stringify(r));
    await page.evaluate(() => window.selectDay("Monday")); await page.waitForTimeout(300);
    const txt = await page.evaluate(() => document.getElementById("tc")?.innerText || "");
    note("Monday shows its legs work and, below, the chest sets under 'Also logged this day'", /Also logged this day/i.test(txt) && /Chest Press/.test(txt));
    await page.close();
  }

  // Weekly summary "Calories compliance" printed "undefined%": the summary read
  // wc.calories after weekCompliance stopped returning it. Sunday Oct 11 shows
  // the summary for the week just ending; seed food on some days.
  {
    const page = await browser.newPage({ viewport: { width: 412, height: 2200 }, timezoneId: "America/Toronto" });
    page.on("pageerror", (e) => jsErrors.push(`calcomp: ${e.message}`));
    await page.clock.install({ time: new Date("2026-10-11T15:00:00-04:00") });
    await page.addInitScript(() => {
      window.FORGE_API_CFG = { baseUrl: "", token: "x" };
      if (!localStorage.f5) {
        const days = {};
        for (const [d, k] of [["2026-10-05", 1500], ["2026-10-06", 2600], ["2026-10-07", 1400], ["2026-10-08", 1550]]) days[d] = { items: [{ name: "x", kcal: k, protein: 150 }], active: 600 };
        localStorage.f5 = JSON.stringify({ nutrition: { days, weights: { "2026-10-05": 133, "2026-10-10": 132 } }, _v6MonDone1: true, _planMove41: true, _wkFix1: true });
      }
    });
    await page.goto(URL, { waitUntil: "networkidle" });
    await page.waitForTimeout(800);
    await page.evaluate(() => document.getElementById("nav-nutrition")?.click());
    await page.waitForTimeout(900);
    // textContent, not innerText: the phase card may sit in a collapsed section.
    const txt = await page.evaluate(() => document.getElementById("tc")?.textContent || "");
    const m = txt.match(/Calories compliance\s*([^A-Z]+?)(?=Deficit vs required)/);
    const und = txt.match(/.{60}undefined.{40}/g);
    note("weekly summary shows a real calories-compliance figure, never 'undefined'", !und && !!m && /^\d+%$|^·$/.test(m[1].trim()), JSON.stringify(m && m[1]) + " " + JSON.stringify(und));
    await page.close();
  }

  // Simplified app (Oct 2026): every feature switched off in FEATURES must be
  // gone from the rendered UI, not just unused.
  {
    const page = await browser.newPage({ viewport: { width: 412, height: 2400 }, timezoneId: "America/Toronto" });
    page.on("pageerror", (e) => jsErrors.push(`features: ${e.message}`));
    await page.addInitScript(() => { window.FORGE_API_CFG = { baseUrl: "", token: "x" }; });
    await page.goto(URL, { waitUntil: "networkidle" });
    await page.waitForTimeout(800);
    const quote = await page.evaluate(() => { const q = document.getElementById("quoteEl"); return !!q && getComputedStyle(q).display !== "none"; });
    await page.evaluate(() => document.getElementById("nav-nutrition")?.click()); await page.waitForTimeout(700);
    const nut = await page.evaluate(() => document.getElementById("tc")?.textContent || "");
    await page.evaluate(() => document.getElementById("nav-settings")?.click()); await page.waitForTimeout(700);
    const st = await page.evaluate(() => document.getElementById("tc")?.textContent || "");
    await page.evaluate(() => window.openDrawer?.()); await page.waitForTimeout(300);
    const dr = await page.evaluate(() => document.getElementById("drawerContent")?.textContent || "");
    const shown = {
      quoteCard: quote, medicationCard: /Zepbound|next dose|overdue/i.test(nut), complianceGrid: /This week's compliance/i.test(nut),
      progressCharts: /Volume This Week|Weekly Calorie Deficit/.test(st), prList: /Personal Records/.test(dr),
    };
    const wrong = Object.entries(shown).filter(([k, v]) => v !== FEATURES[k]).map(([k, v]) => `${k}:${v ? "shown" : "hidden"}`);
    note(`each switched-off feature is hidden, each switched-on one shown${wrong.length ? " · " + wrong.join(", ") : ""}`, wrong.length === 0);
    note("the rest of the Insights menu stays (trends, Machine Busy)", /7-Day Trends/.test(dr) && /Machine Busy/.test(dr));
    await page.close();
  }

  // The up/down/equal arrow must follow EVERY set, not just the first. reCard()
  // skips while the input you just typed in still has focus, so after set 1
  // (below last session = down) a PR on set 2 left the arrow on down. Typed
  // with .fill() and ticked straight away: focus stays in the box, as on iOS.
  {
    const page = await browser.newPage({ viewport: { width: 412, height: 1400 }, timezoneId: "America/Toronto" });
    page.on("pageerror", (e) => jsErrors.push(`olbadge: ${e.message}`));
    page.on("dialog", (d) => d.dismiss());
    await page.clock.install({ time: new Date("2026-10-13T10:00:00-04:00") });
    await page.addInitScript(() => { window.FORGE_API_CFG = { baseUrl: "", token: "x" }; });
    await page.goto(URL, { waitUntil: "networkidle" });
    await page.waitForTimeout(800);
    const exId = await page.evaluate(() => {
      const ids = [...document.querySelectorAll(".si")].filter((i) => /^wi-.*-1$/.test(i.id)).map((i) => i.id.replace("wi-", "").replace(/-\d+$/, ""));
      return ids.find((id) => document.querySelector(`#ex-${id} .ex-icon.gym`));
    });
    await page.evaluate((a) => {
      const S = JSON.parse(localStorage.f5);
      S.sessions = { Tuesday_2026W41: { [a]: { unit: "kg", done: true, sets: [{ weight: "40", reps: "10", done: true }] } } };
      Object.assign(S, { _v6MonDone1: true, _planMove41: true, _wkFix1: true });
      localStorage.f5 = JSON.stringify(S);
      try { localStorage.setItem("f5_unitreview_2026-10-13", "1"); } catch {}
    }, exId);
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(800);
    await page.locator(`#ex-${exId} .ex-top`).click().catch(() => {});
    await page.waitForTimeout(300);
    await page.evaluate(() => { window.__forgeKey = () => "Tuesday_2026W42"; });
    const tick = async (i, w, r) => {
      await page.locator(`#wi-${exId}-${i}`).fill(w);
      await page.locator(`#ri-${exId}-${i}`).fill(r);
      // iOS: tapping the tick does NOT move focus off the reps box (a desktop
      // click would focus the button and hide the bug). Tick with focus kept.
      await page.evaluate(({ a, i }) => { document.getElementById(`ri-${a}-${i}`).focus(); window.toggleSet(window.__forgeKey(), a, i); }, { a: exId, i });
      await page.waitForTimeout(250);
      return page.evaluate((a) => document.querySelector(`#ol-${a} span`)?.className || "none", exId);
    };
    const s1 = await tick(0, "35", "10");   // below last session's 40x10
    const s2 = await tick(1, "45", "10");   // beats it
    note("arrow follows later sets: down after a weaker set 1, up once set 2 beats last session", s1 === "ol-down" && s2 === "ol-up", `set1=${s1} set2=${s2}`);
    await page.close();
  }

  // V7 reorder: the user did Legs & Shoulders on Mon 12 Oct, logged on the old
  // Wednesday screen (w4_ ids). It must land on Monday with V7 ids, the old key
  // deleted server-side, this week's v4 plan restamped v7 on the new days. Also
  // the weight/unit overlap ("145.1" ran under "LBS") and the 145.1 pre-fill.
  {
    const page = await browser.newPage({ viewport: { width: 412, height: 1400 }, timezoneId: "America/Toronto" });
    page.on("pageerror", (e) => jsErrors.push(`v7move: ${e.message}`));
    await page.clock.install({ time: new Date("2026-10-12T21:00:00-04:00") });
    await page.addInitScript(() => {
      window.FORGE_API_CFG = { baseUrl: "", token: "x" };
      if (!localStorage.f5) localStorage.f5 = JSON.stringify({
        sessions: {
          Wednesday_2026W42: { w4_lp: { done: true, unit: "kg", sets: [{ weight: "118", reps: "12", done: true }] }, w4_le: { unit: "kg", sets: [{ weight: "65.8", reps: "12", done: true }] }, _notes: "legs today" },
          Thursday_2026W41: { th4_slr: { done: true, unit: "lbs", sets: [{ weight: "145", reps: "10", done: true }] } },
        },
        weekPlans: { "2026W42": { _prog: "v4", Wednesday: [{ id: "w4_lp", hint: "120 kg" }], Monday: [{ id: "m4_cp", sets: 5 }] } },
        _v6MonDone1: true, _planMove41: true, _wkFix1: true,
      });
      try { localStorage.setItem("f5_unitreview_2026-10-12", "1"); } catch {}
    });
    await page.goto(URL, { waitUntil: "networkidle" });
    await page.waitForTimeout(900);
    const r = await page.evaluate(() => {
      const S = JSON.parse(localStorage.f5), ob = JSON.parse(localStorage.f5_outbox || "[]");
      return { mon: Object.keys(S.sessions.Monday_2026W42 || {}).sort(), wed: !!S.sessions.Wednesday_2026W42, note: S.sessions.Monday_2026W42?._notes,
        plan: S.weekPlans["2026W42"], del: ob.filter((m) => m.entity === "session_key_delete").map((m) => m.payload.sessionKey) };
    });
    note("this week's Wednesday-logged legs session moves to Monday with V7 ids (notes too)",
      r.mon.includes("m7_lp") && r.mon.includes("m7_le") && !r.wed && r.note === "legs today" && r.del.includes("Wednesday_2026W42"), JSON.stringify(r));
    note("this week's v4 plan follows its exercises (w4_lp -> Monday m7_lp, m4_cp -> Wednesday w7_cp) and is restamped v7",
      r.plan?._prog === "v7" && r.plan.Monday?.[0]?.id === "m7_lp" && r.plan.Wednesday?.[0]?.id === "w7_cp", JSON.stringify(r.plan));
    const hero = await page.evaluate(() => document.querySelector(".hero-title")?.textContent || "");
    note("Monday now shows Legs & Shoulders, with today's logged work", /Legs/.test(hero), hero);
    // Overlap: the input reserves the unit label's corner.
    // Measure the real render: the typed number's text box and the unit label
    // must not overlap, and "147.5" must fit without clipping.
    await page.evaluate(() => { const top = [...document.querySelectorAll(".ex-card")].find((c) => c.querySelector(".ex-icon.gym"))?.querySelector(".ex-top"); top?.click(); });
    await page.waitForTimeout(300);
    const ov = await page.evaluate(() => {
      const i = [...document.querySelectorAll(".wt-wrap .si")].find((x) => x.getBoundingClientRect().width > 0); if (!i) return null;
      i.value = "147.5";
      const c = document.createElement("canvas").getContext("2d"), cs = getComputedStyle(i);
      c.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      const textW = c.measureText(i.value).width, ir = i.getBoundingClientRect();
      const avail = ir.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      const lab = getComputedStyle(i.parentElement, "::after"), wr = i.parentElement.getBoundingClientRect();
      const labTop = wr.bottom - parseFloat(lab.bottom || 0) - parseFloat(lab.fontSize);
      return { fits: textW <= avail, textW: Math.round(textW), avail: Math.round(avail), below: labTop >= ir.top + ir.height * 0.6 };
    });
    note("weight and unit never overlap, and a wide number (147.5) is not clipped", !!ov && ov.fits && ov.below, JSON.stringify(ov));
    await page.close();
  }

  // Per-weekday user edits (custom adds, swap drops) must only apply to the
  // week they were made in. Both were once keyed by weekday alone, so a
  // one-off edit silently reshaped that weekday in every later week and every
  // later program (two stale Leg Extensions on every Monday). Seeds a stale
  // and a current-week version of each and checks only the current ones apply.
  {
    const page = await browser.newPage({ viewport: { width: 412, height: 1200 }, timezoneId: "America/Toronto" });
    page.on("pageerror", (e) => jsErrors.push(`week-scope: ${e.message}`));
    await page.addInitScript(() => { window.FORGE_API_CFG = { baseUrl: "", token: "x" }; });
    await page.goto(URL, { waitUntil: "networkidle" });
    await page.waitForTimeout(900);
    const ids = await page.evaluate(() => [...document.querySelectorAll(".ex-card[id^='ex-']")].map((e) => e.id.slice(3)));
    const [A, B] = ids;
    await page.evaluate(([A, B]) => {
      const S = JSON.parse(localStorage.f5);
      const d = new Date(), j = new Date(d.getFullYear(), 0, 1);
      const wk = (()=>{const _d=new Date(d.getFullYear(),d.getMonth(),d.getDate(),12);_d.setDate(_d.getDate()-((_d.getDay()+6)%7)+2);const _j=new Date(_d.getFullYear(),0,1);return _d.getFullYear()+"W"+Math.ceil(((_d-_j)/86400000+_j.getDay()+1)/7);})();
      const day = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][d.getDay()];
      const mk = (ts, n) => ({ id: "c_" + ts, name: n, cat: "gym", sets: 3, reps: 12, hint: "", custom: true });
      S.custom = { [day]: [mk(Date.now() - 90 * 86400000, "StaleCustomX"), mk(Date.now(), "FreshCustomX")] };
      S.dropped = { [day]: [A, B] };
      S.droppedWk = { [A]: wk, [B]: "2000W1" };
      S._v6MonDone1 = true;
      localStorage.f5 = JSON.stringify(S);
    }, [A, B]);
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(1000);
    const r = await page.evaluate(([A, B]) => ({
      a: !!document.getElementById("ex-" + A), b: !!document.getElementById("ex-" + B),
      stale: /StaleCustomX/.test(document.getElementById("tc")?.innerText || ""),
      fresh: /FreshCustomX/.test(document.getElementById("tc")?.innerText || ""),
    }), [A, B]);
    note("a custom exercise from an earlier week does not reappear this week", !!A && !r.stale && r.fresh, JSON.stringify(r));
    note("a swap drop from an earlier week does not remove the exercise this week", !!B && !r.a && r.b, JSON.stringify(r));
    await page.close();
  }

  // toggleSet's onchange/blur race: weight/reps commit to state only on
  // input blur, so tapping "done" right after typing (no Enter, the common
  // mobile path) can beat that blur to the click. Drives the real page's
  // .fill() the same way, which sets .value WITHOUT dispatching the change
  // event a real blur would, then taps done immediately with no blur first.
  {
    const page = await browser.newPage({ viewport: { width: 412, height: 1200 }, timezoneId: "America/Toronto" });
    page.on("pageerror", (e) => jsErrors.push(`toggleSet: ${e.message}`));
    await page.addInitScript(() => { window.FORGE_API_CFG = { baseUrl: "", token: "x" }; });
    await page.goto(URL, { waitUntil: "networkidle" });
    await page.waitForTimeout(900);
    await page.evaluate(SEED, SEED_EX);
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(1300);

    // Skip the seeded exercise: SEED marks it done with a logged set, which is
    // not the untouched set this check needs.
    const exId = await page.evaluate((seedId) => {
      const inp = [...document.querySelectorAll(".si:not([disabled])")].find((i) => i.id.startsWith("wi-") && !i.id.startsWith("wi-" + seedId + "-"));
      return inp ? inp.id.replace("wi-", "").replace(/-\d+$/, "") : null;
    }, SEED_EX.id);
    if (exId) {
      await page.locator(`#ex-${exId} .ex-top`).click().catch(() => {});
      await page.waitForTimeout(300);
      await page.locator(`#wi-${exId}-0`).fill("42.5");
      await page.locator(`#ri-${exId}-0`).fill("8");
      await page.locator(`#ex-${exId} .sdone`).first().click(); // no blur first — the race
      await page.waitForTimeout(400);
      const done = await page.evaluate((id) => document.getElementById(`sr-${id}-0`)?.classList.contains("done"), exId);
      note("toggleSet marks a set done despite no blur before the tap (the real race)", done === true);

      await page.locator(`#ex-${exId} .sdone`).first().click(); // toggle back off
      await page.waitForTimeout(200);
      await page.locator(`#wi-${exId}-0`).fill("");
      await page.locator(`#ex-${exId} .sdone`).first().click();
      await page.waitForTimeout(300);
      const stillDone = await page.evaluate((id) => document.getElementById(`sr-${id}-0`)?.classList.contains("done"), exId);
      note("toggleSet refuses a set whose weight was just cleared, not stale-completed", stillDone === false);
    } else {
      note("toggleSet race check found an editable set input to test", false, "no enabled .si input on default tab");
    }
    await page.close();
  }

  note("no JS errors on any tab", jsErrors.length === 0, jsErrors.slice(0, 3).join(" | "));
} finally {
  if (browser) await browser.close();
  stop();
}

if (fails.length) {
  console.error(`\n  ${fails.length} runtime check(s) FAILED`);
  process.exit(1);
}
console.log("  runtime checks green");

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
import { programFor } from "./src/constants.js";

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
  const wk = (y) => y.getFullYear() + "W" + Math.ceil(((y - j) / 86400000 + j.getDay() + 1) / 7);
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
    note(`${theme}: PR row leads with the set lifted, not the estimate`,
      /^40kg × 10 .*est\. 1RM 53kg$/.test(prRow), prRow);

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
        const wkOf = (d) => { const j = new Date(d.getFullYear(), 0, 1); return d.getFullYear() + "W" + Math.ceil(((d - j) / 86400000 + j.getDay() + 1) / 7); };
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
      const wk = d.getFullYear() + "W" + Math.ceil(((d - j) / 86400000 + j.getDay() + 1) / 7);
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

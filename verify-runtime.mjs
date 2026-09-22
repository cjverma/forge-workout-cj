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
const _todayProg = programFor(new Date());
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

    const exId = await page.evaluate(() => {
      const inp = [...document.querySelectorAll(".si:not([disabled])")].find((i) => i.id.startsWith("wi-"));
      return inp ? inp.id.replace("wi-", "").replace(/-\d+$/, "") : null;
    });
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

/**
 * End-to-end user flows: drives every user-facing action of the BUILT app
 * (dist/, served as the site root exactly as Vercel serves it) in a real
 * browser and checks four things per flow: the UI changed, the stored state
 * (localStorage f5) changed correctly, the right mutation reached the server,
 * and nothing threw.
 *
 * The server is fully mocked with page.route: /api/state, /api/mutate and the
 * AI endpoints answer from this file, so no real database is ever touched.
 * Data: a synthetic but realistic state built below (kg and lbs, current and
 * last week sessions, PRs, food, weights). E2E_STATE=path/to/backup.json runs
 * the same flows against a real backup instead ({state:{...}} or the state).
 *
 * Usage: node e2e-flows.mjs     (also invoked by node test.js)
 */
import { readFileSync } from "fs";
import { chromium } from "playwright";
import express from "express";
import { programFor, weekKeyOf, DAYS, prSlug, PR_ALIAS } from "./src/constants.js";

const CHROME = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const PORT = 8793, BASE = `http://127.0.0.1:${PORT}/`;
// Wednesday evening, mid-week: there is a past day (Mon/Tue), today, and future.
const NOW = new Date("2026-10-21T18:00:00-04:00");
const TODAY = "2026-10-21", WK = weekKeyOf(new Date("2026-10-21T12:00:00"));

const fails = [];
let passes = 0;
const note = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"}  ${label}${!ok && detail ? " — " + String(detail).slice(0, 300) : ""}`);
  if (ok) passes++; else fails.push(label);
};

// ── Fixture ────────────────────────────────────────────────────────────────
const dayIso = (n) => { const d = new Date("2026-10-21T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
function fixture(fresh) {
  if (process.env.E2E_STATE) { const j = JSON.parse(readFileSync(process.env.E2E_STATE, "utf8")); return j.state || j; }
  const S = JSON.parse(JSON.stringify(fresh));
  const prog = (iso) => programFor(new Date(iso + "T12:00:00"));
  const gym = (iso, day) => (prog(iso)[day]?.exercises || []).filter((e) => e.cat === "gym");
  S.sessions = S.sessions || {}; S.prs = S.prs || {};
  const lastWed = dayIso(-7), lastWk = weekKeyOf(new Date(lastWed + "T12:00:00"));
  // Last Wednesday: today's exercises at 40 kg x 10 (Beat targets), one in lbs.
  const lw = {};
  gym(lastWed, "Wednesday").forEach((e, i) => {
    const lbs = i === 2;
    lw[e.id] = { done: true, skipped: false, unit: lbs ? "lbs" : "kg", sets: [1, 2, 3].map(() => ({ weight: lbs ? "90" : "40", reps: "10", done: true })) };
    const slug = PR_ALIAS[prSlug(e.name)] || prSlug(e.name);
    S.prs[slug] = [{ date: lastWed, weight: lbs ? 40.8 : 40, reps: 10, est: lbs ? 54 : 53 }];
  });
  S.sessions["Wednesday_" + lastWk] = lw;
  // Monday this week: trained (two exercises logged, a note).
  const mon = {}; gym(dayIso(-2), "Monday").slice(0, 2).forEach((e) => { mon[e.id] = { done: true, skipped: false, unit: "kg", sets: [{ weight: "60", reps: "12", done: true }] }; });
  mon._notes = "Felt fine.";
  S.sessions["Monday_" + WK] = mon;
  S.nutrition = S.nutrition || {}; S.nutrition.days = S.nutrition.days || {}; S.nutrition.weights = S.nutrition.weights || {};
  for (let i = -3; i <= 0; i++) S.nutrition.days[dayIso(i)] = { items: i === 0 ? [] : [{ id: "n_" + (1000 + i), name: "Chicken rice bowl", kcal: 650, protein: 55, carbs: 70, fat: 14, fibre: 6, sugar: 4, sodium: 900, time: 1 }], restingOverride: 2800, active: 700 };
  for (let i = -12; i <= -1; i++) S.nutrition.weights[dayIso(i)] = Math.round((131 - (i + 12) * 0.15) * 10) / 10;
  return S;
}

// ── Harness ────────────────────────────────────────────────────────────────
let browser, server, FRESH = null;
async function boot({ state, theme = "light", ua, server: srvState = null, noCfg = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: "America/Toronto", serviceWorkers: "block", colorScheme: theme, userAgent: ua });
  const page = await ctx.newPage();
  const h = { ctx, page, errors: [], muts: [], mutStatus: [], serverState: srvState, dialogs: [], answer: true };
  page.on("pageerror", (e) => h.errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) h.errors.push("console: " + m.text()); });
  page.on("dialog", (d) => { h.dialogs.push(d.message()); (typeof h.answer === "function" ? h.answer(d) : h.answer) ? d.accept() : d.dismiss(); });
  await page.clock.setFixedTime(NOW);
  await page.route("**/api/**", async (r) => {
    const u = new URL(r.request().url()), path = u.pathname;
    const json = (status, body) => r.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (path === "/api/state") return h.serverState ? json(200, { state: h.serverState }) : json(501, {});
    if (path === "/api/mutate") { const st = h.mutStatus.length ? h.mutStatus.shift() : 200; if (st === 200) h.muts.push(JSON.parse(r.request().postData() || "{}")); return json(st, st === 200 ? { ok: true } : { error: "x" }); }
    if (path === "/api/coach") return json(200, { text: "Mock coach reply." });
    if (path === "/api/nutrition") return json(200, { items: [{ name: "Greek yogurt", kcal: 150, protein: 20, carbs: 8, fat: 4, fibre: 0, sugar: 6, sodium: 60 }] });
    if (path === "/api/suggest-alt") return json(200, { name: "Low Cable Chest Fly", cat: "gym", muscles: ["chest"], sets: 3, reps: 12, hint: "10-15 kg", cue: "Slow squeeze." });
    if (path === "/api/weekly-plan") return json(200, { text: JSON.stringify({ week_plan: h.planWeek || {}, coaching_notes: "Mock notes", flags: [] }) });
    if (path === "/api/email") return json(200, { ok: true });
    return json(404, { error: "not mocked" });
  });
  await page.addInitScript(([s, th, noCfg]) => {
    if (!noCfg) window.FORGE_API_CFG = { baseUrl: "", token: "x" };
    if (s && !sessionStorage.__seeded) { localStorage.f5 = JSON.stringify(s); localStorage.removeItem("f5_outbox"); sessionStorage.__seeded = 1; }
    try { localStorage.setItem("forge_theme", th); } catch (_) {}
  }, [state || null, theme, noCfg]);
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  await page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
  return h;
}
const S = (page) => page.evaluate(() => JSON.parse(localStorage.f5));
const outbox = (page) => page.evaluate(() => JSON.parse(localStorage.f5_outbox || "[]"));
const flush = async (h) => { await h.page.evaluate(() => flushOutbox()); await h.page.waitForTimeout(150); };
const sent = (h, entity) => h.muts.filter((m) => m.entity === entity);
const wait = (page, ms = 250) => page.waitForTimeout(ms);
// A milestone pop-up (e.g. "130 kg Milestone!") waits for the user to close
// it, as it should; flows close it like a person would before tapping on.
// The clock is frozen for repeatable dates; ids like c_<Date.now()> need it to
// move between taps, as it does in real use.
let _tick = 0;
const advance = (page) => page.clock.setFixedTime(new Date(NOW.getTime() + (++_tick) * 61000));
const closePopups = (page) => page.evaluate(() => { if (document.getElementById("milestoneModal")?.classList.contains("show")) closeMilestone(); });
const text = (page, sel) => page.evaluate((s) => document.querySelector(s)?.textContent || "", sel);
async function flow(name, fn) {
  try { await fn(); } catch (e) { note(`${name} (threw)`, false, e.message.split("\n")[0]); }
}
const noErrors = (h, label) => note(`${label}: no JS errors`, h.errors.length === 0, h.errors.slice(0, 3).join(" | "));
const gymCards = (page) => page.evaluate(() => [...document.querySelectorAll(".ex-card")].filter((c) => c.querySelector(".ex-icon.gym")).map((c) => c.id.slice(3)));

// ── Flows ──────────────────────────────────────────────────────────────────
async function workoutNavigation(state) {
  const h = await boot({ state }); const p = h.page;
  await flow("week navigation", async () => {
    const t0 = await text(p, ".wk-nav-lbl");
    await p.click(".wk-nav-btn[aria-label='Previous week']"); await wait(p);
    const t1 = await text(p, ".wk-nav-lbl");
    await p.click(".wk-nav-back"); await wait(p);
    const t2 = await text(p, ".wk-nav-lbl");
    await p.click(".wk-nav-btn[aria-label='Next week']"); await wait(p);
    const t3 = await text(p, ".wk-nav-lbl"), ro = await p.evaluate(() => [...document.querySelectorAll(".si")].every((i) => i.disabled));
    await p.evaluate(() => goCurrentWeek()); await wait(p);
    note("week nav: previous, back to this week, next week (read-only preview)", /This Week/.test(t0) && /Week of/.test(t1) && /This Week/.test(t2) && /Next Week/.test(t3) && ro, [t0, t1, t2, t3, ro].join(" | "));
  });
  await flow("day select + past-day lock", async () => {
    await p.evaluate(() => document.getElementById("p-Monday").click()); await wait(p);
    const title = await text(p, ".hero-title"), locked = await p.evaluate(() => !!document.querySelector(".lock-banner") && [...document.querySelectorAll(".si")].every((i) => i.disabled));
    await p.evaluate(() => unlockDay()); await wait(p);
    const editable = await p.evaluate(() => [...document.querySelectorAll(".si")].some((i) => !i.disabled));
    await p.evaluate(() => lockDay()); await wait(p);
    const relocked = await p.evaluate(() => [...document.querySelectorAll(".si")].every((i) => i.disabled));
    note("past day opens locked, unlocks for editing, re-locks", /Legs/.test(title) && locked && editable && relocked, JSON.stringify({ title, locked, editable, relocked }));
    await p.evaluate(() => document.getElementById("p-Wednesday").click()); await wait(p);
  });
  noErrors(h, "workout navigation");
  await h.ctx.close();
}

async function workoutSession(state) {
  const h = await boot({ state }); const p = h.page;
  await flow("session lifecycle", async () => {
    await p.click("#bStart"); await wait(p);
    const active = await p.evaluate(() => JSON.parse(localStorage.f5_active || "null"));
    await p.reload({ waitUntil: "networkidle" }); await wait(p, 600);
    const survived = await p.evaluate(() => document.getElementById("bStop")?.classList.contains("show"));
    await p.click("#bStop"); await wait(p);
    const sheet = await p.evaluate(() => !!document.querySelector(".stop-sheet") && getComputedStyle(document.querySelector(".stop-sheet").closest(".swap-modal")).display !== "none");
    await p.evaluate(() => closeStopSheet()); await wait(p);
    const stillOn = await p.evaluate(() => document.getElementById("bStop")?.classList.contains("show"));
    await p.click("#bStop"); await wait(p);
    await p.clock.setFixedTime(new Date(NOW.getTime() + 50 * 60000)); // a 50-minute workout
    await p.evaluate(() => stopSess(true)); await wait(p, 400);
    const summary = await p.evaluate(() => document.getElementById("sum")?.classList.contains("show"));
    const dur1 = await p.evaluate(() => document.getElementById("sumDur").textContent);
    await p.evaluate(() => closeSummary()); await wait(p);
    const stopped = (await S(p)).sessions["Wednesday_" + await p.evaluate(() => wk())]?._stopped;
    const resumeBtn = await p.evaluate(() => /Resume Workout/.test(document.body.innerText));
    await p.evaluate(() => resumeSess()); await wait(p);
    const resumed = await p.evaluate(() => document.getElementById("bStop")?.classList.contains("show"));
    // Resume, two more minutes, finish again: the summary counts the WHOLE
    // workout. It used to show only the stretch since the resume ("0m 01s").
    await p.clock.setFixedTime(new Date(NOW.getTime() + 52 * 60000));
    await p.evaluate(() => stopSess(true)); await wait(p, 300);
    const dur2 = await p.evaluate(() => document.getElementById("sumDur").textContent);
    await p.evaluate(() => closeSummary()); await p.evaluate(() => resumeSess()); await wait(p);
    await p.clock.setFixedTime(NOW);
    const n1 = parseInt(dur1, 10), n2 = parseInt(dur2, 10);
    note("the summary counts the whole workout across a resume (50 min, then 52 min, never Under a minute)",
      /^\d+ min$|^\d+ hr/.test(dur1) && n1 >= 50 && n2 === n1 + 2, JSON.stringify({ dur1, dur2 }));
    await flush(h);
    note("start, survives reload, stop sheet, keep going, finish, summary, resume",
      !!active && survived && sheet && stillOn && summary && stopped && resumeBtn && resumed && sent(h, "session_meta").length > 0,
      JSON.stringify({ active: !!active, survived, sheet, stillOn, summary, stopped, resumeBtn, resumed, meta: sent(h, "session_meta").length }));
  });
  await flow("mark complete + undo", async () => {
    // Mark Complete is offered on a live, unfinished, not-stopped day.
    const h2 = await boot({ state }); const q = h2.page;
    await q.click(".markdone-bar .btn-start"); await wait(q);
    const done = await q.evaluate(() => /Session complete/.test(document.body.innerText));
    await q.click(".sess-undo"); await wait(q);
    const undone = await q.evaluate(() => !/Session complete/.test(document.body.innerText) && !!document.querySelector(".markdone-bar"));
    await h2.ctx.close();
    note("mark day complete, then undo", done && undone, JSON.stringify({ done, undone }));
  });
  noErrors(h, "workout session");
  await h.ctx.close();
}

async function workoutSets(state) {
  const h = await boot({ state }); const p = h.page;
  const ids = await gymCards(p), id = ids[1] || ids[0];
  const key = await p.evaluate(() => "Wednesday_" + wk());
  await p.click(`#ex-${id} .ex-top`); await wait(p);
  await flow("log a set + PR", async () => {
    const unit = await p.evaluate((id) => document.querySelector(`#ex-${id} .wt-wrap`).dataset.unit, id);
    // Beat the exercise's current best (any data): best kg + 5, in the box's unit.
    const bestKg = await p.evaluate((id) => { const S = JSON.parse(localStorage.f5); const cid = canonicalId(id); return Math.max(40, ...(S.prs[cid] || []).map((e) => Number(e.weight))); }, id);
    const wKg = Math.ceil(bestKg + 5), w = unit === "lbs" ? String(Math.round(wKg / 0.45359237)) : String(wKg);
    h.answer = false; // keep the typed unit if asked
    await flush(h); const prBefore = sent(h, "pr").length; // boot-time repairs may send their own
    await p.fill(`#wi-${id}-0`, w); await p.fill(`#ri-${id}-0`, "11");
    await p.click(`#ex-${id} .sdone`); await wait(p, 400); await closePopups(p);
    const st = await S(p), ed = st.sessions[key]?.[id];
    const name = await p.evaluate((id) => document.querySelector(`#ex-${id} .ex-name`).textContent, id);
    const prs = Object.values(st.prs).flat().filter((e) => e.date === TODAY);
    await flush(h);
    note("tick a set: stored done, PR written in kg, session_set + pr mutations sent",
      ed?.sets?.[0]?.done === true && prs.length === 1 && Math.abs(prs[0].weight - wKg) < 0.6 && sent(h, "session_set").length > 0 && sent(h, "pr").length === prBefore + 1 && Math.abs(sent(h, "pr").at(-1).payload.weight - wKg) < 0.6,
      JSON.stringify({ unit, name, set: ed?.sets?.[0], prs, muts: h.muts.map((m) => m.entity) }));
    const badge = await text(p, `#ex-${id} .pr-badge`);
    note("the Best line shows the new PR", new RegExp(`Best ${Math.floor(wKg)}(\\.\\d)? kg × 11`).test(badge), badge);
  });
  await flow("untick, add set, delete set", async () => {
    await closePopups(p);
    await p.click(`#ex-${id} .sdone`); await wait(p);
    const undone = (await S(p)).sessions[key][id].sets[0].done === false;
    const rows0 = await p.evaluate((id) => document.querySelectorAll(`#ex-${id} .set-row`).length, id);
    await p.click(`#ex-${id} .add-set-btn`); await wait(p, 300);
    const rows1 = await p.evaluate((id) => document.querySelectorAll(`#ex-${id} .set-row`).length, id);
    await p.click(`#ex-${id} .set-row:last-of-type .sdel`).catch(async () => p.evaluate(([k, id, n]) => delSet(k, id, n - 1), [key, id, rows1]));
    await wait(p, 300);
    const rows2 = await p.evaluate((id) => document.querySelectorAll(`#ex-${id} .set-row`).length, id);
    note("untick a set, add a set, delete a set", undone && rows1 === rows0 + 1 && rows2 === rows0, JSON.stringify({ undone, rows0, rows1, rows2 }));
  });
  await flow("delete the PR set", async () => {
    // re-tick set 1 (the PR), then delete it: PR must drop (or recover to the old best)
    await p.click(`#ex-${id} .sdone`); await wait(p, 300); await closePopups(p);
    h.answer = true; // confirm "Delete set 1?"
    await p.evaluate(([k, id]) => delSet(k, id, 0), [key, id]); await wait(p, 300);
    const st = await S(p), todays = Object.values(st.prs).flat().filter((e) => e.date === TODAY);
    note("deleting the set that set a PR removes that PR", todays.length === 0, JSON.stringify(todays));
  });
  await flow("unit toggle + unit check", async () => {
    const u0 = await p.evaluate((id) => document.querySelector(`#ex-${id} .wt-wrap`).dataset.unit, id);
    await p.click(`#ex-${id} .unit-chip`); await wait(p);
    const u1 = await p.evaluate((id) => document.querySelector(`#ex-${id} .wt-wrap`).dataset.unit, id);
    await p.click(`#ex-${id} .unit-chip`); await wait(p);
    // 120 in kg on an exercise usually ~40 kg: the app must ask; OK converts it.
    h.answer = true; h.dialogs.length = 0;
    const kgNow = await p.evaluate((id) => document.querySelector(`#ex-${id} .wt-wrap`).dataset.unit, id);
    if (kgNow !== "kg") { await p.click(`#ex-${id} .unit-chip`); await wait(p); }
    await p.fill(`#wi-${id}-1`, "120"); await p.fill(`#ri-${id}-1`, "10");
    await p.click(`#sr-${id}-1 .sdone`);
    await wait(p, 300);
    const set = (await S(p)).sessions[key][id].sets[1];
    note("kg/lbs toggles; a weight ~3x usual asks first and OK logs it converted", u1 !== u0 && h.dialogs.some((d) => /Did you mean 120 lbs/.test(d)) && Number(set?.weight) === 54.4, JSON.stringify({ u0, u1, dialogs: h.dialogs, set }));
  });
  await flow("cardio + skip", async () => {
    const cardio = await p.evaluate(() => [...document.querySelectorAll(".ex-card")].find((c) => c.querySelector(".ex-icon.cardio"))?.id.slice(3));
    if (cardio) {
      await p.click(`#ex-${cardio} .ex-top`); await wait(p);
      await p.click(`#ex-${cardio} .cardio-row`); await wait(p);
    }
    const cDone = cardio ? (await S(p)).sessions[key][cardio]?.done === true : true;
    const other = ids[ids.length - 1];
    await p.evaluate(([k, x]) => skipEx(k, x), [key, other]); await wait(p);
    const skipped = (await S(p)).sessions[key][other]?.skipped === true;
    const shown = await p.evaluate((x) => document.getElementById("ex-" + x).classList.contains("skipped"), other);
    note("cardio ticks done; skip marks an exercise skipped", cDone && skipped && shown, JSON.stringify({ cardio, cDone, skipped, shown }));
  });
  noErrors(h, "workout sets");
  await h.ctx.close();
}

async function calfNotes(state) {
  const h = await boot({ state }); const p = h.page;
  await flow("calf twinge forces a note", async () => {
    await p.click("#bStart"); await wait(p);
    await p.click("#calfBtn"); await wait(p);
    const req = await p.evaluate(() => !!document.querySelector(".notes-req") && document.getElementById("sessNotes").classList.contains("needed"));
    await p.evaluate(() => stopSess()); await wait(p);
    const stillRunning = await p.evaluate(() => document.getElementById("bStop")?.classList.contains("show") && !document.querySelector(".swap-modal.show .stop-sheet"));
    await p.focus("#sessNotes"); await p.keyboard.type("Left calf tight on the walk");
    await wait(p, 1500); // saveNotes is debounced
    const focusKept = await p.evaluate(() => document.activeElement?.id === "sessNotes");
    const met = await p.evaluate(() => document.querySelector(".notes-req")?.classList.contains("met"));
    await p.evaluate(() => undoCalfTwinge()); await wait(p);
    const k = await p.evaluate(() => "Wednesday_" + wk()), sess = (await S(p)).sessions[k];
    await flush(h);
    note("twinge makes the note required, blocks stop until written, typing keeps focus, undo removes it",
      req && stillRunning && focusKept && met && (sess._calfTwinges || []).length === 0 && /calf tight/.test(sess._notes) && sent(h, "session_meta").length > 0,
      JSON.stringify({ req, stillRunning, focusKept, met, tw: sess._calfTwinges, notes: sess._notes }));
  });
  noErrors(h, "calf + notes");
  await h.ctx.close();
}

async function exercisesFlow(state) {
  const h = await boot({ state }); const p = h.page;
  const key = await p.evaluate(() => "Wednesday_" + wk());
  await flow("library add + swap + restore", async () => {
    await p.evaluate(() => toggleCF()); await wait(p);
    await p.fill("#cfSearch", "crossover"); await wait(p, 400);
    const hits = await p.evaluate(() => document.querySelectorAll("#cfDD .dd-item").length);
    h.answer = true;
    await p.click("#cfDD [data-action='fromdb']"); await wait(p, 400);
    const st = await S(p), customs = (st.custom.Wednesday || []);
    const swapOpen = await p.evaluate(() => !!document.querySelector(".swap-modal.show"));
    // drop the first program exercise offered
    await p.click(".swap-modal.show [data-action='swapdrop']"); await wait(p, 400);
    const st2 = await S(p), dropped = st2.dropped?.Wednesday || [];
    await flush(h);
    note("search the library, add an exercise, offered a swap, drop one",
      hits > 0 && customs.length >= 1 && swapOpen && dropped.length === 1 && sent(h, "custom_exercise").length === 1 && sent(h, "dropped_exercise").length === 1,
      JSON.stringify({ hits, customs: customs.map((c) => c.name), swapOpen, dropped, muts: h.muts.map((m) => m.entity) }));
    await p.evaluate(([d, id]) => restoreDropped(d, id), ["Wednesday", dropped[0]]); await wait(p, 300);
    const back = !((await S(p)).dropped?.Wednesday || []).includes(dropped[0]);
    await flush(h);
    note("restore the dropped exercise", back && sent(h, "dropped_exercise_restore").length === 1, JSON.stringify((await S(p)).dropped));
  });
  await flow("free-form add, demo or no-demo line, remove", async () => {
    await p.evaluate(() => { const f = document.getElementById("cf"); if (!f.classList.contains("open") && !f.classList.contains("show")) toggleCF(); }); await wait(p);
    await advance(p);
    await p.fill("#cfSearch", "Zxqv Wobble"); await wait(p, 400);
    await p.click("#cfDD [data-action='freeform']"); await wait(p, 400);
    await p.evaluate(() => closeSwap?.()); await wait(p);
    const st = await S(p), c = (st.custom.Wednesday || []).find((x) => /Zxqv/.test(x.name));
    await p.click(`#ex-${c.id} .ex-top`); await wait(p, 900);
    const none = await p.evaluate((id) => document.querySelector(`#ex-${id} .demo-none`)?.textContent || "", c.id);
    await p.evaluate(([d, id]) => removeCustomEx(d, id), ["Wednesday", c.id]); await wait(p, 300);
    const gone = !((await S(p)).custom.Wednesday || []).some((x) => x.id === c.id) && !(await p.$(`#ex-${c.id}`));
    await flush(h);
    note("free-form exercise: added, shows 'No demo for this one', removable (custom_exercise_delete sent)",
      !!c && /No demo for this one/.test(none) && gone && sent(h, "custom_exercise_delete").length >= 1, JSON.stringify({ c: c?.name, none, gone }));
  });
  await flow("program exercise shows a bundled demo", async () => {
    const id = (await gymCards(p))[1];
    await p.click(`#ex-${id} .ex-top`); await wait(p, 900);
    const ok = await p.evaluate(async (id) => { const im = document.querySelector(`#ex-${id} .demo-wrap img`); if (!im) return false; if (!im.complete) await new Promise((r) => { im.onload = im.onerror = r; setTimeout(r, 2000); }); return im.naturalWidth > 0 && /^demos\/.+\.webp$/.test(im.getAttribute("src")); }, id);
    note("opening a program exercise shows its bundled WebP demo", ok);
  });
  await flow("AI alternative", async () => {
    await p.evaluate(() => { const f = document.getElementById("cf"); if (!f.classList.contains("open") && !f.classList.contains("show")) toggleCF(); }); await wait(p);
    await advance(p);
    await p.fill("#cfSearch", "Zxqv deadlift"); await wait(p, 400); // banned, no library match
    const altBtn = await p.$("#cfDD [data-action='suggestalt']");
    if (altBtn) await altBtn.click();
    await wait(p, 600);
    const ready = await p.evaluate(() => /Low Cable Chest Fly/.test(document.getElementById("cfDD")?.innerText || ""));
    await p.click("#cfDD [data-action='fromalt']"); await wait(p, 400);
    await p.evaluate(() => closeSwap?.()); await wait(p);
    const added = ((await S(p)).custom.Wednesday || []).some((x) => x.name === "Low Cable Chest Fly");
    note("a banned search offers a safe AI alternative, which can be added", !!altBtn && ready && added, JSON.stringify({ altBtn, ready, added }));
  });
  noErrors(h, "exercises");
  await h.ctx.close();
}

async function planFlow(state) {
  const h = await boot({ state }); const p = h.page;
  await flow("weekly plan generate + apply + reset", async () => {
    const thu = programFor(new Date(dayIso(8) + "T12:00:00")).Thursday.exercises.find((e) => e.cat === "gym");
    h.planWeek = { Thursday: [{ id: thu.id, sets: 4, hint: "50-55 kg", reason: "Mock reason" }] };
    await p.click("#nav-settings"); await wait(p, 500);
    await p.evaluate(() => { const d = [...document.querySelectorAll("details")].find((x) => x.querySelector(".gen-plan-btn")); if (d) d.open = true; });
    await p.click(".gen-plan-btn"); await wait(p, 900);
    const modal = await p.evaluate(() => !!document.querySelector("#planModal.show"));
    await p.click("#planModal [onclick='applyPendingPlan()']"); await wait(p, 400);
    const st = await S(p), wkKey = await p.evaluate(() => planWk());
    const upd = st.weekPlans?.[wkKey]?.Thursday?.find((u) => u.id === thu.id);
    await flush(h);
    note("generate a plan (mocked AI), review modal, apply: stored and sent", modal && upd?.sets === 4 && sent(h, "week_plan_update").length >= 1, JSON.stringify({ modal, upd, muts: h.muts.map((m) => m.entity) }));
    h.answer = true;
    await p.evaluate(() => resetPlan()); await wait(p, 400);
    const after = (await S(p)).weekPlans?.[wkKey];
    await flush(h);
    note("reset the plan: cleared and week_plan_reset sent", (!after || !after.Thursday) && sent(h, "week_plan_reset").length >= 1, JSON.stringify(after));
  });
  noErrors(h, "weekly plan");
  await h.ctx.close();
}

async function foodFlow(state) {
  const h = await boot({ state }); const p = h.page;
  await p.click("#nav-nutrition"); await wait(p, 600);
  await flow("log a meal with AI", async () => {
    await p.evaluate(() => openFood()); await wait(p);
    await p.fill("#foodTa", "a cup of greek yogurt"); await p.evaluate(() => askFood()); await wait(p, 700);
    const pending = await p.evaluate(() => /Greek yogurt/.test(document.querySelector(".pending-food")?.innerText || ""));
    await p.evaluate((d) => confirmFood(d), TODAY); await wait(p, 400);
    const items = (await S(p)).nutrition.days[TODAY]?.items || [];
    await flush(h);
    note("describe food, AI estimate shows, confirm adds it (nutrition_item_add sent)", pending && items.some((i) => i.name === "Greek yogurt" && i.kcal === 150) && sent(h, "nutrition_item_add").length >= 1, JSON.stringify({ pending, items: items.map((i) => i.name) }));
  });
  await flow("redo + drop pending", async () => {
    await p.evaluate(() => openFood()); await wait(p);
    await p.fill("#foodTa", "yogurt again"); await p.evaluate(() => askFood()); await wait(p, 700);
    await p.evaluate(() => redoFood()); await wait(p);
    const back = await p.evaluate(() => !!document.getElementById("foodTa") && !document.querySelector(".pending-food"));
    await p.evaluate(() => askFood()); await wait(p, 700);
    const pid = await p.evaluate(() => (document.querySelector(".pending-food [onclick*='dropPending']")?.getAttribute("onclick") || "").match(/'([^']+)'/)?.[1]);
    if (pid) { await p.evaluate((x) => dropPending(x), pid); await wait(p); }
    const n = ((await S(p)).nutrition.days[TODAY]?.items || []).length;
    await p.evaluate(() => closeFood()); await wait(p);
    note("re-enter goes back to the text box; dropping the pending item adds nothing", back && n === 1, JSON.stringify({ back, pid, n }));
  });
  await flow("quick add + search + delete", async () => {
    await p.evaluate(() => { _foodSearchOpen = true; _foodSearchQ = ""; renderNutrition(); }); await wait(p);
    const food = await p.evaluate(() => { const S = JSON.parse(localStorage.f5); for (const d of Object.values(S.nutrition.days)) for (const i of d.items || []) if (i.name) return i.name; return "chicken"; });
    await p.fill("#foodSearchInp", food.slice(0, 6)); await wait(p, 300);
    const rows = await p.evaluate(() => document.querySelectorAll("#foodSearchResults > div[onclick]").length);
    await p.evaluate(() => document.querySelector("#foodSearchResults > div[onclick]")?.click()); await wait(p, 400);
    const items = (await S(p)).nutrition.days[TODAY].items;
    const added = items.at(-1);
    await p.evaluate(([d, id]) => delFood(d, id), [TODAY, added?.id]); await wait(p, 300);
    const left = (await S(p)).nutrition.days[TODAY].items.length;
    await flush(h);
    note("search past foods, quick-add one, delete it (nutrition_item_delete sent)", rows > 0 && !!added && left === items.length - 1 && sent(h, "nutrition_item_delete").length >= 1, JSON.stringify({ rows, added: added?.name, left }));
  });
  await flow("resting + active + shock day", async () => {
    await p.fill("#bvRest", "2900"); await p.press("#bvRest", "Enter"); await p.evaluate(() => document.getElementById("bvRest")?.dispatchEvent(new Event("change"))); await wait(p, 300);
    await p.fill("#bvAct", "950"); await p.evaluate(() => document.getElementById("bvAct")?.dispatchEvent(new Event("change"))); await wait(p, 300);
    await p.evaluate((d) => toggleShock(d), TODAY); await wait(p, 300);
    const day = (await S(p)).nutrition.days[TODAY];
    await p.evaluate((d) => toggleShock(d), TODAY); await wait(p, 300);
    await flush(h);
    const metas = sent(h, "nutrition_day_meta");
    note("resting override, active calories and shock day save and sync", day.restingOverride === 2900 && Number(day.active) === 950 && day.shockProtocol === true && metas.length >= 1, JSON.stringify({ day: { r: day.restingOverride, a: day.active, s: day.shockProtocol }, metas: metas.length }));
  });
  await flow("date shift + past-day lock", async () => {
    await p.evaluate(() => nutShift(-1)); await wait(p, 300);
    const lbl = await p.evaluate(() => document.body.innerText.match(/TUE[^\n]*|Tue[^\n]*/)?.[0] || "");
    const ro = await p.evaluate(() => !!document.getElementById("bvRest")?.disabled);
    await p.evaluate(() => unlockNut(_nutDate)); await wait(p, 300);
    const rw = await p.evaluate(() => !document.getElementById("bvRest")?.disabled);
    await p.evaluate(() => lockNut(_nutDate)); await wait(p, 300);
    await p.evaluate(() => nutShift(1)); await wait(p, 300);
    note("food tab: go back a day (read-only), unlock to edit, lock again, return to today", ro && rw, JSON.stringify({ lbl, ro, rw }));
  });
  noErrors(h, "food");
  await h.ctx.close();
}

async function weightFlow(state) {
  const h = await boot({ state }); const p = h.page;
  await p.click("#nav-nutrition"); await wait(p, 600);
  await flow("weigh-in save + delete", async () => {
    await p.evaluate(() => toggleWtOpen()); await wait(p);
    await p.fill("#wtInp", "129.40000001"); await p.evaluate((d) => saveWeight(d), TODAY); await wait(p, 300);
    const w = (await S(p)).nutrition.weights[TODAY];
    await flush(h);
    const sentW = sent(h, "weight").at(-1)?.payload;
    const card = await p.evaluate(() => document.body.innerText.includes("129.4"));
    await p.evaluate((d) => delWeight(d), TODAY); await wait(p, 300);
    const gone = (await S(p)).nutrition.weights[TODAY] == null;
    await flush(h);
    note("weigh-in rounds float noise (129.4), shows, syncs; delete removes and syncs", w === 129.4 && sentW?.kg === 129.4 && card && gone && sent(h, "weight_delete").length === 1, JSON.stringify({ w, sentW, card, gone }));
  });
  await flow("weight history paging", async () => {
    await p.evaluate(() => { const d = [...document.querySelectorAll("details")].find((x) => /Weight History/.test(x.innerText)); if (d) d.open = true; }); await wait(p);
    const before = await p.evaluate(() => document.querySelectorAll("table tr").length);
    await p.evaluate(() => wtPage(1)); await wait(p);
    await p.evaluate(() => wtPage(0)); await wait(p);
    note("weight history renders and pages without errors", before > 0, String(before));
  });
  noErrors(h, "weight");
  await h.ctx.close();
}

async function settingsFlow(state) {
  const h = await boot({ state }); const p = h.page;
  await flow("drawer + theme on every tab", async () => {
    await p.evaluate(() => openDrawer()); await wait(p);
    const open = await p.evaluate(() => document.getElementById("drawer").classList.contains("open"));
    await p.evaluate(() => closeDrawer()); await wait(p);
    const th0 = await p.evaluate(() => document.documentElement.getAttribute("data-theme"));
    await p.click("#nav-settings"); await wait(p, 500);
    const seen = new Set();
    for (let i = 0; i < 3; i++) { await p.evaluate(() => toggleTheme()); await wait(p, 300); seen.add(await p.evaluate(() => document.documentElement.getAttribute("data-theme") || "auto")); }
    const th1 = [...seen].join(",");
    for (const t of ["workout", "nutrition", "settings"]) { await p.click("#nav-" + t); await wait(p, 400); }
    note("drawer opens and closes; the theme cycles light/dark and every tab re-renders", open && seen.has("light") && seen.has("dark"), JSON.stringify({ open, th0, th1 }));
  });
  await flow("export + backup round-trip", async () => {
    await p.click("#nav-settings"); await wait(p, 400);
    await p.evaluate(() => showExportSheet()); await wait(p, 300);
    await p.evaluate(() => genExp?.()); await wait(p, 300);
    const exp = await p.evaluate(() => (document.getElementById("expOut")?.value || document.querySelector("textarea[readonly]")?.value || document.querySelector(".export-sheet")?.innerText || "").length);
    const [dl] = await Promise.all([p.waitForEvent("download", { timeout: 4000 }).catch(() => null), p.evaluate(() => exportBackup())]);
    let path = null; if (dl) path = await dl.path();
    const before = await S(p);
    note("export sheet produces output; backup downloads a file", exp > 0 && !!path, JSON.stringify({ exp, path: !!path }));
    if (path) {
      const input = await p.$("input[type=file]");
      if (input) {
        h.answer = true;
        await input.setInputFiles(path); await wait(p, 900);
        const after = await S(p);
        const same = Object.keys(before.sessions).length === Object.keys(after.sessions).length && JSON.stringify(before.prs) === JSON.stringify(after.prs) && JSON.stringify(before.nutrition.weights) === JSON.stringify(after.nutrition.weights);
        note("importing that backup restores the same data (no loss)", same, JSON.stringify({ s0: Object.keys(before.sessions).length, s1: Object.keys(after.sessions).length }));
      } else note("import control present in Settings", false, "no input[type=file]");
    }
  });
  await flow("PDF report", async () => {
    const [pop] = await Promise.all([p.context().waitForEvent("page", { timeout: 4000 }).catch(() => null), p.evaluate(() => openPDFReport())]);
    const html = pop ? await pop.content() : await p.evaluate(() => document.body.innerHTML);
    note("PDF report opens with the training log", /FORGE|Forge/.test(html) && html.length > 2000, String(html.length));
    if (pop) await pop.close();
  });
  await flow("unit review + PR delete", async () => {
    // Plant a mix-up: last week's first set typed as 120 "kg" on a ~40 kg lift.
    const where = await p.evaluate(() => {
      const S = JSON.parse(localStorage.f5);
      // A past, logged, kg set on an exercise whose usual load is well under 66 kg.
      for (const k of Object.keys(S.sessions).filter((k) => !k.endsWith(wk())).sort().reverse()) for (const [id, ed] of Object.entries(S.sessions[k] || {})) {
        if (id.startsWith("_") || !ed?.sets?.[0]?.done || (ed.unit || "kg") !== "kg" || !(Number(ed.sets[0].weight) > 5 && Number(ed.sets[0].weight) < 45)) continue;
        ed.sets[0].weight = "120"; delete ed.sets[0].unitOk; localStorage.f5 = JSON.stringify(S); return [k, id];
      }
      return null; });
    await p.reload({ waitUntil: "networkidle" }); await wait(p, 600); await p.evaluate(() => { closeUnitReview?.(); });
    await p.evaluate(() => openUnitReview()); await wait(p, 300);
    const shown = await p.evaluate(() => !!document.querySelector("#planModal.show") && /120/.test(document.getElementById("planModal").innerText));
    await p.click("#planModal [onclick='unitFix(0,true)']"); await wait(p, 400);
    const fixed = await p.evaluate(([k, id]) => JSON.parse(localStorage.f5).sessions[k][id].sets[0].weight, where);
    await p.evaluate(() => closeUnitReview()); await wait(p);
    note("unit review lists a planted kg/lbs mix-up and Convert fixes it (120 -> 54.4)", shown && Number(fixed) === 54.4, JSON.stringify({ shown, fixed }));
    const st = await S(p), slug = Object.keys(st.prs)[0];
    h.answer = true;
    await p.evaluate((s) => dropPR(s), slug); await wait(p, 300);
    await flush(h);
    note("unit review opens and closes; deleting a PR syncs (pr_delete)", shown && sent(h, "pr_delete").length >= 1, JSON.stringify({ shown, del: sent(h, "pr_delete").length }));
  });
  await flow("restore snapshot (cancel + confirm)", async () => {
    await p.evaluate(() => { pushSnapshot(JSON.parse(localStorage.f5)); }); await wait(p);
    const snaps = await p.evaluate(() => listSnapshots().map((s) => s.ts));
    h.answer = false; h.dialogs.length = 0;
    await flush(h); const before = sent(h, "restore_all").length;
    await p.evaluate((ts) => restoreSnapshot(ts), snaps[0]); await wait(p, 300); await flush(h);
    const asked = h.dialogs.length > 0 && /every device|all devices|REPLACES/i.test(h.dialogs[0]);
    const nothing = sent(h, "restore_all").length === before && !(await outbox(p)).some((m) => m.entity === "restore_all");
    note("restore asks first (shows it reaches every device) and Cancel changes nothing", asked && nothing, JSON.stringify(h.dialogs.slice(0, 1)));
  });
  await flow("lock + unlock", async () => {
    const h3 = await boot({ state, noCfg: true }); const q = h3.page;
    const locked = await q.evaluate(() => getComputedStyle(document.getElementById("lockScreen")).display !== "none");
    await q.fill("#lockInput", "x"); await q.click(".lock-btn"); await wait(q, 900);
    const open = await q.evaluate(() => getComputedStyle(document.getElementById("lockScreen")).display === "none" && !!document.querySelector(".ex-card"));
    await q.evaluate(() => lockApp()); await wait(q, 900);
    const relocked = await q.evaluate(() => getComputedStyle(document.getElementById("lockScreen")).display !== "none");
    noErrors(h3, "lock screen");
    await h3.ctx.close();
    note("no token shows the lock screen; the token unlocks; Lock App locks again", locked && open && relocked, JSON.stringify({ locked, open, relocked }));
  });
  await flow("clear data: cancel keeps everything", async () => {
    const before = await S(p);
    h.answer = false;
    await p.evaluate(() => clearD()); await wait(p, 300);
    const after = await S(p);
    note("clear data with Cancel keeps all data", Object.keys(after.sessions).length === Object.keys(before.sessions).length);
  });
  noErrors(h, "settings");
  await h.ctx.close();
}

async function chatFlow(state) {
  const h = await boot({ state }); const p = h.page;
  await flow("coach chat", async () => {
    await p.click("#nav-askforge"); await wait(p);
    await p.fill("#aiChatInp", "how am I doing?"); await p.click("#aiChatSend"); await wait(p, 1500);
    const reply = await p.evaluate(() => /Mock coach reply/.test(document.getElementById("aiChatMessages").innerText));
    await p.evaluate(() => clearAiChat()); await wait(p);
    const cleared = ((await S(p)).aiChat || []).length === 0;
    await p.evaluate(() => closeForgeChat()); await wait(p);
    await flush(h);
    note("chat: send, reply shows, clear, close (ai_chat_add/clear sent)", reply && cleared && sent(h, "ai_chat_add").length >= 2 && sent(h, "ai_chat_clear").length === 1, JSON.stringify({ reply, cleared, muts: h.muts.map((m) => m.entity) }));
  });
  noErrors(h, "chat");
  await h.ctx.close();
}

async function syncFlow(state) {
  const h = await boot({ state }); const p = h.page;
  await flow("outbox: offline queue, 400 dropped, 500 retried, order kept", async () => {
    await p.evaluate(() => { queueMutation("weight", { date: "2026-10-01", kg: 130 }, "weight:2026-10-01"); queueMutation("weight", { date: "2026-10-02", kg: 129.8 }, "weight:2026-10-02"); queueMutation("weight", { date: "2026-10-03", kg: 129.6 }, "weight:2026-10-03"); });
    h.mutStatus = [500];
    await flush(h);
    const afterFail = (await outbox(p)).length;
    h.mutStatus = [200, 400, 200];
    await flush(h);
    const left = (await outbox(p)).length;
    const dates = sent(h, "weight").map((m) => m.payload.date);
    note("a 5xx stops and keeps the queue; a 400 is dropped and the rest go through in order",
      afterFail === 3 && left === 0 && JSON.stringify(dates) === JSON.stringify(["2026-10-01", "2026-10-03"]), JSON.stringify({ afterFail, left, dates }));
  });
  await flow("server pull replaces local state", async () => {
    const server = await S(p); server.nutrition.weights["2026-10-21"] = 128.8;
    h.serverState = server;
    await p.evaluate(() => loadServerState(false)); await wait(p, 600);
    const w = (await S(p)).nutrition.weights["2026-10-21"];
    note("a pull from the server replaces local state (sync replaces wholesale)", w === 128.8, String(w));
    h.serverState = null;
  });
  noErrors(h, "sync");
  await h.ctx.close();
}

async function themesAndHint(state) {
  for (const theme of ["light", "dark"]) {
    const h = await boot({ state, theme }); const p = h.page;
    for (const t of ["workout", "nutrition", "settings"]) { await p.click("#nav-" + t); await wait(p, 400); }
    await p.evaluate(() => openDrawer()); await wait(p, 300);
    noErrors(h, `${theme}: every tab and the drawer`);
    await h.ctx.close();
  }
  const ua = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
  const h = await boot({ state, ua }); const p = h.page;
  await flow("install hint", async () => {
    const shown = !!(await p.$("#installHint"));
    await p.evaluate(() => dismissInstallHint()); await wait(p);
    await p.reload({ waitUntil: "networkidle" }); await wait(p, 500);
    const gone = !(await p.$("#installHint"));
    note("iPhone Safari shows 'Add Forge to your Home Screen' once; dismissed stays dismissed", shown && gone, JSON.stringify({ shown, gone }));
  });
  noErrors(h, "install hint");
  await h.ctx.close();
}

// Service worker update: install v1, then serve a "newer" sw.js; the page must
// take the new worker, reload once, and drop the old cache.
async function swUpdate() {
  let swBody = readFileSync("dist/sw.js", "utf8");
  const app2 = express();
  app2.get("/sw.js", (req, res) => res.type("application/javascript").set("Cache-Control", "no-store").send(swBody));
  app2.use(express.static("dist"));
  const srv2 = await new Promise((res) => { const s = app2.listen(8794, () => res(s)); });
  const ctx = await browser.newContext({ serviceWorkers: "allow" });
  const page = await ctx.newPage(); const errs = []; page.on("pageerror", (e) => errs.push(e.message));
  await page.route("**/api/**", (r) => r.fulfill({ status: 501, body: "{}" }));
  await page.addInitScript(() => { window.FORGE_API_CFG = { baseUrl: "", token: "x" }; });
  await page.goto("http://127.0.0.1:8794/", { waitUntil: "networkidle" });
  const v1 = await page.evaluate(async () => { await navigator.serviceWorker.ready; for (let i = 0; i < 80 && !navigator.serviceWorker.controller; i++) await new Promise((r) => setTimeout(r, 100)); return caches.keys(); });
  swBody = swBody.replace(/const V = "([^"]+)"/, 'const V = "$1-next"');
  let reloads = 0; page.on("load", () => reloads++);
  await page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => r.update()));
  await page.waitForTimeout(4000);
  const v2 = await page.evaluate(() => caches.keys());
  note("service worker update: the new version takes over, reloads once, old cache deleted",
    v1.length === 1 && v2.length === 1 && v2[0].endsWith("-next") && reloads === 1 && errs.length === 0, JSON.stringify({ v1, v2, reloads, errs }));
  await ctx.close(); srv2.close();
}

// ── Run ────────────────────────────────────────────────────────────────────
try {
  browser = await chromium.launch({ executablePath: CHROME });
  const app = express(); app.use(express.static("dist"));
  server = await new Promise((res) => { const s = app.listen(PORT, () => res(s)); });
  // Fresh install state, then the realistic fixture on top of it.
  { const h = await boot({}); FRESH = await S(h.page); noErrors(h, "fresh install boots"); await h.ctx.close(); }
  const state = fixture(FRESH);
  console.log(`  e2e: ${process.env.E2E_STATE ? "real backup " + process.env.E2E_STATE : "synthetic fixture"}, ${NOW.toISOString()}`);
  await workoutNavigation(state);
  await workoutSession(state);
  await workoutSets(state);
  await calfNotes(state);
  await exercisesFlow(state);
  await planFlow(state);
  await foodFlow(state);
  await weightFlow(state);
  await settingsFlow(state);
  await chatFlow(state);
  await syncFlow(state);
  await themesAndHint(state);
  await swUpdate();
} catch (e) {
  note("e2e suite ran to completion", false, e.stack);
} finally {
  if (browser) await browser.close();
  if (server) server.close();
}
console.log(`\n  e2e flows: ${passes} passed, ${fails.length} failed`);
process.exit(fails.length ? 1 : 0);

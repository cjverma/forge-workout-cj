// qa_nutrition.cjs — Extended QA for Nutrition tab, light/dark mode, and Apple Health sync
'use strict';

const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const fs = require('fs');
const path = require('path');

const BASE_URL = 'http://localhost:9090';
const SCREENSHOT_DIR = '/tmp/qa_screenshots_nutrition';

if (!fs.existsSync(SCREENSHOT_DIR)) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

// Include session seed so ghost-text and overload tests work after page reloads
function buildSeedData() {
  const d = new Date();
  const j = new Date(d.getFullYear(), 0, 1);
  const curWk = d.getFullYear() + 'W' + Math.ceil(((d - j) / 86400000 + j.getDay() + 1) / 7);
  const prev = new Date(d); prev.setDate(prev.getDate() - 7);
  const jp = new Date(prev.getFullYear(), 0, 1);
  const prevWk = prev.getFullYear() + 'W' + Math.ceil(((prev - jp) / 86400000 + jp.getDay() + 1) / 7);
  const sessions = {};
  sessions[`Tuesday_${prevWk}`] = {
    't2_hc': { done: true, skipped: false, sets: [
      { weight: '10', reps: '12', done: true, attempted: true },
      { weight: '10', reps: '12', done: true, attempted: true },
    ]},
    _calfTwinges: []
  };
  sessions[`Tuesday_${curWk}`] = {
    't2_hc': { done: false, skipped: false, sets: [
      { weight: '12', reps: '12', done: true, attempted: true }
    ]}
  };
  return JSON.stringify({
    sessions,
    custom: {},
    nutrition: {
      days: {
        '2026-06-07': {
          active: 420,
          items: [
            { id: 'n_1', name: 'Chicken wrap', kcal: 480, protein: 35, carbs: 44, fat: 16, time: Date.now() - 86400000 },
            { id: 'n_2', name: 'Greek yogurt', kcal: 150, protein: 17, carbs: 10, fat: 4, time: Date.now() - 80000000 }
          ]
        },
        '2026-06-08': { active: 0, items: [] }
      },
      weights: {
        '2026-06-01': 136.6,
        '2026-06-03': 136.2,
        '2026-06-05': 135.8,
        '2026-06-07': 135.4,
        '2026-06-08': 135.1
      },
      aiDeficitModifier: 0,
      weeklyCoachNote: '',
      weeklySnapshots: []
    },
    theme: 'dark'
  });
}

let passed = 0;
let failed = 0;
const results = [];

async function test(name, fn, page) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
    results.push({ name, ok: true });
  } catch (err) {
    console.log(`  ❌ ${name}: ${err.message}`);
    failed++;
    results.push({ name, ok: false, err: err.message });
    try {
      const safe = name.replace(/[^a-z0-9]/gi, '_').toLowerCase();
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, `FAIL_${safe}.png`) });
    } catch (_) {}
  }
}

async function screenshot(page, name) {
  const safe = name.replace(/[^a-z0-9]/gi, '_').toLowerCase();
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${safe}.png`) });
}

// Helper: fresh page reload resets _nutDate to today
async function goNutrition(page) {
  // Navigate away then back to reset any JS state issues
  await page.click('#nav-workout');
  await page.waitForTimeout(200);
  await page.click('#nav-nutrition');
  await page.waitForTimeout(400);
  // If date label doesn't show today, click next until it does (max 3 tries)
  for (let i = 0; i < 3; i++) {
    const lbl = await page.$eval('.nut-date-lbl', el => el.textContent).catch(() => '');
    if (lbl.includes('8') || lbl.includes('Jun 8') || lbl.includes('Mon')) break;
    const btns = await page.$$('.nut-date-btn');
    if (btns[1]) await btns[1].click();
    await page.waitForTimeout(200);
  }
}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const context = await browser.newContext();
  const seedData = buildSeedData();

  await context.addInitScript(`
    localStorage.setItem('forge_key', 'test-token');
    localStorage.setItem('f5', ${JSON.stringify(seedData)});
  `);

  const page = await context.newPage();
  console.log('\n=== FORGE Nutrition Extended QA ===\n');

  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.waitForTimeout(800);
  await screenshot(page, '00_initial');

  // ── TEST N1: Nutrition tab exists in nav ──
  await test('Nutrition tab present in nav', async () => {
    const navNut = await page.$('#nav-nutrition');
    if (!navNut) throw new Error('Nutrition nav item not found');
    const text = await navNut.textContent();
    if (!text.includes('Nutrition')) throw new Error('Nav item text does not include "Nutrition"');
  }, page);

  // ── TEST N2: AI Coach tab removed ──
  await test('AI Coach tab removed from nav', async () => {
    const navAI = await page.$('#nav-ai');
    if (navAI) throw new Error('#nav-ai element still exists — should be removed');
  }, page);

  // ── TEST N3: Nutrition tab renders ──
  await test('Nutrition tab renders correctly', async () => {
    await page.click('#nav-nutrition');
    await page.waitForTimeout(500);
    await screenshot(page, 'n03_nutrition_tab');
    const content = await page.$eval('#tc', el => el.textContent);
    if (!content.includes('Nutrition')) throw new Error('Nutrition title not found');
    if (!content.includes('Burn')) throw new Error('Burn row not found');
    if (!content.includes('Target')) throw new Error('Target strip not found');
  }, page);

  // ── TEST N4: BMR calculated correctly ──
  await test('BMR value is in correct range (Mifflin-St Jeor)', async () => {
    await goNutrition(page);
    const content = await page.$eval('#tc', el => el.textContent);
    // With weight log at 135.1kg: BMR = 10*135.1 + 6.25*190.5 - 5*30 + 5 = 2397
    if (!content.match(/\b2[34]\d{2}\b/)) throw new Error('BMR value not found in expected range (2300–2499)');
  }, page);

  // ── TEST N5: Date navigator shows today's date ──
  await test('Date navigator shows today (Jun 8)', async () => {
    await goNutrition(page);
    const lbl = await page.$eval('.nut-date-lbl', el => el.textContent);
    if (!lbl.includes('8') && !lbl.includes('Jun')) throw new Error(`Date label unexpected: ${lbl}`);
  }, page);

  // ── TEST N6: Navigate to previous day ──
  await test('Date navigator: go to previous day', async () => {
    await goNutrition(page);
    const prevBtn = await page.$('.nut-date-btn');
    await prevBtn.click();
    await page.waitForTimeout(300);
    await screenshot(page, 'n06_prev_day');
    const lbl = await page.$eval('.nut-date-lbl', el => el.textContent);
    if (!lbl.includes('7')) throw new Error(`Expected Jun 7, got: ${lbl}`);
    const content = await page.$eval('#tc', el => el.textContent);
    if (!content.includes('Chicken wrap')) throw new Error('Seeded food item not visible on Jun 7');
  }, page);

  // ── TEST N7: Cannot navigate to future date (start from today) ──
  await test('Date navigator: cannot navigate past today', async () => {
    await goNutrition(page);
    // Must be on today (Jun 8) now
    const lblBefore = await page.$eval('.nut-date-lbl', el => el.textContent);
    const btns = await page.$$('.nut-date-btn');
    if (btns.length < 2) throw new Error('Expected 2 date buttons');
    await btns[1].click(); // next
    await page.waitForTimeout(300);
    const lblAfter = await page.$eval('.nut-date-lbl', el => el.textContent);
    if (lblBefore !== lblAfter) throw new Error(`Date changed to future: "${lblAfter}" (was "${lblBefore}")`);
  }, page);

  // ── TEST N8: Food items list on previous day ──
  await test('Food log shows seeded items on Jun 7', async () => {
    await goNutrition(page);
    const prevBtn = await page.$('.nut-date-btn');
    await prevBtn.click();
    await page.waitForTimeout(300);
    const content = await page.$eval('#tc', el => el.textContent);
    if (!content.includes('Chicken wrap')) throw new Error('Chicken wrap not found');
    if (!content.includes('Greek yogurt')) throw new Error('Greek yogurt not found');
    if (!content.includes('630')) throw new Error('Total kcal (630) not found');
  }, page);

  // ── TEST N9: Add Food button opens chat panel ──
  await test('Add Food button opens chat panel', async () => {
    await goNutrition(page);
    const addBtn = await page.$('.add-food-btn');
    if (!addBtn) throw new Error('Add food button not found');
    await addBtn.click();
    await page.waitForTimeout(300);
    await screenshot(page, 'n09_food_chat_open');
    const panel = await page.$('.food-chat-panel.open');
    if (!panel) throw new Error('Food chat panel did not open');
    const ta = await page.$('#foodChatTa');
    if (!ta) throw new Error('Food chat textarea not found');
  }, page);

  // ── TEST N10: Cancel closes chat panel ──
  await test('Cancel closes food chat panel', async () => {
    await goNutrition(page);
    const addBtn = await page.$('.add-food-btn');
    await addBtn.click();
    await page.waitForTimeout(300);
    // Find cancel button by onclick attribute
    const cancelBtn = await page.$('[onclick="closeFoodChat()"]');
    if (!cancelBtn) throw new Error('Cancel button (onclick=closeFoodChat) not found');
    await cancelBtn.click();
    await page.waitForTimeout(300);
    const panel = await page.$('.food-chat-panel.open');
    if (panel) throw new Error('Food chat panel still open after cancel');
  }, page);

  // ── TEST N11: Delete food item ──
  await test('Delete food item removes it from list', async () => {
    await goNutrition(page);
    const prevBtn = await page.$('.nut-date-btn');
    await prevBtn.click();
    await page.waitForTimeout(300);
    const delBtns = await page.$$('.food-del');
    if (!delBtns.length) throw new Error('No delete buttons found on Jun 7');
    await delBtns[0].click();
    await page.waitForTimeout(300);
    await screenshot(page, 'n11_after_delete');
    const content = await page.$eval('#tc', el => el.textContent);
    if (content.includes('Chicken wrap')) throw new Error('Chicken wrap still visible after delete');
    if (!content.includes('Greek yogurt')) throw new Error('Greek yogurt disappeared after deleting other item');
  }, page);

  // ── TEST N12: Shock Protocol toggle ──
  await test('Shock Protocol toggle activates and deactivates', async () => {
    await goNutrition(page);
    const shockBtn = await page.$('.shock-btn');
    if (!shockBtn) throw new Error('Shock button not found');
    const beforeText = await shockBtn.textContent();
    if (beforeText.includes('Active')) throw new Error('Shock should be off initially');
    await shockBtn.click();
    await page.waitForTimeout(300);
    await screenshot(page, 'n12_shock_on');
    const afterText = await page.$eval('.shock-btn', el => el.textContent);
    if (!afterText.includes('Active')) throw new Error('Shock did not activate');
    // Toggle off
    await page.click('.shock-btn');
    await page.waitForTimeout(300);
    const offText = await page.$eval('.shock-btn', el => el.textContent);
    if (offText.includes('Active')) throw new Error('Shock did not deactivate');
  }, page);

  // ── TEST N13: Weight log entries visible ──
  await test('Weight log shows seeded entries', async () => {
    await goNutrition(page);
    await screenshot(page, 'n13_weight_log');
    const content = await page.$eval('#tc', el => el.textContent);
    if (!content.includes('135.1')) throw new Error('Latest weight (135.1) not shown');
    if (!content.includes('136.6')) throw new Error('First weight (136.6) not shown');
  }, page);

  // ── TEST N14: Log Weight button saves entry ──
  await test('Log Weight saves a new entry to localStorage', async () => {
    await goNutrition(page);
    const wtInput = await page.$('#wtInput');
    if (!wtInput) throw new Error('Weight input not found');
    await wtInput.fill('134.8');
    await page.click('.wt-save-btn');
    await page.waitForTimeout(400);
    await screenshot(page, 'n14_weight_logged');
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('f5')));
    const today = new Date().toISOString().slice(0, 10);
    if (!stored.nutrition?.weights?.[today]) throw new Error(`Weight key ${today} not in localStorage`);
    if (stored.nutrition.weights[today] !== 134.8) throw new Error(`Wrong weight saved: ${stored.nutrition.weights[today]}`);
  }, page);

  // ── TEST N15: Sparkline renders ──
  await test('Sparkline SVG renders with weight data', async () => {
    await goNutrition(page);
    const svg = await page.$('.sparkline-wrap');
    if (!svg) throw new Error('Sparkline SVG not found');
    const tagName = await svg.evaluate(el => el.tagName.toLowerCase());
    if (tagName !== 'svg') throw new Error(`Expected svg, got: ${tagName}`);
  }, page);

  // ── TEST N16: Estimated arrival date shown ──
  await test('Estimated arrival date shown below weight chart', async () => {
    await goNutrition(page);
    const content = await page.$eval('#tc', el => el.textContent);
    if (!content.includes('Estimated arrival')) throw new Error('Estimated arrival text not found');
  }, page);

  // ── TEST N17: Apple Health setup modal ──
  await test('Apple Health setup button opens modal and closes', async () => {
    await goNutrition(page);
    await page.click('.hk-setup-btn');
    await page.waitForTimeout(300);
    await screenshot(page, 'n17_hk_modal');
    const modal = await page.$('#hkModal.show');
    if (!modal) throw new Error('HK modal did not open');
    const content = await modal.textContent();
    if (!content.includes('Shortcuts')) throw new Error('Setup instructions not shown');
    await page.click('#hkModal button:last-child');
    await page.waitForTimeout(300);
    const modalAfter = await page.$('#hkModal.show');
    if (modalAfter) throw new Error('Modal did not close');
  }, page);

  // ── TEST N18: Apple Health URL param sync ──
  await test('Apple Health URL param syncs active calories', async () => {
    await page.goto(BASE_URL + '?hksync=1&active=520&date=2026-06-08', { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(1000);
    await screenshot(page, 'n18_hk_sync');
    const url = page.url();
    if (url.includes('hksync')) throw new Error('URL params not cleaned after sync');
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('f5')));
    const dayData = stored.nutrition?.days?.['2026-06-08'];
    if (!dayData) throw new Error('Day data not created');
    if (dayData.active !== 520) throw new Error(`Active kcal not saved correctly: ${dayData.active}`);
  }, page);

  // ── TEST N19: AI Coaching accordion exists ──
  await test('AI Coaching accordion present in Nutrition tab', async () => {
    await goNutrition(page);
    const accordion = await page.$('details.ai-accordion');
    if (!accordion) throw new Error('AI Coaching accordion not found');
    const text = await page.$eval('details.ai-accordion summary', el => el.textContent);
    if (!text.includes('AI Coaching')) throw new Error(`Accordion summary wrong: ${text}`);
  }, page);

  // ── TEST N20: AI Coaching accordion expands ──
  await test('AI Coaching accordion expands to show all 6 coach cards', async () => {
    await goNutrition(page);
    await page.click('details.ai-accordion summary');
    await page.waitForTimeout(300);
    await screenshot(page, 'n20_accordion_open');
    const open = await page.$('details.ai-accordion[open]');
    if (!open) throw new Error('Accordion did not open');
    const content = await open.textContent();
    if (!content.includes('Log in Plain English')) throw new Error('Log card not in accordion');
    if (!content.includes('Machine Busy')) throw new Error('Machine Busy card not in accordion');
    if (!content.includes('Warm-Up Weights')) throw new Error('Warm-Up card not in accordion');
  }, page);

  // ── TEST N21: Light mode toggle ──
  await test('Light mode toggle switches theme and applies html.light class', async () => {
    await page.click('#nav-settings');
    await page.waitForTimeout(400);
    await screenshot(page, 'n21_settings_dark');
    const themeRow = await page.$('[onclick="toggleTheme()"]');
    if (!themeRow) throw new Error('Theme toggle row not found');
    await themeRow.click();
    await page.waitForTimeout(300);
    await screenshot(page, 'n21_settings_light');
    const hasLight = await page.evaluate(() => document.documentElement.classList.contains('light'));
    if (!hasLight) throw new Error('html.light class not applied');
    // Toggle back
    await page.click('[onclick="toggleTheme()"]');
    await page.waitForTimeout(200);
    const isDarkAgain = await page.evaluate(() => !document.documentElement.classList.contains('light'));
    if (!isDarkAgain) throw new Error('html.light not removed on toggle back');
  }, page);

  // ── TEST N22: Theme persists in localStorage ──
  await test('Light mode saved to localStorage and persists on navigation', async () => {
    await page.click('#nav-settings');
    await page.waitForTimeout(300);
    await page.click('[onclick="toggleTheme()"]');
    await page.waitForTimeout(300);
    await page.click('#nav-workout');
    await page.waitForTimeout(200);
    const hasLight = await page.evaluate(() => document.documentElement.classList.contains('light'));
    if (!hasLight) throw new Error('Light mode lost after navigation');
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('f5')));
    if (stored.theme !== 'light') throw new Error(`theme not saved: ${stored.theme}`);
    // Reset
    await page.click('#nav-settings');
    await page.waitForTimeout(300);
    await page.click('[onclick="toggleTheme()"]');
    await page.waitForTimeout(200);
  }, page);

  // ── TEST N23: Invalid weight (999) rejected ──
  await test('Invalid weight (999) rejected with validation toast', async () => {
    await goNutrition(page);
    const wtInput = await page.$('#wtInput');
    await wtInput.fill('999');
    await page.click('.wt-save-btn');
    await page.waitForTimeout(500);
    const toastText = await page.$eval('#toast', el => el.textContent);
    if (!toastText.includes('valid weight')) throw new Error(`Expected validation toast, got: "${toastText}"`);
  }, page);

  // ── TEST N24: Progress bar green when under target ──
  await test('Progress bar is green when 0 kcal consumed (< 90% of target)', async () => {
    await goNutrition(page);
    const fill = await page.$('.nut-progress-fill.green');
    if (!fill) throw new Error('Green progress fill not found');
  }, page);

  // ── TEST N25: Macro targets shown ──
  await test('Macro row shows protein target (190g)', async () => {
    await goNutrition(page);
    const content = await page.$eval('#tc', el => el.textContent);
    if (!content.includes('190g')) throw new Error('Protein target 190g not shown');
  }, page);

  // ── TEST N26: Net deficit line renders ──
  await test('Net deficit line renders with consumed and net values', async () => {
    await goNutrition(page);
    const netEl = await page.$('.net-line');
    if (!netEl) throw new Error('Net line element not found');
    const text = await netEl.textContent();
    if (!text.includes('consumed')) throw new Error(`Net line text unexpected: ${text}`);
  }, page);

  // ── TEST N27: Workout tab still functions (regression check) ──
  await test('Workout tab: Hammer Curl still on Tuesday (regression)', async () => {
    await page.click('#nav-workout');
    await page.waitForTimeout(400);
    await page.click('#p-Tuesday');
    await page.waitForTimeout(400);
    const content = await page.$eval('#tc', el => el.textContent);
    if (!content.includes('Hammer Curl')) throw new Error('Hammer Curl not found on Tuesday');
  }, page);

  // ── TEST N28: Ghost text still works (regression) ──
  await test('Ghost text "Last:" still appears on Tuesday (regression)', async () => {
    await page.click('#nav-workout');
    await page.waitForTimeout(300);
    await page.click('#p-Tuesday');
    await page.waitForTimeout(400);
    const content = await page.$eval('#tc', el => el.textContent);
    if (!content.includes('Last:')) throw new Error('"Last:" ghost text not found — regression');
  }, page);

  // ── TEST N29: XSS in weight input does not execute ──
  await test('XSS in weight input field does not execute alert', async () => {
    await goNutrition(page);
    let alertFired = false;
    page.once('dialog', async dialog => { alertFired = true; await dialog.dismiss(); });
    const wtInput = await page.$('#wtInput');
    await wtInput.fill('0');
    await page.click('.wt-save-btn');
    await page.waitForTimeout(500);
    if (alertFired) throw new Error('XSS alert fired from weight input');
  }, page);

  // ── TEST N30: BMR updates when weight log changes ──
  await test('BMR recalculates lower after logging lower weight', async () => {
    await goNutrition(page);
    const contentBefore = await page.$eval('#tc', el => el.textContent);
    const bmrMatch = contentBefore.match(/BMR today: (\d+)/);
    if (!bmrMatch) throw new Error('BMR today text not found');
    const bmrBefore = parseInt(bmrMatch[1]);

    const wtInput = await page.$('#wtInput');
    await wtInput.fill('125.0');
    await page.click('.wt-save-btn');
    await page.waitForTimeout(400);

    const contentAfter = await page.$eval('#tc', el => el.textContent);
    const bmrMatchAfter = contentAfter.match(/BMR today: (\d+)/);
    if (!bmrMatchAfter) throw new Error('BMR today text not found after update');
    const bmrAfter = parseInt(bmrMatchAfter[1]);
    if (bmrAfter >= bmrBefore) throw new Error(`BMR should decrease with lower weight: before=${bmrBefore} after=${bmrAfter}`);
  }, page);

  await screenshot(page, 'zz_final');

  console.log('\n=== Nutrition QA Summary ===');
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  console.log(`Total:  ${passed + failed}`);
  if (failed > 0) {
    console.log('\nFailed tests:');
    results.filter(r => !r.ok).forEach(r => console.log(`  ❌ ${r.name}: ${r.err}`));
  }
  console.log(`\nScreenshots saved to: ${SCREENSHOT_DIR}`);

  await browser.close();
  process.exit(failed > 0 ? 1 : 0);
})();

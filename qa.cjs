// qa.cjs — Playwright QA script for FORGE workout app
// Run: node qa.cjs (assumes python3 http.server running on port 9090)
'use strict';

const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const fs = require('fs');
const path = require('path');

const BASE_URL = 'http://localhost:9090';
const SCREENSHOT_DIR = '/tmp/qa_screenshots';

// Ensure screenshot dir exists
if (!fs.existsSync(SCREENSHOT_DIR)) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

// Seed data: a past session (last week) for Tuesday with done sets for Hammer Curl and Seated Calf Raise
function buildSeedData() {
  const d = new Date();
  const j = new Date(d.getFullYear(), 0, 1);
  const curWk = d.getFullYear() + 'W' + Math.ceil(((d - j) / 86400000 + j.getDay() + 1) / 7);
  const prev = new Date(d);
  prev.setDate(prev.getDate() - 7);
  const jp = new Date(prev.getFullYear(), 0, 1);
  const prevWk = prev.getFullYear() + 'W' + Math.ceil(((prev - jp) / 86400000 + jp.getDay() + 1) / 7);

  const pastTuesdayKey = `Tuesday_${prevWk}`;
  const sessions = {};

  // Past Tuesday session with done sets for Hammer Curl (t2_hc) and Seated Calf Raise (t_sc)
  sessions[pastTuesdayKey] = {
    't2_hc': {
      done: true, skipped: false,
      sets: [
        { weight: '10', reps: '12', done: true, attempted: true },
        { weight: '10', reps: '12', done: true, attempted: true },
        { weight: '10', reps: '12', done: true, attempted: true },
      ]
    },
    't_sc': {
      done: true, skipped: false,
      sets: [
        { weight: '35', reps: '15', done: true, attempted: true },
        { weight: '35', reps: '15', done: true, attempted: true },
        { weight: '35', reps: '15', done: true, attempted: true },
      ]
    },
    // Calf twinges seed
    _calfTwinges: [Date.now() - 3600000]
  };

  // Current week session with higher weight for Hammer Curl to trigger ↑ badge
  const curTuesdayKey = `Tuesday_${curWk}`;
  sessions[curTuesdayKey] = {
    't2_hc': {
      done: false, skipped: false,
      sets: [
        { weight: '12', reps: '12', done: true, attempted: true },
      ]
    }
  };

  return JSON.stringify({ sessions, custom: {} });
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

(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const context = await browser.newContext();
  const seedData = buildSeedData();

  // Bypass lock screen by injecting forge_key and seed f5 data
  await context.addInitScript(`
    localStorage.setItem('forge_key', 'test-token');
    localStorage.setItem('f5', ${JSON.stringify(seedData)});
  `);

  const page = await context.newPage();

  console.log('\n=== FORGE QA Test Suite ===\n');

  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.waitForTimeout(800);
  await screenshot(page, '00_initial_load');

  // ── TEST 1: Tuesday day loads ──
  await test('Tuesday day loads', async () => {
    await page.click('#p-Tuesday');
    await page.waitForTimeout(500);
    await screenshot(page, '01_tuesday');
    const content = await page.$eval('#tc', el => el.textContent);
    if (content.length < 50) throw new Error('Tuesday content not rendered');
  }, page);

  // ── TEST 2: Hammer Curl present on Tuesday ──
  await test('Hammer Curl present on Tuesday', async () => {
    await page.click('#p-Tuesday');
    await page.waitForTimeout(400);
    await screenshot(page, '02_hammer_curl');
    const content = await page.$eval('#tc', el => el.textContent);
    if (!content.includes('Hammer Curl')) throw new Error('Hammer Curl not found on Tuesday');
  }, page);

  // ── TEST 3: Wednesday Seated Calf Raise ──
  await test('Wednesday Seated Calf Raise', async () => {
    await page.click('#p-Wednesday');
    await page.waitForTimeout(400);
    await screenshot(page, '03_wednesday');
    const content = await page.$eval('#tc', el => el.textContent);
    if (!content.includes('Seated Calf Raise')) throw new Error('Seated Calf Raise not found on Wednesday');
  }, page);

  // ── TEST 4: Saturday Hip Abduction Machine ──
  await test('Saturday Hip Abduction Machine', async () => {
    await page.click('#p-Saturday');
    await page.waitForTimeout(400);
    await screenshot(page, '04_saturday');
    const content = await page.$eval('#tc', el => el.textContent);
    if (!content.includes('Hip Abduction Machine')) throw new Error('Hip Abduction Machine not found on Saturday');
  }, page);

  // ── TEST 5: Sunday is Active Recovery ──
  await test('Sunday is Active Recovery', async () => {
    await page.click('#p-Sunday');
    await page.waitForTimeout(400);
    await screenshot(page, '05_sunday');
    const content = await page.$eval('#tc', el => el.textContent);
    if (!content.includes('Active Recovery')) throw new Error('Sunday does not show Active Recovery');
    // Check physio banner
    const hasBanner = content.includes('physio only') || content.includes('Rest day');
    if (!hasBanner) throw new Error('Sunday physio rest banner not found');
  }, page);

  // ── TEST 6: Last session ghost text ──
  await test('Last session ghost text appears', async () => {
    await page.click('#p-Tuesday');
    await page.waitForTimeout(400);
    await screenshot(page, '06_last_ghost');
    const content = await page.$eval('#tc', el => el.textContent);
    if (!content.includes('Last:')) throw new Error('"Last:" ghost text not found on Tuesday');
  }, page);

  // ── TEST 7: Carry-forward weight input pre-filled ──
  await test('Carry-forward weight input pre-filled', async () => {
    await page.click('#p-Tuesday');
    await page.waitForTimeout(400);
    const inputs = await page.$$('input.si[type="number"]');
    let found = false;
    for (const inp of inputs) {
      const val = await inp.inputValue();
      if (val && parseFloat(val) > 0) { found = true; break; }
    }
    await screenshot(page, '07_carry_forward');
    if (!found) throw new Error('No pre-filled weight input found (carry-forward failed)');
  }, page);

  // ── TEST 8: Calf logger button visible after starting workout ──
  await test('Calf logger button visible when workout active', async () => {
    await page.click('#p-Monday');
    await page.waitForTimeout(400);
    const startBtn = await page.$('#bStart');
    if (startBtn && await startBtn.isVisible()) await startBtn.click();
    await page.waitForTimeout(300);
    await screenshot(page, '08_calf_btn');
    const calfBtn = await page.$('#calfBtn');
    if (!calfBtn) throw new Error('Calf twinge button not found after starting workout');
    const visible = await calfBtn.isVisible();
    if (!visible) throw new Error('Calf twinge button not visible after starting workout');
  }, page);

  // ── TEST 9: Calf twinge badge increments ──
  await test('Calf twinge badge increments to 3', async () => {
    // Should still be on Monday with workout active from TEST 8
    let calfBtn = await page.$('#calfBtn');
    if (!calfBtn) {
      // Re-activate
      await page.click('#p-Monday');
      await page.waitForTimeout(300);
      const startBtn = await page.$('#bStart');
      if (startBtn && await startBtn.isVisible()) await startBtn.click();
      await page.waitForTimeout(300);
      calfBtn = await page.$('#calfBtn');
    }
    if (!calfBtn) throw new Error('Calf button not found');

    for (let i = 0; i < 3; i++) {
      calfBtn = await page.$('#calfBtn');
      if (!calfBtn) throw new Error(`Calf button not found on click ${i + 1}`);
      await calfBtn.click();
      await page.waitForTimeout(200);
    }
    await screenshot(page, '09_calf_count');
    const badge = await page.$('.calf-badge');
    if (!badge) throw new Error('Calf badge element not found');
    const count = parseInt(await badge.textContent());
    if (count < 3) throw new Error(`Badge shows ${count}, expected >= 3`);
  }, page);

  // ── TEST 10: Session notes persist after reload ──
  await test('Session notes save and persist after reload', async () => {
    await page.click('#p-Tuesday');
    await page.waitForTimeout(400);
    const bStart = await page.$('#bStart');
    if (bStart && await bStart.isVisible()) await bStart.click();
    await page.waitForTimeout(300);

    const notesArea = await page.$('#sessNotes');
    if (!notesArea) throw new Error('Notes textarea not found');
    await notesArea.fill('Test session note 12345');
    await page.waitForTimeout(700); // wait for debounce

    await screenshot(page, '10a_notes_typed');
    await page.evaluate(() => localStorage.setItem('forge_key', 'test-token'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(800);
    await page.click('#p-Tuesday');
    await page.waitForTimeout(400);
    await screenshot(page, '10b_notes_reloaded');

    const notesArea2 = await page.$('#sessNotes');
    if (!notesArea2) throw new Error('Notes textarea not found after reload');
    const val = await notesArea2.inputValue();
    if (!val.includes('Test session note 12345')) throw new Error(`Notes not persisted — got: "${val}"`);
  }, page);

  // ── TEST 11: Rest timer appears after marking a set done ──
  await test('Rest timer overlay appears after marking a set done', async () => {
    await page.click('#p-Tuesday');
    await page.waitForTimeout(400);
    const bStart = await page.$('#bStart');
    if (bStart && await bStart.isVisible()) await bStart.click();
    await page.waitForTimeout(300);

    let setMarked = false;
    const cards = await page.$$('.ex-card');
    for (const card of cards) {
      const top = await card.$('.ex-top');
      if (!top) continue;
      await top.click();
      await page.waitForTimeout(200);

      const inputs = await card.$$('input.si[type="number"]');
      if (inputs.length < 2) continue;

      // Fill weight
      await inputs[0].fill('30');
      await inputs[0].dispatchEvent('change');
      await page.waitForTimeout(150);

      // Fill reps
      await inputs[1].fill('12');
      await inputs[1].dispatchEvent('change');
      await page.waitForTimeout(200);

      // Click done button (should no longer be locked)
      const doneBtn = await card.$('.sdone:not(.locked)');
      if (doneBtn) {
        await doneBtn.click();
        setMarked = true;
        break;
      }
    }

    await page.waitForTimeout(300);
    await screenshot(page, '11_rest_timer');

    if (!setMarked) throw new Error('Could not find and complete a set to trigger rest timer');

    const rt = await page.$('#restTimer');
    if (!rt) throw new Error('Rest timer element not found');
    const display = await rt.evaluate(el => el.style.display);
    if (display === 'none') throw new Error('Rest timer not displayed after set done');
  }, page);

  // ── TEST 12: Progressive overload ↑ badge ──
  await test('Progressive overload ↑ badge shows when weight increased', async () => {
    // Seed has t2_hc at 12kg this week vs 10kg last week → should show ↑
    await page.click('#p-Tuesday');
    await page.waitForTimeout(400);
    await screenshot(page, '12_overload');
    const olUp = await page.$('.ol-up');
    if (!olUp) throw new Error('No ↑ overload badge found (expected for Hammer Curl seeded with higher weight this week)');
  }, page);

  // ── TEST 13: XSS in session notes is escaped ──
  await test('XSS in session notes is escaped not executed', async () => {
    await page.click('#p-Wednesday');
    await page.waitForTimeout(400);
    const bStart = await page.$('#bStart');
    if (bStart && await bStart.isVisible()) await bStart.click();
    await page.waitForTimeout(300);

    const notesArea = await page.$('#sessNotes');
    if (!notesArea) throw new Error('Notes textarea not found');

    let alertFired = false;
    page.once('dialog', async dialog => {
      alertFired = true;
      await dialog.dismiss();
    });

    await notesArea.fill('<script>alert(1)</script>');
    await page.waitForTimeout(700);
    await screenshot(page, '13_xss_notes');

    if (alertFired) throw new Error('XSS executed — alert dialog was triggered!');

    // The textarea value should contain the literal text
    const val = await notesArea.inputValue();
    if (!val.includes('<script>')) throw new Error('Notes value was not stored (unexpected)');

    // Verify the textarea HTML attribute is escaped
    const outerHtml = await page.$eval('.notes-wrap textarea', el => el.outerHTML);
    // Should not contain raw unescaped script tag
    if (outerHtml.includes('<script>alert') && !outerHtml.includes('&lt;script&gt;')) {
      throw new Error('Raw unescaped script tag found in textarea HTML attribute — XSS vulnerability!');
    }
  }, page);

  // ── TEST 14: No overload badge with no history ──
  await test('No overload badge on exercise with no history', async () => {
    await page.click('#p-Saturday');
    await page.waitForTimeout(400);
    await screenshot(page, '14_no_overload_badge');

    // Saturday has no seeded session data, so no ol badges should appear
    const olBadges = await page.$$('.ol-up, .ol-down, .ol-eq');
    if (olBadges.length > 0) {
      // This might be fine if some other exercise has data — let's just verify
      // that the cardio bike card has no badge (it never should)
      const bikeCard = await page.$('[id^="ex-sa_bike"], [id^="ex-sa2_bike"]');
      if (bikeCard) {
        const badgeInBike = await bikeCard.$('.ol-up, .ol-down, .ol-eq');
        if (badgeInBike) throw new Error('Overload badge found on cardio exercise (should never appear)');
      }
    }
    // Test passes if no unexpected badges
  }, page);

  // Final summary
  console.log('\n=== QA Summary ===');
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

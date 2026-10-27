# FORGE — Claude Code Instructions

## Stack
- Single-file PWA: `index.html` (HTML + CSS + JS, no build step)
- Serverless API routes: `/api/*.js` (Vercel)
- State: `localStorage` key `f5`, object `S`
- No TypeScript, no framework, no bundler

## Branch Rules
- Feature work → `claude/keen-ritchie-YZhKV`
- **Never push to `main` without explicit user approval**
- Always commit to keen-ritchie first, get user sign-off, then merge

## UI / CSS Conventions: the iOS look (Oct 2026)

**The whole app now uses Apple's own-app grammar** (user chose "Apple's own
apps"; Workout shipped first, then every other screen). The live tokens sit
on `body[data-tab]` in `index.html` ("WORKOUT TAB CHROME + TOKENS"), so every
tab, the drawer, chat, sheets and pop-ups inherit them: system background
`#F2F2F7`/`#000`, white/`#1C1C1E` cards, system blue `--accent`, SF Pro via
`-apple-system`, SF Rounded (`--font-num`) for figures, system colours for the
macro chart. The `:root` volt tokens below are only a fallback now.

- Grammar: large sentence-case titles (34px bold), inset grouped cards on
  `--s1` with NO border/shadow/gradient, hairline (.5px) separators, 13px
  uppercase grey group headers between cards, sentence-case 13px captions in
  cards, 17px rows, filled blue for the one primary action and grey-tinted
  (`--s2` + blue text) for the rest, filled inputs with a tint focus ring.
- Workout content lives under `.wv`; every other screen under the "EVERY
  OTHER SCREEN · iOS" block, all prefixed `body[data-tab]` so they outrank
  the single-class card rule. Inline JS styles are normalised there too:
  9-12px text is lifted to 13px, inline uppercase eyebrows are dropped,
  hairline-bordered inline buttons become tinted buttons.
- The intake card (`.nut-hero`) is an ordinary card now: its `--hero-*`
  tokens are re-pointed at the surface tokens. It must stay >= 4.5:1 in both
  themes (runtime-tested).
- No "·" separators in UI copy (an AI tell for the user): use a comma, a
  colon or two sentences. `mdLite` turns AI em dashes into ", " (": " in a
  heading). The PDF report is exempt.
- Status bar: `#000` dark / `#F2F2F7` light (`applyTheme`, manifest `?v=3`).
- `verify-runtime.mjs` fails if any tab or the drawer falls back to volt.

## Legacy: the "Premium Athletic / Volt" design system (fallback tokens only)

### Always use CSS variables — never hardcode colours
All themed tokens live in ONE `:root` block using `light-dark(lightVal, darkVal)`,
driven by `color-scheme` (`html[data-theme]` set by `applyTheme()`). There is no
duplicated dark block — edit a token once and both themes update.

Key variables:
```
--black        → primary surface (app bg, modal bg) · #F4F4F5 light / #0A0A0B dark
--s1           → card background
--s2           → secondary card / input background
--b1, --b2     → border colours
--white        → primary text
--lt / --mid / --dim → secondary / muted / placeholder text

VOLT ACCENT SYSTEM (the brand colour):
--accent       → volt lime FILLS only (buttons, badges, CTAs)
--accent-ink   → text ON accent fills (near-black; never use white on volt)
--accent-text  → accent-coloured TEXT/strokes on surfaces
                 (moss #55700B in light — raw volt is illegible on white;
                  volt #C8F135 in dark)
--accent-lo    → accent tint background
--orange       → alias for --accent-text (safe everywhere; legacy name)
--on-accent    → alias for --accent-ink

SEMANTIC:
--green / --red → success / destructive
--amber        → WARNINGS ONLY (needs-input, sugar/sodium over-limit, shock day)
                 — never use as a brand/CTA colour

HERO TOKENS (theme-independent — hero cards stay dark in BOTH themes):
--grad-push/-pull/-legs/-core/-rest/-nut → per-day hero gradients
--hero-fg / --hero-fg-dim / --hero-fg-faint → text on hero gradients
--hero-chip / --hero-line  → chip/hairline surfaces on heroes
--hero-accent  → raw volt (safe: always on dark gradient)
--hero-pos / --hero-neg    → positive/negative deltas on heroes
--chart-p/-c/-f/-fi        → macro chart colours (protein = volt)
```

### Accent usage rules
- Filled CTA: `background:var(--accent); color:var(--accent-ink)`
- Accent text/border/stroke on a normal surface: `var(--accent-text)` (or the
  `--orange` alias) — NEVER raw volt/`--accent` for text or thin strokes in
  light mode (1.5:1 contrast on white)
- Anything inside `.hero`, `.quote-card`, `.nut-hero`: use `--hero-*` tokens
  only. A scope-guard rule (`.hero * { color:var(--hero-fg) }`) protects
  against theme bleed; specific rules override it by cascade — don't add
  `!important` colour rules inside heroes.

### Typography
- Display font: **Barlow Condensed 600/700** via `var(--font-display)` —
  SELF-HOSTED in `/fonts/*.woff2` (offline-first; never load fonts from a CDN).
  Both files are pre-cached in `sw.js` PRECACHE.
- Used for: hero titles, page titles, big numerals (rest timer, kcal remaining,
  summary stats) — always with `text-transform:uppercase` and
  `font-variant-numeric:tabular-nums` on counters.
- Body/buttons/inputs/nav use **Barlow 400/500/600/700** via `var(--font-body)`
  — the non-condensed sibling of the display font, so the whole app is one
  superfamily. Also self-hosted in `/fonts/barlow-*.woff2` and pre-cached.
  Never hardcode a family name; never reintroduce Inter or a CDN font link.
- Barlow is loaded at **400–700 only**. Don't use `font-weight:800` in app CSS —
  the browser would synthesize it. (The PDF print report is exempt: it renders
  in system fonts on white paper.)
- **Tabular numerals are not automatic.** Barlow defaults to proportional
  figures, so any number that updates in place (weights, reps, timers, macro
  counters, table cells) jitters horizontally as digits change — `136.6` and
  `111.1` differ by ~8px. Add new counters/inputs/cells to the shared
  `font-variant-numeric:tabular-nums` rule in `index.html`. Never put it on
  `body` or prose containers: tabular digits in running text read wide and gappy.
- Any new critical font face needs three things: an `@font-face`, a
  `<link rel="preload" ... crossorigin>` (crossorigin is mandatory even
  same-origin, or the file is fetched twice), and an entry in `sw.js` PRECACHE.
  Keep preloads to the faces that paint on first frame — currently
  `barlow-400` + `barlow-condensed-600`.

### No em dashes in UI text
- User-visible strings must not contain `—`. Reword instead: split into two
  sentences, or use `·` (labels, stats, chips), a colon, or a comma. Never a
  hyphen between words — that reads as a typo.
- `·` is also the "no value" placeholder in tables and set rows.
- `mdLite()` in `src/ui.js` normalises AI output at render time: em dash → ` · `,
  en dash → `-` (en dashes are numeric ranges like `8–12 reps`). It matches
  `[ \t]*` not `\s*` on purpose — `\s` would swallow newlines and join lines.
- Code comments may use em dashes freely. AI *prompt* strings are exempt too
  (never rendered), and the test sweep skips both.
- `node test.js` fails the build if an em dash reaches a user-visible string.

### Surface material (what makes it read as premium)
- **Every surface step must stay distinct.** `--s0/--s1/--s2/--s3/--b1/--b2/--black`
  are a ramp; if two collapse, the design breaks. Light mode was once
  `--s0 == --s1 == #FFFFFF` (white cards on grey, the generic-dashboard look)
  and dark had `--b1 == --s3` (invisible card borders). `node test.js` now fails
  on any collapse.
- The light ramp is **warm off-white**, not pure white. A hair of warmth is what
  reads as paper instead of an unstyled default. Never reintroduce `#FFFFFF` as
  a card fill (`--s0`, the bottom nav, is the one legitimate exception).
- **Cards use `--card-grad` + `--card-edge`, never a flat `background:var(--s1)`.**
  A near-invisible vertical gradient plus a brighter top hairline is the
  light-source cue that makes a rectangle read as a lit object. It's applied by
  one grouped rule at the end of the cascade, using single-class selectors so
  `.a.b` modifiers (`.ex-card.done`) still win. Recessed `--s2` surfaces
  (`.set-row`, `.st-subacc`, `.weekly-note`) are excluded on purpose.
- **Single-class selectors protect COMPOUND modifiers only, not a second
  independent class on the same element.** `.ex-card.done` is (0,2,0) and wins.
  But `.nut-hero` rides on `<div class="nut-card nut-hero">` — also (0,1,0), so
  the later grouped rule won and the hero lost its dark gradient *and* its volt
  `border-top`. Invisible in dark mode, white-on-white in light. Hence
  `.nut-card:not(.nut-hero)`. **Putting a card class on a hero element needs an
  exclusion in that rule**, and `node test.js` fails if the two ever mix.
- **Heroes are theme-independent dark surfaces.** Never let card material,
  `--s1`, or any `light-dark()` surface token reach `.hero`, `.quote-card`, or
  `.nut-hero`. Verify hero changes in LIGHT mode: dark mode hides this whole
  class of bug, because a wrong light surface still looks dark there.
- **Overlays use `--scrim` + `--scrim-blur`**, never a raw `rgba(0,0,0,.N)`.
  Keep the `@supports not (backdrop-filter…)` fallback in sync when adding a
  blurred surface, or it degrades to washed-out and unreadable.

### Shape, space, elevation scales
- Radius: `--r-sm/-md/-lg/-xl/--r-pill` only (`50%` stays for true circles).
  There were once 27 distinct radii and two competing pill idioms.
- Spacing: `--sp-1`…`--sp-6`. **`--sp-4` (16px) is THE page gutter** — every
  wrapper uses it, so content aligns down the page edge.
- Elevation is rationed to three tiers: most cards have **no** shadow (the lit
  top edge separates them), `--shadow` is for interactive/raised things only,
  `--shadow-lift` for heroes, sheets, drawer, overlays. Shadow on everything
  means depth signals nothing; the test caps `--shadow` carriers.
- **Define each card class once.** A v2/v3 retrofit block once re-declared
  `.nut-card`/`.st-group`/`.export-card`/`.rule-item`/`.weekly-note` instead of
  editing them, so two rules fought and the later silently won. Tested.

### Labels: landmarks vs captions
- **Landmarks** (`.sec`, `.hero-kicker`, `.nut-kicker`, `.st-sec`) keep the
  uppercase letterspaced `--fs-label`/`--fw-label`/`--ls-label` treatment.
- **Captions inside a card** use `--fs-cap`/`--fw-cap` in sentence case, no
  letterspacing, no uppercase. There were ~26 eyebrow treatments and ~60
  rendered instances, so everything shouted and nothing read as emphasis.

### Icons
- Use the inline SVG set via `icon(name)` in `src/ui.js`: one 1.5px stroke
  weight, no fills, 24 grid, `stroke="currentColor"` so it themes for free.
- **No emoji as iconography.** Emoji render differently on every platform, so
  the look isn't ours to control, and they read as informal. Emoji are fine as
  *content* (milestone/celebration toasts). `node test.js` sweeps for this;
  exemptions are toasts/milestones, AI prompt strings, `confirm()` dialogs
  (native, cannot hold markup) and the PDF report.
- **`${...}` only interpolates inside backticks.** In a plain `'...'` or `"..."`
  string it is inert and ships to the user as literal text. This has now bitten
  twice, both times inserting an `icon()` call into a concatenated string. Use
  `'...'+icon("x",20)+'...'` there, not `${}`. A static regex cannot catch it
  (quoted HTML attributes inside a template literal look identical, ~460 false
  positives), so `node verify-render.mjs` renders every tab and fails if a
  placeholder reaches the DOM. Run it after touching render code.
- **`icon()` returns markup, so the call site must be able to render it.**
  Three traps, all of which bit during the sweep: a plain `"..."` string can't
  interpolate `${...}` (promote it to a template literal), `textContent` won't
  parse HTML (use `innerHTML`, and only with values you know are safe), and
  anything passed through `esc()` will show the SVG as literal text (drop the
  glyph or move the icon to the render site).
- Don't put icons in filled pastel tiles — they read as stickers. Colour the
  stroke instead (`.ex-icon.gym/.cardio/.physio`).

### Modals and overlays
- Background: `var(--black)` — same as the app surface, shifts with theme
- Cards inside modals: `var(--s1)` with `border: 1px solid var(--b1)`
- Never use `rgba(0,0,0,0.97)` or hardcoded hex — these don't shift with theme
- CTAs: `var(--accent)` background with `color:var(--accent-ink)`
- `position:fixed;inset:0` for full-screen — never mix with `left:50%` +
  `transform:translateX(-50%)` + `max-width` (creates a centred column)
- Top padding: `calc(env(safe-area-inset-top,0px) + 76px)` to clear nav bar

### Theming plumbing (don't break these)
- `applyTheme()` also updates `<meta name="theme-color">` — keep that in sync
  if surface colours change (`#0A0A0B` dark / `#F4F4F5` light)
- `toggleTheme()` re-renders the active tab so JS-rendered template colours
  refresh — keep the repaint sweep when adding tabs
- The manifest link is cache-busted (`manifest.json?v=2`) — bump the query
  param when changing manifest colours/icons
- Bump `sw.js` `V` ("forge-vN") on any asset/design change so clients update
  (activate deletes every other cache, so a bump also frees the old ~6 MB)

### PDF export (print report)
Uses fixed light-paper hexes (volt doesn't survive white paper): brand accents
are moss `#55700B`; keep it consistent if editing the report builder.

### z-index scale
- Drawer: 201
- Modals / overlays: 1000
- Never below 1000 for full-screen takeovers

## Week keys run Monday to Sunday (`weekKeyOf`)

Sessions are keyed `Day_YYYYWnn`. `weekKeyOf(date)` in `src/constants.js` is
the ONE week rule: the old formula applied to the WEDNESDAY of the date's
Mon-Sun week. The old formula applied to the date itself rolled over partway
through Saturday, so every weekend "this week" read next week's sessions
(Mon-Wed vanished from view), weekend workouts were filed a week late, and a
day ticked on the weekend landed on the following week. `wk`, `nextWk`,
`planWk`, `nthPrevWk`, `vwk`, `trainedOn` and the volume chart all use it;
never reintroduce the raw formula (the test seeds in `verify-runtime.mjs` use
the Monday-based one too). The one-time repair that moved misfiled sessions
(`S._wkFix1`) is DELETED: it re-ran after every sync and, by its "dated in the
future = misfiled" rule, merged a Legs session logged early on Wednesday's
screen into the previous Wednesday, overwriting a set (repaired by
`S._oct12Fix1`). **Nothing may move logged sessions automatically**, and a
one-off move must never target a day in the future.

## One-time repairs must not re-run (`f5_once`)

`S._flags` guarding one-time repairs are NOT stored server-side, so every sync
wiped them and every repair re-ran on every launch. `persistOnceFlags()` (end
of the repair section in `src/main.js`) copies every `S._x === true` into the
`f5_once` localStorage key, and boot restores them before any repair runs. A
new repair must sit ABOVE `persistOnceFlags()`. Assume a repair can still run
twice (another device, cleared storage): make it a no-op on already-fixed data.

**The streak counts WEEKS** (user's rule): a Mon-Sun week with 5 trained days
(`STREAK_WEEK_MIN`, or fewer if the program plans fewer) keeps it alive, so one
missed day no longer resets it. The week in progress only counts once it
qualifies and never breaks it. `S.milestones.longestStreak` is in weeks,
recomputed from the log by `longestWeekStreak()` (it used to hold days).

`isProgramRestDay` means "no GYM work" (like `isGymRestDay`): Sunday carries a
physio block, and "no exercises at all" made every unlogged Sunday break the
streak, so it reset each Monday.

## The weight goal: 95 kg by Feb 28 2027, in 5 kg phases (Oct 26-27 2026)

The user (Oct 26): "5 kg phases starting today, 130 kg starting weight"; then
(Oct 27) "up the ante: 2000 kcal deficit and harder training" and "95 by
February end is still required". The ONE hard goal is `GOAL_CHECKPOINTS` in
`src/phase.js`: **95 kg by Feb 28 2027**. `PHASES` ends in seven 5 kg steps
(`p5_1`..`p5_7`, built from one table), **18 days each**, Oct 26 -> Feb 28
(126 days), every one **2,139 kcal/day** (5 x 7,700 / 18, ~1.94 kg/week):

| phase | ends | kg |
|---|---|---|
| 1 | Nov 12 | 130 -> 125 |
| 2 | Nov 30 | -> 120 |
| 3 | Dec 18 | -> 115 |
| 4 | Jan 5 | -> 110 |
| 5 | Jan 23 | -> 105 |
| 6 | Feb 10 | -> 100 |
| 7 | Feb 28 | -> 95 |

Each phase starts at the previous target the day after it ends: the line is
continuous and lands on 95 exactly on Feb 28 (tested). Every phase eats
**1,500**; the Watch active target is solved daily from the real resting
burn (~1,120 active on a 2,800 resting day). A custom 120-by-Nov-22 milestone
was asked about and declined (2,750/day for four weeks). Earlier versions
(Oct 26: 21-day phases at 1,833; Oct 27: 19-day at 2,026) were replaced
before any phase closed. History stays so past days keep their real
deficits: `phase_1`, `phase_2`, `goal_v1` (Oct 16-19) and `goal` (130 -> 95
by Feb 20, cut at Oct 25, targetKg 128.31, ~2,173/day). `USER` is 95 by Feb
28 2027 and `api/cron-diet-review.js` GOALS mirrors the phases. Resting burn
for an unlogged day is `restingDefaultFor()` (last 5 logged, else 2,800).
Phase names never use "·". Don't change the phases or add a goal unasked.

**Harder training from Mon Nov 2 2026** (dated, so earlier weeks show what
they had): +1 working set on a main lift each day (Leg Press, Chest
Supported Row, Seated Pulldown, Incline Chest Press, Saturday Leg Press,
Friday Chest Supported Row, Saturday Incline Chest Press: +7 sets a week),
bike 15 -> 20 min, incline walk 35 -> 40 min, and a "last set: stop one rep
before you cannot do another" cue on the four heavy compounds. No new
movement (the one-new-pattern-a-week and recovery rules hold). `_stage()`
now accepts a LIST of dated changes in `before`/`setsBefore` (the walk has
two: 15 -> 35 on Oct 16, 35 -> 40 on Nov 2); a date takes the earliest entry
it falls before.

**Compliance is five habits** (`weekCompliance` in `src/nutrition.js`), not
deficit maths:

| part | weight | scores |
|---|---|---|
| Food on target | 30% | finished days with food logged AND at or under `eatKcal` |
| Workouts | 25% | `min(trained,5)` vs planned days possible so far; never over 100 |
| Weight vs line | 25% | 0.5 kg deadband, then -25/kg; capped at 100 when ahead |
| Weigh-ins | 10% | finished days with a weigh-in |
| Watch active | 10% | finished days at or over the target, clamped `+max(0,eaten-eatKcal)/ACTIVE_MULT` |

- Today is never charged until it ends (`isoToday`, Toronto).
- A weigh-in this week is judged against the line on its date. With none, the
  last one is CARRIED FORWARD against today's line, so skipping the scale
  decays the score instead of excusing 25% of it.
- A part with nothing to score drops out and the rest reweight; with nothing
  at all `overall` is null ("Starts after today"), never 0 or NaN.
- Weekly history is stored with `v:2`; older weeks only carry `overall`, and
  the AI review describes them that way.

The goal card shows only: weight vs the plan line, the "This week" habit rows
(progress copy: "3 of 5 done, 2 to go"), and "Review my progress" (an AI
review of progress so far and how to get back on track). Pause, verdict,
week summary, banked days and drift are behind `FEATURES.goal*` flags.

**Descending weights in a session mean the first set was too heavy** (the
user's rule: "drop means I'm not able to work hard and the first set wasn't
right"). `setFatigue()` in `src/plan.js` flags weights falling set to set as
`pattern:"descending"`, and the weekly-plan prompt makes that OVERRIDE the PR
step-up: next week is straight sets at a weight the user can hold, never a
progression from the top set.

## Known issue: two different "today" (not yet fixed)

The app disagrees with itself about which calendar day it is:

- `isoDate()` / `isoToday()` in `src/phase.js` hardcode **America/Toronto**.
  These drive nutrition day keys, weights, phase math and the workout streak.
- Session keys (`sk()`, `wk()`, the default `cDay`, `isPastDay()`) in
  `src/main.js` use the **device-local** date via `new Date().getDay()`.

In Toronto the two always agree, which is why this has never bitten. Anywhere
else they diverge for part of every day, and the consequences are silent:
a session is written under one day-name while `trainedOn()` looks up another,
so the day reads as untrained and **the streak breaks**. Verified in-browser:

| device timezone | session key | streak |
|---|---|---|
| America/Toronto | Thursday | 1 day streak |
| Asia/Kolkata    | Friday   | none |
| UTC             | Friday   | none |

**Travelling is enough to trigger it** — the device timezone changes, the
hardcoded one does not, and previously-logged days can shift under the app.

Fixing it means choosing one calendar and migrating existing keys, which is why
it is parked rather than patched. Whichever way it goes, `trainedOn()`,
`sk()`/`wk()` and `isoDate()` must all read from the SAME source. Do not "fix"
one of them in isolation: matching two of the three is what produces the silent
breakage.

## The active program (Southpaw)

`PROG_V4` in `src/constants.js`, live from Mon 3 Aug 2026, with a one-week
interruption: `PROG_V5` runs Fri 11 Sep - Sun 20 Sep 2026 as a return block
after a training gap (full body, 2 sets, ~60-65% loads, Wed + Sun active
recovery), then Southpaw resumes automatically on Mon 21 Sep. Both boundaries
are set in **both** `programFor` and `programKeyFor` (`src/constants.js`) —
they are two independently-maintained cascades and drifting apart is the
failure mode. `PROG_V5` copies every exercise NAME verbatim from `PROG_V4`:
`S.prs` is keyed by a slug of the name, so a renamed exercise in a return
block would silently lose its PR history and the AI-suggested weight hints
built from it.

A second interruption: `PROG_V6` runs Mon 28 Sep - Sun 4 Oct 2026 as a deload
week (two body parts a day, three exercises each, 2 sets at ~90% loads, 30-35
min cardio a day, days rotated off the busy gym calendar). It uses only
exercises already in `PROG_V4` (resolved by name, unknown names throw), so no
new movement appears and PR slugs carry over. Southpaw
resumes Mon 5 Oct. Same rule: both cascades change together.

From Mon 12 Oct 2026 there is more volume (dated, so earlier weeks are
unchanged): one extra exercise on Tue (Cable Bicep Curl), Wed (Cable Glute
Kickback), Thu (Tricep Extension Machine) and Sat (Seated Lateral Raise), each
a movement already on another Southpaw day, staged with `from:"2026-10-12"`.
Mon and Fri got an extra SET instead (Chest Press 4->5, Seated Pulldown 3->4,
via `setsBefore:{until,sets}`), because any new exercise there would train a
muscle the day before or after the same muscle: **the recovery rule (no small
muscle on back-to-back days) beats adding volume**. Superset partners must be
adjacent; additions go before a superset pair, never between it.

**From Mon 12 Oct 2026 the days are reordered (`PROG_V7`, key `v7`)** so chest
is off Monday, the busiest gym day: Mon Legs & Shoulders · Tue Back & Biceps ·
Wed Chest & Triceps · Thu Legs & Core · Fri Back & Biceps · Sat Shoulders &
Chest · Sun rest. Same sessions and exercises; each muscle group's pair still
3 days apart, heavy first. Built from `PROG_V4` via `V7_FROM`. Tue/Fri/Sun
are unchanged and keep their V4 ids (`t4_`/`f4_`/`su4_`) so logged work stays
attached; moved days use `m7_`/`w7_`/`th7_`/`sa7_`. `v4IdToV7()` maps an old
id to its new day + id; `S._v7Move1` used it once to move week 2026W42's
sessions (Legs logged on the old Wednesday screen -> Monday) and plan. Weekday
cues are stripped in V7. The split line below is the ORIGINAL Southpaw order.

- **Sunday is the only rest day.** Mon-Sat all train. The rest day is derived,
  never hardcoded: `isGymRestDay()` means "no GYM work", so Sunday still counts
  as rest once its physio block returns.
- **Physio is hidden until Mon 10 Aug 2026** (`_sp()` in `programFor`). Before
  that date Sunday renders as a true rest day with zero exercises and no Start
  Workout button; after it, Sunday is a 7-item physio session.
- `_sp()`'s Sunday exemption is for **legacy** programs only (`p!==PROG_V4`),
  whose physio block sits on Sunday and would be emptied by the strip. Left
  unscoped it protects Southpaw's rest day too, which then renders as a
  training day.
- Split: Mon Chest & Triceps · Tue Back & Biceps · Wed Legs & Shoulders ·
  Thu Shoulders & Chest · Fri Back & Biceps · Sat Legs & Core · Sun rest.
  Each muscle group's two days are three days apart. **Reordering days means
  renumbering exercise-id prefixes** (`m4_`/`t4_`/`w4_`/`th4_`/`f4_`/`sa4_`/`su4_`)
  so ids match their day; `node test.js` checks for duplicates.

### Staged introduction (`from:"ISO"`)
A new movement carries `from:"2026-08-17"` and **does not exist** before that
date. `_stage()` in `programFor` filters it out, the same way `_sp()` strips
physio. One new pattern per week is a safety rule, not a preference: an
unfamiliar movement is where a flare comes from, and a delayed nerve reaction
is only attributable if exactly one thing changed. Day sizes therefore differ
by week, so read counts at full rollout, not from today's render.

### Supersets (`ss:"key"`)
Two exercises sharing an `ss` key are performed back to back and render a volt
`.ss-chip` on the card. **They must come in pairs** — an orphaned key is a
plan bug, and `node test.js` fails on one.

### Vertical pulling
A standard lat pulldown is banned by the spine rules. The only pulldown in the
plan is `Seated Pulldown (Neutral Grip)`, and the grip belongs **in the name**:
`isBannedExercise()` allows a pulldown only when the name says neutral or
close, so renaming it re-bans it.

### What the AI is told
`genWeeklyPlan()` plans **next** week, so `buildPlanSnapshot()`,
`buildApprovedExercises()` and `buildProgramMeta()` all read
`programFor(planWeekStart())`, not `PROG` (today's). Built from `PROG` the AI
saw a physio-stripped week with the rest day missing entirely, and scheduled
work on it. Rest days are sent as `rest:true` with their exercises, never
omitted. `api/weekly-plan.js` builds its schedule sentence from
`profile.program` rather than naming days in the prompt.

**Which week, and automatically.** `planMon()`/`planWk()` (`src/main.js`) are
the one source for the week a plan is for: on Monday the week just starting,
otherwise the coming Monday. Everything uses them: the storage key, the
`_prog` stamp, the AI snapshot (`planWeekStart()`), and every label. The modal
and `applyPendingPlan()` validate ids against `programFor(planMon())`, never
`PROG`: on a program boundary (ramp week -> Southpaw) today's ids match none
of the plan's and every update was silently dropped. `maybeAutoPlan()` runs
after the first server pull on Sunday (Monday as fallback): if the target week
has no plan it generates and applies one with no modal, keeping the coaching
notes in `S._lastPlanNotes`, at most one attempt per week per day. It is
client-side, so it needs the app opened; a server cron would have to rebuild
the whole client-side payload. `_prog` is a string: never iterate it as a
day's update list (it once synced back as `["v","4"]` and voided every plan).

## The exercise library (`EX_DB`)

The list the custom-exercise search reads from. ~235 entries across Gym, Cardio
and Physio, including the **Precor** and **Hoist** machine lines by product
name so a machine can be found by the label on it.

- **Every entry must pass `isBannedExercise()`.** Two once shipped that the
  app's own spine filter refused to add ("Underhand Lat Pulldown",
  "Seated Bent-Over Lateral Raise"), so the search offered exercises that
  could not be added. `node test.js` now fails on any such entry, on duplicate
  names, and if the library drops below 200.
- A pulldown needs `neutral` or `close` **in the name** or it is banned.
- **The gym has inner and outer thigh machines, not hip abduction/adduction.**
  Canonical PR slugs are `outer_thigh_machine` / `inner_thigh_machine`; the
  clinical names alias onto them via `PR_ALIAS`, and `_prCanonMigrated3`
  re-merges history written under the old slug. Flipping a `PR_ALIAS`
  canonical without a migration orphans that exercise's PR history.

## A sync replaces state wholesale

`loadServerState()` does `ctx.setS(d.state)` — the whole object, not a merge.
Anything that lives only in `localStorage` is undone by the next pull. So every
user action that changes structure needs three things, not one:

1. the local mutation,
2. a `queueMutation(...)` so it reaches Postgres,
3. a column/table in `assembleState()` so it comes back.

`S.dropped` and custom-exercise deletion both shipped with only step 1 and were
silently reverted on the next sync. `dropped_exercises` is now a table, and
`custom_exercise_delete` / `dropped_exercise` / `dropped_exercise_restore` are
mutations. The two full-wipe paths in `api/mutate.js` clear and repopulate it
alongside `custom_exercises`.

## Swapping an exercise out (`S.dropped`)

Adding a custom exercise offers to drop one from that day. The drop is stored
in `S.dropped[day]` and re-applied by `applyDroppedExercises()` on load, next
to `hydrateCustomExercises()`. It is a separate list on purpose: the program
itself stays as planned, so a drop never silently rewrites `PROG_V4`.

All three add paths (`addFromDB`, `addFreeform`, `addFromAlt`) funnel through
`afterCustomAdd()`. Wire new add paths there too, or the offer silently does
not appear for them. Tested.

**Custom exercises belong to the week they were added in.** `S.custom` is keyed
by weekday only, and `hydrateCustomExercises()` used to attach every custom ever
added to that weekday on every launch, so a one-off addition reappeared every
week forever (two stale Leg Extensions on every Monday). `customInWeek()` now
shows one only if its `c_<timestamp>` id falls in the current week or it has
sets logged this week; `curProg()` adds back the customs logged in a past week
when you browse to it, without mutating the shared program object.

**Swap drops are week-scoped the same way.** `S.dropped[day]` still lists ids,
but each drop is stamped in `S.droppedWk[id]` (`dropped_exercises.week_key`)
and `applyDroppedExercises()` only applies drops from the current week. Legacy
rows have no week and have expired. **Any new per-weekday user edit must carry
a week the same way**; `verify-runtime.mjs` seeds a stale and a current-week
custom + drop and fails if a stale one applies.

A custom exercise also has a **direct** remove button on its card
(`removeCustomEx`). Without it the only route was the swap sheet, which needs
you to add something first, so anything added by mistake was stranded on that
day permanently.

## Exercise names must never render as slugs

`S.prs` is keyed by **name-slug** (`outer_thigh_machine`), not by exercise id.
Four surfaces resolve those keys back to names, and all four must agree:

| surface | resolver |
|---|---|
| PR list (drawer) | `exName()` in `src/nutrition.js` → `ctx.prName` |
| PDF report + backup | `exName()` in `src/settings.js` (x2) → `ctx.prName` |
| weekly email | `nameOf()` in `api/_weeklyReport.js` |

- **`prSlug()` in `src/constants.js` is the one slug rule.** It strips leading
  and trailing separators: 30 exercise names end in `)`, which without the trim
  slugged to `cable_crossover_high_to_low_`.
- **Every resolver must apply `PR_ALIAS` before lookup.** A non-canonical slug
  that skips it renders a phantom row under the retired name that can never
  hold a PR, because writes go to the canonical key.
- **`KEY_IDS` in `src/nutrition.js` seeds "not yet PR'd" rows.** Canonical
  slugs only.
- The **de-slug fallback** in `prName()` (and its mirror in the email) is the
  backstop: it guarantees a readable label for ANY key, including exercises
  that have left the program entirely.
- The weekly email (`api/_weeklyReport.js`) builds its names from the programs
  in `src/constants.js`. The old email carried a hand-written 166-entry map
  keyed by day-prefixed ids, none from V4 and none name-slugs, so every PR
  lookup missed and it emailed raw slugs. Do not reintroduce a literal map.
  (The CSV attachment that map fed was dropped in Oct 2026: "useless".)

## Session flow and targets

- **A running workout is persisted** (`f5_active`: session key + start time),
  written by `startSess`/`resumeSess`, cleared by `stopSess`/`closeSummary`,
  restored in `initApp()` when it is today's session and under 6 hours old.
  It used to live only in memory, and iOS unloading the backgrounded PWA made
  the workout look like it "closed on its own".
- **The finish sheet and summary are Workout pop-ups.** They sit outside
  `#mainScroll`, so they get the Workout look by id in the scoped token
  selector (`#stopModal,#swapModal,#sum,#milestoneModal,#planModal`); left out,
  they shipped in the old volt style. The summary shows the session's total
  `_duration` via `fmtWorkoutDur()` ("48 min"), never the stretch since the
  last resume (which read "0m 01s").
- **No rest timer.** Removed at the user's request; `ex.rest` stays on the
  program data but nothing reads it for a timer.
- **The target is last session's best set.** The user aims for a PR every
  session, so the card shows "Beat W × R" (best set by estimated 1RM from
  `lastSessionEx().top`, in the box's unit) and pre-fills every set with that
  weight; the program `hint` is only the fallback for an exercise with no
  history. `lastSessionEx` matches by canonical exercise, not day id, so it
  follows an exercise across program versions.
- **The weekly plan sees set-to-set fatigue.** `buildSessionHistory` adds
  `fatigue` (reps at the most-used weight, first vs last, `repDropPct`) and
  the prompt says: big drop = hold load, add reps; little drop = step up.
- **The Shake to Undo prompt is iOS, not FORGE.** The app has no shake
  handler; a web app cannot disable it (iPhone Settings → Accessibility →
  Touch → Shake to Undo).

## Vercel Hobby: 12 serverless functions, maximum

Every `api/*.js` whose name does not start with `_` is deployed as its own
function, and the Hobby plan refuses a deployment with more than 12. Adding
the Sunday plan cron made 13 and the deploy failed (preview AND production,
which kept serving the previous version). Shared helpers are `_`-prefixed
(`_shared.js`, `_db.js`) so they do not count. `node test.js` fails above 12.
**api/ is AT the limit (12/12).** Any new server feature must be folded into
an existing endpoint (e.g. a new `entity` in `api/mutate.js`, a new branch in
an existing cron) rather than a new file, unless the user moves to Vercel Pro.
Check `ls api | grep -vc '^_'` before adding anything under `api/`.

## The weekly email is an AI coach verdict (`api/_weeklyReport.js`)

`api/cron-weekly-email.js` runs **Monday 12:00 UTC** (8 AM Toronto). It is an
**AI coach's verdict**, not a stats report (the user: "summary" meant how the
week went, not the details). `buildWeeklyReport` computes the week's numbers;
`coachPrompt(data)` hands them to `callOpenAI` with session notes, calf
twinges, PRs and the most-eaten foods; `parseCoach` turns the JSON reply into
`{headline, diet, training, nextWeek[≤3]}` (code fences tolerated, dashes
normalised). The email is: the coach's headline, ideal (plan line) vs actual
weight + progress bar (the user asked for it), Diet and Training paragraphs,
and up to three next-week items. **If the model call fails or returns junk,
the rule-based verdict and focus list go out instead**: a Monday email that
never arrives is worse than a plainer one. Plain subject (no weight or stats),
no attachment (the CSV was dropped as useless). Don't grow it back into tables.
**Never rely on a background colour in the email.** The Gmail app dropped every
background: the dark header went white-on-white in light mode, its white text
turned grey under dark-mode inversion, and the progress bar vanished. Text is
dark on the white card, the brand stripe and the bar are BORDERS. Tested. It
covers COMPLETE days only (the week containing yesterday), so a half-logged
day never skews the averages. Every number comes from `src/phase.js`, the same
engine as the app; the builder is pure and `_`-prefixed (not a function, see
the 12-function limit) and is tested with a seeded week in `test.js`.

## Vercel serves ONLY `dist/` (vercel.json `outputDirectory`)

Anything the page loads must be copied into `dist/` by `build.mjs`, or it 404s
in production while working locally (`server.js` serves the repo root). This
bit three times at once: the bundled demos, the manifest/icons and `sw.js` had
never shipped, so production had no demos from `demos/`, no install icons and
**no offline mode at all**. `build.mjs` now copies `demos/` (minus index.json),
the manifest, icons, and `sw.js` with its demo list filled in. Tested.

## Form demos are ALL bundled (`demos/`, `scripts/build-demos.mjs`)

Every demo is a start/end photo pair (WebP, ~480px) from the public-domain
free-exercise-db, stored in `demos/` and listed in `demos/map.json`. **Nothing
is fetched from another site**: the MuscleWiki probing, the remote GitHub
fuzzy match and the Settings "scan demos" row are gone. A free-typed custom
exercise gets the closest bundled pair (`localFuzzyDemo`), else a plain
"No demo for this one. Works …" line. Coverage: 37/37 program exercises
(Bird Dog and Nerve Floss have no free source) and 195/235 of the library.
Run `node scripts/build-demos.mjs` when exercises change; it matches with
equipment/angle/posture penalties plus a hand-checked `ALIASES` table, writes
`scripts/demo-report.txt` (review LOW CONFIDENCE before committing) and keeps
`demos/` under the 12 MB budget `test.js` enforces. Gym Visual / ExerciseDB GIFs
were rejected: their media needs a paid licence ("cloning this repo is not a
license"). Synced `S.demoCache` held remote URLs from the old probing; the
`demoCacheV` 4 reset in `src/main.js` clears it locally and on the server.

## Offline mode (`sw.js`)

`dist/sw.js` precaches the app shell (CRITICAL) and every demo image (DEMOS,
filled in by build.mjs). Install **fails** if a critical file is missing or
over 5% of demos fail, so a half-filled cache never passes for offline-ready
(the browser retries on next launch). Demo images are cache-first (immutable
within a version); the app, map.json and manifest are network-first with the
cache as fallback, navigations matching with `ignoreSearch`. `/api/` and other
origins are never touched. Bump `V` on any asset change: activate deletes every
cache that isn't `V`. iPhone Safari (not the Home Screen app) can evict storage
after 7 days, so Workout shows a dismissible "Add Forge to your Home Screen"
line there only. `verify-runtime.mjs` serves `dist/` as root, waits for the
worker, goes offline, reloads, and requires a demo to load from cache with no
foreign request.

## The weekly plan is built in ONE place (`src/plan.js`)

`src/plan.js` holds everything the plan needs: `planMonFor`, the payload
builders (`buildPlanPayload` and friends), `isBannedExercise`/`sanitizePlan`
and `planToUpdates`. It is pure (no ctx/DOM/localStorage), so the app AND the
server import it: `genWeeklyPlan()` in the app, and `api/cron-weekly-plan.js`,
which runs every **Sunday 23:00 UTC** (7 PM Toronto), generates the coming
week's plan if none exists and writes the same `week_plan_updates` rows the
app does, so the week is planned even if the app is never opened.
`api/weekly-plan.js` exports `generateWeeklyPlan()` so both share one prompt.

- Every `src` file is inlined into ONE script by `build.mjs` (an explicit
  list: add new files there), so top-level names must be unique across files.
  `plan.js` keeps its private helpers prefixed (`planToKg`, `PLAN_LB_TO_KG`).
- Dates for the AI come from `planYmd()`, not `isoDate()`: `isoDate` converts
  to Toronto, which on the UTC server turns Monday 00:00 into Sunday.
- **Session notes are instructions.** `buildSessionHistory` sends
  `sessionNotes` (note + calf-twinge count) for every week and every day that
  has one, and the prompt ranks them above the numbers.

## Switched-off features (`FEATURES` in `src/constants.js`)

The user simplified the app (Oct 2026). Hidden, not deleted: data and code
stay, and setting a flag back to `true` restores the feature. Off: the quote
card (and its rotation timer), the "This week's
compliance" grid, Settings' Volume This Week + Progress group, and the
Personal Records section of the Insights drawer (the rest of that drawer:
7-day trends, Machine Busy, How Hard stays). `verify-runtime.mjs` checks the
rendered UI matches every flag. Don't re-add hidden features unasked.

**Medication (Zepbound) tracking is REMOVED, not switched off** (Oct 2026, the
user's request: "no Zepbound tracking, remove all mentions"). Gone from the UI,
the compliance score (since replaced by the five-habit score), sync
(`api/state.js` no longer returns `meds`), the mutations, the schema, the AI
chat context and every AI prompt. The `med_doses` table and its rows are left
in the database untouched; nothing reads or writes them. `node test.js` fails
if zepbound / tirzepatide / med_dose / S.meds reappears anywhere.

## Calf twinge makes the session note mandatory

`stopSess()` refuses to stop while `_calfTwinges` is non-empty and `_notes` is
blank. The count alone records THAT something happened, not what you were doing
or how it felt, and reconstructed days later it is unattributable, which is the
only reason the button exists.

- The requirement is visible **before** you try to stop: a `required` chip on
  the label, an amber textarea border, and a hint line. Amber is the warnings
  colour and this is a needs-input state, so it qualifies.
- `refreshNotesRequirement()` updates it **in place**. A `renderW()` would
  rebuild the textarea and drop focus mid-sentence, which is exactly when
  `saveNotes` fires. It is called from `logCalfTwinge`, `undoCalfTwinge` and
  `saveNotes` — three call sites, asserted by the suite.

## Weight precision (`kg1`)

The HealthKit shortcut sends float noise (`136.00000001`). A bathroom scale has
no business reporting eight decimals, and the raw value leaks into the PDF, the
CSV and the AI prompts verbatim.

`kg1()` in `src/constants.js` is the single rounder, imported by the client and
the api. It returns **null for null/undefined/""** on purpose: `Number(null)` is
`0` and finite, so a naive version turns a missing weigh-in into 0 kg and drags
every average.

Rounding is applied at **three** layers, and all three are needed:

1. **Ingest** — `api/healthkit.js` and the manual form in `src/nutrition.js`.
2. **Storage** — `api/mutate.js` on write, `api/state.js` on read (so rows
   already stored wrong are healed without a migration everyone must run).
3. **Render/export** — both sparklines, the PDF report, the CSV export, the AI
   prompts, and `latestWeightLog()`.

**Round at the source of a chart, not at its labels.** Both sparklines derive
labels, deltas, per-month rate and the y-scale from one `vals` array. Rounding
only the label leaves the noise in the arithmetic. The recent-weights footer in
`buildSparkline` reads `wts` directly rather than `vals` and was missed by
exactly that reasoning the first time.

`S._wtRound1` cleans values already in `localStorage`, once.

## The outbox freezes on one bad mutation

`flushOutbox()` walks the queue in order and `break`s on any non-OK response.
`pr_delete` shipped on the client with **no `case` in `api/mutate.js`**, so the
server answered `400 Unknown entity` and the queue froze at entry #1 for days:
73 mutations stranded, the database left stale, and `loadServerState()`
early-returning on the non-empty outbox so **snapshots stopped being taken
too**. Every later failure traced back to that one missing switch case.

- `node test.js` now fails if **any** `queueMutation(...)` entity has no server
  handler. Adding a mutation means adding both halves.
- A **4xx is permanent** — the payload will be rejected forever, so it is
  dropped and the queue continues, with a toast. A 5xx or network error is
  transient and still stops for retry.
- Snapshots are taken **before** the outbox-backlog early return, so the safety
  net keeps working exactly when it is most needed. `pushSnapshot` dedupes on
  unchanged `dataWeight` and a 30-minute floor, or five launches would evict
  every genuinely different snapshot.

## Restores replace the DATABASE, not just the device

`restoreSnapshot()` and `restoreDailyBackup()` both queue `restore_all`, which
wipes every table and repopulates from the restored state. The confirm used to
say only "This REPLACES all current data on this device", which is wrong and
cost a day of training data.

- Both dialogs now show current vs restored entry counts, the approximate loss,
  and that it reaches every device.
- The state being replaced is `pushSnapshot`ed first, so a restore is itself
  undoable.
- **Restoring preserves today's `f5_daily_` backup.** The restored state carries
  an old `_lastAutoBackupDay`, so the next `save()` rewrote today's backup with
  the restored data and destroyed the only copy of that day's work.

## PRs are stored in KG, always

The set inputs take lbs per exercise (`ed.unit`), and every PR path used to take
the typed number at face value. 120 lbs logged as a 120 kg PR, rendered
"160kg est. 1RM". `toKg(weight, unit)` in `src/workout.js` is the one
conversion, and it must be applied at all three places a set becomes a PR:

1. `checkAndStorePR` — the write, on ticking a set.
2. `bestFromSessions` — the recompute, which reads `ed.unit` per session.
3. `dropPRForSet` — the delete, since the stored PR is kg and the set may be lbs.

`S._prLbFix1` heals PRs already written wrong: it finds the logged set each PR
came from and converts only when that set was in lbs, so a genuine kg entry is
left alone.

**Mix-ups in the LOG itself.** Every repair above trusts the logged set, so a
number typed in lbs while the exercise said kg (Leg Extension "120 kg x 15")
survived all of them and blocked every real PR beneath it. Three layers now:
`checkUnitOnLog()` asks on tick when a weight is >=1.8x the exercise's usual
(or <=0.55x in lbs mode); `findUnitSuspects()` + the review sheet
(`openUnitReview`, Settings, and once a day after launch) offer Convert / Keep
per past set and `rebuildPRsFor()` the exercise; and the unit is printed in
every weight box, with new entries defaulting to the unit last used on that
exercise (`defaultUnit`, persisted by `ensure()`). "Usual" is the LOWER
QUARTILE of logged sets so a run of mis-typed sets cannot redefine it. A
confirmed set carries `unitOk` and is never asked about again. Entries with
weights but no `unit` predate the field and must keep reading as kg.

**`delSet` must splice the set BEFORE dropping its PR.** `dropPRForSet` calls
`recoverPRFromLog`, which recomputes the best remaining lift from the logged
sessions — with the set still present it recovered the very PR it had just
deleted, and the badge never changed.

## Testing Before Merging
- **`verify-layout.mjs` measures every screen** (run by `node test.js`):
  Workout (day, past, exercise open, running), Food (top, cards open, meal
  entry, AI estimate, search, past day), Settings (all open), the drawer,
  chat, and every sheet/pop-up, as four iPhones (mini 375x812, 15 390x844,
  17 Pro 402x874, 17 Pro Max 440x956; 3x, touch, Safari user agent) in both
  themes, on the shared fixture (`test-fixture.mjs`) plus an empty state.
  It is Chromium emulating the phones (WebKit is not installed here), so SF
  fonts and safe-area insets are approximations; the Safari user agent is
  what makes Safari-only UI (the Home Screen hint) render at all. It fails on text off
  screen, clipped, overlapping, outside its card or ring, under 4.5:1 (3:1
  large), under 11px (tab bar exempt), controls under 44x44, and old-look
  leftovers. It found what screenshots missed ("1,500" touching its ring,
  Apple's stock blue/grey/green failing contrast, 23 small tap targets).
  **Add any new screen or sheet to its `SCREENS` list.** Exceptions go in
  `ALLOW` with a reason. `E2E_STATE=backup.json` runs it on real data
  (local only); `LAYOUT_OUT=dir` crops every finding.
- `node test.js` runs BOTH the static suite and the runtime checks. The runtime
  half boots its own server, renders every tab in both themes with data seeded,
  and fails on: template placeholders reaching the DOM, a hero losing its
  gradient or dropping below 4.5:1, and any JS error. It skips loudly (not
  silently) when Playwright is unavailable.
- `verify-runtime.mjs` is a committed file, not a local scratch script —
  `playwright` is a real devDependency (`npm install` pulls it) so every clone
  gets the same runtime coverage. It was gitignored for a while as a "scratch
  verification script"; that dropped it from fresh clones silently, so the
  runtime half quietly stopped running anywhere except whichever machine
  still had a local copy. Do not re-add it to `.gitignore`.
- When editing `verify-runtime.mjs` itself, don't hardcode an exercise id from
  one program version into the seed data — the active program changes on a
  schedule (see "SCHEDULE" in `src/constants.js`), and a version-specific id
  silently stops matching anything once that program retires. Derive the
  seeded exercise from `programFor(new Date())` at run time instead, the way
  the weekly-plan payload check does.
- Static tests read source and CSS, so they structurally cannot see a cascade
  conflict or an un-interpolated `${...}`. Both classes have shipped from this
  repo. If a change touches render code or the cascade, the runtime half is the
  part that matters.
- **Seed the states that only exist with data.** The "Plan queued for …" string
  shipped broken because it does not render until a plan exists, and every
  screenshot until then had no plan. `verify-runtime.mjs` seeds plans, PRs,
  nutrition, weights, doses and milestones for exactly this reason.
- **Dark mode hides an entire class of bug.** The white-on-white hero passes in
  dark and fails at 1:1 in light. Always check light.
- Run `/verify` after every non-trivial change before pushing to main
- Any `position:fixed` full-screen element: confirm `inset:0` only, no centering transforms
- Any new colour: confirm it uses a CSS variable, not a hex literal
- Check BOTH themes (Settings → Appearance cycles light/dark/auto) — especially
  text inside hero cards in light mode
- `let`/`const`: declaration must appear before first use — never assign to a variable before its `let`/`const` line (TDZ crash)

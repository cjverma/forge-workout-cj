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

## UI / CSS Conventions — "Premium Athletic / Volt" design system

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

### PDF export (print report)
Uses fixed light-paper hexes (volt doesn't survive white paper): brand accents
are moss `#55700B`; keep it consistent if editing the report builder.

### z-index scale
- Drawer: 201
- Modals / overlays: 1000
- Never below 1000 for full-screen takeovers

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

`PROG_V4` in `src/constants.js`, live from Mon 3 Aug 2026.

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

## Swapping an exercise out (`S.dropped`)

Adding a custom exercise offers to drop one from that day. The drop is stored
in `S.dropped[day]` and re-applied by `applyDroppedExercises()` on load, next
to `hydrateCustomExercises()`. It is a separate list on purpose: the program
itself stays as planned, so a drop never silently rewrites `PROG_V4`.

All three add paths (`addFromDB`, `addFreeform`, `addFromAlt`) funnel through
`afterCustomAdd()`. Wire new add paths there too, or the offer silently does
not appear for them. Tested.

## Exercise names must never render as slugs

`S.prs` is keyed by **name-slug** (`outer_thigh_machine`), not by exercise id.
Four surfaces resolve those keys back to names, and all four must agree:

| surface | resolver |
|---|---|
| PR list (drawer) | `exName()` in `src/nutrition.js` → `ctx.prName` |
| PDF report + backup | `exName()` in `src/settings.js` (x2) → `ctx.prName` |
| weekly email CSV | `exName()` in `api/cron-weekly-email.js` |

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
- `api/cron-weekly-email.js` imports from `src/constants.js`. It used to carry
  a hand-written 166-entry map keyed by day-prefixed ids, none from V4 and none
  name-slugs, so every PR lookup missed and the CSV emailed raw slugs. Do not
  reintroduce a literal map.

## Testing Before Merging
- `node test.js` runs BOTH the static suite and the runtime checks. The runtime
  half boots its own server, renders every tab in both themes with data seeded,
  and fails on: template placeholders reaching the DOM, a hero losing its
  gradient or dropping below 4.5:1, and any JS error. It skips loudly (not
  silently) when Playwright is unavailable.
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

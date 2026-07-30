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
  *content* (milestone/celebration toasts).
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

## Testing Before Merging
- Run `/verify` after every non-trivial change before pushing to main
- Any `position:fixed` full-screen element: confirm `inset:0` only, no centering transforms
- Any new colour: confirm it uses a CSS variable, not a hex literal
- Check BOTH themes (Settings → Appearance cycles light/dark/auto) — especially
  text inside hero cards in light mode
- `let`/`const`: declaration must appear before first use — never assign to a variable before its `let`/`const` line (TDZ crash)

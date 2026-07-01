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
- Body/buttons/inputs/nav stay Inter.

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

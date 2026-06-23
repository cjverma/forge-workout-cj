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

## UI / CSS Conventions

### Always use CSS variables — never hardcode colours
The app has a full CSS variable palette that adapts to light/dark OS theme automatically. Always use these; never use hex values in new CSS rules.

Key variables:
```
--black      → primary surface (app background, modal backgrounds)
--s1         → card background (slightly lighter than --black)
--s2         → secondary card / input background
--b1, --b2   → border colours
--white      → primary text
--lt         → secondary text
--mid        → muted text
--dim        → very muted / placeholder text
--amber      → accent colour (CTAs, highlights, section labels)
--green      → positive / success
--red        → destructive / warning
--orange     → DO NOT USE for UI — resolves to dark grey in light mode
```

### Modals and overlays
- Background: `var(--black)` — same as the app surface, shifts with OS theme
- Cards inside modals: `var(--s1)` with `border: 1px solid var(--b1)`
- Never use `rgba(0,0,0,0.97)` or hardcoded hex — these don't shift with theme
- CTAs: `var(--amber)` background with `color:#000`
- `position:fixed;inset:0` for full-screen — never mix with `left:50%` + `transform:translateX(-50%)` + `max-width` (that creates a centred column, not full-screen)
- Top padding: `calc(env(safe-area-inset-top,0px) + 76px)` to clear nav bar on all devices

### --orange is NOT orange in light mode
`--orange` resolves to `#33302A` (dark brown) in light mode. Use `--amber` for any visible accent colour.

### z-index scale
- Drawer: 201
- Modals / overlays: 1000
- Never below 1000 for full-screen takeovers

## Testing Before Merging
- Run `/verify` after every non-trivial change before pushing to main
- Any `position:fixed` full-screen element: confirm `inset:0` only, no centering transforms
- Any new colour: confirm it uses a CSS variable, not a hex literal

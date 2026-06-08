# FORGE Workout App — Full Context

Personal workout tracker for one user with a lumbar disc herniation. Single-file frontend (`index.html`) + Express backend (`server.js`). No database — all session data lives in `localStorage` under the key `f5`.

---

## Architecture

```
index.html          All UI, CSS, exercise DB, program definitions, and JS logic (1446 lines)
server.js           Express API server — two AI endpoints + health check (port 8787)
api/coach.js        Unused (logic duplicated inline in server.js)
api/weekly-plan.js  Unused (logic duplicated inline in server.js)
api/_shared.js      Shared auth + OpenAI helpers (used by api/* but not server.js)
```

The frontend is served **statically** — `server.js` does NOT serve `index.html`. The live app requires a static file host (nginx, Vercel, Netlify, etc.) alongside the backend. In production the `config.local.js` script tag provides `window.FORGE_API_CFG = { baseUrl, token }` to point the frontend at the backend.

---

## Spine Safety Rules (HARD — never override)

User has **lumbar disc herniation with nerve impingement** causing left-leg sciatica and chronic left calf nerve pain.

- **No overhead movements** — no overhead press, no standard lat pulldown
- **No axial compression** — no barbell squat, deadlift, good mornings, hip-hinge under load
- **No standing loaded exercises** — all resistance work must be seated or lying
- **No stairmaster / step-climbing under load**
- **Always start with stationary bike** (min 15 min) — hip flexion decompresses spine
- **Always end with easy treadmill walk** at low incline — no running
- **Core gently braced** throughout all exercises
- **Left calf pain = nerve symptom**: if triggered 3+ times in a session → stop/modify immediately. Never push through it.

These rules are embedded in every AI system prompt via `HARD_RULES` in both `server.js` and `api/_shared.js`.

---

## Program Structure

Two programs defined in `index.html`:

### PROG_V1 — active until May 31, 2026
6-day Push/Pull hybrid split (Mon-Sat), Sunday rest:
- Mon/Thu: Push + Pull (Chest · Triceps · Shoulders · Back · Biceps)
- Tue/Fri: Push + Lower (Chest · Triceps · Legs · Glutes · Calves)
- Wed/Sat: Pull + Lower (Back · Biceps · Legs · Glutes · Calves)

### PROG_V2 — active from June 1, 2026 onwards (CURRENT)
6-day clean split × 2 per week, Sunday rest:
- **Mon/Thu**: Chest & Shoulders (Upper Push)
- **Tue/Fri**: Back & Arms (Pull Day)
- **Wed/Sat**: Legs & Core (Lower Day)

Active program is selected at runtime:
```js
const PROG = new Date() >= new Date(2026,5,1) ? PROG_V2 : PROG_V1;
```

### PROG_V2 — Full Muscle Coverage (as of June 8, 2026)

| Muscle group | Days hit |
|---|---|
| chest / upper chest | Mon + Thu ×2 |
| front delt | Mon + Thu ×2 |
| lateral delt | Mon + Thu ×2 |
| rear delt | Mon + Tue + Thu + Fri ×4 |
| triceps | Mon + Tue + Thu + Fri ×4 |
| mid back / rhomboids | Mon + Tue + Thu + Fri ×4 |
| traps / rotator cuff | Mon + Thu ×2 |
| lats / back | Tue + Fri ×2 |
| biceps | Tue + Fri ×2 |
| brachialis / forearms | Tue + Fri ×2 (Hammer Curl) |
| quads | Wed + Sat ×2 |
| glutes | Wed + Sat ×2 |
| hamstrings | Wed + Sat ×2 |
| hip abductors | Wed + Sat ×2 (Hip Abduction Machine) |
| calves | Wed + Sat ×2 (Seated Calf Raise) |
| obliques / core | Wed + Sat ×2 |

---

## Exercise Data Structures

### Exercise DB (`EX_DB`, ~36 exercises)
```js
{
  name: string,
  cat: "Gym" | "Cardio" | "Physio",
  hint: string,       // weight suggestion e.g. "30-40 kg"
  sets: number,
  reps: number | string,
  url: string,        // YouTube link
  cue: string,        // form coaching cue
  muscles: string[],
  tags: string[]
}
```

### Program Exercise (in PROG_V1/V2)
```js
{
  id: string,         // unique e.g. "m2_cp", "t2_hc"
  name: string,
  cat: "gym" | "cardio" | "physio",   // lowercase in programs
  sets: number,
  reps: number | string,
  hint: string,
  url: string,
  cue: string,
  muscles: string[]
}
```

---

## localStorage Schema (`f5`)

```js
{
  sessions: {
    "Monday_2026W24": {
      "m2_cp": {
        done: boolean,
        skipped: boolean,
        sets: [{ weight: string, reps: string, done: boolean, attempted: boolean }]
      },
      _duration: number,   // seconds, accumulated across resumes
      _stopped: boolean    // true if session was stopped mid-session
    }
  },
  weekPlans: {
    "2026W25": {            // keyed by ISO week string
      "Monday": [
        { id: "m2_cp", sets: 3, reps: 12, hint: "37-42 kg" },   // update
        { action: "remove", id: "m2_pf" },                        // remove
        { action: "add", id: "ai_mon_xxx", name: "...", cat: "gym", sets: 3, reps: 12, hint: "...", cue: "...", muscles: [] }  // add
      ]
    }
  },
  custom: {
    "Monday": [CustomExercise[]]    // user-added exercises (persisted across weeks)
  }
}
```

Session keys are `"DayName_YYYYWnn"` (e.g. `"Monday_2026W24"`).
Week keys are `"YYYYWnn"` — calculated using a custom `wk()` function (not ISO standard; uses `Math.ceil`).

---

## Key Frontend Functions

| Function | Purpose |
|---|---|
| `initApp()` | Entry point — builds nav, selects today, starts quote cycle |
| `renderW()` | Renders workout view for `cDay` — handles current/past/future week |
| `card(ex, sess, key, rdOnly)` | Returns HTML for one exercise card |
| `expand(id)` | Toggle sets body open/closed |
| `saveF(key, exId, i, field, val)` | Save weight or reps for a set |
| `toggleSet(key, exId, i)` | Mark a set done/undone |
| `toggleCardio(key, exId)` | Toggle cardio exercise done |
| `skipEx(key, exId)` | Mark exercise as skipped |
| `addSet(key, exId)` | Add an extra set to an exercise |
| `startSess() / stopSess() / resumeSess()` | Session timer management |
| `applyPlanOverrides()` | Mutates `PROG[day].exercises` in place from `S.weekPlans[wk()]` |
| `hydrateCustomExercises()` | Appends custom exercises from `S.custom` into `PROG` |
| `genWeeklyPlan()` | Calls `/api/weekly-plan`, shows modal with changes |
| `applyPendingPlan()` | Writes AI plan to `S.weekPlans[nextWk()]` |
| `searchEx(q, day)` | Fuzzy search `EX_DB` for the add-exercise dropdown |
| `wk()` | Returns current ISO-ish week string e.g. `"2026W24"` |
| `nextWk()` | Returns next week string |
| `sk(day)` | Returns session key for `day` in viewed week |

---

## API Endpoints (`server.js`, port 8787)

All endpoints require `Authorization: Bearer <FORGE_API_TOKEN>`.

### `POST /api/coach`
General coaching queries. Accepts `{ prompt, context: { day, program } }`.
Returns `{ text }`. Prompt max 2000 chars. Uses OpenAI with HARD_RULES in system prompt.

### `POST /api/weekly-plan`
Generates next week's program. Accepts `{ weekSummary, profile, rules }`.
Returns `{ text }` — raw JSON string matching:
```json
{
  "week_plan": { "Monday": [...exercises/actions] },
  "coaching_notes": "...",
  "flags": ["..."]
}
```
AI may add, remove, or update exercises. Never touches physio or cardio. Max 4 gym exercises per body-part group per day.

### `GET /api/health`
Returns `{ ok: true }`. No auth required.

---

## AI Coach UI (4 cards)

| Card | Input | Prompt type |
|---|---|---|
| Log in Plain English | Free text | Parses workout note into structured format |
| What Weight Today? | Free text | Progressive overload target from last session |
| Machine Busy? | Free text | 3 safe alternatives from available gym equipment |
| How Hard Should I Train? | CPAP score, Energy, Soreness, Calf pain | Recovery intensity recommendation |

---

## UI Layout

```
Header: FORGE logo + "PERSONAL" pill
Quote bar: cycling motivational quotes (9s interval)
Day nav: MON-SUN with date below each (scrollable)
  ↑ wk-nav: ← Prev | This Week / Next Week | Next → (capped at next week)
Main scroll: exercise cards or AI/Settings tabs
Bottom nav: Workout | AI Coach | Settings
```

Exercise card states: default → active (orange border) → done (green) → skipped (faded).
Set row states: default → `needs-input` (amber border) → `done` (green).

---

## Gym Equipment Available

`Stationary bike, treadmill, seated cable machine, chest press machine, pec fly machine, tricep extension machine, leg press (feet high 90 deg max), seated leg curl, seated hip abduction, seated calf raise, dumbbells 5-30kg`

(Used in AI "Machine Busy?" prompts and weekly plan context.)

---

## Environment Variables

| Var | Purpose |
|---|---|
| `FORGE_API_TOKEN` | Bearer token for all API endpoints |
| `OPENAI_API_KEY` | OpenAI key |
| `OPENAI_MODEL` | Defaults to `"gpt-5.5"` |
| `PORT` | Defaults to `8787` |

---

## Important Quirks

- **`server.js` and `api/_shared.js` both define `HARD_RULES`** — they are identical but maintained separately. If updating spine rules, update both files.
- **`wk()` is non-standard ISO** — uses `Math.ceil` which can differ from ISO 8601 week numbers. All week keys must use this function for consistency.
- **`applyPlanOverrides()` mutates `PROG` in place** at load time. Calling `renderW()` works off the already-mutated `PROG` — there is no re-apply on render.
- **Week navigation is capped at next week** — cannot preview more than one week ahead.
- **`config.local.js`** is loaded before the main script. In production this sets `window.FORGE_API_CFG`. If absent and no `forge_key` in localStorage, the lock screen shows.
- **Past weeks are read-only** — `isPast()` returns true for any viewed week before the current one. All save/toggle functions check this.
- **Custom exercises persist** in `S.custom` and are re-injected into `PROG` via `hydrateCustomExercises()` on every page load.

# Hoist weight-ratio data: research notes (Nov 12 2026)

`hoist-machines.json` lists every ROC-IT machine page on hoistfitness.com and,
for the 30 that have the "Weight Ratio Calculation", the constants to compute
the site's table at any body weight.

## How the site's calculator works

Each ROC-IT page (`/pages/rs-XXXX-...`) has an inline `getTable()` that sends
the model number and the typed weight to Hoist's own server and shows the
HTML it returns:

```
GET https://hoistweightratiocalculatorprod-qoltpirw3q-wl.a.run.app/weightratio/calculateRatio/RS-1402/125
-> { data: { actualWeightLiftedList: [ {level, weightLifted, weightLiftedAddOn}, ... ],
             actualWeightLiftedHtml: "<table>..." } }
```

There are no constants in the page itself. What the server does, worked out
from about 2,500 responses:

- **Body weight is truncated to a whole number** before use (183.99 gives the
  same table as 183). Negative values and 0 are accepted, and text returns
  nulls.
- **Every machine has 18 levels**, even though the site's table for RS-1402
  at 125 was read as 17: level 18 is 295 there.
- **For each level the result is a straight line in body weight**, rounded to a
  whole number: `actual = round(a + b * floor(bodyWeight))`, with its own `a`
  and `b` per level. `b` grows with the level (RS-1402: 0.18 at level 1 and
  0.61 at level 18), because more of the body rides with the moving seat at
  heavier settings.
- **RS-2000 models also return `weightLiftedAddOn`**: the same table with the
  optional 5 lb weight upgrade (`RS-CAGE-NG-OPT1`) fitted. These are stored as
  `coefAddOn`. RS-1000 models return 0 there.
- **Units are lb in and lb out (inferred).** The page labels no unit. The
  pointers: the old controller script on the page calls the field
  `weight_lbs`, Hoist lists every stack in lb first, and the outputs scale
  with the lb stack sizes (RS-2402, 270 lb stack, 18 levels of about 15 lb).

## The file

Per machine: `model`, `name`, `url`, `series`, `hasCalculator`, `levels`,
`bodyWeightUnit` / `outputUnit` (`"lb"`), `kind: "linear"`, `apiUrl`,
`coef` (18 `[a, b]` pairs), `coefAddOn` (RS-2000 only), `overrides` /
`overridesAddOn` where needed, plus `stackLb` / `stackKg` /
`stackWithAddOnLb` from the store's product JSON.

```js
function actual(machine, level, bodyWeight, addOn = false) {
  const bw = Math.floor(bodyWeight);
  const ov = (addOn ? machine.overridesAddOn : machine.overrides)?.[level]?.[bw];
  if (ov != null) return ov;
  const [a, b] = (addOn ? machine.coefAddOn : machine.coef)[level - 1];
  return Math.round(a + b * bw);
}
```

## How it was verified

- **Your data point**: RS-1402 at 125 returns 28, 41, 53, 70, 87, 104, 122,
  140, 154, 170, 186, 200, 216, 232, 247, 263, 279 for levels 1-17, exactly
  as you read it (plus 295 at level 18).
- **Fit**: for each of 810 level series (30 machines, 18 levels, with and
  without the add-on), the best straight line was fitted over body weights 0,
  60-400 (every 5-10 lb) and 1000; RS-2601 every 1 lb from 40 to 420. The
  formula plus overrides reproduces all 67,968 sampled values exactly.
- **Held-out check**: 5 machines at 4 body weights the fit never saw (133, 177,
  211.7 and 262 lb):

| machine | 133 | 177 | 211.7 | 262 |
|---|---|---|---|---|
| RS-1301 Chest Press | exact | exact | exact | exact |
| RS-1402 Leg Curl | exact | level 2 off by 1 | exact | exact |
| RS-1601 Abdominals | level 3 off by 1 | exact | exact | exact |
| RS-2101 Seated Dip | exact | exact | exact | exact |
| RS-2403 Leg Press | exact | exact | exact | level 14 off by 1 |

  That is 357 of 360 values exact. All three misses had a raw value within
  0.03 of a .5 tie (53.497 vs the site's 54, 36.497 vs 37, 303.53 vs 303).

## Known limitation: 1 lb at near-ties

The server's exact arithmetic is hidden, so `a` and `b` are only pinned to a
narrow range. When the true value sits almost exactly on .5, the formula can
round the other way. It is **never off by more than 1 lb**, and that happens
on roughly 1 value in 100 at body weights that were not sampled. Eight series
have exact .5 ties inside the samples (RS-1402/2402 level 1, RS-1403/2403
level 5, RS-2402 level 18, RS-2101 add-on level 4, RS-2102 add-on levels 8 and
14), and those sampled points are stored in `overrides`.

To make it exact for every whole body weight in a range, sample each machine
at every whole pound in that range (about 9,000 requests for 80-450 lb across
30 machines) and add the disagreements to `overrides`. That bulk fetch was
not run because of the load it puts on Hoist's server.

## Machines without a calculator

12 ROC-IT models have no calculator on their page, and the API answers 400
for them: RS-1103/2103 Triceps Extension, RS-1408/2408 Prone Leg Curl,
RS-1412/2412 Glute Master, RS-1502/2502 Lateral Raise, RS-1602/2602 Rotary
Torso, RS-1700/2700 Chin-Dip Assist. They are in the file with
`hasCalculator: false` and stack sizes where the store lists them. The HD
Dual series (fixed path, nothing moves with the body) and the RPL
plate-loaded line have no calculator and are not included.

## Access

The calculator host needed adding to this cloud environment's allowed
domains (done Nov 12, with your approval).

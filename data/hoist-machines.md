# Hoist weight-ratio data: research notes (Nov 12 2026)

## Status: formula NOT derived

The calculator could not be reproduced from this research session. The
formula lives on a server, and that server's host was refused by this cloud
environment's network policy (proxy answered `CONNECT tunnel failed, response
403`). Nothing in `hoist-machines.json` is guessed: every formula field is
`null` until the API can be queried.

## How the calculator works (from the page source)

Every ROC-IT product page (`/pages/rs-XXXX-...`, Shopify template
`page.roc-it-product`) has a "Weight Ratio Calculation" accordion with one
number input and a CALCULATE button. The button runs `getTable()`, inline in
the page:

```js
var userWeight = Number(document.getElementById('user__weight__input__box').value);
var modelName = "RS-1402 Leg Curl";
modelName = modelName.substring(0, modelName.indexOf(' '));   // "RS-1402"
axios.get(`https://hoistweightratiocalculatorprod-qoltpirw3q-wl.a.run.app/weightratio/calculateRatio/${modelName}/${userWeight}`)
  .then(r => tableDiv.innerHTML = r.data.data.actualWeightLiftedHtml);
```

So:

- The table is computed **server-side** (a Google Cloud Run service), and the
  response is ready-made HTML (`data.data.actualWeightLiftedHtml`). There are
  no per-level constants, ratios or stack tables anywhere in the page, its
  Shopify assets, or the product JSON (`/products/<handle>.json`).
- The model key sent is the part of the title before the first space
  (`RS-1101 : Seated Dip` -> `RS-1101`), so every machine is addressed by its
  bare model number.
- The input is a bare number with no unit label. The label says only "ENTER
  YOUR WEIGHT:". Hoist is a US company (Poway, CA) and lists stacks in lb
  first, so lb in and lb out is likely, but it is **unverified**.
- Each page also carries a leftover legacy script that POSTs
  `action=calculate_weight_ratio&weight_lbs=...&modal_number=` to
  `apps.shopifyrepublic.com/hoistfitness-republic/controller.php`; it targets
  elements (`weight_lbs`, `weight_ratio_table_div`) that no longer exist on the
  page, so it is dead code. Its parameter name `weight_lbs` is the one hint
  that body weight is entered in pounds. Not queried.

## The known data point

RS-1402 Leg Curl, body weight 125.0: levels 1-17 -> 28, 41, 53, 70, 87, 104,
122, 140, 154, 170, 186, 200, 216, 232, 247, 263, 279 (user-supplied, stored
under `observed` for RS-1402). Level 17 (279) is above the RS-2402's listed
270 lb stack, so the output already includes the machine's leverage/body
movement and is most likely in lb. One body weight cannot separate the stack
term from the body-weight term, so no formula was fitted.

## Machines found (42 ROC-IT pages, from `sitemap_pages_1.xml`)

- **30 have the calculator**: RS-1101, 1102, 1201, 1203, 1204, 1301, 1302,
  1401, 1402, 1403, 1406, 1407, 1415, 1501, 1601 and the RS-2000 twins
  (2101 ... 2601), `hasCalculator: true`, `apiUrlTemplate` filled in.
- **12 have no calculator on their page** (`hasCalculator: false`):
  RS-1103/2103 Triceps Extension, RS-1408/2408 Prone Leg Curl, RS-1412/2412
  Glute Master, RS-1502/2502 Lateral Raise, RS-1602/2602 Rotary Torso,
  RS-1700/2700 Chin-Dip Assist. Whether the API still answers for them is
  unknown.
- **HD Dual series** (HD-3000 ... HD-3900) pages: no calculator (fixed-path
  machines, nothing moves with the body). Not included.
- **RPL plate-loaded** products: no calculator, not included.

`stackLb` / `stackKg` / `stackWithAddOnLb` come from the store's product JSON
("Weight Stack: 270 lbs. (123 kg)", plus the optional 5 lb add-on). Several
RS-1000 models have no product listing of their own, so they are `null`
rather than copied from their RS-2000 twin.

## Not verified (needed to finish)

The required check (site output vs formula for 3+ machines at 2 body weights)
was not possible. To finish, allow the host
`hoistweightratiocalculatorprod-qoltpirw3q-wl.a.run.app` in the environment's
network settings, then for each `apiUrlTemplate` fetch e.g. body weights 100,
150, 200, 250 and fit per level `actual = a_level + b_level * bodyWeight`
(or check for a simpler shared ratio), filling `levels`, `bodyWeightUnit`,
`outputUnit`, `kind`, `formula` and the constants.

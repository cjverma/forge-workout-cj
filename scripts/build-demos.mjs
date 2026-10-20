// Builds the bundled form demos: one start/end photo pair (WebP) for every
// exercise in the program and the add-exercise library (EX_DB), from the
// public-domain free-exercise-db. Run by hand when exercises change:
//
//   node scripts/build-demos.mjs
//
// Writes demos/<slug>-0.webp / -1.webp, rewrites demos/map.json, and prints a
// review report to scripts/demo-report.txt (not shipped). Read the report and
// fix bad matches with ALIASES below before committing.
//
// Nothing is fetched at runtime: the app reads demos/map.json only.
import { readFileSync, writeFileSync, existsSync, unlinkSync, statSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import sharp from "sharp";
import { EX_DB, PROG_V4, PROG_V7 } from "../src/constants.js";

const SRC = "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/";
const INDEX = JSON.parse(readFileSync("demos/index.json", "utf8")); // [[name, dir], ...]
const MAP_PATH = "demos/map.json";
const oldMap = JSON.parse(readFileSync(MAP_PATH, "utf8"));

// Exercise name -> free-exercise-db directory, for matches the scorer gets
// wrong or misses. Checked by eye against the photos.
export const ALIASES = {
  "Hip Thrust Machine": "Barbell_Hip_Thrust",
  "Lying Cable Tricep Extension": "Cable_Lying_Triceps_Extension",
  "Cable Pallof Press": "Pallof_Press",
  "V-Bar Seated Row": "Seated_Cable_Rows",
  "Low Row Machine": "Leverage_Iso_Row",
  "Seated Cable Fly": "Cable_Crossover",
  "Seated Unilateral Cable Row": "Seated_One-arm_Cable_Pulley_Rows",
  "Cable Reverse Fly": "Cable_Rear_Delt_Fly",
  "Lying DB Chest Press": "Dumbbell_Bench_Press",
  "DB Zottman Curl": "Zottman_Curl",
  "DB Wrist Extension": "Palms-Down_Dumbbell_Wrist_Curl_Over_A_Bench",
  "Converging Chest Press Machine": "Leverage_Chest_Press",
  "Cable Crossover (High to Low)": "Cable_Crossover",
  "Cable Crossover (Low to High)": "Low_Cable_Crossover",
  "Seated Rope Face Pull": "Face_Pull",
  "Single-Arm Cable Lateral Raise": "Cable_Seated_Lateral_Raise",
  "Seated Rope Tricep Extension": "Cable_Rope_Overhead_Triceps_Extension",
  "Single-Arm Cable Pushdown": "Triceps_Pushdown",
  "Seated Reverse Wrist Curl": "Seated_Dumbbell_Palms-Down_Wrist_Curl",
  "Single-Leg Leg Curl": "Seated_Leg_Curl",
  "Cable Crunch (Kneeling)": "Cable_Crunch",
  "Prone Quad Stretch": "Lying_Prone_Quadriceps",
  "Precor Converging Chest Press": "Leverage_Chest_Press",
  "Precor Low Row": "Leverage_Iso_Row",
  "Precor Leg Extension": "Leg_Extensions",
  "Precor Prone Leg Curl": "Lying_Leg_Curls",
  "Hoist Pec Fly / Rear Delt": "Butterfly",
  "Precor Incline Press": "Leverage_Incline_Chest_Press",
  "Precor Seated Leg Curl": "Seated_Leg_Curl",
  "Close-Grip Machine Press": "Machine_Bench_Press",
  "Side Plank": "Side_Bridge",
  "Precor Biceps Curl": "Machine_Bicep_Curl",
  "Machine Rear Delt Fly": "Reverse_Machine_Flyes",
  "Precor Rear Delt Fly": "Reverse_Machine_Flyes",
  "Wide-Grip Seated Row Machine": "Leverage_Iso_Row",
  "Close-Grip Underhand Pulldown": "Underhand_Cable_Pulldowns",
  "Assisted Dip Machine": "Dip_Machine",
  "Machine Tricep Dip": "Dip_Machine",
  "Low Cable Chest Fly": "Low_Cable_Crossover",
  "Seated Cable Shrug": "Cable_Shrugs",
  "Seated Single-Arm Face Pull": "Face_Pull",
  "Lying DB Skull Crusher": "Lying_Dumbbell_Tricep_Extension",
  "DB Skull Crusher (Incline)": "Lying_Dumbbell_Tricep_Extension",
  "Chest Supported Lateral Raise": "One-Arm_Incline_Lateral_Raise",
  "Push-Up (Hands Elevated)": "Incline_Push-Up",
  "Machine Chest Fly (Single Arm)": "Butterfly",
  "Close-Grip Neutral Pulldown": "V-Bar_Pulldown",
  "Machine Pullover": "Straight-Arm_Pulldown",
  "Chest Supported T-Bar Row": "Lying_T-Bar_Row",
  "Seated Row Machine (Neutral Grip)": "Seated_Cable_Rows",
  "Assisted Pull-Up Machine (Neutral Grip)": "Band_Assisted_Pull-Up",
  "Reverse Pec Deck": "Reverse_Machine_Flyes",
  "Chest Supported Reverse Fly": "Reverse_Machine_Flyes",
  "Seated Rear Delt Raise (Chest Supported)": "Seated_Bent-Over_Rear_Delt_Raise",
  "Bench Dip (Feet Supported)": "Bench_Dips",
  "Seated Two-Hand DB Extension": "Seated_Triceps_Press",
  "Spider Curl (Incline Bench)": "Spider_Curl",
  "Assisted Nordic Curl": "Natural_Glute_Ham_Raise",
  "Glute Drive Machine": "Barbell_Hip_Thrust",
  "Frog Pump": "Butt_Lift_Bridge",
  "Cable Anti-Rotation Hold": "Pallof_Press",
  "Front Plank": "Plank",
  "Modified Curl-Up (McGill)": "Crunches",
  "Stationary Bike Intervals": "Bicycling_Stationary",
  "Figure-4 Stretch (Supine)": "Ankle_On_The_Knee",
  "Ankle Dorsiflexion Stretch": "Calf_Stretch_Hands_Against_Wall",
  "Levator Scapulae Stretch": "Side_Neck_Stretch",
  "Supine Hamstring Stretch (Strap)": "Lying_Hamstring",
  "Precor Diverging Pulldown (Neutral Grip)": "V-Bar_Pulldown",
  "Precor Fixed Pulldown (Neutral Grip)": "V-Bar_Pulldown",
  "Precor Diverging Seated Row": "Leverage_Iso_Row",
  "Precor Pec Fly": "Butterfly",
  "Precor Glute Extension": "Glute_Kickback",
  "Precor Outer Thigh": "Thigh_Abductor",
  "Precor Inner Thigh": "Thigh_Adductor",
  "Hoist Outer Thigh": "Thigh_Abductor",
  "Hoist Inner Thigh": "Thigh_Adductor",
  "Precor Abdominal Crunch": "Ab_Crunch_Machine",
  "Hoist ROC-IT Abdominal Crunch": "Ab_Crunch_Machine",
  "Precor Calf Extension": "Calf_Press",
  "Precor Chin/Dip Assist": "Band_Assisted_Pull-Up",
  "Hoist Chin/Dip Assist": "Band_Assisted_Pull-Up",
  "Precor EFX Elliptical": "Elliptical_Trainer",
  "Precor AMT": "Elliptical_Trainer",
  "Precor TRM Treadmill": "Walking_Treadmill",
  "Precor UBK Upright Bike": "Bicycling_Stationary",
  "Hoist ROC-IT Chest Press": "Leverage_Chest_Press",
  "Hoist ROC-IT Incline Press": "Leverage_Incline_Chest_Press",
  "Hoist ROC-IT Pulldown (Neutral Grip)": "V-Bar_Pulldown",
  "Hoist ROC-IT Seated Row": "Leverage_Iso_Row",
  "Hoist Dual Action Row": "Leverage_High_Row",
  "Hoist ROC-IT Leg Press": "Leg_Press",
  "Hoist ROC-IT Leg Extension": "Leg_Extensions",
  "Hoist ROC-IT Leg Curl": "Seated_Leg_Curl",
  "Hoist ROC-IT Biceps Curl": "Machine_Bicep_Curl",
  "Hoist ROC-IT Triceps Extension": "Machine_Triceps_Extension",
  "Hoist Glute Master": "Glute_Kickback",
};

// No demo on purpose: no free source shows these correctly.
// No demo on purpose: no free source shows these correctly (mostly physio).
const NONE = new Set(["Seated Butterfly Stretch","Levator Scapulae Stretch","Bird Dog", "Nerve Floss", "Nerve Floss Left Leg", "Cable Wrist Extension", "Prone Hip Extension", "Prone Hip Extension Machine", "McKenzie Press Up", "Clamshell", "Prone Cobra", "Clamshell with Band", "Heel Slides", "Wall Slide", "Thoracic Extension", "Side-Lying Hip Abduction", "Hollow Body Hold", "Supine Heel Tap", "Supine Leg Lowering (90/90)", "Stir the Pot (Ball)", "Seated Cross-Trainer", "Arm Ergometer", "Pool Walking", "Swimming (Easy Freestyle)", "Sciatic Nerve Glide (Seated)", "Femoral Nerve Glide", "Open Book Rotation", "90/90 Hip Stretch", "Hamstring Nerve Floss", "Quadruped Rock Back", "Transverse Abdominis Activation", "Diaphragmatic Breathing", "Prone Scapular Retraction", "Progressive Prone Press-Up", "Arch Doming (Toe Curls)", "Chin Tuck", "Wall Angel", "Thread the Needle", "Precor Stretch Trainer", "Hoist Mi1 Functional Trainer", "Hoist Dual Pulley Cable Column"]);

const ABBR = { db: "dumbbell", dbs: "dumbbell", bb: "barbell", kb: "kettlebell", sa: "single", ez: "ez", rdl: "romanian deadlift" };
const SYN = { single: "one", arm: "arm", lat: "lat", pulldowns: "pulldown", pushdowns: "pushdown", raises: "raise", curls: "curl", rows: "row", presses: "press", flyes: "fly", flye: "fly", flys: "fly" };
const BRANDS = new Set(["precor", "hoist", "cybex", "nautilus", "technogym", "matrix"]);
const STOP = new Set(["the", "a", "an", "with", "on", "to", "of", "and", "machine", "seated", "standing", "lying", "warm", "up", "modified", "s"]);
const EQUIP = ["barbell", "dumbbell", "cable", "band", "kettlebell", "smith", "bodyweight"];
const ANGLE = ["incline", "decline", "flat"];

function tokens(name) {
  const raw = String(name).toLowerCase().replace(/warm-up ·/g, " ").replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
  const out = [];
  for (let t of raw) {
    if (BRANDS.has(t)) continue;
    t = ABBR[t] || t;
    for (let w of t.split(" ")) { w = SYN[w] || w; if (!STOP.has(w)) out.push(w); }
  }
  return out;
}
const pick = (toks, set) => set.filter((s) => toks.includes(s));

function score(qName, cName) {
  const q = tokens(qName), c = tokens(cName);
  if (!q.length || !c.length) return 0;
  const overlap = q.filter((t) => c.includes(t)).length;
  let s = overlap / Math.max(q.length, c.length) + (overlap === q.length ? 0.3 : 0);
  // Hard penalties: a dumbbell press is not a barbell press, incline is not flat.
  const qe = pick(q, EQUIP), ce = pick(c, EQUIP);
  if (qe.length && ce.length && !qe.some((e) => ce.includes(e))) s -= 0.6;
  // Machine vs free weight: a lever/machine/cable press is not a dumbbell press.
  const free = ["barbell", "dumbbell", "kettlebell", "band"], fixed = ["machine", "leverage", "lever", "smith", "cable"];
  const qr = String(qName).toLowerCase(), cr = String(cName).toLowerCase();
  const qFree = free.some((w) => q.includes(w)), cFree = free.some((w) => c.includes(w));
  const qFixed = fixed.some((w) => qr.includes(w)), cFixed = fixed.some((w) => cr.includes(w));
  if ((qFree && cFixed && !cFree) || (qFixed && !qFree && cFree)) s -= 0.6;
  // Posture: seated is not lying, prone is not supine.
  const POST = ["seated", "lying", "standing", "prone", "supine", "kneeling"];
  const qp = POST.filter((w) => qr.includes(w)), cp = POST.filter((w) => cr.includes(w));
  if (qp.length && cp.length && !qp.some((w) => cp.includes(w))) s -= 0.4;
  const qa = pick(q, ANGLE), ca = pick(c, ANGLE);
  if ((qa.length || ca.length) && qa.join() !== ca.join()) s -= 0.6;
  return s;
}

function bestMatch(name) {
  if (ALIASES[name]) return { dir: ALIASES[name], cand: ALIASES[name], s: 9 };
  let best = null;
  for (const [cand, dir] of INDEX) {
    const s = score(name, cand);
    if (!best || s > best.s) best = { dir, cand, s };
  }
  return best && best.s >= 0.65 ? best : { ...best, miss: true };
}

const slug = (n) => n.toLowerCase().replace(/warm-up · /, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function fetchBuf(url) {
  // curl, not fetch(): it honours the environment's HTTPS proxy.
  return execFileSync("curl", ["-sfL", "--max-time", "30", url], { maxBuffer: 20 * 1024 * 1024 });
}
async function toWebp(buf, out) {
  await sharp(buf).resize({ width: 480, withoutEnlargement: true }).webp({ quality: 65 }).toFile(out);
}

const names = [...new Set([
  ...Object.values(PROG_V7).flatMap((d) => d.exercises.map((e) => e.name)),
  ...Object.values(PROG_V4).flatMap((d) => d.exercises.map((e) => e.name)),
  ...EX_DB.map((e) => e.name),
])];

const DRY = !!process.env.DRY; // DRY=1: report matches, write nothing
const map = {}, report = { kept: [], matched: [], low: [], missed: [] };
for (const name of names) {
  if (NONE.has(name)) { report.missed.push(`${name}  (no free source)`); continue; }
  // Existing hand-picked pairs win: convert their JPEGs to WebP.
  if (Array.isArray(oldMap[name])) {
    if (DRY) { report.kept.push(name); continue; }
    const out = [];
    for (const f of oldMap[name]) {
      const webp = f.replace(/\.(jpe?g|png)$/i, ".webp");
      if (!existsSync(webp)) await toWebp(readFileSync(f), webp);
      out.push(webp);
    }
    map[name] = out; report.kept.push(name); continue;
  }
  const m = bestMatch(name);
  if (m.miss) { report.missed.push(`${name}  (best: ${m.cand} ${m.s.toFixed(2)})`); continue; }
  if (DRY) { (m.s < 0.85 ? report.low : report.matched).push(`${name}  ->  ${m.cand}  (${m.s.toFixed(2)})`); continue; }
  const base = "demos/" + slug(name);
  const files = [base + "-0.webp", base + "-1.webp"];
  try {
    for (let k = 0; k < 2; k++) if (!existsSync(files[k])) await toWebp(fetchBuf(`${SRC}${encodeURIComponent(m.dir)}/${k}.jpg`), files[k]);
    map[name] = files;
    (m.s < 0.85 ? report.low : report.matched).push(`${name}  ->  ${m.cand}  (${m.s.toFixed(2)})`);
  } catch (e) {
    report.missed.push(`${name}  (download failed: ${m.dir})`);
  }
}

if (DRY) { console.log(["LOW", ...report.low, "", "MISSED", ...report.missed, "", "MATCHED", ...report.matched].join("\n")); process.exit(0); }
// Old JPEGs are replaced by WebP; drop any that nothing references now.
const used = new Set(Object.values(map).flat());
for (const f of readdirSync("demos")) if (/\.(jpe?g|webp)$/i.test(f) && !used.has("demos/" + f)) unlinkSync("demos/" + f);

writeFileSync(MAP_PATH, JSON.stringify(map, null, 1) + "\n");
const size = readdirSync("demos").reduce((a, f) => a + statSync("demos/" + f).size, 0);
const txt = [
  `names ${names.length} · mapped ${Object.keys(map).length} · demos/ ${(size / 1048576).toFixed(1)} MB`,
  `\nLOW CONFIDENCE (check these photos)\n` + report.low.join("\n"),
  `\nMISSED\n` + report.missed.join("\n"),
  `\nMATCHED\n` + report.matched.join("\n"),
  `\nKEPT (hand-picked)\n` + report.kept.join("\n"),
].join("\n");
writeFileSync("scripts/demo-report.txt", txt + "\n");
console.log(txt.split("\n")[0]);

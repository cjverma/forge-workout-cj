#!/usr/bin/env node
import { readFileSync } from "fs";
import handler, {
  __resetHealthKitSqlForTests,
  __setHealthKitSqlForTests,
  buildHealthKitSql,
  normalizeHealthKitPayload
} from "./api/healthkit.js";

let passed = 0;
let failed = 0;

function ok(label, condition, detail = "") {
  if (condition) {
    console.log(`  ✓  ${label}`);
    passed++;
  } else {
    console.error(`  ✗  ${label}${detail ? " — " + detail : ""}`);
    failed++;
  }
}

function section(title) {
  console.log(`\n-- ${title}`);
}

function mockRes() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    ended: false,
    setHeader(k, v) { this.headers[k] = v; return this; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    end() { this.ended = true; return this; }
  };
}

async function call(req) {
  const res = mockRes();
  await handler({ headers: {}, body: {}, ...req }, res);
  return res;
}

section("HealthKit static wiring");
const SERVER = readFileSync("server.js", "utf8");
const HEALTHKIT = readFileSync("api/healthkit.js", "utf8");

ok("server imports healthkit handler", SERVER.includes('import healthkit from "./api/healthkit.js"'));
ok("server mounts /api/healthkit", SERVER.includes('app.all("/api/healthkit", mount(healthkit))'));
ok("healthkit imports shared auth", HEALTHKIT.includes('checkAuth'));
ok("healthkit uses Toronto default date", HEALTHKIT.includes('America/Toronto'));
ok("healthkit has column-scoped active upsert", HEALTHKIT.includes('active=EXCLUDED.active'));
ok("healthkit has column-scoped resting upsert", HEALTHKIT.includes('resting_override=EXCLUDED.resting_override'));
ok("healthkit upserts weights", HEALTHKIT.includes('INSERT INTO weights(date, kg, updated_at)'));

section("HealthKit validation");
let p = normalizeHealthKitPayload({ active: 1450 }, "2026-07-16");
ok("active-only payload is valid", p.ok && p.date === "2026-07-16" && p.applied.active === 1450 && Object.keys(p.applied).length === 1);

p = normalizeHealthKitPayload({ date: "bad", active: 1 }, "2026-07-16");
ok("invalid date is rejected", !p.ok && p.errors.some(e => e.includes("date")));

p = normalizeHealthKitPayload({ active: -1, resting: 799, weightKg: 301 }, "2026-07-16");
ok("bounds are enforced", !p.ok && p.errors.length === 3);

p = normalizeHealthKitPayload({ foo: "ignored", active: 100 }, "2026-07-16");
ok("unknown fields are ignored", p.ok && p.ignored.includes("foo") && !Object.hasOwn(p.applied, "foo"));

p = normalizeHealthKitPayload({}, "2026-07-16");
ok("empty metric payload is rejected", !p.ok && p.errors.some(e => e.includes("at least one")));

section("HealthKit SQL shape");
const activeOnly = buildHealthKitSql(normalizeHealthKitPayload({ date: "2026-07-16", active: 1450 }, "2026-07-16"));
ok("active-only payload creates one statement", activeOnly.length === 1);
ok("active-only SQL touches active", /active=EXCLUDED\.active/.test(activeOnly[0].text));
ok("active-only SQL does not touch resting_override", !/resting_override/.test(activeOnly[0].text));
ok("active-only SQL does not touch shock", !/shock/.test(activeOnly[0].text));
ok("active-only SQL params are date + active", JSON.stringify(activeOnly[0].values) === JSON.stringify(["2026-07-16", 1450]));

const full = buildHealthKitSql(normalizeHealthKitPayload({ date: "2026-07-16", active: 1450, resting: 2850, weightKg: 136.4 }, "2026-07-16"));
ok("full payload creates day-meta and weight statements", full.length === 2 && /nutrition_day_meta/.test(full[0].text) && /weights/.test(full[1].text));

section("HealthKit handler");
process.env.FORGE_API_TOKEN = "test-token";

let res = await call({ method: "POST", headers: {}, body: { active: 1 } });
ok("401 without bearer token", res.statusCode === 401);

res = await call({ method: "GET", headers: { authorization: "Bearer test-token" }, body: { active: 1 } });
ok("405 on GET", res.statusCode === 405);

res = await call({ method: "POST", headers: { authorization: "Bearer test-token" }, body: {} });
ok("400 on empty body", res.statusCode === 400);

const calls = [];
__setHealthKitSqlForTests(async (text, values) => { calls.push({ text, values }); });
res = await call({ method: "POST", headers: { authorization: "Bearer test-token" }, body: { date: "2026-07-16", active: 1450 } });
__resetHealthKitSqlForTests();
ok("200 on valid active-only POST", res.statusCode === 200 && res.body?.ok === true && res.body.applied.active === 1450);
ok("mock SQL received one active-only statement", calls.length === 1 && /active=EXCLUDED\.active/.test(calls[0].text));
ok("mock SQL active-only statement preserves other day-meta columns", !/resting_override|shock/.test(calls[0].text));

const total = passed + failed;
console.log(`\n${"-".repeat(50)}`);
console.log(`  ${passed}/${total} passed${failed > 0 ? `  ·  ${failed} FAILED` : "  ·  all green"}`);
if (failed > 0) process.exit(1);

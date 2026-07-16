#!/usr/bin/env node
import { readFileSync } from "fs";

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

const SHARED = readFileSync("api/_shared.js", "utf8");
const COACH = readFileSync("api/coach.js", "utf8");
const NUTRITION = readFileSync("api/nutrition.js", "utf8");
const SUGGEST = readFileSync("api/suggest-alt.js", "utf8");
const STATE = readFileSync("api/state.js", "utf8");

section("Backend hardening");
ok("shared fetchWithTimeout helper exists", /export async function fetchWithTimeout/.test(SHARED) && SHARED.includes("AbortController"));
ok("callOpenAI uses fetchWithTimeout with a 60s default", SHARED.includes("timeoutMs = 60000") && SHARED.includes("await fetchWithTimeout"));
ok("shared checkRateLimit helper exists", /export function checkRateLimit/.test(SHARED) && SHARED.includes("Rate limit exceeded"));
ok("rate limiter returns 429 with Retry-After", SHARED.includes("res.status(429)") && SHARED.includes("Retry-After"));

section("AI endpoint guards");
ok("coach imports and calls checkRateLimit", COACH.includes("checkRateLimit") && COACH.includes('name: "coach"'));
ok("nutrition imports and calls checkRateLimit", NUTRITION.includes("checkRateLimit") && NUTRITION.includes('name: "nutrition"'));
ok("suggest-alt imports and calls checkRateLimit", SUGGEST.includes("checkRateLimit") && SUGGEST.includes('name: "suggest-alt"'));
ok("nutrition OpenAI call uses fetchWithTimeout", NUTRITION.includes("fetchWithTimeout") && !NUTRITION.includes('apiRes = await fetch("https://api.openai.com'));

section("Generic server errors");
ok("state endpoint logs raw error but returns generic client error", STATE.includes('console.error("[state]", e.message)') && STATE.includes('{ error: "Failed to load state" }'));
ok("state endpoint no longer concatenates e.message into JSON response", !STATE.includes('"Failed to load state: " + e.message'));

const total = passed + failed;
console.log(`\n${"-".repeat(50)}`);
console.log(`  ${passed}/${total} passed${failed > 0 ? `  ·  ${failed} FAILED` : "  ·  all green"}`);
if (failed > 0) process.exit(1);

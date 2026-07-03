// FORGE local dev server.
// Thin Express adapter over the Vercel serverless handlers in api/ —
// api/*.js is the single source of truth for backend logic; this file
// only provides routing + static serving for local development.
// Production (Vercel) uses api/ directly and never runs this file.

import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

import coach from "./api/coach.js";
import weeklyPlan from "./api/weekly-plan.js";
import nutrition from "./api/nutrition.js";
import state from "./api/state.js";
import mutate from "./api/mutate.js";
import health from "./api/health.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: "1mb" }));

const mount = handler => (req, res) => Promise.resolve(handler(req, res)).catch(err => {
  console.error("[server]", err);
  if (!res.headersSent) res.status(500).json({ error: "Internal error" });
});

app.all("/api/coach", mount(coach));
app.all("/api/weekly-plan", mount(weeklyPlan));
app.all("/api/nutrition", mount(nutrition));
app.all("/api/state", mount(state));
app.all("/api/mutate", mount(mutate));
app.all("/api/health", mount(health));

app.use(express.static(__dirname));

const PORT = Number(process.env.PORT || 8787);
app.listen(PORT, () => console.log(`FORGE dev server on http://localhost:${PORT}`));

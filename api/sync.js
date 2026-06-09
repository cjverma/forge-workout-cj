import { setCors, checkAuth } from "./_shared.js";

const KEY = "forge:state";
const MAX_BYTES = 900_000;

function kvCfg() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url, token } : null;
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (!checkAuth(req, res)) return;

  const kv = kvCfg();
  if (!kv) {
    const present = Object.keys(process.env).filter(k => /KV_|UPSTASH|REDIS/i.test(k));
    console.error("[sync] storage not configured. Redis-related env vars present:", present.join(", ") || "none");
    return res.status(501).json({ error: "Sync storage not configured" });
  }

  try {
    if (req.method === "GET") {
      const r = await fetch(`${kv.url}/get/${KEY}`, {
        headers: { authorization: `Bearer ${kv.token}` }
      });
      const d = await r.json();
      if (!d.result) return res.json({ state: null, updatedAt: 0 });
      try {
        return res.json(JSON.parse(d.result));
      } catch {
        return res.json({ state: null, updatedAt: 0 });
      }
    }

    if (req.method === "POST") {
      const { state, updatedAt } = req.body || {};
      if (!state || !updatedAt) return res.status(400).json({ error: "Missing state or updatedAt" });
      const payload = JSON.stringify({ state, updatedAt });
      if (payload.length > MAX_BYTES) return res.status(413).json({ error: "State too large" });
      const r = await fetch(`${kv.url}/set/${KEY}`, {
        method: "POST",
        headers: { authorization: `Bearer ${kv.token}` },
        body: payload
      });
      const d = await r.json();
      if (d.error) {
        console.error("[sync] storage error:", d.error);
        return res.status(502).json({ error: "Storage error" });
      }
      return res.json({ ok: true, updatedAt });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    console.error("[sync]", e.message);
    return res.status(502).json({ error: "Sync failed" });
  }
}

import { setCors } from "./_shared.js";

// Resolve an exercise name to a working MuscleWiki demo MP4.
// Tries candidate URLs server-side (HEAD) and caches the winner in Redis
// so each exercise is only probed once, ever.

const CDN = "https://media.musclewiki.com/media/uploads/videos/branded/";

function kvCfg() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url, token } : null;
}

function candidates(name) {
  const n = name.toLowerCase().trim();
  // Base slug: strip equipment words, normalise
  let base = n
    .replace(/\bmachine\b/g, "")
    .replace(/\bcable\b/g, "")
    .replace(/\bdumbbell\b/g, "")
    .replace(/\bseated\b/g, "seated")
    .replace(/[()]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/ /g, "-");
  const full = n.replace(/[()]/g, "").replace(/\s+/g, "-");

  const slugs = new Set([base, full,
    "seated-" + base.replace(/^seated-/, ""),
    base.replace(/^seated-/, "")
  ]);

  const equipment = n.includes("cable") ? ["cables", "machine"]
    : n.includes("dumbbell") || n.includes("curl") && !n.includes("machine") ? ["dumbbells", "machine", "cables"]
    : ["machine", "cables", "dumbbells"];

  const out = [];
  for (const eq of equipment)
    for (const slug of slugs)
      for (const view of ["front", "side"])
        out.push(`${CDN}male-${eq}-${slug}-${view}.mp4`);
  return [...new Set(out)].slice(0, 24);
}

async function headOk(url) {
  try {
    const r = await fetch(url, { method: "HEAD", redirect: "follow" });
    return r.ok;
  } catch { return false; }
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const name = (req.query.name || "").toString().slice(0, 80).trim();
  if (!name) return res.status(400).json({ error: "Missing name" });

  const kv = kvCfg();
  const cacheKey = "demo:" + name.toLowerCase().replace(/[^a-z0-9]+/g, "-");

  // Cache lookup
  if (kv) {
    try {
      const r = await fetch(`${kv.url}/get/${cacheKey}`, { headers: { authorization: `Bearer ${kv.token}` } });
      const d = await r.json();
      if (d.result) {
        const cached = d.result === "none" ? null : d.result;
        return res.json({ url: cached, cached: true });
      }
    } catch {}
  }

  // Probe candidates
  let found = null;
  for (const url of candidates(name)) {
    if (await headOk(url)) { found = url; break; }
  }
  console.log("[demo]", name, "→", found || "no match");

  // Cache result (including misses, so we don't re-probe forever)
  if (kv) {
    try {
      await fetch(`${kv.url}/set/${cacheKey}`, {
        method: "POST",
        headers: { authorization: `Bearer ${kv.token}` },
        body: found || "none"
      });
    } catch {}
  }

  return res.json({ url: found });
}

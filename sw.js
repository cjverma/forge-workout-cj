// Cache version: bump this string on any asset/design change so every client
// drops the old cache and installs the new one.
const V = "forge-v139";

// Offline-first PWA. build.mjs copies this file into dist/ (the only folder
// Vercel serves) and fills DEMOS with every bundled demo image, so the app AND
// its form demos load with no connection. In the repo copy DEMOS stays empty
// (local dev: server.js serves the repo root).
const CRITICAL = ["/", "/manifest.json?v=5", "/demos/map.json", "/icon-192.png", "/icon-512.png", "/apple-touch-icon.png"];
const DEMOS = [/*__DEMOS__*/];

// Install fails (and the browser retries on the next launch) if any critical
// file is missing or more than 5% of the demos fail. A half-filled cache must
// never pass for "offline ready": the user finds out in airplane mode.
self.addEventListener("install", e => {
  e.waitUntil((async () => {
    const cache = await caches.open(V);
    const put = async u => { const r = await fetch(u, { cache: "no-cache" }); if (!r.ok) throw new Error(u + " " + r.status); await cache.put(u, r); };
    const crit = await Promise.allSettled(CRITICAL.map(put));
    if (crit.some(r => r.status === "rejected")) throw new Error("precache: a critical file failed");
    let failed = 0;
    for (let i = 0; i < DEMOS.length; i += 8) {
      const res = await Promise.allSettled(DEMOS.slice(i, i + 8).map(put));
      failed += res.filter(r => r.status === "rejected").length;
    }
    if (DEMOS.length && failed / DEMOS.length > 0.05) throw new Error(`precache: ${failed}/${DEMOS.length} demos failed`);
    await self.skipWaiting(); // take over without waiting for old tabs to close
  })());
});

// Drop every cache that isn't this version (a stale 6 MB cache must not linger).
self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== V).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // other sites: untouched
  if (url.pathname.startsWith("/api/")) return;    // live data: untouched

  // Demo images never change within a version: cache-first, so one bar of
  // signal at the gym never stalls a picture.
  if (/\/demos\/[^/]+\.(webp|jpe?g|png)$/i.test(url.pathname)) {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(V).then(c => c.put(req, copy)); }
      return res;
    })));
    return;
  }

  // Everything else (the app, map.json, manifest): network-first so online
  // always gets the latest; the cache answers when offline. Navigations ignore
  // the query string (/?demo=streak still opens offline).
  e.respondWith(
    fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(V).then(c => c.put(req, copy)); }
      return res;
    }).catch(async () =>
      (await caches.match(req, { ignoreSearch: req.mode === "navigate" })) ||
      (req.mode === "navigate" ? caches.match("/") : undefined))
  );
});

// Logging reminders (api/_nudge.js, Web Push). Shown even when the app is
// closed; tapping one opens (or focuses) Forge.
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { title: "Forge", body: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(d.title || "Forge", {
    body: d.body || "", icon: "/icon-192.png", badge: "/icon-192.png", tag: "forge-nudge", data: { url: "/" },
  }));
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((ws) => {
    for (const w of ws) if ("focus" in w) return w.focus();
    return self.clients.openWindow("/");
  }));
});

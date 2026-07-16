// Cache version — bump this string to force all clients to update immediately.
// The registration code in index.html detects a new waiting SW and reloads.
const V = "forge-v12";

// Static assets pre-cached at install so the app renders fully offline
// (self-hosted display font must never depend on the network mid-session).
const PRECACHE = [
  "/fonts/barlow-condensed-600.woff2",
  "/fonts/barlow-condensed-700.woff2",
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(V).then(c => c.addAll(PRECACHE)));
  self.skipWaiting(); // activate as soon as installed, don't wait for old tab to close
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== V).map(k => caches.delete(k)))
    ).then(() => self.clients.claim()) // take control of all open tabs immediately
  );
});

// Network-first: always try the network, fall back to cache.
// This means users always get the latest version when online.
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  // Only handle same-origin requests; skip API calls
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;

  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(V).then(c => c.put(e.request, clone));
        }
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});

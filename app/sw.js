/* Muster service worker.
   - App shell: precached, served stale-while-revalidate (works offline, picks up new code on next load).
   - data/*.json and data/meta-lists/*.json: network-first (fresh points when online), falling back to the cached copy offline.
   - Faction artwork: precached from assets/factions/index.json, cache-first.
   - Accounts/sync (Supabase /auth/v1/, /rest/v1/) are never cached: they are cross-origin and/or non-GET, and are
     ignored explicitly below as well, so the browser talks to Supabase directly every time. */
const SHELL = "muster-shell-v20", DATA = "muster-data-v1", ART = "muster-art-v1";
const SHELL_FILES = ["./", "index.html", "css/app.css", "js/config.js", "js/core.js", "js/sync.js", "js/app.js", "manifest.webmanifest",
  "icons/icon-192.png", "icons/icon-512.png", "icons/maskable-512.png", "icons/apple-touch-icon.png", "icons/favicon-32.png"];

self.addEventListener("install", (ev) => {
  ev.waitUntil((async () => {
    const shell = await caches.open(SHELL);
    await shell.addAll(SHELL_FILES.map((f) => new Request(f, { cache: "reload" })));
    const data = await caches.open(DATA);
    await Promise.all(["data/version.json", "data/points.json", "data/winrates.json", "data/datasheets.json"].map((u) => data.add(u).catch(() => {})));
    try {
      const idx = await (await fetch("assets/factions/index.json")).json();
      const art = await caches.open(ART);
      const files = Object.values(idx).flatMap((v) => [v.banner, v.thumb]).filter(Boolean).map((f) => f.startsWith("assets/") ? f : `assets/factions/${f}`);
      await Promise.all(files.map((f) => art.add(f).catch(() => {})));
    } catch (e) { /* artwork is optional */ }
    self.skipWaiting();
  })());
});
self.addEventListener("activate", (ev) => {
  ev.waitUntil((async () => {
    for (const k of await caches.keys()) if (![SHELL, DATA, ART].includes(k)) await caches.delete(k);
    await self.clients.claim();
  })());
});
self.addEventListener("fetch", (ev) => {
  const req = ev.request; if (req.method !== "GET") return;
  const url = new URL(req.url); if (url.origin !== location.origin) return;            // Supabase + any other cross-origin call: network only
  if (/\/(auth|rest|realtime|storage)\/v1\//.test(url.pathname)) return;              // never cache account / sync API calls
  const path = url.pathname;
  if (/\/data\/(meta-lists\/)?[^/]+\.json$/.test(path)) {
    ev.respondWith((async () => {
      const cache = await caches.open(DATA);
      const key = new Request(url.origin + path);
      try {
        const res = await fetch(req);
        if (res.ok) await cache.put(key, res.clone());
        return res;
      } catch (e) {
        const hit = await cache.match(key, { ignoreSearch: true });
        return hit || new Response(JSON.stringify({ error: "offline" }), { status: 503, headers: { "Content-Type": "application/json" } });
      }
    })());
    return;
  }
  if (path.includes("/assets/")) {
    ev.respondWith((async () => {
      const cache = await caches.open(ART);
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      try { const res = await fetch(req); if (res.ok) cache.put(req, res.clone()); return res; } catch (e) { return new Response("", { status: 504 }); }
    })());
    return;
  }
  ev.respondWith((async () => {
    // App shell: network-first (bypassing the browser HTTP cache) so new code shows on the first refresh;
    // falls back to the cached copy when offline or the network is slow.
    const cache = await caches.open(SHELL);
    const isNav = req.mode === "navigate";
    const key = isNav ? "index.html" : req;
    const net = fetch(req, { cache: "no-cache" }).then((res) => { if (res.ok) cache.put(key, res.clone()); return res; }).catch(() => null);
    const timeout = new Promise((r) => setTimeout(() => r(null), 4000));
    const res = await Promise.race([net, timeout]);
    if (res) return res;
    const hit = await cache.match(key, { ignoreSearch: true });
    if (hit) { ev.waitUntil(net); return hit; }
    return (await net) || new Response("Offline", { status: 503 });
  })());
});

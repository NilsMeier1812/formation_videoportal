/* ============================================================================
   Formation-App – Service Worker (eine PWA für alle Bereiche)

   - App-Dateien (HTML/CSS/JS/Bibliotheken): NETWORK-FIRST. Online kommt immer
     der neueste Stand, offline der zuletzt geladene.
   - /api/* wird nie zwischengespeichert – Daten kommen immer frisch.
   - Andere Domains (Videos auf media.…, Supabase) laufen am Service Worker
     vorbei. Die Musik des Planers liegt in IndexedDB, nicht hier.
   ========================================================================== */

const VERSION = "v1";
const CACHE = `formation-shell-${VERSION}`;

// Grundausstattung, damit der Planer offline startet, auch wenn man ihn nach
// der Installation noch nicht geöffnet hat. Alles Weitere landet beim ersten Laden im Cache.
const PRECACHE = [
  "/choreo/",
  "/css/choreo.css",
  "/js/pwa.js",
  "/js/choreo/main.js",
  "/vendor/alpine.esm.js",
  "/vendor/dexie.mjs",
  "/vendor/wavesurfer.esm.js",
  "/vendor/wavesurfer-regions.esm.js",
  "/vendor/supabase.umd.js",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .catch(() => {}) // fehlt etwas, startet die App trotzdem
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // Videos, Supabase: direkt übers Netz
  if (url.pathname.startsWith("/api/")) return; // Daten nie aus dem Cache
  event.respondWith(networkFirst(req));
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req);
    if (res.ok && res.status === 200) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const cached = await cache.match(req, { ignoreSearch: true });
    if (cached) return cached;
    throw err;
  }
}

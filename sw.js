const CACHE_VERSION = "v6";
const APP_SHELL_CACHE = `back-to-lincolnshire-shell-${CACHE_VERSION}`;
const RUNTIME_CACHE = `back-to-lincolnshire-runtime-${CACHE_VERSION}`;

const APP_SHELL_URLS = [
  "/",
  "/index.html",
  "/app.js",
  "/deadline.js",
  "/point-in-polygon.js",
  "/styles.css",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-512-maskable.png",
  "/icons/apple-touch-icon.png",
  "/data/crossings.json",
  "/data/boundaries/lincolnshire-ceremonial.geojson",
  "/data/boundaries/lincolnshire-administrative.geojson",
  "/vendor/leaflet/leaflet.css",
  "/vendor/leaflet/leaflet.js",
  "/vendor/leaflet/images/marker-icon.png",
  "/vendor/leaflet/images/marker-icon-2x.png",
  "/vendor/leaflet/images/marker-shadow.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(APP_SHELL_CACHE).then((cache) => cache.addAll(APP_SHELL_URLS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== APP_SHELL_CACHE && key !== RUNTIME_CACHE)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

// Network-first with a cached fallback. The fallback is never presented as fresh:
// any response written into RUNTIME_CACHE is stamped with an X-Cached-At header at
// write time (Response.headers can't be mutated after construction, so we build a
// new Response with the extra header before cache.put), so a later cache-served
// response always carries proof of its age.
async function networkFirstWithAgeHeader(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) {
      const headers = new Headers(response.headers);
      headers.set("X-Cached-At", new Date().toISOString());
      const toCache = new Response(response.clone().body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
      await cache.put(request, toCache);
    }
    return response;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw err;
  }
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  if (url.origin === self.location.origin && APP_SHELL_URLS.includes(url.pathname)) {
    event.respondWith(
      caches.match(event.request).then((cached) => cached || fetch(event.request))
    );
    return;
  }

  if (url.origin === self.location.origin && url.pathname.startsWith("/api/")) {
    event.respondWith(networkFirstWithAgeHeader(event.request));
    return;
  }

  // Everything else (e.g. OSM map tiles) — pass through to the network, no caching.
});

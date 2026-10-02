/**
 * sw.js — Service Worker de WHIP Studio (PWA).
 *
 * Estrategia:
 *  - Pre-cache del shell de la aplicación (app-offline vN).
 *  - Navegación: network-first con fallback offline al shell cacheado.
 *  - Estáticos same-origin: cache-first.
 *  - Nunca se cachean peticiones WHIP/HTTP a servidores de media (passthrough),
 *    para no interferir con la señalización ni la ingesta.
 */

const VERSION = "whip-studio-v10";
const SHELL_CACHE = `${VERSION}-shell`;
const SHELL_ASSETS = [
  "./",
  "./index.html",
  "./css/styles.css",
  "./js/main.js",
  "./js/utils.js",
  "./js/devices.js",
  "./js/audio.js",
  "./js/sdp.js",
  "./js/whip.js",
  "./js/stats.js",
  "./js/hud.js",
  "./js/return.js",
  "./vendor/hls.min.js",
  "./manifest.webmanifest",
  "./icons/icon.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((c) => c.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;               // POST/DELETE WHIP siempre a red

  const url = new URL(req.url);

  // Passthrough total para orígenes externos (endpoints WHIP, STUN/TURN HTTP…)
  if (url.origin !== self.location.origin) return;

  // Navegación: network-first → fallback shell offline
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then((c) => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match("./index.html"))
    );
    return;
  }

  // Estáticos: cache-first con revalidación en segundo plano
  event.respondWith(
    caches.match(req).then((cached) => {
      const refresh = fetch(req)
        .then((res) => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(SHELL_CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached ?? refresh;
    })
  );
});

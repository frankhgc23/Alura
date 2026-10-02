/* Service Worker - RCM P2P Camera LAN
 * Estrategia:
 *  - index.html y assets locales: network-first con fallback a caché (funciona offline tras la primera visita)
 *  - peerjs (CDN): cache-first (stale-while-revalidate) para que la app arranque sin conexión
 *  - Navegaciones: si todo falla, sirve la copia cacheada de index.html
 */
const CACHE_VERSION = 'rcm-p2p-v1';
const STATIC_ASSETS = [
    './',
    './index.html',
    './manifest.webmanifest',
    './icons/icon.svg',
    './icons/icon-192.png',
    './icons/icon-512.png',
    './icons/icon-maskable-512.png',
    'https://unpkg.com/peerjs@1.5.5/dist/peerjs.min.js'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_VERSION)
            .then(cache => cache.addAll(STATIC_ASSETS))
            .then(() => self.skipWaiting())
            .catch(err => console.warn('[SW] precache parcial:', err))
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;

    const url = new URL(req.url);

    // No cachear streams ni peticiones no-GET del WebRTC/peer signaling por este SW
    // (solo recursos estáticos)
    if (url.origin !== self.location.origin && !/unpkg\.com/.test(url.host)) return;

    // CDN (peerjs): cache-first con revalidación en segundo plano
    if (url.host === 'unpkg.com') {
        event.respondWith(
            caches.match(req).then(cached => {
                const fetchPromise = fetch(req).then(res => {
                    if (res && res.ok) {
                        const clone = res.clone();
                        caches.open(CACHE_VERSION).then(c => c.put(req, clone));
                    }
                    return res;
                }).catch(() => null);
                return cached || fetchPromise.then(res => res || Response.error());
            })
        );
        return;
    }

    // Navegaciones y HTML: network-first, fallback caché
    if (req.mode === 'navigate' || url.pathname.endsWith('.html')) {
        event.respondWith(
            fetch(req).then(res => {
                const clone = res.clone();
                caches.open(CACHE_VERSION).then(c => c.put(req, clone));
                return res;
            }).catch(() => caches.match('./index.html').then(r => r || Response.error()))
        );
        return;
    }

    // Resto de estáticos: network-first con fallback caché
    event.respondWith(
        fetch(req).then(res => {
            if (res && res.ok) {
                const clone = res.clone();
                caches.open(CACHE_VERSION).then(c => c.put(req, clone));
            }
            return res;
        }).catch(() => caches.match(req).then(r => r || Response.error()))
    );
});

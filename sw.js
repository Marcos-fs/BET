// ===================== SERVICE WORKER =====================
// BetManager PWA - Offline Support & Cache

const CACHE_NAME = 'betmanager-v1';

// All files to cache for offline use
const STATIC_ASSETS = [
    '/',
    '/dashboard',
    '/apostas',
    '/nova-aposta',
    '/nova-multipla',
    '/historico',
    '/carteira',
    '/perfil',
    '/styles/main.css',
    '/js/data.js',
    '/manifest.json',
    '/icons/icon-72.png',
    '/icons/icon-96.png',
    '/icons/icon-128.png',
    '/icons/icon-144.png',
    '/icons/icon-192.png',
    '/icons/icon-512.png',
];

// ---- INSTALL: cache all static assets ----
self.addEventListener('install', (event) => {
    console.log('[SW] Installing BetManager Service Worker...');
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            console.log('[SW] Caching static assets');
            // Use addAll but ignore failures for optional assets (like icons)
            return Promise.allSettled(
                STATIC_ASSETS.map(url => cache.add(url).catch(() => {
                    console.warn('[SW] Could not cache:', url);
                }))
            );
        })
    );
    // Take over immediately without waiting for old SW to die
    self.skipWaiting();
});

// ---- ACTIVATE: clean up old caches ----
self.addEventListener('activate', (event) => {
    console.log('[SW] Activating BetManager Service Worker...');
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames
                    .filter(name => name !== CACHE_NAME)
                    .map(name => {
                        console.log('[SW] Deleting old cache:', name);
                        return caches.delete(name);
                    })
            );
        })
    );
    // Claim all clients immediately
    self.clients.claim();
});

// ---- FETCH: Cache-First for static assets, Network-First for others ----
self.addEventListener('fetch', (event) => {
    const { request } = event;
    const url = new URL(request.url);

    // Only handle same-origin requests
    if (url.origin !== location.origin) return;

    // Skip non-GET requests (POST, etc.)
    if (request.method !== 'GET') return;

    event.respondWith(
        caches.match(request).then((cachedResponse) => {
            if (cachedResponse) {
                // Return cache, but also update it in background (stale-while-revalidate)
                const fetchPromise = fetch(request).then((networkResponse) => {
                    if (networkResponse && networkResponse.status === 200) {
                        const clone = networkResponse.clone();
                        caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
                    }
                    return networkResponse;
                }).catch(() => { });
                return cachedResponse;
            }

            // Not in cache: fetch from network and cache it
            return fetch(request).then((networkResponse) => {
                if (!networkResponse || networkResponse.status !== 200) {
                    return networkResponse;
                }
                const clone = networkResponse.clone();
                caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
                return networkResponse;
            }).catch(() => {
                // Offline fallback: serve index.html for navigation requests
                if (request.mode === 'navigate') {
                    return caches.match('/index.html');
                }
            });
        })
    );
});

// ---- MESSAGE: force update ----
self.addEventListener('message', (event) => {
    if (event.data === 'skipWaiting') {
        self.skipWaiting();
    }
});

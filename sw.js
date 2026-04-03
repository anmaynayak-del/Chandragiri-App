// App Version 5.6.1 — increment CACHE_NAME when deploying to bust stale caches
const CACHE_NAME = 'chandragiri-cache-v15';
const URLS_TO_CACHE = [
    './',
    './index.html',
    './styles.css',
    './app.js',
    './i18n.js',
    './manifest.json',
    './icon-honey.png?v=2',
    // NOTE: Google Fonts is intentionally excluded — it sets Cache-Control: private
    // which prevents the Cache API from storing the response. It is loaded from
    // network when online and gracefully degrades to system-ui fonts when offline.
    'https://www.gstatic.com/firebasejs/10.8.1/firebase-app-compat.js',
    'https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore-compat.js',
    'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js'
];

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(async cache => {
            await Promise.all(
                URLS_TO_CACHE.map(url =>
                    cache.add(url).catch(error => {
                        console.warn('[SW] Failed to pre-cache:', url, error);
                        return null;
                    })
                )
            );
            await self.skipWaiting();
        })
    );
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys => {
            return Promise.all(
                keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
            );
        }).then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', event => {
    if (event.request.method !== 'GET') return;

    // Network-first strategy to reduce stale app.js/index.html issues after deployments.
    event.respondWith(
        fetch(event.request)
            .then(networkResponse => {
                if (networkResponse && networkResponse.ok) {
                    const clone = networkResponse.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
                }
                return networkResponse;
            })
            .catch(async () => {
                const cachedResponse = await caches.match(event.request, { ignoreSearch: true });
                if (cachedResponse) return cachedResponse;
                if (event.request.mode === 'navigate') {
                    const cachedIndex = await caches.match('./index.html');
                    if (cachedIndex) return cachedIndex;
                }
                return new Response('Offline and not cached', { status: 503, statusText: 'Service Unavailable' });
            })
    );
});

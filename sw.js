const CACHE_NAME = 'chandragiri-v6.1.0';
const ASSETS_TO_CACHE = [
    './',
    './index.html',
    './app.js',
    './i18n.js',
    './styles.css',
    './manifest.json',
    './icon-honey.png',
    './logo-clean.png'
];

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => {
            return cache.addAll(ASSETS_TO_CACHE);
        }).then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(cacheNames => {
            return Promise.all(
                cacheNames.map(cacheName => {
                    if (cacheName !== CACHE_NAME) {
                        return caches.delete(cacheName);
                    }
                })
            );
        }).then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', event => {
    // Network first, falling back to cache
    if (event.request.method !== 'GET') return;

    event.respondWith(
        fetch(event.request).then(response => {
            const responseClone = response.clone();
            caches.open(CACHE_NAME).then(cache => {
                cache.put(event.request, responseClone);
            });
            return response;
        }).catch(() => caches.match(event.request, { ignoreSearch: true }))
    );
});

// Allow manual cache clearing via messaging
self.addEventListener('message', event => {
    if (event.data?.type === 'CLEAR_APP_CACHE') {
        caches.keys().then(names => Promise.all(names.map(name => caches.delete(name))))
            .then(() => self.registration.unregister());
    }
});

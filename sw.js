const CACHE_NAME = 'shiori-pwa-v301';
const APP_SHELL = [
  './',
  './index.html',
  './src/enhancements.css',
  './src/enhancements.js',
  './src/firebase-sync.js',
  './src/suggestion-sync.js',
  './src/suggestion-validation.js',
  './src/discussion-ui.js',
  './src/discussion.css',
  './src/participant-v2.css',
  './src/participant-v2.js',
  './src/trip-v2-core.js',
  './src/map-links.js',
  './src/draft-validation.js',
  './src/trip-v2-analysis.js',
  './src/trip-v2-index.js',
  './manifest.webmanifest',
  './images/shiori-icon-v2.svg',
  './images/shiori-icon-v2-192.png',
  './images/shiori-icon-v2-512.png',
  './images/shiori-icon-v2-180.png',
  './images/ana-app.jpg',
  './images/jalan-app.jpg',
  './images/toyota-rent-app.png',
  './images/hello-cycling-app.png',
  './images/paypay.png',
  './images/tabelog.png',
  './images/weather.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(key => key.startsWith('shiori-pwa-') && key !== CACHE_NAME).map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', event => {
  if (event.data && (event.data.action === 'SKIP_WAITING' || event.data.action === 'skipWaiting')) {
    self.skipWaiting();
  }
});

function cacheKeyFor(request) {
  const url = new URL(request.url);
  url.search = '';
  url.hash = '';
  return url.toString();
}

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const requestUrl = new URL(event.request.url);
  if (requestUrl.hostname === 'api.open-meteo.com') return;
  const path = requestUrl.pathname;
  const isAdminAsset = path.endsWith('/admin.html')
    || path.endsWith('/src/admin.js')
    || path.endsWith('/src/admin.css')
    || path.endsWith('/src/admin-v2.css')
    || path.endsWith('/firestore.rules')
    || path.endsWith('/firebase.json')
    || path.includes('/scripts/');
  if (isAdminAsset) return;
  // Let external maps, tiles, fonts and app links use the browser's normal network path.
  // Caching opaque third-party responses here would grow the cache without a safe limit.
  if (requestUrl.origin !== self.location.origin) return;
  const cacheKey = cacheKeyFor(event.request);
  // Cache only the public shell, never arbitrary JSON responses or admin modules.
  if (!APP_SHELL.some(asset => new URL(asset, self.location.href).href === cacheKey)) return;

  const isWebAsset = requestUrl.pathname.endsWith('.html') ||
                     requestUrl.pathname.endsWith('.js') ||
                     requestUrl.pathname.endsWith('.css') ||
                     requestUrl.pathname.endsWith('.webmanifest') ||
                     requestUrl.pathname.endsWith('.json') ||
                     requestUrl.pathname === '/' ||
                     requestUrl.pathname.endsWith('/');

  if (isWebAsset) {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(cacheKey, copy));
          }
          return response;
        })
        .catch(() => caches.match(cacheKey).then(cached => {
          if (cached || event.request.mode !== 'navigate') return cached;
          return caches.match('./index.html');
        }))
    );
    return;
  }

  event.respondWith(
    caches.match(cacheKey).then(cached => {
      return cached || fetch(event.request).then(response => {
        if (response && (response.ok || response.type === 'opaque')) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(cacheKey, copy));
        }
        return response;
      });
    })
  );
});


self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = event.notification.data?.url || './';
  event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(items => {
    const existing = items.find(client => 'focus' in client);
    return existing ? existing.focus() : clients.openWindow(target);
  }));
});

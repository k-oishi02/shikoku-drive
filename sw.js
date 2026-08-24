const CACHE_NAME = 'shiori-pwa-v56';
const APP_SHELL = [
  './',
  './index.html',
  './src/enhancements.css',
  './src/enhancements.js',
  './src/firebase-sync.js',
  './manifest.webmanifest',
  './images/shiori-icon-v2.svg',
  './images/shiori-icon-v2-192.png',
  './images/shiori-icon-v2-512.png',
  './images/shiori-icon-v2-180.png',
  './images/jalan.png',
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
        keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
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
    || path.endsWith('/firestore.rules')
    || path.endsWith('/firebase.json')
    || path.includes('/scripts/');
  if (isAdminAsset) return;
  // Let external maps, tiles, fonts and app links use the browser's normal network path.
  // Caching opaque third-party responses here would grow the cache without a safe limit.
  if (requestUrl.origin !== self.location.origin) return;
  const cacheKey = cacheKeyFor(event.request);

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

const CACHE_VERSION = 'v404';
const CACHE_NAME = `shiori-pwa-${CACHE_VERSION}`;
const APP_SHELL = [
  './',
  './index.html',
  './admin.html',
  './recap.html',
  './20261107.json',
  './20261031.json',
  './recaps/shikoku-2026.json',
  './manifest.webmanifest',
  // Stylesheets
  './src/theme-v31.css',
  './src/design-v31.css',
  './src/expressive-v32.css',
  './src/enhancements.css',
  './src/discussion.css',
  './src/participant-v2.css',
  './src/recap.css',
  './src/admin.css',
  './src/admin-v2.css',
  // Fonts
  './fonts/libre-franklin-latin-400-600.woff2',
  './fonts/libre-franklin-OFL.txt',
  // Participant Viewer Modules (M1-M4)
  './src/viewer-app.js',
  './src/viewer-router.js',
  './src/viewer-ui.js',
  './src/trip-store.js',
  './src/weather-service.js',
  './src/pwa-manager.js',
  './src/error-boundary.js',
  './src/offline-expense-queue.js',
  './src/itinerary-calc.js',
  './src/participant-v2.js',
  './src/navigation-picker.js',
  './src/live-itinerary.js',
  './src/timeline-worker.js',
  './src/journey-v4.js',
  './src/recap.js',
  './src/discussion-ui.js',
  './src/enhancements.js',
  './src/firebase-sync.js',
  './src/suggestion-sync.js',
  './src/suggestion-validation.js',
  // Pure Domain & Calculation Core
  './src/trip-v2-core.js',
  './src/trip-v2-analysis.js',
  './src/trip-v2-index.js',
  './src/draft-validation.js',
  './src/map-links.js',
  // Admin Modules (M2)
  './src/admin.js',
  './src/admin-store.js',
  './src/admin-ui.js',
  './src/admin-auth.js',
  './src/admin-trip-service.js',
  './src/admin-trip-store.js',
  './src/admin-save-state.js',
  './src/admin-draft-record.js',
  './src/admin-transfer.js',
  './src/admin-placement.js',
  './src/admin-day-planner.js',
  './src/admin-day-planner-ui.js',
  './src/admin-candidate-state.js',
  './src/admin-candidate-ui.js',
  './src/admin-view-overview.js',
  './src/admin-view-editor.js',
  './src/admin-distribution-ui.js',
  './src/admin-distribution-ledger.js',
  './src/admin-roles-ui.js',
  './src/admin-discussion-ui.js',
  // Static Images & App Icons
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
  const isServerOrToolAsset = path.endsWith('/firestore.rules')
    || path.endsWith('/firebase.json')
    || path.endsWith('/package.json')
    || path.includes('/scripts/')
    || path.includes('/tests/');
  if (isServerOrToolAsset) return;
  // Let external maps, tiles, fonts and app links use the browser's normal network path.
  if (requestUrl.origin !== self.location.origin) return;
  const cacheKey = cacheKeyFor(event.request);
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
          if (cached) return cached;
          if (event.request.mode === 'navigate') {
            if (requestUrl.pathname.endsWith('/admin.html')) {
              return caches.match('./admin.html');
            }
            return caches.match('./index.html');
          }
          if (requestUrl.pathname.endsWith('.json')) {
            return new Response(JSON.stringify({ error: 'offline', message: 'オフラインのためデータを取得できませんでした。' }), {
              status: 503,
              headers: { 'Content-Type': 'application/json; charset=utf-8' }
            });
          }
          return new Response('Offline', { status: 503, statusText: 'Offline' });
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

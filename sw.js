const CACHE_NAME = 'shikoku-drive-ultimate-1785215343';
const APP_SHELL = [
  './',
  './index.html',
  './travel_guide.html',
  './enhancements.css',
  './enhancements.js',
  './firebase-sync.js',
  './manifest.webmanifest',
  './header_shikoku.png',
  './yadon_park.png',
  './udon_baka.png',
  './sakubee_somen.png',
  './shodoshima.png',
  './chichibugahama.png',
  './dogo_onsen.png',
  './shimonada.png',
  './shimanami.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
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

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const requestUrl = new URL(event.request.url);
  if (requestUrl.hostname === 'api.open-meteo.com') return;

  // Network-First strategy for critical web assets to bypass cache when online
  const isWebAsset = requestUrl.pathname.endsWith('.html') || 
                     requestUrl.pathname.endsWith('.js') || 
                     requestUrl.pathname.endsWith('.css') || 
                     requestUrl.pathname.endsWith('.webmanifest') ||
                     requestUrl.pathname === '/' ||
                     requestUrl.pathname.endsWith('/');

  if (isWebAsset) {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(() => caches.match(event.request) || caches.match('./index.html'))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then(cached => {
      return cached || fetch(event.request).then(response => {
        if (response && (response.ok || response.type === 'opaque')) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
        }
        return response;
      });
    })
  );
});

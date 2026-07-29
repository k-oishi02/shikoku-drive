const CACHE_NAME = 'shikoku-drive-ultimate-v22';
const APP_SHELL = [
  './',
  './index.html',
  './data/trips.json',
  './data/shikoku2026.json',
  './src/enhancements.css',
  './src/enhancements.js',
  './src/firebase-sync.js',
  './manifest.webmanifest',
  './images/header_shikoku.png',
  './images/yadon_park.png',
  './images/udon_baka.png',
  './images/sakubee_somen.png',
  './images/shodoshima.png',
  './images/chichibugahama.png',
  './images/dogo_onsen.png',
  './images/shimonada.png',
  './images/shimanami.png'
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

  const isWebAsset = requestUrl.pathname.endsWith('.html') || 
                     requestUrl.pathname.endsWith('.js') || 
                     requestUrl.pathname.endsWith('.css') || 
                     requestUrl.pathname.endsWith('.webmanifest') ||
                     requestUrl.pathname.endsWith('.json') ||
                     requestUrl === '/' ||
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

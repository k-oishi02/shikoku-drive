const CACHE_NAME = 'shikoku-drive-v17';
const APP_SHELL = [
  './',
  './index.html',
  './travel_guide.html',
  './enhancements.css?v=17',
  './enhancements.js?v=17',
  './firebase-sync.js?v=17',
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

  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
          return response;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then(cached => {
      const networkFetch = fetch(event.request)
        .then(response => {
          if (response && (response.ok || response.type === 'opaque')) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(() => cached);
      
      // Stale-While-Revalidate for CSS/JS/HTML, Cache-First for static assets (PNG)
      const isStaticAsset = requestUrl.pathname.endsWith('.png') || requestUrl.pathname.endsWith('.woff2');
      if (isStaticAsset) {
        return cached || networkFetch;
      }
      return networkFetch.catch(() => cached);
    })
  );
});

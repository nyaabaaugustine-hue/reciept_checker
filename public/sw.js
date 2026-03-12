// InvoiceGuard AI — Service Worker
// Handles offline caching, background sync, and push notifications

const CACHE_NAME = 'invoiceguard-v1';
const OFFLINE_URL = '/';

// Assets to cache immediately on install
const STATIC_ASSETS = [
  '/',
  '/manifest.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // Only handle GET requests
  if (event.request.method !== 'GET') return;

  // API calls — network only, no cache
  if (event.request.url.includes('/api/') || event.request.url.includes('groq.com')) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        // Cache successful responses for next.js chunks and static assets
        if (response.ok && (
          event.request.url.includes('/_next/static') ||
          event.request.url.includes('/icons/') ||
          event.request.url.endsWith('.js') ||
          event.request.url.endsWith('.css')
        )) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => {
        // Offline fallback — return cached homepage
        return caches.match(OFFLINE_URL);
      });
    })
  );
});

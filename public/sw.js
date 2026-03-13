// InvoiceGuard AI — Service Worker v2

const CACHE_NAME = 'invoiceguard-v2';
const BACKGROUND_SYNC_TAG = 'invoiceguard-offline-queue';

self.addEventListener('install', () => {
  // Skip precaching entirely — nothing to fetch at install time
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
  if (event.request.method !== 'GET') return;
  if (event.request.url.includes('groq.com')) return;
  if (event.request.url.includes('/api/')) return;

  // Share target
  if (event.request.url.includes('/share-target')) {
    event.respondWith(
      (async () => {
        try {
          const formData = await event.request.formData();
          const file = formData.get('image');
          if (file && file instanceof File) {
            const cache = await caches.open('share-target');
            await cache.put('/shared-image', new Response(file));
          }
        } catch (err) {
          console.warn('[SW] Share target error:', err);
        }
        return Response.redirect('/?shared=1', 303);
      })()
    );
    return;
  }

  // Network-first for everything; cache static assets on the way through
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (
          response.ok &&
          (
            event.request.url.includes('/_next/static') ||
            event.request.url.includes('/icons/')
          )
        ) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});

// Background sync
self.addEventListener('sync', (event) => {
  if (event.tag === BACKGROUND_SYNC_TAG) {
    event.waitUntil(
      self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
        clients.forEach(c => c.postMessage({ type: 'PROCESS_OFFLINE_QUEUE' }));
      })
    );
  }
});

// Push notifications
self.addEventListener('push', (event) => {
  const data = event.data?.json() || {};
  event.waitUntil(
    self.registration.showNotification(data.title || 'InvoiceGuard AI', {
      body: data.body || 'You have an overdue invoice.',
      icon: '/icons/icon-192.svg',
      badge: '/icons/icon-192.svg',
      tag: 'invoiceguard-alert',
      renotify: true,
      data: { url: '/' },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(clients.openWindow(event.notification.data?.url || '/'));
});

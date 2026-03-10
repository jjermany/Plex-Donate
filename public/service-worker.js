// Cleanup worker: unregister any previously installed worker and purge caches.
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const cacheKeys = await caches.keys();
      await Promise.all(cacheKeys.map((key) => caches.delete(key)));
      await self.registration.unregister();

      const clients = await self.clients.matchAll({
        includeUncontrolled: true,
        type: 'window',
      });
      await Promise.all(clients.map((client) => client.navigate(client.url)));
    })()
  );
});

self.addEventListener('fetch', () => {
  // No-op. This file exists only to remove older cached workers.
});

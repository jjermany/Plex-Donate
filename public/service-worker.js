const CACHE_NAME = 'plex-donate-cache-v1';
const CORE_ASSETS = ['/', '/index.html', '/share.html', '/manifest.webmanifest'];
const OPTIONAL_ASSETS = ['/icons/icon-round-android.png', '/icons/icon-square-ios.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      await cache.addAll(CORE_ASSETS);
      await Promise.all(
        OPTIONAL_ASSETS.map(async (asset) => {
          try {
            const response = await fetch(asset, { cache: 'no-cache' });
            if (response && response.ok) {
              await cache.put(asset, response.clone());
            }
          } catch (err) {
            // Icon asset not present yet; allow install to continue.
          }
        })
      );
    })()
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
      )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') {
    return;
  }

  const acceptHeader = request.headers.get('accept') || '';
  if (acceptHeader.includes('text/html')) {
    event.respondWith(handleHtmlRequest(request));
    return;
  }

  event.respondWith(handleStaticRequest(request));
});

async function handleHtmlRequest(request) {
  try {
    const response = await fetch(request);
    const cache = await caches.open(CACHE_NAME);
    cache.put(request, response.clone());
    return response;
  } catch (err) {
    const cached = await caches.match(request);
    if (cached) {
      return cached;
    }
    const fallbackPath = request.url.includes('/share/') ? '/share.html' : '/index.html';
    const fallback = await caches.match(fallbackPath);
    return fallback || Response.error();
  }
}

async function handleStaticRequest(request) {
  const cached = await caches.match(request);
  if (cached) {
    return cached;
  }
  try {
    const response = await fetch(request);
    if (
      response &&
      response.status === 200 &&
      response.type === 'basic' &&
      request.url.startsWith(self.location.origin)
    ) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    return Response.error();
  }
}

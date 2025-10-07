const CACHE_NAME = 'plex-donate-cache-v2';
const CORE_ASSETS = ['/', '/index.html', '/dashboard.html', '/share.html', '/manifest.webmanifest'];
const OPTIONAL_ASSETS = [
  '/icons/plex-donate-android-any-144.png',
  '/icons/plex-donate-android-any-192.png',
  '/icons/plex-donate-android-any-512.png',
  '/icons/plex-donate-android-maskable-192.png',
  '/icons/plex-donate-android-maskable-512.png',
  '/icons/plex-donate-ios-120.png',
  '/icons/plex-donate-ios-152.png',
  '/icons/plex-donate-ios-167.png',
  '/icons/plex-donate-ios-180.png',
  '/icons/plex-donate-ios-1024.png'
];

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
    let fallbackPath = '/index.html';
    if (request.url.includes('/dashboard')) {
      fallbackPath = '/dashboard.html';
    } else if (request.url.includes('/share/')) {
      fallbackPath = '/share.html';
    }
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

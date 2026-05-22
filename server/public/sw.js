const CACHE_NAME = 'copilot-remote-shell-v8';
const STATIC_ASSETS = [
  './',
  'index.html',
  'manifest.webmanifest',
  'app-icon-192.png',
  'app-icon-512.png',
  'favicon.ico',
  'app-icon.svg',
];

function sameOrigin(url) {
  return url.origin === self.location.origin;
}

function isApiRequest(url) {
  return /\/api\//.test(url.pathname) || /\/socket\.io\//.test(url.pathname);
}

function isPwaMetadataRequest(url) {
  return /\/(?:manifest\.webmanifest|app-icon(?:-\d+)?\.png|app-icon\.svg|favicon\.ico)$/.test(url.pathname);
}

async function cacheShell() {
  const cache = await caches.open(CACHE_NAME);
  const assets = STATIC_ASSETS.map((asset) => new URL(asset, self.registration.scope).href);
  await cache.addAll(assets);
}

async function networkFirst(request, cacheKey) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      cache.put(cacheKey, response.clone());
    }
    return response;
  } catch {
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
    throw new Error('Offline');
  }
}

async function cacheFirst(request, cacheKey) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;
  const response = await fetch(request);
  if (response && response.ok) {
    cache.put(cacheKey, response.clone());
  }
  return response;
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    await cacheShell();
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map((key) => (key === CACHE_NAME ? Promise.resolve() : caches.delete(key))));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (!sameOrigin(url) || isApiRequest(url)) return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request, new URL('./', self.registration.scope).href));
    return;
  }

  if (isPwaMetadataRequest(url)) {
    event.respondWith(networkFirst(request, request.url));
    return;
  }

  event.respondWith(cacheFirst(request, request.url));
});

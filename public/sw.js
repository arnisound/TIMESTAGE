// Service worker TimeStage.
// Objectif principal : garantir que le chrono hors ligne reste ouvrable meme
// sans aucune connexion, une fois la page visitee.

const VERSION = 'timestage-v1';
const SHELL = [
  '/',
  '/offline',
  '/display',
  '/ask',
  '/css/base.css',
  '/css/stage.css',
  '/css/control.css',
  '/js/index.js',
  '/js/offline.js',
  '/js/display.js',
  '/js/ask.js',
  '/js/lib/dom.js',
  '/js/lib/net.js',
  '/js/lib/stage.js',
  '/js/lib/localroom.js',
  '/shared/time.js',
  '/shared/timer.js',
  '/icons/icon.svg',
  '/manifest.webmanifest',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(VERSION);
      // addAll echoue en bloc si une seule requete echoue : on tolere les trous.
      await Promise.all(
        SHELL.map((url) => cache.add(new Request(url, { cache: 'reload' })).catch(() => null))
      );
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => key !== VERSION).map((key) => caches.delete(key)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // L'API et le WebSocket ne sont jamais mis en cache.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws')) return;

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(request, url));
    return;
  }
  event.respondWith(staleWhileRevalidate(request));
});

async function handleNavigation(request, url) {
  const cache = await caches.open(VERSION);
  try {
    const response = await fetch(request);
    if (response.ok && isCacheableRoute(url.pathname)) cache.put(request, response.clone());
    return response;
  } catch {
    // Hors ligne : on sert la page demandee si on l'a, sinon le chrono local.
    return (
      (await cache.match(request)) ||
      (await cache.match(normalizeRoute(url.pathname))) ||
      (await cache.match('/offline')) ||
      new Response('Hors ligne', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } })
    );
  }
}

/** Les routes a code variable (/d/ABCDE) partagent la page de leur famille. */
function normalizeRoute(pathname) {
  if (pathname.startsWith('/d/')) return '/display';
  if (pathname.startsWith('/q/')) return '/ask';
  if (pathname.startsWith('/c/')) return '/offline';
  return '/';
}

function isCacheableRoute(pathname) {
  return ['/', '/offline', '/display', '/ask'].includes(pathname);
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(VERSION);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((response) => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => null);
  return cached || (await network) || new Response('', { status: 504 });
}

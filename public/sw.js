// Service worker TimeStage.
// Objectif principal : garantir que le chrono hors ligne reste ouvrable meme
// sans aucune connexion, une fois la page visitee.
//
// Le fichier vit a la racine du site, qu'il soit servi par le serveur Node (/)
// ou par un hebergement statique dans un sous-dossier (/mon-depot/). Toutes les
// URL sont donc calculees a partir de sa propre adresse.

const VERSION = 'timestage-v6';
const BASE = new URL('./', self.location).pathname;
const at = (path) => BASE + path;

// Les routes propres au serveur Node (offline, display, ask) n'existent pas sur
// un hebergement statique : les echecs de mise en cache y sont sans gravite.
const SHELL = [
  '',
  'index.html',
  'offline',
  'display',
  'ask',
  'css/base.css',
  'css/stage.css',
  'css/control.css',
  'js/index.js',
  'js/offline.js',
  'js/display.js',
  'js/ask.js',
  'js/lib/dom.js',
  'js/lib/net.js',
  'js/lib/stage.js',
  'js/lib/localroom.js',
  'js/lib/effects.js',
  'shared/time.js',
  'shared/timer.js',
  'shared/effects.js',
  'icons/icon.svg',
  'icons/icon-maskable.svg',
  'icons/logo.png',
  'icons/favicon-32.png',
  'icons/favicon-16.png',
  'icons/icon-192.png',
  'icons/apple-touch-icon.png',
  'manifest.webmanifest',
].map(at);

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
  if (url.pathname.startsWith(at('api/')) || url.pathname.startsWith(at('ws'))) return;

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
      (await cache.match(at('offline'))) ||
      (await cache.match(at('index.html'))) ||
      (await cache.match(at(''))) ||
      new Response('Hors ligne', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } })
    );
  }
}

/** Les routes a code variable (/d/ABCDE) partagent la page de leur famille. */
function normalizeRoute(pathname) {
  const route = pathname.startsWith(BASE) ? pathname.slice(BASE.length) : pathname.replace(/^\//, '');
  if (route.startsWith('d/') || route.startsWith('k/')) return at('display');
  if (route.startsWith('q/')) return at('ask');
  if (route.startsWith('c/')) return at('offline');
  return at('');
}

function isCacheableRoute(pathname) {
  return ['', 'index.html', 'offline', 'display', 'ask'].map(at).includes(pathname);
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

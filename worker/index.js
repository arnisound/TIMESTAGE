/*!
 * TimeStage, chronometre de scene
 * © 2026 Arnisound Tools (Theo Arnissolle). Tous droits reserves.
 * Logiciel proprietaire : toute reproduction, modification, distribution ou
 * exploitation sans autorisation ecrite prealable est interdite. Voir LICENSE.
 */
// Point d'entree du Worker Cloudflare : l'equivalent de server/index.js, mais
// sans serveur qui tourne.
//
// Ce que fait ce fichier : router. Les fichiers statiques sont servis par
// Cloudflare avant meme d'arriver ici ; tout le reste (API, WebSocket, URL
// courtes) est aiguille vers le Durable Object de la salle concernee, qui
// detient l'etat et repond a sa place.

import QRCode from 'qrcode';

import { makeCode, normalizeCode } from '../core/rooms.js';

export { Room } from './room.js';
export { Lobby } from './lobby.js';

const json = (data, status = 200) => Response.json(data, { status });
const clientIp = (request) => request.headers.get('CF-Connecting-IP') || request.headers.get('x-forwarded-for') || 'inconnu';

/** Envoie une requete interne au Durable Object d'une salle. */
function roomStub(env, code) {
  return env.ROOMS.get(env.ROOMS.idFromName(code));
}

function callRoom(env, code, path, request, body) {
  const init = {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', 'x-timestage-ip': clientIp(request) },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  return roomStub(env, code).fetch('https://room' + path, init);
}

/** Sert une page du site (les assets sont montes a la racine du Worker). */
const page = (request, env, name) => env.ASSETS.fetch(new URL('/' + name, request.url));

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // --- WebSocket ---------------------------------------------------------
    // Le code de salle voyage dans l'URL : il faut savoir quel Durable Object
    // reveiller avant meme d'accepter la connexion.
    if (path === '/ws') {
      const code = normalizeCode(url.searchParams.get('room'));
      if (!code) return new Response('Code de salle manquant.', { status: 400 });
      return roomStub(env, code).fetch(
        new Request('https://room/ws', {
          headers: { ...Object.fromEntries(request.headers), 'x-timestage-ip': clientIp(request) },
        })
      );
    }

    // --- API ---------------------------------------------------------------
    if (path.startsWith('/api/')) return handleApi(request, env, url, path);

    // --- URL courtes des QR codes ------------------------------------------
    const short = /^\/([cdqk])\/[A-Za-z0-9]{3,8}\/?$/.exec(path);
    if (short) {
      const file = { c: 'control.html', d: 'display.html', q: 'ask.html', k: 'display.html' }[short[1]];
      return page(request, env, file);
    }

    // Toute autre adresse retombe sur l'accueil, comme le serveur Node.
    const home = await page(request, env, 'index.html');
    return new Response(home.body, { status: 404, headers: home.headers });
  },
};

async function handleApi(request, env, url, path) {
  const method = request.method;

  if (path === '/api/health') {
    return json({ ok: true, runtime: 'cloudflare-workers' });
  }

  if (path === '/api/qr.svg') {
    const data = String(url.searchParams.get('data') || '').slice(0, 900);
    if (!data) return new Response('parametre "data" requis', { status: 400 });
    try {
      const svg = await QRCode.toString(data, {
        type: 'svg',
        errorCorrectionLevel: url.searchParams.get('ecl') === 'h' ? 'H' : 'M',
        margin: Number(url.searchParams.get('margin') ?? 1),
        color: {
          dark: String(url.searchParams.get('dark') || '#000000').slice(0, 7),
          light: String(url.searchParams.get('light') || '#ffffff').slice(0, 7),
        },
      });
      return new Response(svg, {
        headers: { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=300' },
      });
    } catch (err) {
      return new Response('QR impossible : ' + err.message, { status: 400 });
    }
  }

  // --- Creation d'une salle -------------------------------------------------
  if (path === '/api/rooms' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const lobby = env.LOBBY.get(env.LOBBY.idFromName('lobby'));
    const allowed = await lobby.fetch('https://lobby/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ip: clientIp(request) }),
    });
    if (!allowed.ok) return json({ error: 'Trop de salles creees, reessayez plus tard.' }, 429);

    // Un code precis permet de reprendre une salle apres un incident : les QR
    // codes deja distribues restent valables.
    if (body.code != null) {
      const code = normalizeCode(body.code);
      if (!code) return json({ error: 'Code de salle invalide.', reason: 'invalid_code' }, 400);
      return callRoom(env, code, '/create', request, { code, name: body.name });
    }

    // Sinon on tire un code au sort, en verifiant qu'il est libre.
    for (let attempt = 0; attempt < 6; attempt++) {
      const code = makeCode();
      const response = await callRoom(env, code, '/create', request, { code, name: body.name });
      if (response.status !== 409) return response;
    }
    return json({ error: 'Aucun code disponible, reessayez.' }, 503);
  }

  const room = /^\/api\/rooms\/([A-Za-z0-9]{3,8})(\/[a-z]+)?$/.exec(path);
  if (room) {
    const code = normalizeCode(room[1]);
    if (!code) return json({ error: 'Salle introuvable.' }, 404);
    const section = room[2] || '';
    const body = method === 'GET' ? undefined : await request.json().catch(() => ({}));

    if (section === '' && method === 'GET') return callRoom(env, code, '/info', request);
    if (section === '/questions' && method === 'POST') return callRoom(env, code, '/questions', request, body);
    if (section === '/vote' && method === 'POST') return callRoom(env, code, '/vote', request, body);
    if (section === '/logo') {
      const init = {
        method,
        headers: { 'content-type': 'application/json', 'x-timestage-ip': clientIp(request) },
      };
      if (method !== 'GET') init.body = JSON.stringify(body);
      return roomStub(env, code).fetch('https://room/logo' + url.search, init);
    }
  }

  return json({ error: 'Route inconnue.' }, 404);
}

/*!
 * TimeStage, chronometre de scene
 * © 2026 Arnisound Tools (Theo Arnissolle). Tous droits reserves.
 * Logiciel proprietaire : toute reproduction, modification, distribution ou
 * exploitation sans autorisation ecrite prealable est interdite. Voir LICENSE.
 */
// Serveur TimeStage : fichiers statiques, API REST et synchronisation WebSocket.

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';
import QRCode from 'qrcode';
import { WebSocketServer } from 'ws';

import {
  RoomStore,
  applyCommand,
  addQuestion,
  addVote,
  publicState,
  viewerState,
  tickRoom,
  cleanText,
  setRoomLogo,
  clearRoomLogo,
  checkAccess,
  rotateOwnerToken,
  markEmpty,
} from './rooms.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_FILE = process.env.TIMESTAGE_DATA === 'none' ? null : process.env.TIMESTAGE_DATA || path.join(ROOT, 'data', 'rooms.json');

const store = new RoomStore({ file: DATA_FILE });
const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '1mb' })); // le logo arrive en data URL

// --- Limitation de debit simple (memoire) ----------------------------------
const buckets = new Map();
function rateLimit(key, { limit, windowMs }) {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || now > bucket.reset) {
    buckets.set(key, { count: 1, reset: now + windowMs });
    return { ok: true, remaining: limit - 1 };
  }
  bucket.count += 1;
  if (bucket.count > limit) {
    return { ok: false, retryAfterMs: bucket.reset - now };
  }
  return { ok: true, remaining: limit - bucket.count };
}
setInterval(() => {
  const now = Date.now();
  for (const [key, b] of buckets) if (now > b.reset) buckets.delete(key);
}, 60_000).unref();

const clientIp = (req) => (req.ip || req.socket?.remoteAddress || 'inconnu').replace(/^::ffff:/, '');

/**
 * Garde-fous du vote. Le plafond par votant est serre : il laisse changer
 * d'avis quelques fois, pas marteler le serveur. Le plafond par adresse est
 * volontairement tres haut, car dans une salle tout le public sort souvent par
 * la meme connexion : une limite serree y refuserait des votes legitimes.
 */
function voteAllowed(room, ip, voterId) {
  const voter = String(voterId || '').slice(0, 64);
  const perVoter = rateLimit(`vote:${room.code}:${voter}`, { limit: 10, windowMs: 60_000 });
  if (!perVoter.ok) return { ok: false, error: 'Trop de changements de vote, patientez un instant.' };
  const perNetwork = rateLimit(`votes:${room.code}:${ip}`, { limit: 600, windowMs: 60_000 });
  if (!perNetwork.ok) return { ok: false, error: 'Trop de votes depuis ce reseau, patientez un instant.' };
  return { ok: true };
}

// --- Fichiers statiques -----------------------------------------------------
const staticOptions = {
  etag: true,
  maxAge: '5m',
  setHeaders(res, filePath) {
    if (filePath.endsWith('sw.js') || filePath.endsWith('manifest.webmanifest')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
};
app.use(express.static(PUBLIC_DIR, staticOptions));
app.use('/shared', express.static(path.join(ROOT, 'shared'), staticOptions));

const page = (name) => (req, res) => res.sendFile(path.join(PUBLIC_DIR, name));
app.get('/', page('index.html'));
app.get('/control', page('control.html'));
app.get('/display', page('display.html'));
app.get('/ask', page('ask.html'));
app.get('/offline', page('offline.html'));
app.get('/legal', page('legal.html'));
// URL courtes : QR codes plus lisibles.
app.get('/c/:code', page('control.html'));
app.get('/d/:code', page('display.html'));
app.get('/q/:code', page('ask.html'));
// Fenetre video : le chrono seul, pour une source navigateur de melangeur.
app.get('/k/:code', page('display.html'));

// --- API --------------------------------------------------------------------
app.get('/api/health', (req, res) => {
  res.json({ ok: true, rooms: store.rooms.size, uptime: Math.round(process.uptime()) });
});

app.post('/api/rooms', (req, res) => {
  const limit = rateLimit('create:' + clientIp(req), { limit: 30, windowMs: 60 * 60 * 1000 });
  if (!limit.ok) return res.status(429).json({ error: 'Trop de salles creees, reessayez plus tard.' });

  // `code` permet a une regie de reprendre son code apres un redemarrage du
  // serveur : les QR codes deja distribues et les ecrans restent valables.
  const result = store.create(cleanText(req.body?.name, 80), req.body?.code ?? null);
  if (!result.ok) {
    return res.status(result.reason === 'taken' ? 409 : 400).json({ error: result.error, reason: result.reason });
  }
  const { room } = result;
  res.status(201).json({
    code: room.code,
    ownerToken: room.ownerToken,
    state: publicState(room),
  });
});

app.get('/api/rooms/:code', (req, res) => {
  const room = store.get(req.params.code);
  if (!room) return res.status(404).json({ error: 'Salle introuvable.' });
  // Salle protegee : on confirme seulement qu'elle existe et qu'il faut un code.
  if (room.access) return res.json({ code: room.code, protected: true });
  res.json({
    code: room.code,
    protected: false,
    name: room.session.name,
    questionsOpen: room.settings.questionsOpen,
    displayName: room.settings.displayName,
  });
});

app.post('/api/rooms/:code/questions', (req, res) => {
  const room = store.get(req.params.code);
  if (!room) return res.status(404).json({ error: 'Salle introuvable.' });
  const ip = clientIp(req);
  if (!checkAccess(room, req.body?.access)) {
    const attempts = rateLimit(`access:${ip}`, { limit: 10, windowMs: 10 * 60_000 });
    return res.status(attempts.ok ? 403 : 429).json({ error: 'Code d acces requis.', code: 'access_denied' });
  }
  const burst = rateLimit(`q:${room.code}:${ip}`, { limit: 5, windowMs: 60_000 });
  if (!burst.ok) {
    return res.status(429).json({ error: 'Patientez un instant avant la prochaine question.' });
  }
  const result = addQuestion(room, { text: req.body?.text, author: req.body?.author });
  if (!result.ok) return res.status(400).json({ error: result.error });
  store.scheduleSave();
  broadcast(room);
  res.status(201).json({ ok: true, id: result.question.id, status: result.question.status });
});

// Repli HTTP du vote, quand le WebSocket ne passe pas.
app.post('/api/rooms/:code/vote', (req, res) => {
  const room = store.get(req.params.code);
  if (!room) return res.status(404).json({ error: 'Salle introuvable.' });
  const ip = clientIp(req);
  if (!checkAccess(room, req.body?.access)) {
    const attempts = rateLimit(`access:${ip}`, { limit: 10, windowMs: 10 * 60_000 });
    return res.status(attempts.ok ? 403 : 429).json({ error: 'Code d acces requis.', code: 'access_denied' });
  }
  const guard = voteAllowed(room, ip, req.body?.voterId);
  if (!guard.ok) return res.status(429).json({ error: guard.error });

  const result = addVote(room, { optionId: req.body?.optionId, voterId: req.body?.voterId, pollId: req.body?.pollId });
  if (!result.ok) return res.status(400).json({ error: result.error });
  if (result.changed) {
    store.scheduleSave();
    broadcast(room);
  }
  res.json({ ok: true, pollId: room.poll.id, optionId: result.optionId });
});

// --- Logo de l'evenement ----------------------------------------------------
app.put('/api/rooms/:code/logo', (req, res) => {
  const room = store.get(req.params.code);
  if (!room) return res.status(404).json({ error: 'Salle introuvable.' });
  if (!store.isOwner(room, req.body?.token)) {
    return res.status(403).json({ error: 'Reserve a la regie.' });
  }
  const limit = rateLimit('logo:' + clientIp(req), { limit: 20, windowMs: 10 * 60_000 });
  if (!limit.ok) return res.status(429).json({ error: 'Trop d envois, patientez un instant.' });

  const result = setRoomLogo(room, req.body?.dataUrl);
  if (!result.ok) return res.status(400).json({ error: result.error });
  store.scheduleSave();
  broadcast(room);
  res.json({ ok: true, version: result.version });
});

app.delete('/api/rooms/:code/logo', (req, res) => {
  const room = store.get(req.params.code);
  if (!room) return res.status(404).json({ error: 'Salle introuvable.' });
  if (!store.isOwner(room, req.body?.token)) {
    return res.status(403).json({ error: 'Reserve a la regie.' });
  }
  if (clearRoomLogo(room)) {
    store.scheduleSave();
    broadcast(room);
  }
  res.json({ ok: true });
});

app.get('/api/rooms/:code/logo', (req, res) => {
  const room = store.get(req.params.code);
  if (!room?.logo) return res.status(404).send('Aucun logo.');
  // L'URL est versionnee : le contenu d'une version donnee ne change jamais.
  res.type(room.logo.type)
    .set('Cache-Control', req.query.v ? 'public, max-age=31536000, immutable' : 'no-cache')
    .send(Buffer.from(room.logo.data, 'base64'));
});

app.get('/api/qr.svg', async (req, res) => {
  const data = String(req.query.data || '').slice(0, 900);
  if (!data) return res.status(400).send('parametre "data" requis');
  try {
    const svg = await QRCode.toString(data, {
      type: 'svg',
      errorCorrectionLevel: req.query.ecl === 'h' ? 'H' : 'M',
      margin: Number(req.query.margin ?? 1),
      color: { dark: String(req.query.dark || '#000000').slice(0, 7), light: String(req.query.light || '#ffffff').slice(0, 7) },
    });
    res.type('image/svg+xml').set('Cache-Control', 'public, max-age=300').send(svg);
  } catch (err) {
    res.status(400).send('QR impossible : ' + err.message);
  }
});

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Route inconnue.' });
  res.status(404).sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// --- WebSocket --------------------------------------------------------------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 256 * 1024 });

/** @type {Map<string, Set<import('ws').WebSocket>>} */
const roomSockets = new Map();

function join(room, ws) {
  let set = roomSockets.get(room.code);
  if (!set) roomSockets.set(room.code, (set = new Set()));
  set.add(ws);
}

function leave(code, ws) {
  const set = roomSockets.get(code);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) roomSockets.delete(code);
}

function send(ws, payload) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

function audience(room) {
  const set = roomSockets.get(room.code);
  if (!set) return { control: 0, display: 0, viewer: 0 };
  let control = 0;
  let display = 0;
  let viewer = 0;
  for (const ws of set) {
    if (ws.role === 'control') control++;
    else if (ws.role === 'display') display++;
    else viewer++;
  }
  return { control, display, viewer };
}

function stateFor(room, role) {
  const state = role === 'control' ? publicState(room) : viewerState(room);
  return { ...state, audience: audience(room) };
}

function broadcast(room) {
  const set = roomSockets.get(room.code);
  if (!set) return;
  const now = Date.now();
  for (const ws of set) {
    send(ws, { t: 'state', serverTime: now, state: stateFor(room, ws.role) });
  }
}

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.role = 'viewer';
  ws.roomCode = null;
  ws.authorized = false;
  ws.ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return send(ws, { t: 'error', code: 'bad_json', message: 'Message illisible.' });
    }
    handleMessage(ws, msg);
  });

  ws.on('close', () => {
    if (!ws.roomCode) return;
    leave(ws.roomCode, ws);
    const room = store.get(ws.roomCode);
    if (!room) return;
    // Si c'etait le dernier appareil, le delai d'inactivite repart d'ici.
    if (!roomSockets.has(room.code)) markEmpty(room);
    broadcast(room);
  });
});

function handleMessage(ws, msg) {
  const now = Date.now();
  switch (msg?.t) {
    case 'hello': {
      const room = store.get(msg.room);
      if (!room) return send(ws, { t: 'error', code: 'no_room', message: 'Salle introuvable.' });
      const wantsControl = msg.role === 'control';
      const isOwner = store.isOwner(room, msg.token);
      if (wantsControl && !isOwner) {
        return send(ws, { t: 'error', code: 'forbidden', message: 'Jeton de controle invalide.' });
      }
      // Le code d'acces vaut pour tout le monde, regie comprise. La cle de
      // regie voyage dans un QR code, que l'on projette ou que l'on
      // photographie ; le code, lui, ne quitte pas ceux a qui on le donne.
      // Prendre la main demande donc les deux.
      if (!checkAccess(room, msg.access)) {
        const attempts = rateLimit(`access:${ws.ip}`, { limit: 10, windowMs: 10 * 60_000 });
        return send(ws, {
          t: 'error',
          code: attempts.ok ? 'access_denied' : 'rate_limited',
          message: attempts.ok ? 'Code d acces requis.' : 'Trop de tentatives, patientez.',
        });
      }
      ws.ownerToken = isOwner ? room.ownerToken : null;
      ws.authorized = true;
      if (ws.roomCode && ws.roomCode !== room.code) leave(ws.roomCode, ws);
      ws.roomCode = room.code;
      ws.role = wantsControl ? 'control' : msg.role === 'display' ? 'display' : 'viewer';
      join(room, ws);
      send(ws, { t: 'welcome', serverTime: now, role: ws.role, state: stateFor(room, ws.role) });
      broadcast(room);
      return;
    }

    case 'ping':
      return send(ws, { t: 'pong', ts: msg.ts, serverTime: now });

    case 'cmd': {
      const room = store.get(ws.roomCode);
      if (!room) return send(ws, { t: 'error', code: 'no_room', message: 'Salle introuvable.' });
      if (ws.role !== 'control') {
        return send(ws, { t: 'error', code: 'forbidden', message: 'Commande reservee a la regie.' });
      }

      // Le renouvellement de cle se traite ici, et non dans applyCommand : il
      // faut savoir quelle regie l'a demande pour ne pas la deconnecter avec
      // les autres.
      if (msg.name === 'room.rotateKey') {
        const ownerToken = rotateOwnerToken(room, now);
        ws.ownerToken = ownerToken;
        send(ws, { t: 'key', ownerToken });
        for (const other of roomSockets.get(room.code) || []) {
          if (other === ws || other.role !== 'control') continue;
          send(other, { t: 'error', code: 'forbidden', message: 'Cle de regie renouvelee.' });
          other.close();
        }
        store.scheduleSave();
        broadcast(room);
        return;
      }
      const result = applyCommand(room, msg.name, msg.payload, now);
      if (!result.ok) {
        return send(ws, { t: 'error', code: 'cmd_failed', message: result.error, cmd: msg.name });
      }
      store.scheduleSave();
      broadcast(room);
      if (msg.ack) send(ws, { t: 'ack', ack: msg.ack });
      return;
    }

    case 'question': {
      const room = store.get(ws.roomCode);
      if (!room) return send(ws, { t: 'error', code: 'no_room', message: 'Salle introuvable.' });
      if (!ws.authorized) {
        return send(ws, { t: 'error', code: 'access_denied', message: 'Code d acces requis.' });
      }
      const limit = rateLimit(`qws:${room.code}:${ws.ip}`, { limit: 5, windowMs: 60_000 });
      if (!limit.ok) {
        return send(ws, { t: 'error', code: 'rate_limited', message: 'Patientez avant la prochaine question.' });
      }
      const result = addQuestion(room, { text: msg.text, author: msg.author }, now);
      if (!result.ok) return send(ws, { t: 'error', code: 'question_refused', message: result.error });
      store.scheduleSave();
      broadcast(room);
      return send(ws, { t: 'question_ok', id: result.question.id, status: result.question.status });
    }

    case 'vote': {
      const room = store.get(ws.roomCode);
      if (!room) return send(ws, { t: 'error', code: 'no_room', message: 'Salle introuvable.' });
      if (!ws.authorized) {
        return send(ws, { t: 'error', code: 'access_denied', message: 'Code d acces requis.' });
      }
      const guard = voteAllowed(room, ws.ip, msg.voterId);
      if (!guard.ok) return send(ws, { t: 'error', code: 'rate_limited', message: guard.error });
      const result = addVote(room, { optionId: msg.optionId, voterId: msg.voterId, pollId: msg.pollId }, now);
      if (!result.ok) return send(ws, { t: 'error', code: 'vote_refused', message: result.error });
      if (result.changed) {
        store.scheduleSave();
        broadcast(room);
      }
      return send(ws, { t: 'vote_ok', pollId: room.poll.id, optionId: result.optionId });
    }

    default:
      send(ws, { t: 'error', code: 'unknown', message: 'Type de message inconnu.' });
  }
}

// Surveillance des connexions mortes.
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30_000).unref();

// Boucle d'entretien : messages auto-masques, enchainement automatique.
setInterval(() => {
  const now = Date.now();
  for (const room of store.rooms.values()) {
    if (tickRoom(room, now)) {
      store.scheduleSave();
      broadcast(room);
    }
  }
}, 250).unref();

// Une salle dont un ecran est encore connecte n'est pas oubliee, meme si la
// regie n'a envoye aucune commande depuis longtemps.
setInterval(() => store.cleanup(Date.now(), (code) => (roomSockets.get(code)?.size || 0) > 0), 30 * 60_000).unref();

function shutdown(signal) {
  console.log(`[timestage] arret (${signal})`);
  store.save();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

server.listen(PORT, HOST, () => {
  console.log(`[timestage] pret sur http://localhost:${PORT}`);
  if (DATA_FILE) console.log(`[timestage] donnees : ${DATA_FILE}`);
});

export { app, server, store };

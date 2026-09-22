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
  publicState,
  viewerState,
  tickRoom,
  cleanText,
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
app.use(express.json({ limit: '256kb' }));

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
// URL courtes : QR codes plus lisibles.
app.get('/c/:code', page('control.html'));
app.get('/d/:code', page('display.html'));
app.get('/q/:code', page('ask.html'));

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
  res.json({
    code: room.code,
    name: room.session.name,
    questionsOpen: room.settings.questionsOpen,
    displayName: room.settings.displayName,
  });
});

app.post('/api/rooms/:code/questions', (req, res) => {
  const room = store.get(req.params.code);
  if (!room) return res.status(404).json({ error: 'Salle introuvable.' });
  const ip = clientIp(req);
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
    if (ws.roomCode) {
      leave(ws.roomCode, ws);
      const room = store.get(ws.roomCode);
      if (room) broadcast(room);
    }
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

setInterval(() => store.cleanup(), 30 * 60_000).unref();

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

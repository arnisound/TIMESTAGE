import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';

process.env.PORT = '0';
process.env.TIMESTAGE_DATA = 'none';

const { server } = await import('../server/index.js');

let base;
let wsBase;

before(async () => {
  await new Promise((resolve) => (server.listening ? resolve() : server.once('listening', resolve)));
  const { port } = server.address();
  base = `http://127.0.0.1:${port}`;
  wsBase = `ws://127.0.0.1:${port}/ws`;
});

after(() => server.close());

const post = (path, body) =>
  fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

/** Ouvre un client WebSocket et collecte les messages recus. */
function connect() {
  const ws = new WebSocket(wsBase);
  const queue = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(String(raw));
    const waiter = waiters.find((w) => w.match(msg));
    if (waiter) {
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(msg);
    } else {
      queue.push(msg);
    }
  });
  return {
    ws,
    open: () => new Promise((resolve) => ws.once('open', resolve)),
    send: (payload) => ws.send(JSON.stringify(payload)),
    /** Attend le prochain message correspondant au filtre. */
    next(match = () => true, timeoutMs = 3000) {
      const index = queue.findIndex(match);
      if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = { match, resolve };
        waiters.push(waiter);
        setTimeout(() => {
          if (!waiters.includes(waiter)) return;
          waiters.splice(waiters.indexOf(waiter), 1);
          reject(new Error('message attendu non recu'));
        }, timeoutMs);
      });
    },
    close: () => ws.close(),
  };
}

async function createRoom(name = 'Integration') {
  const response = await post('/api/rooms', { name });
  assert.equal(response.status, 201);
  return response.json();
}

test('GET /api/health repond', async () => {
  const response = await fetch(base + '/api/health');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
});

test('les pages principales sont servies', async () => {
  for (const path of ['/', '/control', '/display', '/ask', '/offline', '/d/ABCDE', '/q/ABCDE']) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get('content-type') || '', /text\/html/, path);
  }
});

test('le QR code est genere en SVG', async () => {
  const response = await fetch(base + '/api/qr.svg?data=' + encodeURIComponent('https://exemple.test/d/ABCDE'));
  assert.equal(response.status, 200);
  assert.match(await response.text(), /^<svg/);
  assert.equal((await fetch(base + '/api/qr.svg')).status, 400, 'sans donnees : erreur');
});

test('une salle inconnue renvoie 404', async () => {
  assert.equal((await fetch(base + '/api/rooms/ZZZZZ')).status, 404);
});

test('une salle peut etre recreee avec le meme code apres un redemarrage', async () => {
  const room = await createRoom('Reprise');

  // Code deja pris : refus, la salle en cours est protegee.
  const conflict = await post('/api/rooms', { code: room.code });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).reason, 'taken');

  // Le serveur redemarre : on simule en creant sur un code libre.
  const freeCode = 'ZK4MP';
  const recreated = await post('/api/rooms', { name: 'Reprise', code: freeCode });
  assert.equal(recreated.status, 201);
  const data = await recreated.json();
  assert.equal(data.code, freeCode);
  assert.ok(data.ownerToken);

  // Et la regie peut aussitot piloter la salle recreee.
  const control = connect();
  await control.open();
  control.send({ t: 'hello', room: freeCode, role: 'control', token: data.ownerToken });
  const welcome = await control.next((m) => m.t === 'welcome');
  assert.equal(welcome.role, 'control');
  control.close();
});

test('un code de salle invalide est refuse', async () => {
  for (const code of ['AB', 'ABCDEFGHI', 'ABC-D', 'AIOU0']) {
    const response = await post('/api/rooms', { code });
    assert.equal(response.status, 400, code);
    assert.equal((await response.json()).reason, 'invalid_code', code);
  }
});

test('le logo : envoi reserve a la regie, service et retrait', async () => {
  const room = await createRoom('Logo');
  const dataUrl = 'data:image/png;base64,' + 'A'.repeat(200);
  const put = (body) =>
    fetch(`${base}/api/rooms/${room.code}/logo`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  assert.equal((await put({ dataUrl })).status, 403, 'sans jeton : refuse');
  assert.equal((await put({ token: 'faux', dataUrl })).status, 403);
  assert.equal((await put({ token: room.ownerToken, dataUrl: 'data:text/html;base64,AA' })).status, 400);

  const ok = await put({ token: room.ownerToken, dataUrl });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).version, 1);

  const image = await fetch(`${base}/api/rooms/${room.code}/logo?v=1`);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/png');
  assert.match(image.headers.get('cache-control'), /immutable/);
  assert.ok((await image.arrayBuffer()).byteLength > 100);

  const removed = await fetch(`${base}/api/rooms/${room.code}/logo`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: room.ownerToken }),
  });
  assert.equal(removed.status, 200);
  assert.equal((await fetch(`${base}/api/rooms/${room.code}/logo`)).status, 404);
});

test('la regie pilote, l affichage suit', async () => {
  const room = await createRoom('Demo');

  const control = connect();
  await control.open();
  control.send({ t: 'hello', room: room.code, role: 'control', token: room.ownerToken });
  const welcome = await control.next((m) => m.t === 'welcome');
  assert.equal(welcome.role, 'control');
  assert.equal(welcome.state.ownerToken, undefined);

  const display = connect();
  await display.open();
  display.send({ t: 'hello', room: room.code, role: 'display' });
  await display.next((m) => m.t === 'welcome');

  control.send({ t: 'cmd', name: 'timer.setDuration', payload: { ms: 120000 } });
  control.send({ t: 'cmd', name: 'timer.start' });
  const state = await display.next((m) => m.t === 'state' && m.state.timer.running);
  assert.equal(state.state.timer.durationMs, 120000);
  assert.ok(state.serverTime > 0);

  control.close();
  display.close();
});

test('la synchronisation d horloge repond au ping', async () => {
  const room = await createRoom();
  const client = connect();
  await client.open();
  client.send({ t: 'hello', room: room.code, role: 'display' });
  await client.next((m) => m.t === 'welcome');
  client.send({ t: 'ping', ts: 12345 });
  const pong = await client.next((m) => m.t === 'pong');
  assert.equal(pong.ts, 12345);
  assert.ok(Math.abs(pong.serverTime - Date.now()) < 5000);
  client.close();
});

test('un client sans jeton ne peut pas prendre la regie', async () => {
  const room = await createRoom();
  const intrus = connect();
  await intrus.open();
  intrus.send({ t: 'hello', room: room.code, role: 'control', token: 'faux' });
  const error = await intrus.next((m) => m.t === 'error');
  assert.equal(error.code, 'forbidden');
  intrus.close();
});

test('un spectateur ne peut pas envoyer de commande', async () => {
  const room = await createRoom();
  const viewer = connect();
  await viewer.open();
  viewer.send({ t: 'hello', room: room.code, role: 'display' });
  await viewer.next((m) => m.t === 'welcome');
  viewer.send({ t: 'cmd', name: 'timer.start' });
  const error = await viewer.next((m) => m.t === 'error');
  assert.equal(error.code, 'forbidden');
  viewer.close();
});

test('question du public : moderation puis affichage', async () => {
  const room = await createRoom();

  const control = connect();
  await control.open();
  control.send({ t: 'hello', room: room.code, role: 'control', token: room.ownerToken });
  await control.next((m) => m.t === 'welcome');

  const display = connect();
  await display.open();
  display.send({ t: 'hello', room: room.code, role: 'display' });
  await display.next((m) => m.t === 'welcome');

  const response = await post(`/api/rooms/${room.code}/questions`, { text: 'Comment financez-vous le projet ?', author: 'Sam' });
  assert.equal(response.status, 201);
  const { id } = await response.json();

  const controlState = await control.next((m) => m.t === 'state' && m.state.questions.length === 1);
  assert.equal(controlState.state.questions[0].status, 'pending');

  const displayState = await display.next((m) => m.t === 'state');
  assert.equal(displayState.state.questions.length, 0, "l'affichage ne voit pas les questions en attente");

  control.send({ t: 'cmd', name: 'question.show', payload: { id } });
  const shown = await display.next((m) => m.t === 'state' && m.state.questions.length === 1);
  assert.equal(shown.state.questions[0].text, 'Comment financez-vous le projet ?');

  control.close();
  display.close();
});

test('les questions sont limitees en debit', async () => {
  const room = await createRoom();
  const codes = [];
  for (let i = 0; i < 7; i++) {
    const response = await post(`/api/rooms/${room.code}/questions`, { text: `Question numero ${i} ?` });
    codes.push(response.status);
  }
  assert.ok(codes.includes(429), 'la sixieme question doit etre refusee');
});

test('un message JSON invalide ne fait pas tomber le serveur', async () => {
  const client = connect();
  await client.open();
  client.ws.send('ceci n est pas du json');
  const error = await client.next((m) => m.t === 'error');
  assert.equal(error.code, 'bad_json');
  client.close();
});

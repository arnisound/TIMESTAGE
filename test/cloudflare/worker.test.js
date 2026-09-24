/*!
 * TimeStage, chronometre de scene
 * © 2026 Arnisound Tools (Theo Arnissolle). Tous droits reserves.
 */
// Parite entre le serveur Node et le Worker Cloudflare : les memes parcours,
// joues contre le runtime Cloudflare reel (workerd, via wrangler dev).
//
// Ce fichier ne fait pas partie de `npm test` : il demande le runtime
// Cloudflare et met une dizaine de secondes a demarrer. Il se lance avec
// `npm run test:worker`.

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';

const PORT = 8791;
const base = `http://127.0.0.1:${PORT}`;
let server;

before(async () => {
  server = spawn('npx', ['wrangler', 'dev', '--port', String(PORT), '--local', '--ip', '127.0.0.1'], {
    cwd: new URL('../..', import.meta.url).pathname,
    stdio: 'ignore',
  });
  const deadline = Date.now() + 90_000;
  for (;;) {
    try {
      const response = await fetch(base + '/api/health');
      if (response.ok) return;
    } catch { /* pas encore pret */ }
    if (Date.now() > deadline) throw new Error('wrangler dev n a pas demarre');
    await new Promise((r) => setTimeout(r, 1000));
  }
});

after(() => server?.kill());

const post = (path, body) =>
  fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

function connect(code) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?room=${code}`);
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
    open: () => new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    }),
    send: (payload) => ws.send(JSON.stringify(payload)),
    next(match = () => true, timeoutMs = 8000) {
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

async function createRoom(name = 'Cloudflare') {
  const response = await post('/api/rooms', { name });
  assert.equal(response.status, 201);
  return response.json();
}

test('le Worker sert les pages et les fichiers partages', async () => {
  for (const path of ['/', '/control', '/display', '/ask', '/offline', '/legal', '/d/ABCDE', '/q/ABCDE', '/k/ABCDE', '/c/ABCDE']) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get('content-type') || '', /text\/html/, path);
  }
  const shared = await fetch(base + '/shared/timer.js');
  assert.equal(shared.status, 200);
  assert.match(await shared.text(), /export function sanitizeTimer/);
});

test('le QR code est genere par le Worker', async () => {
  const response = await fetch(base + '/api/qr.svg?data=' + encodeURIComponent('https://exemple.test/d/ABCDE'));
  assert.equal(response.status, 200);
  assert.match(await response.text(), /^<svg/);
  assert.equal((await fetch(base + '/api/qr.svg')).status, 400);
});

test('une salle inconnue reste introuvable', async () => {
  assert.equal((await fetch(base + '/api/rooms/ZZZZZ')).status, 404);
});

test('la regie pilote, l affichage suit', async () => {
  const room = await createRoom();

  const control = connect(room.code);
  await control.open();
  control.send({ t: 'hello', room: room.code, role: 'control', token: room.ownerToken });
  const welcome = await control.next((m) => m.t === 'welcome');
  assert.equal(welcome.role, 'control');

  const display = connect(room.code);
  await display.open();
  display.send({ t: 'hello', room: room.code, role: 'display' });
  await display.next((m) => m.t === 'welcome');

  control.send({ t: 'cmd', name: 'timer.setDuration', payload: { ms: 90_000 } });
  const duree = await display.next((m) => m.t === 'state' && m.state.timer.durationMs === 90_000);
  assert.equal(duree.state.timer.running, false);

  control.send({ t: 'cmd', name: 'timer.start' });
  const marche = await display.next((m) => m.t === 'state' && m.state.timer.running);
  assert.ok(marche.state.timer.startedAt > 0);
  assert.ok(marche.serverTime > 0, "l'horloge de reference est diffusee");

  control.close();
  display.close();
});

test('la synchronisation d horloge repond au ping', async () => {
  const room = await createRoom();
  const client = connect(room.code);
  await client.open();
  client.send({ t: 'hello', room: room.code, role: 'display' });
  await client.next((m) => m.t === 'welcome');
  const ts = Date.now();
  client.send({ t: 'ping', ts });
  const pong = await client.next((m) => m.t === 'pong');
  assert.equal(pong.ts, ts);
  assert.ok(Math.abs(pong.serverTime - Date.now()) < 5000, "l'heure du Worker suit l'heure reelle");
  client.close();
});

test('un spectateur ne peut pas prendre la regie ni commander', async () => {
  const room = await createRoom();
  const pirate = connect(room.code);
  await pirate.open();
  pirate.send({ t: 'hello', room: room.code, role: 'control', token: 'faux-jeton' });
  const refus = await pirate.next((m) => m.t === 'error');
  assert.equal(refus.code, 'forbidden');

  pirate.send({ t: 'hello', room: room.code, role: 'viewer' });
  await pirate.next((m) => m.t === 'welcome');
  pirate.send({ t: 'cmd', name: 'timer.start' });
  const refus2 = await pirate.next((m) => m.t === 'error');
  assert.equal(refus2.code, 'forbidden');
  pirate.close();
});

test('question du public : moderation puis affichage', async () => {
  const room = await createRoom();
  const control = connect(room.code);
  await control.open();
  control.send({ t: 'hello', room: room.code, role: 'control', token: room.ownerToken });
  await control.next((m) => m.t === 'welcome');

  const display = connect(room.code);
  await display.open();
  display.send({ t: 'hello', room: room.code, role: 'display' });
  await display.next((m) => m.t === 'welcome');

  const response = await post(`/api/rooms/${room.code}/questions`, { text: 'Quelle marque de micro ?', author: 'Sam' });
  assert.equal(response.status, 201);
  const { id } = await response.json();

  const attente = await control.next((m) => m.t === 'state' && m.state.questions.length === 1);
  assert.equal(attente.state.questions[0].status, 'pending');

  const vu = await display.next((m) => m.t === 'state');
  assert.equal(vu.state.questions.length, 0, "l'affichage ne voit pas les questions en attente");

  control.send({ t: 'cmd', name: 'question.show', payload: { id } });
  const montree = await display.next((m) => m.t === 'state' && m.state.questions.length === 1);
  assert.equal(montree.state.questions[0].text, 'Quelle marque de micro ?');

  control.close();
  display.close();
});

test('sondage : vote, changement d avis et ouverture des resultats', async () => {
  const room = await createRoom();
  const control = connect(room.code);
  await control.open();
  control.send({ t: 'hello', room: room.code, role: 'control', token: room.ownerToken });
  await control.next((m) => m.t === 'welcome');

  control.send({ t: 'cmd', name: 'poll.set', payload: { question: 'On prolonge ?', options: ['Oui', 'Non'] } });
  const lance = await control.next((m) => m.t === 'state' && m.state.poll);
  const [oui, non] = lance.state.poll.options;

  const votant = connect(room.code);
  await votant.open();
  votant.send({ t: 'hello', room: room.code, role: 'viewer' });
  await votant.next((m) => m.t === 'welcome');

  votant.send({ t: 'vote', pollId: lance.state.poll.id, optionId: oui.id, voterId: 'tel-1' });
  await votant.next((m) => m.t === 'vote_ok');
  const compte = await control.next((m) => m.t === 'state' && m.state.poll?.options[0].votes === 1);
  assert.equal(compte.state.poll.resultsVisible, true, 'la regie depouille en direct');

  const masque = await votant.next((m) => m.t === 'state' && m.state.poll?.voterCount === 1);
  assert.equal(masque.state.poll.options[0].votes, 0, 'le public ne voit pas les chiffres');

  votant.send({ t: 'vote', pollId: lance.state.poll.id, optionId: non.id, voterId: 'tel-1' });
  await votant.next((m) => m.t === 'vote_ok' && m.optionId === non.id);
  const bascule = await control.next((m) => m.t === 'state' && m.state.poll?.options[1].votes === 1);
  assert.equal(bascule.state.poll.options[0].votes, 0, 'la voix a change de camp');

  control.send({ t: 'cmd', name: 'poll.reveal', payload: { reveal: true } });
  const revele = await votant.next((m) => m.t === 'state' && m.state.poll?.resultsVisible);
  assert.equal(revele.state.poll.options[1].votes, 1);

  control.close();
  votant.close();
});

test('une salle protegee filtre tout le monde sauf la regie', async () => {
  const room = await createRoom();
  const control = connect(room.code);
  await control.open();
  control.send({ t: 'hello', room: room.code, role: 'control', token: room.ownerToken });
  await control.next((m) => m.t === 'welcome');
  control.send({ t: 'cmd', name: 'room.setAccessCode', payload: { code: 'decibel2026' } });
  await control.next((m) => m.t === 'state' && m.state.hasAccessCode);

  // La salle ne revele plus rien.
  const info = await (await fetch(`${base}/api/rooms/${room.code}`)).json();
  assert.equal(info.protected, true);
  assert.equal(info.name, undefined);

  const sans = connect(room.code);
  await sans.open();
  sans.send({ t: 'hello', room: room.code, role: 'display' });
  const refus = await sans.next((m) => m.t === 'error');
  assert.equal(refus.code, 'access_denied');

  const avec = connect(room.code);
  await avec.open();
  avec.send({ t: 'hello', room: room.code, role: 'display', access: 'decibel2026' });
  await avec.next((m) => m.t === 'welcome');

  assert.equal((await post(`/api/rooms/${room.code}/questions`, { text: 'Sans le code ?' })).status, 403);
  assert.equal((await post(`/api/rooms/${room.code}/questions`, { text: 'Avec le code ?', access: 'decibel2026' })).status, 201);

  control.close();
  sans.close();
  avec.close();
});

test('renouveler la cle ejecte les autres regies, pas celle qui demande', async () => {
  const room = await createRoom();
  const premiere = connect(room.code);
  await premiere.open();
  premiere.send({ t: 'hello', room: room.code, role: 'control', token: room.ownerToken });
  await premiere.next((m) => m.t === 'welcome');

  const seconde = connect(room.code);
  await seconde.open();
  seconde.send({ t: 'hello', room: room.code, role: 'control', token: room.ownerToken });
  await seconde.next((m) => m.t === 'welcome');

  premiere.send({ t: 'cmd', name: 'room.rotateKey' });
  const cle = await premiere.next((m) => m.t === 'key');
  assert.notEqual(cle.ownerToken, room.ownerToken);

  const ejectee = await seconde.next((m) => m.t === 'error');
  assert.equal(ejectee.code, 'forbidden');

  // Celle qui a demande garde la main.
  premiere.send({ t: 'cmd', name: 'timer.start' });
  const suite = await premiere.next((m) => m.t === 'state' && m.state.timer.running);
  assert.equal(suite.state.timer.running, true);

  premiere.close();
  seconde.close();
});

test('le logo fait l aller-retour par le Durable Object', async () => {
  const room = await createRoom();
  // 1 pixel PNG transparent.
  const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  assert.equal((await fetch(`${base}/api/rooms/${room.code}/logo`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dataUrl, token: 'faux' }),
  })).status, 403, 'le logo est reserve a la regie');

  const envoi = await fetch(`${base}/api/rooms/${room.code}/logo`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dataUrl, token: room.ownerToken }),
  });
  assert.equal(envoi.status, 200);

  const image = await fetch(`${base}/api/rooms/${room.code}/logo?v=1`);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/png');
  assert.ok((await image.arrayBuffer()).byteLength > 20);

  const retrait = await fetch(`${base}/api/rooms/${room.code}/logo`, {
    method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: room.ownerToken }),
  });
  assert.equal(retrait.status, 200);
  assert.equal((await fetch(`${base}/api/rooms/${room.code}/logo`)).status, 404);
});

test('une salle survit a la fermeture de tous les ecrans', async () => {
  const room = await createRoom('Persistance');
  const control = connect(room.code);
  await control.open();
  control.send({ t: 'hello', room: room.code, role: 'control', token: room.ownerToken });
  await control.next((m) => m.t === 'welcome');
  control.send({ t: 'cmd', name: 'timer.setTitle', payload: { title: 'Ouverture' } });
  await control.next((m) => m.t === 'state' && m.state.timer.title === 'Ouverture');
  control.close();

  await new Promise((r) => setTimeout(r, 500));

  // Plus personne n'est connecte : l'etat doit venir du stockage.
  const retour = connect(room.code);
  await retour.open();
  retour.send({ t: 'hello', room: room.code, role: 'display' });
  const welcome = await retour.next((m) => m.t === 'welcome');
  assert.equal(welcome.state.timer.title, 'Ouverture');
  assert.equal(welcome.state.session.name, 'Persistance');
  retour.close();
});

test('un code deja pris est refuse, un code libre est accepte', async () => {
  const room = await createRoom();
  const doublon = await post('/api/rooms', { code: room.code });
  assert.equal(doublon.status, 409);
  // Le stockage local de wrangler survit d'une execution a l'autre : un code
  // fixe serait deja pris au deuxieme lancement.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const choisi = Array.from({ length: 5 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
  const libre = await post('/api/rooms', { code: choisi, name: 'Reprise' });
  assert.equal(libre.status, 201);
  assert.equal((await libre.json()).code, choisi);
  assert.equal((await post('/api/rooms', { code: 'iii' })).status, 400);
});

test('le message a masquage automatique disparait tout seul', async () => {
  const room = await createRoom();
  const control = connect(room.code);
  await control.open();
  control.send({ t: 'hello', room: room.code, role: 'control', token: room.ownerToken });
  await control.next((m) => m.t === 'welcome');

  control.send({ t: 'cmd', name: 'message.send', payload: { text: 'Trois secondes', autoHideMs: 1200 } });
  await control.next((m) => m.t === 'state' && m.state.message.visible);

  // C'est l'alarme du Durable Object qui doit le masquer, sans boucle.
  const masque = await control.next(
    (m) => m.t === 'state' && m.state.message.text === 'Trois secondes' && m.state.message.visible === false,
    10_000
  );
  assert.ok(masque.serverTime > 0, "c'est bien l'alarme qui a rendu la main");
  control.close();
});

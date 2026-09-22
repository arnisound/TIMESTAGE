import test from 'node:test';
import assert from 'node:assert/strict';

import { RoomStore, applyCommand, addQuestion, viewerState, publicState, tickRoom, cleanText } from '../server/rooms.js';
import { MS } from '../shared/time.js';

const newRoom = () => new RoomStore().create('Test');

test('une salle recoit un code lisible et un jeton secret', () => {
  const room = newRoom();
  assert.match(room.code, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5}$/);
  assert.ok(room.ownerToken.length >= 20);
  assert.equal(publicState(room).ownerToken, undefined, 'le jeton ne sort jamais dans un etat public');
});

test('cleanText retire les caracteres de controle et tronque', () => {
  assert.equal(cleanText('  bonjour\u0000\u0007  '), 'bonjour');
  assert.equal(cleanText('a'.repeat(50), 10).length, 10);
  assert.equal(cleanText('ligne1\nligne2', 100, { multiline: true }), 'ligne1\nligne2');
  assert.equal(cleanText('ligne1\nligne2'), 'ligne1 ligne2');
});

test('les commandes inconnues sont refusees', () => {
  const room = newRoom();
  const result = applyCommand(room, 'timer.explode', {});
  assert.equal(result.ok, false);
});

test('chargement d une partie : duree, titre et remise a zero', () => {
  const room = newRoom();
  applyCommand(room, 'session.parts.add', { part: { title: 'Intro', speaker: 'Ana', durationMs: 3 * MS.m } });
  applyCommand(room, 'session.parts.add', { part: { title: 'Debat', durationMs: 20 * MS.m } });
  const [intro, debat] = room.session.parts;

  applyCommand(room, 'session.load', { id: intro.id, autostart: true });
  assert.equal(room.timer.durationMs, 3 * MS.m);
  assert.equal(room.timer.title, 'Intro');
  assert.equal(room.timer.speaker, 'Ana');
  assert.equal(room.timer.running, true);

  applyCommand(room, 'session.next', {});
  assert.equal(room.session.activeId, debat.id);
  assert.equal(room.session.parts[0].done, true, 'la partie precedente est marquee terminee');
  assert.equal(room.timer.running, false, 'la partie suivante attend le top depart');

  assert.equal(applyCommand(room, 'session.next', {}).ok, false, 'pas de partie suivante');
});

test('reordonner et supprimer une partie', () => {
  const room = newRoom();
  for (const title of ['A', 'B', 'C']) applyCommand(room, 'session.parts.add', { part: { title, durationMs: MS.m } });
  const [a, b] = room.session.parts;

  applyCommand(room, 'session.parts.move', { id: b.id, index: 0 });
  assert.deepEqual(room.session.parts.map((p) => p.title), ['B', 'A', 'C']);

  applyCommand(room, 'session.parts.remove', { id: a.id });
  assert.deepEqual(room.session.parts.map((p) => p.title), ['B', 'C']);
});

test('les questions passent par la moderation avant affichage', () => {
  const room = newRoom();
  const { ok, question } = addQuestion(room, { text: 'Quel est votre budget ?', author: 'Lou' });
  assert.equal(ok, true);
  assert.equal(question.status, 'pending');

  // Tant que la regie n'a rien valide, l'affichage ne voit aucune question.
  assert.equal(viewerState(room).questions.length, 0);

  applyCommand(room, 'question.show', { id: question.id });
  assert.equal(room.shownQuestionId, question.id);
  assert.equal(viewerState(room).questions.length, 1);

  applyCommand(room, 'question.hide', {});
  assert.equal(viewerState(room).questions.length, 0);

  applyCommand(room, 'question.setStatus', { id: question.id, status: 'rejected' });
  assert.equal(room.questions[0].status, 'rejected');
});

test('les questions fermees ou trop courtes sont refusees', () => {
  const room = newRoom();
  assert.equal(addQuestion(room, { text: 'ok' }).ok, false, 'trop court');
  applyCommand(room, 'settings.update', { patch: { questionsOpen: false } });
  assert.equal(addQuestion(room, { text: 'Une vraie question ?' }).ok, false, 'questions fermees');
});

test('les doublons rapides sont ecartes', () => {
  const room = newRoom();
  assert.equal(addQuestion(room, { text: 'Meme question' }).ok, true);
  assert.equal(addQuestion(room, { text: 'meme question' }).ok, false);
});

test('sans validation obligatoire, la question est directement approuvee', () => {
  const room = newRoom();
  applyCommand(room, 'settings.update', { patch: { requireApproval: false } });
  assert.equal(addQuestion(room, { text: 'Question libre ?' }).question.status, 'approved');
});

test('un message peut se masquer tout seul', () => {
  const room = newRoom();
  const now = Date.now();
  applyCommand(room, 'message.send', { text: 'Merci de conclure', style: 'warn', autoHideMs: 5000 }, now);
  assert.equal(room.message.visible, true);

  assert.equal(tickRoom(room, now + 1000), false);
  assert.equal(tickRoom(room, now + 5001), true);
  assert.equal(room.message.visible, false);
});

test('l enchainement automatique passe a la partie suivante a zero', () => {
  const room = newRoom();
  const now = Date.now();
  applyCommand(room, 'session.parts.add', { part: { title: 'A', durationMs: 10 * MS.s } });
  applyCommand(room, 'session.parts.add', { part: { title: 'B', durationMs: 5 * MS.m } });
  applyCommand(room, 'session.set', { autoAdvance: true });
  applyCommand(room, 'session.load', { id: room.session.parts[0].id, autostart: true }, now);

  assert.equal(tickRoom(room, now + 5 * MS.s), false);
  assert.equal(tickRoom(room, now + 11 * MS.s), true);
  assert.equal(room.timer.title, 'B');
  assert.equal(room.timer.running, true);
});

test('settings.update ignore les cles inconnues', () => {
  const room = newRoom();
  applyCommand(room, 'settings.update', { patch: { theme: 'light', piratage: true } });
  assert.equal(room.settings.theme, 'light');
  assert.equal(room.settings.piratage, undefined);
});

test('room.reset remet le chrono et les marques a zero', () => {
  const room = newRoom();
  applyCommand(room, 'session.parts.add', { part: { title: 'A', durationMs: MS.m } });
  applyCommand(room, 'session.load', { id: room.session.parts[0].id, autostart: true });
  applyCommand(room, 'message.send', { text: 'Coucou' });
  applyCommand(room, 'room.reset', {});
  assert.equal(room.timer.running, false);
  assert.equal(room.message.visible, false);
  assert.equal(room.session.activeId, null);
  assert.equal(room.session.parts[0].done, false);
});

test('le magasin verifie le jeton et purge les vieilles salles', () => {
  const store = new RoomStore({ ttlMs: 1000 });
  const room = store.create();
  assert.equal(store.isOwner(room, room.ownerToken), true);
  assert.equal(store.isOwner(room, 'faux-jeton'), false);
  assert.equal(store.isOwner(room, ''), false);

  assert.equal(store.cleanup(Date.now()), 0);
  assert.equal(store.cleanup(Date.now() + 5000), 1);
  assert.equal(store.get(room.code), null);
});

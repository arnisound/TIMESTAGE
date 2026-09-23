import test from 'node:test';
import assert from 'node:assert/strict';

import { RoomStore, applyCommand, addQuestion, viewerState, publicState, tickRoom, cleanText, normalizeCode, applySettings, defaultSettings, setRoomLogo, clearRoomLogo, setAccessCode, checkAccess, rotateOwnerToken } from '../server/rooms.js';
import { MS } from '../shared/time.js';

const newRoom = () => new RoomStore().create('Test').room;

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
  const room = store.create().room;
  assert.equal(store.isOwner(room, room.ownerToken), true);
  assert.equal(store.isOwner(room, 'faux-jeton'), false);
  assert.equal(store.isOwner(room, ''), false);

  assert.equal(store.cleanup(Date.now()), 0);
  assert.equal(store.cleanup(Date.now() + 5000), 1);
  assert.equal(store.get(room.code), null);
});

test('une salle peut etre recreee avec le meme code apres un redemarrage', () => {
  const store = new RoomStore();
  const first = store.create('Conference').room;
  const code = first.code;

  // Le serveur redemarre : la salle disparait.
  store.delete(code);
  assert.equal(store.get(code), null);

  const again = store.create('Conference', code);
  assert.equal(again.ok, true);
  assert.equal(again.room.code, code, 'les QR codes deja distribues restent valables');
  assert.notEqual(again.room.ownerToken, first.ownerToken, 'une nouvelle cle de regie est emise');
});

test('un code deja pris ou invalide est refuse', () => {
  const store = new RoomStore();
  const room = store.create().room;

  const taken = store.create('', room.code);
  assert.equal(taken.ok, false);
  assert.equal(taken.reason, 'taken');

  for (const bad of ['', 'AB', 'ABCDEFGHI', 'ABC-D', 'AIOU0', null]) {
    const result = store.create('', bad);
    if (bad === null) {
      assert.equal(result.ok, true, 'null veut dire "code au hasard"');
    } else {
      assert.equal(result.ok, false, 'devrait refuser : ' + JSON.stringify(bad));
      assert.equal(result.reason, 'invalid_code');
    }
  }
});

test('normalizeCode accepte la casse et les espaces', () => {
  assert.equal(normalizeCode(' abcde '), 'ABCDE');
  assert.equal(normalizeCode('a2c4e'), 'A2C4E');
  assert.equal(normalizeCode('abc'), null);
});

const pngDataUrl = (bytes = 100) => 'data:image/png;base64,' + 'A'.repeat(Math.ceil((bytes * 4) / 3));

test('les reglages numeriques sont bornes, les enums verifies', () => {
  const settings = defaultSettings();

  applySettings(settings, { timerScale: 9, textScale: -3, logoSize: 200, logoOpacity: 0 });
  assert.equal(settings.timerScale, 1.6, 'plafonne');
  assert.equal(settings.textScale, 0.5, 'plancher');
  assert.equal(settings.logoSize, 60);
  assert.equal(settings.logoOpacity, 10);

  applySettings(settings, { timerAlign: 'top', logoPosition: 'center', theme: 'contrast' });
  assert.equal(settings.timerAlign, 'top');
  assert.equal(settings.logoPosition, 'center');
  assert.equal(settings.theme, 'contrast');

  // Valeurs hors liste : l'ancienne est conservee.
  applySettings(settings, { timerAlign: 'diagonale', theme: 'neon', logoMode: 'video' });
  assert.equal(settings.timerAlign, 'top');
  assert.equal(settings.theme, 'contrast');
  assert.equal(settings.logoMode, 'none');

  // Valeurs non numeriques ignorees.
  applySettings(settings, { timerScale: 'grand' });
  assert.equal(settings.timerScale, 1.6);
});

test('applySettings ignore les cles hors schema', () => {
  const settings = defaultSettings();
  applySettings(settings, { ownerToken: 'vole', piratage: true, showTitle: false });
  assert.equal(settings.ownerToken, undefined);
  assert.equal(settings.piratage, undefined);
  assert.equal(settings.showTitle, false);
});

test('le logo est stocke hors de l etat diffuse', () => {
  const room = newRoom();
  assert.equal(publicState(room).logoUrl, '');

  const result = setRoomLogo(room, pngDataUrl());
  assert.equal(result.ok, true);
  assert.equal(result.version, 1);
  assert.equal(room.settings.logoMode, 'custom', 'le mode bascule automatiquement');

  const state = publicState(room);
  assert.equal(state.logo, undefined, 'le binaire ne part jamais dans l etat');
  assert.match(state.logoUrl, new RegExp(`/api/rooms/${room.code}/logo\\?v=1$`));

  // Un nouvel envoi incremente la version : l'URL change, le cache suit.
  assert.equal(setRoomLogo(room, pngDataUrl()).version, 2);
  assert.match(publicState(room).logoUrl, /v=2$/);

  assert.equal(clearRoomLogo(room), true);
  assert.equal(publicState(room).logoUrl, '');
  assert.equal(room.settings.logoMode, 'none', 'le mode revient a aucun');
  assert.equal(clearRoomLogo(room), false, 'rien a retirer la seconde fois');
});

test('le logo refuse les formats et les tailles hors limites', () => {
  const room = newRoom();
  assert.equal(setRoomLogo(room, 'data:text/html;base64,AAAA').ok, false);
  assert.equal(setRoomLogo(room, 'pas une data url').ok, false);
  assert.equal(setRoomLogo(room, '').ok, false);
  assert.equal(setRoomLogo(room, pngDataUrl(500 * 1024)).ok, false, 'trop lourd');
  assert.equal(setRoomLogo(room, 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=').ok, true);
});

test('le code d acces protege la salle sans jamais etre expose', () => {
  const room = newRoom();
  assert.equal(checkAccess(room, ''), true, 'salle ouverte par defaut');
  assert.equal(publicState(room).hasAccessCode, false);

  assert.equal(setAccessCode(room, 'abc').ok, false, 'trop court');
  assert.equal(setAccessCode(room, 'x'.repeat(40)).ok, false, 'trop long');

  assert.equal(setAccessCode(room, 'decibel2026').ok, true);
  assert.equal(checkAccess(room, 'decibel2026'), true);
  assert.equal(checkAccess(room, 'Decibel2026'), false, 'sensible a la casse');
  assert.equal(checkAccess(room, ''), false);
  assert.equal(checkAccess(room, null), false);
  assert.equal(checkAccess(room, ' decibel2026 '), true, 'espaces ignores');

  // Ni le secret ni son empreinte ne sortent dans l'etat.
  const state = publicState(room);
  assert.equal(state.access, undefined);
  assert.equal(state.hasAccessCode, true);
  assert.equal(JSON.stringify(state).includes('decibel2026'), false);
  assert.equal(JSON.stringify(state).includes(room.access.hash), false);
  assert.equal(JSON.stringify(viewerState(room)).includes(room.access.salt), false);

  // Le stockage est hache et sale.
  assert.notEqual(room.access.hash, 'decibel2026');
  assert.equal(room.access.hash.length, 64);
  const other = newRoom();
  setAccessCode(other, 'decibel2026');
  assert.notEqual(other.access.hash, room.access.hash, 'deux sels, deux empreintes');

  assert.equal(setAccessCode(room, '').ok, true);
  assert.equal(checkAccess(room, ''), true, 'salle rouverte');
});

test('renouveler la cle de regie invalide l ancienne', () => {
  const store = new RoomStore();
  const room = store.create().room;
  const first = room.ownerToken;

  const second = rotateOwnerToken(room);
  assert.notEqual(second, first);
  assert.equal(store.isOwner(room, first), false, 'l ancienne cle ne vaut plus rien');
  assert.equal(store.isOwner(room, second), true);
  assert.equal(publicState(room).ownerToken, undefined);
});

test('la commande de regie pose et retire le code d acces', () => {
  const room = newRoom();
  assert.equal(applyCommand(room, 'room.setAccessCode', { code: 'scene-2026' }).ok, true);
  assert.equal(checkAccess(room, 'scene-2026'), true);
  assert.equal(applyCommand(room, 'room.setAccessCode', { code: 'no' }).ok, false, 'trop court : refuse');
  assert.equal(checkAccess(room, 'scene-2026'), true, 'l ancien code tient toujours');
});

test('les couleurs du chrono sont validees, le vide vaut « couleur du theme »', () => {
  const settings = defaultSettings();
  assert.equal(settings.colorNormal, '', 'aucune couleur imposee par defaut');

  applySettings(settings, { colorNormal: '#FF8800', colorWrapUp: '#00b140' });
  assert.equal(settings.colorNormal, '#ff8800', 'normalise en minuscules');
  assert.equal(settings.colorWrapUp, '#00b140');

  // Tout ce qui n'est pas #rrggbb est ignore : la couleur en place tient.
  for (const bad of ['rouge', '#abc', 'ff8800', '#gggggg', 'rgb(1,2,3)', 42, null]) {
    applySettings(settings, { colorNormal: bad });
    assert.equal(settings.colorNormal, '#ff8800', 'refuse : ' + JSON.stringify(bad));
  }

  // La chaine vide est acceptee : elle rend la main au theme.
  applySettings(settings, { colorNormal: '' });
  assert.equal(settings.colorNormal, '');
});

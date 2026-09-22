import test from 'node:test';
import assert from 'node:assert/strict';

import * as T from '../shared/timer.js';
import { MS } from '../shared/time.js';

const T0 = 1_700_000_000_000;

test('demarrage, pause et reprise conservent le temps ecoule', () => {
  let timer = T.defaultTimer();
  timer = T.start(timer, T0);
  assert.equal(T.elapsedOf(timer, T0 + 10 * MS.s), 10 * MS.s);

  timer = T.pause(timer, T0 + 10 * MS.s);
  assert.equal(timer.running, false);
  // Le temps ne bouge plus en pause.
  assert.equal(T.elapsedOf(timer, T0 + 60 * MS.s), 10 * MS.s);

  timer = T.start(timer, T0 + 60 * MS.s);
  assert.equal(T.elapsedOf(timer, T0 + 70 * MS.s), 20 * MS.s);
});

test('compte a rebours : restant, seuils et depassement', () => {
  let timer = { ...T.defaultTimer(), durationMs: 60 * MS.s, wrapUpMs: 30 * MS.s, finalMs: 10 * MS.s };
  timer = T.start(timer, T0);

  assert.equal(T.readTimer(timer, T0).phase, 'running');
  assert.equal(T.readTimer(timer, T0 + 35 * MS.s).phase, 'wrapup');
  assert.equal(T.readTimer(timer, T0 + 55 * MS.s).phase, 'final');

  const over = T.readTimer(timer, T0 + 70 * MS.s);
  assert.equal(over.phase, 'overrun');
  assert.equal(over.negative, true);
  assert.equal(over.remainingMs, -10 * MS.s);
  assert.equal(over.displayMs, 10 * MS.s);
});

test('depassement desactive : le chrono se fige a zero', () => {
  let timer = { ...T.defaultTimer(), durationMs: 10 * MS.s, overrun: false };
  timer = T.start(timer, T0);
  const view = T.readTimer(timer, T0 + 25 * MS.s);
  assert.equal(view.remainingMs, 0);
  assert.equal(view.negative, false);
});

test('chronometre : progression vers un objectif', () => {
  let timer = { ...T.defaultTimer(), mode: 'countup', durationMs: 60 * MS.s };
  timer = T.start(timer, T0);
  const view = T.readTimer(timer, T0 + 30 * MS.s);
  assert.equal(view.displayMs, 30 * MS.s);
  assert.equal(view.progress, 0.5);
});

test('addTime modifie la duree, seek decale le temps ecoule', () => {
  let timer = T.start({ ...T.defaultTimer(), durationMs: 5 * MS.m }, T0);
  timer = T.addTime(timer, T0, 60 * MS.s);
  assert.equal(timer.durationMs, 6 * MS.m);

  timer = T.seek(timer, T0 + 30 * MS.s, 10 * MS.s);
  assert.equal(T.elapsedOf(timer, T0 + 30 * MS.s), 40 * MS.s);
  assert.equal(timer.running, true, 'le chrono reste en marche apres un decalage');

  // Un recul ne passe jamais sous zero.
  timer = T.seek(timer, T0 + 30 * MS.s, -10 * MS.m);
  assert.equal(T.elapsedOf(timer, T0 + 30 * MS.s), 0);
});

test('changer de mode remet le chrono a zero', () => {
  let timer = T.start(T.defaultTimer(), T0);
  timer = T.setMode(timer, T0 + 5 * MS.s, 'countup');
  assert.equal(timer.mode, 'countup');
  assert.equal(timer.running, false);
  assert.equal(timer.elapsedMs, 0);
});

test('sanitizeTimer borne les valeurs douteuses', () => {
  const timer = T.sanitizeTimer({ mode: 'bidon', durationMs: -5, format: { h: 'x' }, title: 'a'.repeat(500) });
  assert.equal(timer.mode, 'countdown');
  assert.equal(timer.durationMs, 0);
  assert.equal(timer.format.h, 'auto');
  assert.equal(timer.title.length, 120);
});

test('restart relance depuis zero', () => {
  let timer = T.pause(T.start(T.defaultTimer(), T0), T0 + 30 * MS.s);
  timer = T.restart(timer, T0 + 60 * MS.s);
  assert.equal(timer.running, true);
  assert.equal(T.elapsedOf(timer, T0 + 60 * MS.s), 0);
});

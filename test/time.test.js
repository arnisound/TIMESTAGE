import test from 'node:test';
import assert from 'node:assert/strict';

import { formatDuration, parseDuration, formatLabel, normalizeFormat, MS } from '../shared/time.js';

test('formatDuration : format par defaut MM:SS', () => {
  assert.equal(formatDuration(0), '00:00');
  assert.equal(formatDuration(5 * MS.m), '05:00');
  assert.equal(formatDuration(59 * MS.s + 999), '00:59');
});

test('formatDuration : heures automatiques', () => {
  assert.equal(formatDuration(59 * MS.m), '59:00');
  assert.equal(formatDuration(MS.h), '01:00:00');
  assert.equal(formatDuration(MS.h, { h: 'off', m: 'on', s: 'on', ms: 0 }), '60:00');
  assert.equal(formatDuration(5 * MS.m, { h: 'on', m: 'on', s: 'on', ms: 0 }), '00:05:00');
});

test('formatDuration : millisecondes', () => {
  assert.equal(formatDuration(1234, { h: 'off', m: 'on', s: 'on', ms: 3 }), '00:01.234');
  assert.equal(formatDuration(1234, { h: 'off', m: 'on', s: 'on', ms: 2 }), '00:01.23');
  assert.equal(formatDuration(1250, { h: 'off', m: 'on', s: 'on', ms: 1 }), '00:01.2');
});

test('formatDuration : arrondi superieur pour un compte a rebours', () => {
  assert.equal(formatDuration(4500, { h: 'off', m: 'on', s: 'on', ms: 0 }, { round: 'ceil' }), '00:05');
  assert.equal(formatDuration(4500, { h: 'off', m: 'on', s: 'on', ms: 0 }, { round: 'floor' }), '00:04');
  // L'arrondi peut faire apparaitre l'heure en mode automatique.
  assert.equal(formatDuration(59 * MS.m + 59.5 * MS.s, { h: 'auto', m: 'on', s: 'on', ms: 0 }, { round: 'ceil' }), '01:00:00');
});

test('formatDuration : minutes seules et secondes seules', () => {
  assert.equal(formatDuration(90 * MS.s, { h: 'off', m: 'on', s: 'off', ms: 0 }), '01');
  assert.equal(formatDuration(90 * MS.s, { h: 'off', m: 'off', s: 'on', ms: 0 }), '90');
  assert.equal(formatDuration(-30 * MS.s, { h: 'off', m: 'on', s: 'on', ms: 0 }), '-00:30');
});

test('normalizeFormat rejette les valeurs invalides', () => {
  assert.deepEqual(normalizeFormat({ h: 'oui', m: 'off', s: 2, ms: 9 }), { h: 'auto', m: 'off', s: 'on', ms: 3 });
});

test('formatLabel decrit le format', () => {
  assert.equal(formatLabel({ h: 'off', m: 'on', s: 'on', ms: 0 }), 'MM:SS');
  assert.equal(formatLabel({ h: 'on', m: 'on', s: 'on', ms: 2 }), 'HH:MM:SS.cc');
});

test('parseDuration : formats usuels', () => {
  assert.equal(parseDuration('5'), 5 * MS.m);
  assert.equal(parseDuration('5', 's'), 5 * MS.s);
  assert.equal(parseDuration('5:30'), 5 * MS.m + 30 * MS.s);
  assert.equal(parseDuration('1:02:03'), MS.h + 2 * MS.m + 3 * MS.s);
  assert.equal(parseDuration('1h30'), MS.h + 30 * MS.m);
  assert.equal(parseDuration('2m30s'), 2 * MS.m + 30 * MS.s);
  assert.equal(parseDuration('90s'), 90 * MS.s);
  assert.equal(parseDuration('750ms'), 750);
  assert.equal(parseDuration(' 10:00 '), 10 * MS.m);
});

test('parseDuration : entrees invalides', () => {
  assert.equal(parseDuration(''), null);
  assert.equal(parseDuration('abc'), null);
  assert.equal(parseDuration('1:2:3:4'), null);
  assert.equal(parseDuration(null), null);
});

test('parseDuration et formatDuration font un aller-retour', () => {
  for (const value of ['00:30', '05:00', '01:15:00']) {
    assert.equal(formatDuration(parseDuration(value), { h: 'auto', m: 'on', s: 'on', ms: 0 }), value);
  }
});

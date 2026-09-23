/*!
 * TimeStage, chronometre de scene
 * © 2026 Arnisound Tools (Theo Arnissolle). Tous droits reserves.
 * Logiciel proprietaire : toute reproduction, modification, distribution ou
 * exploitation sans autorisation ecrite prealable est interdite. Voir LICENSE.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

const HOLDER = 'Arnisound Tools';
const SIRET = '108 233 578 00013';
const CONTACT = 'contact@arnisoundtools.com';

test('la licence affirme la propriete et identifie l editeur', () => {
  const license = read('LICENSE');
  assert.match(license, /Tous droits réservés/);
  assert.match(license, new RegExp(HOLDER));
  assert.match(license, /Théo Arnissolle/);
  assert.match(license, new RegExp(SIRET));
  assert.match(license, new RegExp(CONTACT));
  assert.match(license, /All rights reserved/, 'un resume anglais accompagne le texte francais');

  // Les interdictions essentielles sont bien posees.
  for (const mot of ['modification', 'distribution', 'sous-licence', 'hébergement', 'ingénierie inverse']) {
    assert.match(license, new RegExp(mot, 'i'), 'interdiction manquante : ' + mot);
  }
});

test('aucun fichier ne presente encore le projet comme libre', () => {
  // Le depot est parti d'une dedicace au domaine public (CC0) et le README
  // annoncait MIT : ce test empeche l'une ou l'autre de revenir.
  const files = ['LICENSE', 'README.md', 'package.json', 'public/index.html', 'public/legal.html'];
  for (const file of files) {
    const content = read(file);
    assert.equal(/CC0|Creative Commons/i.test(content), false, 'mention CC0 dans ' + file);
    assert.equal(/licence MIT|MIT License|licensed under MIT/i.test(content), false, 'mention MIT dans ' + file);
  }
});

test('package.json designe l auteur et une licence proprietaire', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.license, 'UNLICENSED', 'valeur npm pour un paquet proprietaire');
  assert.match(pkg.author, new RegExp(HOLDER));
  assert.match(pkg.author, new RegExp(CONTACT));
  assert.equal(pkg.private, true);
});

test('les mentions legales portent les informations exigees', () => {
  const legal = read('public/legal.html');
  for (const attendu of [HOLDER, 'Theo Arnissolle', SIRET, CONTACT, 'Castelnau-le-Lez',
                         'Directeur de la publication', 'Hebergement', 'RGPD', 'CNIL']) {
    assert.ok(legal.includes(attendu), 'mention manquante : ' + attendu);
  }
  assert.match(legal, /Tous droits reserves/);
  // La description des donnees doit rester fidele au fonctionnement reel.
  assert.match(legal, /48 heures/, 'la duree de conservation est annoncee');
  assert.match(legal, /ne depose aucun cookie/i);
});

test('les pages publiques mènent aux mentions legales', () => {
  for (const page of ['public/index.html', 'public/ask.html', 'public/offline.html', 'public/control.html']) {
    const content = read(page);
    assert.match(content, /href="\/legal"/, 'lien absent dans ' + page);
    assert.match(content, /name="copyright"|Arnisound Tools/, 'mention absente dans ' + page);
  }
});

test('le code source porte l entete de propriete', () => {
  const sources = [
    'server/index.js', 'server/rooms.js',
    'shared/time.js', 'shared/timer.js', 'shared/effects.js',
    'public/js/control.js', 'public/js/display.js', 'public/js/offline.js',
    'public/js/lib/stage.js', 'public/js/lib/effects.js', 'public/js/lib/net.js',
    'public/sw.js', 'public/css/base.css', 'scripts/build-static.mjs',
  ];
  for (const file of sources) {
    const head = read(file).slice(0, 400);
    assert.match(head, new RegExp(HOLDER), 'entete manquante : ' + file);
    assert.match(head, /Tous droits reserves/, 'entete incomplete : ' + file);
  }
});

test('le serveur expose la route des mentions legales', () => {
  assert.match(read('server/index.js'), /app\.get\('\/legal'/);
});

test('les pages publiques ne renvoient pas vers le depot de code', () => {
  // Le logiciel est proprietaire : l'interface n'invite pas a recuperer le code.
  for (const page of ['public/index.html', 'public/ask.html', 'public/offline.html', 'public/control.html']) {
    assert.equal(/github\.com/i.test(read(page)), false, 'lien vers le depot dans ' + page);
  }
});

test('aucun tiret cadratin dans les textes du projet', () => {
  // Choix de redaction : la ponctuation francaise du projet se passe de « — »
  // et de « – ». Ce test les attrape s'ils reviennent.
  const fichiers = [
    'LICENSE', 'README.md', 'package.json',
    'public/index.html', 'public/legal.html', 'public/control.html',
    'public/ask.html', 'public/offline.html', 'public/display.html',
    'public/js/control.js', 'public/js/display.js', 'public/js/ask.js',
    'public/js/index.js', 'public/js/offline.js',
    'public/js/lib/stage.js', 'public/js/lib/net.js', 'public/js/lib/dom.js',
    'server/index.js', 'server/rooms.js',
    'shared/time.js', 'shared/timer.js', 'shared/effects.js',
  ];
  for (const fichier of fichiers) {
    const contenu = read(fichier);
    const ligne = contenu.split('\n').findIndex((l) => /[\u2013\u2014]/.test(l));
    assert.equal(ligne, -1, `tiret cadratin dans ${fichier} ligne ${ligne + 1}`);
  }
});

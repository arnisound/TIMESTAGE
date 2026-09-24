/*!
 * TimeStage, chronometre de scene
 * © 2026 Arnisound Tools (Theo Arnissolle). Tous droits reserves.
 * Logiciel proprietaire : toute reproduction, modification, distribution ou
 * exploitation sans autorisation ecrite prealable est interdite. Voir LICENSE.
 */
import test from 'node:test';
import { ROOM_TTL_MS, ROOM_MAX_MS } from '../core/rooms.js';
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
  // Les deux bornes doivent figurer, et correspondre a ce que fait le code.
  assert.match(legal, /24 heures/, 'le delai d inactivite est annonce');
  assert.match(legal, /50 heures/, 'le plafond absolu est annonce');
  assert.match(legal, /ne depose aucun cookie/i);
  assert.match(legal, /arnisoundtools\.com/, "l'adresse du service est annoncee");
  // Le sondage ajoute un traitement : il doit figurer dans la description.
  assert.match(legal, /sondage/i, 'les votes sont decrits');
});

test("l accueil ne repete pas le lien des mentions legales", () => {
  const home = read('public/index.html');
  const liens = home.match(/href="\/legal"/g) || [];
  assert.equal(liens.length, 1, 'un seul lien, en pied de page');
  const entete = home.slice(home.indexOf('<header'), home.indexOf('</header>'));
  assert.equal(/href="\/legal"/.test(entete), false, "pas de lien legal en entete");
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
  // Choix de redaction : la ponctuation francaise du projet se passe du tiret
  // cadratin (U+2014) et du tiret demi-cadratin (U+2013). Le balayage est
  // automatique, et non une liste de fichiers : une liste tenue a la main
  // prend du retard des qu'un fichier arrive, et ne protege alors plus rien.
  // Les deux caracteres ne sont nommes ici que par leur code, sinon ce
  // commentaire se ferait prendre par son propre test.
  const ignores = new Set(['node_modules', '.git', 'dist', 'dist-worker', '.wrangler', 'data', 'brand']);
  const extensions = /\.(md|html|js|mjs|css|json)$/;
  const fautifs = [];

  const balaye = (dossier) => {
    for (const entree of fs.readdirSync(path.join(ROOT, dossier), { withFileTypes: true })) {
      if (ignores.has(entree.name)) continue;
      const relatif = path.join(dossier, entree.name);
      if (entree.isDirectory()) balaye(relatif);
      else if (extensions.test(entree.name) || entree.name === 'LICENSE') {
        const lignes = fs.readFileSync(path.join(ROOT, relatif), 'utf8').split('\n');
        const i = lignes.findIndex((l) => /[\u2013\u2014]/.test(l));
        if (i >= 0) fautifs.push(`${relatif} ligne ${i + 1}`);
      }
    }
  };
  balaye('.');

  assert.deepEqual(fautifs, [], 'tiret cadratin trouve');
});

test('les durees annoncees au public sont celles du code', () => {
  const legal = read('public/legal.html');
  const heures = (ms) => Math.round(ms / 3_600_000);
  // Une mention legale qui promet autre chose que ce que le service fait n'est
  // pas une approximation, c'est une information fausse.
  assert.ok(legal.includes(`${heures(ROOM_TTL_MS)} heures apres le dernier usage`), 'delai d inactivite');
  assert.ok(legal.includes(`${heures(ROOM_MAX_MS)} heures apres la derniere action`), 'plafond absolu');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'timestage-static-'));

test.before(() => {
  execFileSync('node', ['scripts/build-static.mjs', OUT], { cwd: ROOT, stdio: 'pipe' });
});
test.after(() => fs.rmSync(OUT, { recursive: true, force: true }));

test('la version statique contient tout le necessaire', () => {
  for (const file of [
    'index.html',
    '404.html',
    '.nojekyll',
    'sw.js',
    'manifest.webmanifest',
    'js/offline.js',
    'js/lib/localroom.js',
    'js/lib/stage.js',
    'shared/time.js',
    'shared/timer.js',
    'css/base.css',
    'css/stage.css',
    'icons/icon.svg',
  ]) {
    assert.ok(fs.existsSync(path.join(OUT, file)), 'manquant : ' + file);
  }
});

test('les pages dependant du serveur sont exclues', () => {
  for (const file of ['js/control.js', 'js/index.js', 'js/lib/net.js', 'control.html']) {
    assert.equal(fs.existsSync(path.join(OUT, file)), false, 'ne devrait pas etre publie : ' + file);
  }
});

test('aucun chemin absolu : le site tient dans un sous-dossier', () => {
  const html = fs.readFileSync(path.join(OUT, 'index.html'), 'utf8');
  assert.equal(/(href|src)="\/(css|js|icons|manifest|shared)/.test(html), false, 'chemin absolu dans index.html');

  const walk = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      return entry.isDirectory() ? walk(full) : full;
    });
  for (const file of walk(path.join(OUT, 'js'))) {
    const code = fs.readFileSync(file, 'utf8');
    assert.equal(/from '\/(shared|js)/.test(code), false, 'import absolu dans ' + path.relative(OUT, file));
  }
});

test('le manifeste est relatif a la base du site', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(OUT, 'manifest.webmanifest'), 'utf8'));
  assert.equal(manifest.start_url, './');
  assert.equal(manifest.scope, './');
  assert.ok(manifest.icons.every((icon) => !icon.src.startsWith('/')));
});

test('le service worker se cale sur sa propre adresse', () => {
  const sw = fs.readFileSync(path.join(OUT, 'sw.js'), 'utf8');
  assert.match(sw, /new URL\('\.\/', self\.location\)/);
  assert.equal(/'\/css\//.test(sw), false, 'chemin absolu dans le service worker');
});

test('la version statique embarque les mentions legales', () => {
  assert.ok(fs.existsSync(path.join(OUT, 'legal.html')), 'legal.html manquant');
  const legal = fs.readFileSync(path.join(OUT, 'legal.html'), 'utf8');
  assert.equal(/(href|src)="\/(css|js|icons)/.test(legal), false, 'chemin absolu dans legal.html');
  assert.match(legal, /108 233 578 00013/);
  const index = fs.readFileSync(path.join(OUT, 'index.html'), 'utf8');
  assert.match(index, /href="legal\.html"/, 'la page statique doit mener aux mentions');
});

test('la version statique ne renvoie pas vers le depot', () => {
  for (const file of ['index.html', '404.html', 'legal.html']) {
    const content = fs.readFileSync(path.join(OUT, file), 'utf8');
    assert.equal(/github\.com/i.test(content), false, 'lien vers le depot dans ' + file);
  }
  assert.match(fs.readFileSync(path.join(OUT, 'index.html'), 'utf8'), /mailto:contact@arnisoundtools\.com/);
});

test('la page statique annonce ce qui demande un serveur', () => {
  const html = fs.readFileSync(path.join(OUT, 'index.html'), 'utf8');
  assert.match(html, /Version statique/);
  assert.match(html, /questions du public/);
});

/*!
 * TimeStage, chronometre de scene
 * © 2026 Arnisound Tools (Theo Arnissolle). Tous droits reserves.
 * Logiciel proprietaire : toute reproduction, modification, distribution ou
 * exploitation sans autorisation ecrite prealable est interdite. Voir LICENSE.
 */
// Construit la version statique de TimeStage (GitHub Pages, Netlify, S3…).
//
// Un hebergement statique ne peut pas faire tourner le serveur Node : pas de
// salles, pas de WebSocket, donc pas de synchronisation multi-appareils ni de
// questions du public. On publie donc le mode hors ligne, qui est complet et
// fonctionne sans reseau : chrono, formats, messages, deroule, et une seconde
// fenetre d'affichage synchronisee sur le meme appareil.
//
// Usage : node scripts/build-static.mjs [dossier-de-sortie]
//   TIMESTAGE_SERVER_URL=https://mon-serveur.example  (facultatif)
//     ajoute un lien vers l'instance complete depuis la page statique.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.resolve(ROOT, process.argv[2] || 'dist');
const SERVER_URL = process.env.TIMESTAGE_SERVER_URL || '';
// Logiciel proprietaire : la page publique ne renvoie pas vers le depot.
// Sans instance complete connue, on oriente vers l'editeur.
const CONTACT_URL = 'mailto:contact@arnisoundtools.com';

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

for (const dir of ['css', 'js', 'icons']) {
  fs.cpSync(path.join(ROOT, 'public', dir), path.join(OUT, dir), { recursive: true });
}
fs.cpSync(path.join(ROOT, 'shared'), path.join(OUT, 'shared'), { recursive: true });
for (const file of ['manifest.webmanifest', 'sw.js']) {
  fs.copyFileSync(path.join(ROOT, 'public', file), path.join(OUT, file));
}

// Les pages qui dependent du serveur n'ont pas leur place ici.
for (const file of ['js/control.js', 'js/index.js', 'js/display.js', 'js/ask.js', 'js/lib/net.js']) {
  fs.rmSync(path.join(OUT, file), { force: true });
}

// --- Mentions legales ------------------------------------------------------
// La page part telle quelle, chemins rendus relatifs comme le reste.
{
  let legal = fs.readFileSync(path.join(ROOT, 'public', 'legal.html'), 'utf8');
  legal = legal.replace(/(href|src)="\/(css|js|icons|manifest)/g, '$1="$2');
  legal = legal.replace('href="/offline"', 'href="./"').replace('href="/"', 'href="./"');
  fs.writeFileSync(path.join(OUT, 'legal.html'), legal);
}

// --- Page d'accueil = le chrono hors ligne ---------------------------------
let html = fs.readFileSync(path.join(ROOT, 'public', 'offline.html'), 'utf8');

// Chemins absolus -> relatifs, pour tenir dans un sous-dossier (/mon-depot/).
html = html.replace(/(href|src)="\/(css|js|icons|manifest)/g, '$1="$2');
html = html.replace('href="/legal"', 'href="legal.html"');

html = html
  .replace('<title>Chrono hors ligne | TimeStage</title>', '<title>TimeStage, chronometre de scene</title>')
  .replace(
    '<a class="btn sm ghost" href="/">Mode connecte</a>',
    SERVER_URL
      ? `<a class="btn sm ghost" href="${SERVER_URL}" rel="noopener">Version complete</a>`
      : '<a class="btn sm ghost" href="legal.html">Mentions legales</a>'
  );

const link = SERVER_URL || CONTACT_URL;
const linkLabel = SERVER_URL ? "ouvrir l'instance complete" : 'nous contacter';
const note = `  <div class="static-note">
    <strong>Version statique.</strong> Le chronometre, les formats, les messages, le deroule et la seconde
    fenetre d'affichage fonctionnent ici sans serveur, meme sans connexion.
    Le partage multi-appareils (QR code, questions du public, regie a distance) demande l'instance
    complete : <a href="${link}" rel="noopener">${linkLabel}</a>.
  </div>
`;
html = html.replace('  <main class="offline-layout">', note + '  <main class="offline-layout">');
html = html.replace(
  '</style>',
  `  .static-note {
    margin: .8rem .8rem 0;
    padding: .6rem .8rem;
    border: 1px solid var(--line);
    border-left: 3px solid var(--accent);
    border-radius: var(--radius-sm);
    background: var(--panel);
    font-size: .85rem;
    color: var(--muted);
  }
  .static-note strong { color: var(--text); }
</style>`
);

fs.writeFileSync(path.join(OUT, 'index.html'), html);
// Toute URL inconnue retombe sur le chrono (GitHub Pages sert 404.html).
fs.writeFileSync(path.join(OUT, '404.html'), html);
// Empeche GitHub Pages de passer le dossier dans Jekyll.
fs.writeFileSync(path.join(OUT, '.nojekyll'), '');

const manifest = JSON.parse(fs.readFileSync(path.join(OUT, 'manifest.webmanifest'), 'utf8'));
manifest.start_url = './';
manifest.scope = './';
manifest.icons = manifest.icons.map((icon) => ({ ...icon, src: icon.src.replace(/^\//, '') }));
manifest.shortcuts = [{ name: 'Chrono', short_name: 'Chrono', url: './' }];
fs.writeFileSync(path.join(OUT, 'manifest.webmanifest'), JSON.stringify(manifest, null, 2));

const count = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? count(path.join(dir, e.name)) : 1), 0);
console.log(`[timestage] version statique ecrite dans ${path.relative(ROOT, OUT) || '.'} (${count(OUT)} fichiers)`);
if (SERVER_URL) console.log(`[timestage] lien vers l'instance complete : ${SERVER_URL}`);

/*!
 * TimeStage, chronometre de scene
 * © 2026 Arnisound Tools (Theo Arnissolle). Tous droits reserves.
 * Logiciel proprietaire : toute reproduction, modification, distribution ou
 * exploitation sans autorisation ecrite prealable est interdite. Voir LICENSE.
 */
// Assemble les fichiers statiques servis par le Worker Cloudflare.
//
// Le serveur Node sert public/ a la racine et shared/ sous /shared. Cloudflare
// ne monte qu'un seul dossier : on le compose ici, a l'identique, pour que les
// memes pages fonctionnent sans modification sur les deux plateformes.
//
// wrangler lance ce script tout seul avant chaque deploiement et chaque
// lancement local (champ « build » de wrangler.jsonc) : il n'y a pas d'etape
// a penser, ni en local ni dans la construction automatique de Cloudflare.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.resolve(ROOT, process.argv[2] || 'dist-worker');

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

fs.cpSync(path.join(ROOT, 'public'), OUT, { recursive: true });
fs.cpSync(path.join(ROOT, 'shared'), path.join(OUT, 'shared'), { recursive: true });

// control.js parle au serveur : il n'a pas de raison d'etre sur la version
// statique, mais ici tout est servi, y compris la regie.
const count = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? count(path.join(dir, e.name)) : 1), 0);
console.log(`[timestage] fichiers du Worker ecrits dans ${path.relative(ROOT, OUT)} (${count(OUT)} fichiers)`);

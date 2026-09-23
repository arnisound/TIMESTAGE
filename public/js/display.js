// Fenetre d'affichage : lecture seule, plein ecran, resiste aux coupures reseau.

import { $, toast, toggleFullscreen, keepAwake } from './lib/dom.js';
import { createStage } from './lib/stage.js';
import { RoomConnection, readAccessFromUrl, rememberAccess } from './lib/net.js';

const params = new URLSearchParams(location.search);
const pathMatch = location.pathname.match(/^\/([dk])\/([A-Za-z0-9]{3,8})$/);
const code = (pathMatch?.[2] || params.get('room') || params.get('code') || '').toUpperCase();

// Mode incrustation video : le chrono seul, sur fond transparent ou sur une
// couleur d'incrustation. Destine a une source navigateur dans un melangeur.
const keyMode = pathMatch?.[1] === 'k' || params.get('key') === '1';
const KEY_BACKGROUNDS = { transparent: 'transparent', green: '#00b140', magenta: '#ff00ff', blue: '#0047bb', black: '#000000', white: '#ffffff' };

const stageRoot = $('#stage');
const statusChip = $('#status');
const statusText = $('#status-text');
const stage = createStage(stageRoot);

if (params.get('compact') === '1') stageRoot.dataset.compact = 'true';

if (keyMode) {
  document.body.classList.add('key-mode');
  document.documentElement.classList.add('key-mode');
  stageRoot.classList.add('key-mode');
  const raw = (params.get('bg') || 'transparent').toLowerCase();
  const background = KEY_BACKGROUNDS[raw] || (/^#?[0-9a-f]{6}$/.test(raw) ? (raw.startsWith('#') ? raw : '#' + raw) : 'transparent');
  stageRoot.style.setProperty('--key-bg', background);
  // « show » ajoute au chrono les elements demandes : title, sub, progress, message.
  stageRoot.dataset.show = (params.get('show') || '').toLowerCase().split(/[,\s]+/).filter(Boolean).join(' ');
  if (params.get('shadow') === '1') stageRoot.dataset.shadow = 'true';
  document.title = `Chrono video ${code} — TimeStage`;
}

// --- Bandeau d'etat ---------------------------------------------------------
let hudTimer = null;
let cursorTimer = null;

/**
 * Affiche le bandeau d'etat. `ms = 0` le laisse a l'ecran : reserve aux cas ou
 * la regie doit voir qu'il y a un probleme (connexion perdue, salle absente).
 * Le reste du temps il s'efface vite : sur une scene, rien ne doit rester
 * devant le chrono.
 */
function showHud(ms = 1200) {
  document.body.classList.add('show-hud');
  document.body.classList.remove('idle-cursor');
  clearTimeout(hudTimer);
  clearTimeout(cursorTimer);
  if (ms > 0) hudTimer = setTimeout(() => document.body.classList.remove('show-hud'), ms);
  cursorTimer = setTimeout(() => document.body.classList.add('idle-cursor'), 3000);
}

const wake = () => showHud(1600);
document.addEventListener('mousemove', wake);
document.addEventListener('touchstart', wake, { passive: true });
if (!keyMode) showHud(1600);

if (!code) {
  showJoin();
} else {
  start(code);
}

let joinWired = false;
function showJoin({ askAccess = false } = {}) {
  $('#join').classList.remove('hidden');
  stageRoot.classList.add('hidden');
  $('#access-field').classList.toggle('hidden', !askAccess);
  if (askAccess) {
    $('#code').value = code;
    $('#access').focus();
  }
  if (joinWired) return;
  joinWired = true;
  $('#join-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const value = $('#code').value.trim().toUpperCase();
    if (!value) return;
    const access = $('#access').value.trim();
    if (access) rememberAccess(value, access);
    if (value === code && access) location.reload();
    else location.href = '/d/' + encodeURIComponent(value);
  });
}

function start(roomCode) {
  document.title = `Affichage ${roomCode} — TimeStage`;
  const conn = new RoomConnection({ code: roomCode, role: 'display', access: readAccessFromUrl(roomCode) });
  let state = null;
  let missingAttempts = 0;

  conn.addEventListener('state', (event) => {
    state = event.detail;
    missingAttempts = 0;
    stageRoot.dataset.theme = state.settings?.theme || 'dark';
    document.title = `${state.settings?.displayName || state.session?.name || 'Affichage'} ${roomCode} — TimeStage`;
  });

  conn.addEventListener('status', (event) => {
    const status = event.detail.status;
    const dot = statusChip.querySelector('.dot');
    statusChip.className = 'chip ' + (status === 'online' ? 'ok' : status === 'offline' ? 'danger' : '');
    dot.className = 'dot ' + (status === 'online' ? 'ok' : status === 'offline' ? 'danger' : 'warn');
    statusText.textContent =
      status === 'online'
        ? 'En ligne'
        : conn.missingRoom
          ? 'Salle indisponible — nouvelle tentative…'
          : status === 'connecting'
            ? 'Connexion…'
            : status === 'offline'
              ? state
                ? 'Hors ligne — le chrono continue'
                : 'Serveur injoignable — nouvelle tentative…'
              : 'Arrete';
    // En ligne : on confirme brievement puis on libere l'ecran.
    // Hors ligne : le bandeau reste, c'est une information utile a la regie.
    if (!keyMode) showHud(status === 'online' ? 1200 : 0);
  });

  conn.addEventListener('remote-error', (event) => {
    if (event.detail.code === 'access_denied' || event.detail.code === 'rate_limited') {
      rememberAccess(roomCode, '');
      toast(event.detail.message || 'Code d\'acces requis.', 'error', 8000);
      showJoin({ askAccess: true });
      return;
    }
    if (event.detail.code !== 'no_room') return;
    missingAttempts += 1;
    if (state) {
      // On a deja recu cette salle : le serveur vient de redemarrer. Le chrono
      // continue sur l'horloge estimee et la connexion se retablira des que la
      // regie aura recree la salle avec le meme code.
      return;
    }
    // Jamais connecte : c'est sans doute une erreur de code. On propose la
    // saisie apres quelques essais, sans cesser de reessayer en fond.
    if (missingAttempts >= 3) {
      toast('Salle introuvable : ' + roomCode, 'error', 8000);
      showJoin();
    }
  });

  conn.connect();

  // Boucle de rendu : le temps vient de l'horloge serveur estimee, donc
  // l'affichage reste juste meme si la connexion tombe quelques minutes.
  const loop = () => {
    if (state) stage.update(state, conn.now());
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);

  keepAwake();
}

// --- Confort d'usage --------------------------------------------------------
$('#btn-fs').addEventListener('click', () => toggleFullscreen());

document.addEventListener('keydown', (event) => {
  if (event.key === 'f' || event.key === 'F') toggleFullscreen();
});

if ('serviceWorker' in navigator) navigator.serviceWorker.register(new URL('../sw.js', import.meta.url)).catch(() => {});

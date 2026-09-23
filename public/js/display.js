// Fenetre d'affichage : lecture seule, plein ecran, resiste aux coupures reseau.

import { $, toast, toggleFullscreen, keepAwake } from './lib/dom.js';
import { createStage } from './lib/stage.js';
import { RoomConnection, readAccessFromUrl, rememberAccess } from './lib/net.js';

const params = new URLSearchParams(location.search);
const pathCode = location.pathname.match(/^\/d\/([A-Za-z0-9]{3,8})$/)?.[1];
const code = (pathCode || params.get('room') || params.get('code') || '').toUpperCase();

const stageRoot = $('#stage');
const statusChip = $('#status');
const statusText = $('#status-text');
const stage = createStage(stageRoot);

if (params.get('compact') === '1') stageRoot.dataset.compact = 'true';

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
showHud(1600);

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
    showHud(status === 'online' ? 1200 : 0);
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

// Fenetre d'affichage : lecture seule, plein ecran, resiste aux coupures reseau.

import { $, toast, toggleFullscreen, keepAwake } from './lib/dom.js';
import { createStage } from './lib/stage.js';
import { RoomConnection } from './lib/net.js';

const params = new URLSearchParams(location.search);
const pathCode = location.pathname.match(/^\/d\/([A-Za-z0-9]{3,8})$/)?.[1];
const code = (pathCode || params.get('room') || params.get('code') || '').toUpperCase();

const stageRoot = $('#stage');
const statusChip = $('#status');
const statusText = $('#status-text');
const stage = createStage(stageRoot);

if (params.get('compact') === '1') stageRoot.dataset.compact = 'true';

if (!code) {
  showJoin();
} else {
  start(code);
}

function showJoin() {
  $('#join').classList.remove('hidden');
  stageRoot.classList.add('hidden');
  $('#join-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const value = $('#code').value.trim().toUpperCase();
    if (value) location.href = '/d/' + encodeURIComponent(value);
  });
}

function start(roomCode) {
  document.title = `Affichage ${roomCode} — TimeStage`;
  const conn = new RoomConnection({ code: roomCode, role: 'display' });
  let state = null;

  conn.addEventListener('state', (event) => {
    state = event.detail;
    stageRoot.dataset.theme = state.settings?.theme || 'dark';
    document.title = `${state.settings?.displayName || state.session?.name || 'Affichage'} ${roomCode} — TimeStage`;
  });

  conn.addEventListener('status', (event) => {
    const status = event.detail.status;
    const dot = statusChip.querySelector('.dot');
    statusChip.className = 'chip ' + (status === 'online' ? 'ok' : status === 'offline' ? 'danger' : '');
    dot.className = 'dot ' + (status === 'online' ? 'ok' : status === 'offline' ? 'danger' : 'warn');
    statusText.textContent =
      status === 'online' ? 'En ligne' : status === 'connecting' ? 'Connexion…' : status === 'offline' ? 'Hors ligne — le chrono continue' : 'Arrete';
    if (status === 'offline') document.body.classList.add('show-hud');
    else if (status === 'online') setTimeout(() => document.body.classList.remove('show-hud'), 1500);
  });

  conn.addEventListener('remote-error', (event) => {
    if (event.detail.code === 'no_room') {
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

let hudTimer = null;
let cursorTimer = null;
const wake = () => {
  document.body.classList.add('show-hud');
  document.body.classList.remove('idle-cursor');
  clearTimeout(hudTimer);
  clearTimeout(cursorTimer);
  hudTimer = setTimeout(() => document.body.classList.remove('show-hud'), 2500);
  cursorTimer = setTimeout(() => document.body.classList.add('idle-cursor'), 4000);
};
document.addEventListener('mousemove', wake);
document.addEventListener('touchstart', wake, { passive: true });
wake();

if ('serviceWorker' in navigator) navigator.serviceWorker.register(new URL('../sw.js', import.meta.url)).catch(() => {});

// Page publique : envoi de questions + apercu du temps restant.

import { $, el, clear, toast } from './lib/dom.js';
import { RoomConnection, readAccessFromUrl, rememberAccess } from './lib/net.js';
import { formatDuration } from '../shared/time.js';
import { readTimer } from '../shared/timer.js';

const pathCode = location.pathname.match(/^\/q\/([A-Za-z0-9]{3,8})$/)?.[1];
const params = new URLSearchParams(location.search);
const code = (pathCode || params.get('room') || params.get('code') || '').toUpperCase();

if (!code) location.replace('/');
$('#room-code').textContent = code;

const MINE_KEY = 'timestage:mine:' + code;
const loadMine = () => { try { return JSON.parse(localStorage.getItem(MINE_KEY) || '[]'); } catch { return []; } };
const saveMine = (list) => { try { localStorage.setItem(MINE_KEY, JSON.stringify(list.slice(-20))); } catch { /* prive */ } };

let access = readAccessFromUrl(code);
const conn = new RoomConnection({ code, role: 'viewer', access });
let state = null;

conn.addEventListener('state', (event) => {
  state = event.detail;
  $('#room-name').textContent = state.settings.displayName || state.session.name || 'TimeStage';
  document.title = `Question — ${$('#room-name').textContent}`;
  $('#live-title').textContent = state.timer.title || 'En cours';

  const open = state.settings.questionsOpen;
  $('#ask-form').classList.toggle('hidden', !open);
  $('#closed').classList.toggle('hidden', open);
  renderMine();
});

conn.addEventListener('status', (event) => {
  const status = event.detail.status;
  const chip = $('#status');
  chip.className = 'chip ' + (status === 'online' ? 'ok' : status === 'offline' ? 'danger' : '');
  chip.textContent =
    status === 'online' ? 'En direct' : conn.missingRoom ? 'Salle indisponible' : status === 'connecting' ? 'Connexion…' : 'Hors ligne';
});

conn.addEventListener('remote-error', (event) => {
  if (event.detail.code === 'access_denied' || event.detail.code === 'rate_limited') {
    rememberAccess(code, '');
    $('#access-panel').classList.remove('hidden');
    $('#live-panel').classList.add('hidden');
    $('#ask-form').classList.add('hidden');
    if (event.detail.code === 'rate_limited') toast(event.detail.message, 'error', 8000);
    return;
  }
  if (event.detail.code === 'no_room') {
    // Redemarrage du serveur : on patiente, la reconnexion est automatique.
    $('#live-title').textContent = 'Salle indisponible';
    return;
  }
  toast(event.detail.message || 'Erreur', 'error', 5000);
  $('#send').disabled = false;
});

conn.addEventListener('message', (event) => {
  if (event.detail.t !== 'question_ok') return;
  const list = loadMine();
  list.push({ id: event.detail.id, text: pending, at: Date.now() });
  saveMine(list);
  pending = '';
  $('#text').value = '';
  $('#counter').textContent = '0 / 500';
  $('#send').disabled = false;
  toast('Question envoyee a la regie', 'ok');
  renderMine();
});

conn.connect();

let pending = '';

$('#ask-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = $('#text').value.trim();
  if (text.length < 3) return toast('Votre question est trop courte.', 'error');
  pending = text;
  $('#send').disabled = true;

  if (conn.askQuestion(text, $('#author').value.trim())) return;

  // Repli HTTP si le WebSocket est indisponible.
  try {
    const response = await fetch(`/api/rooms/${code}/questions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, author: $('#author').value.trim(), access }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'envoi impossible');
    const list = loadMine();
    list.push({ id: data.id, text, at: Date.now() });
    saveMine(list);
    $('#text').value = '';
    toast('Question envoyee', 'ok');
    renderMine();
  } catch (err) {
    toast(err.message, 'error', 5000);
  } finally {
    $('#send').disabled = false;
  }
});

$('#access-form').addEventListener('submit', (event) => {
  event.preventDefault();
  access = $('#access').value.trim();
  rememberAccess(code, access);
  conn.access = access;
  conn.closedByUser = false;
  conn.attempt = 0;
  conn.connect();
  $('#access-panel').classList.add('hidden');
  $('#live-panel').classList.remove('hidden');
  $('#ask-form').classList.remove('hidden');
});

$('#text').addEventListener('input', (event) => {
  $('#counter').textContent = `${event.target.value.length} / 500`;
});

function renderMine() {
  const mine = loadMine();
  $('#mine-panel').classList.toggle('hidden', !mine.length);
  const list = clear($('#mine'));
  const shown = state?.shownQuestionId;
  for (const entry of [...mine].reverse()) {
    const onAir = shown === entry.id;
    list.append(
      el('li', { class: 'list-item' }, [
        el('div', { class: 'grow' }, [
          el('div', { text: entry.text }),
          el('small', { class: 'muted', text: onAir ? 'Affichee a l\'ecran' : 'En attente de validation' }),
        ]),
      ])
    );
  }
}

// Apercu du chrono pour le public.
function loop() {
  if (state) {
    const view = readTimer(state.timer, conn.now());
    const value = $('#live-value');
    const round = view.mode === 'countdown' && !view.negative ? 'ceil' : 'floor';
    value.textContent = (view.negative ? '-' : '') + formatDuration(view.displayMs, state.timer.format, { round });
    value.dataset.phase = view.phase;
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

if ('serviceWorker' in navigator) navigator.serviceWorker.register(new URL('../sw.js', import.meta.url)).catch(() => {});

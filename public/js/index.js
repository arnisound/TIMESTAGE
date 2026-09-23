/*!
 * TimeStage — chronometre de scene
 * © 2026 Arnisound Tools — Theo Arnissolle. Tous droits reserves.
 * Logiciel proprietaire : toute reproduction, modification, distribution ou
 * exploitation sans autorisation ecrite prealable est interdite. Voir LICENSE.
 */
// Accueil : creation de salle, reprise des salles recentes, acces rapide.

import { $, el, clear, toast, relativeTime } from './lib/dom.js';

const RECENT_KEY = 'timestage:recent';

function loadRecent() {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch { return []; }
}

function saveRecent(entries) {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(entries.slice(0, 6))); } catch { /* mode prive */ }
}

function rememberRoom(code, name) {
  const entries = loadRecent().filter((entry) => entry.code !== code);
  entries.unshift({ code, name: name || '', at: Date.now() });
  saveRecent(entries);
}

function renderRecent() {
  const entries = loadRecent();
  const box = $('#recent');
  const list = clear($('#recent-list'));
  if (!entries.length) return box.classList.add('hidden');
  box.classList.remove('hidden');

  for (const entry of entries) {
    const token = localStorage.getItem('timestage:token:' + entry.code);
    list.append(
      el('li', { class: 'list-item row between' }, [
        el('div', { class: 'grow' }, [
          el('div', {}, [el('span', { class: 'code-badge', text: entry.code }), ' ', entry.name || 'Sans nom']),
          el('small', { class: 'muted', text: relativeTime(entry.at) }),
        ]),
        el('div', { class: 'row tight' }, [
          token ? el('a', { class: 'btn sm primary', href: `/c/${entry.code}`, text: 'Regie' }) : null,
          el('a', { class: 'btn sm ghost', href: `/d/${entry.code}`, text: 'Affichage' }),
          el('button', { class: 'btn sm ghost', text: '✕', title: 'Oublier', onclick: () => {
            saveRecent(loadRecent().filter((x) => x.code !== entry.code));
            renderRecent();
          } }),
        ]),
      ])
    );
  }
}

// Sur un hebergement gratuit, le serveur s'endort apres quelques minutes sans
// trafic et met jusqu'a une minute a repartir. On le reveille des l'ouverture
// de la page, et on le dit clairement si l'attente se prolonge.
let serverAwake = false;
fetch('/api/health', { cache: 'no-store' })
  .then((response) => { serverAwake = response.ok; })
  .catch(() => {});

$('#create-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('#create-btn');
  const hint = $('#create-hint');
  button.disabled = true;
  button.textContent = 'Creation…';

  // Message d'attente seulement si le serveur tarde vraiment.
  const slow = setTimeout(() => {
    if (serverAwake) return;
    hint.classList.remove('hidden');
    hint.textContent = 'Le serveur se reveille — cela peut prendre jusqu\'a une minute la premiere fois.';
  }, 2500);

  try {
    const response = await fetch('/api/rooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: $('#name').value.trim() }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'creation impossible');
    try { localStorage.setItem('timestage:token:' + data.code, data.ownerToken); } catch { /* mode prive */ }
    rememberRoom(data.code, $('#name').value.trim());
    location.href = `/c/${data.code}#t=${encodeURIComponent(data.ownerToken)}`;
  } catch (err) {
    toast('Impossible de creer la session : ' + err.message, 'error', 6000);
    hint.classList.remove('hidden');
    hint.textContent = 'Serveur injoignable. Le chrono hors ligne reste utilisable.';
    button.disabled = false;
    button.textContent = 'Creer la session';
  } finally {
    clearTimeout(slow);
  }
});

const codeValue = () => $('#code').value.trim().toUpperCase();

$('#join-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (!codeValue()) return toast('Saisissez un code de salle.', 'error');
  location.href = '/d/' + encodeURIComponent(codeValue());
});
$('#join-ask').addEventListener('click', () => {
  if (!codeValue()) return toast('Saisissez un code de salle.', 'error');
  location.href = '/q/' + encodeURIComponent(codeValue());
});
$('#join-control').addEventListener('click', () => {
  if (!codeValue()) return toast('Saisissez un code de salle.', 'error');
  location.href = '/c/' + encodeURIComponent(codeValue());
});

renderRecent();

if ('serviceWorker' in navigator) navigator.serviceWorker.register(new URL('../sw.js', import.meta.url)).catch(() => {});

// Chrono hors ligne : aucun serveur, tout se passe dans le navigateur.
// Deux fenetres du meme appareil se synchronisent par BroadcastChannel.

import { $, $$, el, clear, toast, toggleFullscreen, keepAwake } from './lib/dom.js';
import { createStage } from './lib/stage.js';
import { LocalRoom } from './lib/localroom.js';
import { formatDuration, formatLabel, parseDuration, MS } from '../shared/time.js';
import { readTimer } from '../shared/timer.js';

const room = new LocalRoom();
const isDisplayWindow = new URLSearchParams(location.search).get('view') === 'display';

if (isDisplayWindow) {
  document.body.classList.add('offline-display');
  document.title = 'Affichage hors ligne — TimeStage';
  const stage = createStage($('#full-stage'));
  const loop = () => {
    $('#full-stage').dataset.theme = room.state.settings.theme || 'dark';
    stage.update(room.state, Date.now());
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'f' || event.key === 'F') toggleFullscreen();
  });
  $('#full-stage').addEventListener('dblclick', () => toggleFullscreen());
  keepAwake();
} else {
  initControl();
}

function initControl() {
  const preview = createStage($('#preview-stage'));
  const apply = (name, payload) => room.apply(name, payload);
  const focused = (node) => document.activeElement === node;
  const setValue = (node, value) => { if (!focused(node) && node.value !== String(value)) node.value = value; };

  room.addEventListener('state', render);
  render();

  function render() {
    const state = room.state;
    const t = state.timer;
    $('#preview-stage').dataset.theme = state.settings.theme || 'dark';

    setValue($('#duration-input'), formatDuration(t.durationMs, { h: 'auto', m: 'on', s: 'on', ms: 0 }));
    setValue($('#title-input'), t.title || '');
    setValue($('#speaker-input'), t.speaker || '');
    setValue($('#wrapup-input'), formatDuration(t.wrapUpMs, { h: 'off', m: 'on', s: 'on', ms: 0 }));
    setValue($('#final-input'), formatDuration(t.finalMs, { h: 'off', m: 'on', s: 'on', ms: 0 }));

    $('#btn-toggle').textContent = t.running ? 'Pause' : 'Demarrer';
    $('#btn-toggle').className = 'btn lg ' + (t.running ? 'warn' : 'ok');
    for (const button of $$('#mode-seg button')) button.setAttribute('aria-pressed', String(button.dataset.mode === t.mode));
    if (!focused($('#fmt-h'))) $('#fmt-h').value = t.format.h;
    if (!focused($('#fmt-m'))) $('#fmt-m').value = t.format.m;
    if (!focused($('#fmt-s'))) $('#fmt-s').value = t.format.s;
    if (!focused($('#fmt-ms'))) $('#fmt-ms').value = String(t.format.ms);
    $('#format-label').textContent = formatLabel(t.format);
    $('#overrun-input').checked = !!t.overrun;

    $('#theme-select').value = state.settings.theme || 'dark';
    for (const input of $$('[data-setting]')) input.checked = !!state.settings[input.dataset.setting];
    $('#btn-blackout').setAttribute('aria-pressed', String(!!state.settings.blackout));
    $('#message-state').textContent = state.message.visible ? "A l'ecran" : 'Masque';
    $('#message-state').className = 'chip ' + (state.message.visible ? 'accent' : '');
    $('#parts-count').textContent = `${state.session.parts.length} partie${state.session.parts.length > 1 ? 's' : ''}`;

    renderParts();
    renderPresets();
  }

  function renderParts() {
    const list = clear($('#parts-list'));
    const { parts, activeId } = room.state.session;
    if (!parts.length) {
      list.append(el('li', { class: 'empty', text: 'Aucune partie enregistree.' }));
      return;
    }
    parts.forEach((part, index) => {
      list.append(
        el('li', { class: 'list-item' + (part.id === activeId ? ' active' : '') + (part.done ? ' done' : '') }, [
          el('div', { class: 'part-row grow' }, [
            el('span', { class: 'part-index', text: String(index + 1) }),
            el('div', { class: 'part-main' }, [
              el('div', { class: 'part-title', text: part.title }),
              el('div', { class: 'part-meta' }, [
                el('span', { class: 'mono', text: formatDuration(part.durationMs, { h: 'auto', m: 'on', s: 'on', ms: 0 }) }),
                part.speaker ? el('span', { text: '· ' + part.speaker }) : null,
              ]),
            ]),
            el('div', { class: 'part-actions' }, [
              el('button', { class: 'btn sm', text: 'Charger', onclick: () => apply('session.load', { id: part.id }) }),
              el('button', { class: 'btn sm ghost', text: '✕', onclick: () => apply('session.parts.remove', { id: part.id }) }),
            ]),
          ]),
        ])
      );
    });
  }

  function renderPresets() {
    const grid = clear($('#presets'));
    for (const preset of room.state.presets) {
      grid.append(
        el('button', {
          class: 'btn preset',
          type: 'button',
          dataset: { style: preset.style },
          text: preset.text,
          onclick: () => apply('message.send', { text: preset.text, style: preset.style }),
        })
      );
    }
  }

  // --- Transport ------------------------------------------------------------
  $('#btn-toggle').addEventListener('click', () => apply('timer.toggle'));
  $('#btn-reset').addEventListener('click', () => apply('timer.reset'));
  $('#btn-restart').addEventListener('click', () => apply('timer.restart'));
  for (const button of $$('[data-add]')) button.addEventListener('click', () => apply('timer.add', { ms: Number(button.dataset.add) }));
  for (const button of $$('[data-preset]')) {
    button.addEventListener('click', () => apply('timer.setDuration', { ms: Number(button.dataset.preset), restart: true }));
  }

  $('#duration-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const ms = parseDuration($('#duration-input').value, 'm');
    if (ms == null || ms < 0) return toast('Duree illisible. Essayez 5, 5:30, 1h15 ou 90s.', 'error');
    apply('timer.setDuration', { ms });
    $('#duration-input').blur();
  });

  const bindText = (selector, build) => {
    const node = $(selector);
    const commit = () => build(node.value);
    node.addEventListener('change', commit);
    node.addEventListener('blur', commit);
    node.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); commit(); node.blur(); } });
  };
  bindText('#title-input', (value) => apply('timer.setTitle', { title: value }));
  bindText('#speaker-input', (value) => apply('timer.setTitle', { speaker: value }));
  bindText('#wrapup-input', (value) => {
    const ms = parseDuration(value, 'm');
    if (ms != null && ms >= 0) apply('timer.setThresholds', { wrapUpMs: ms });
  });
  bindText('#final-input', (value) => {
    const ms = parseDuration(value, 's');
    if (ms != null && ms >= 0) apply('timer.setThresholds', { finalMs: ms });
  });
  $('#overrun-input').addEventListener('change', (event) => apply('timer.setThresholds', { overrun: event.target.checked }));

  for (const button of $$('#mode-seg button')) button.addEventListener('click', () => apply('timer.setMode', { mode: button.dataset.mode }));
  const sendFormat = () =>
    apply('timer.setFormat', {
      format: { h: $('#fmt-h').value, m: $('#fmt-m').value, s: $('#fmt-s').value, ms: Number($('#fmt-ms').value) },
    });
  for (const id of ['#fmt-h', '#fmt-m', '#fmt-s', '#fmt-ms']) $(id).addEventListener('change', sendFormat);

  // --- Messages -------------------------------------------------------------
  $('#message-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const text = $('#message-text').value.trim();
    if (!text) return toast('Message vide.', 'error');
    apply('message.send', { text, style: $('#message-style').value, flash: $('#message-flash').checked });
  });
  $('#btn-hide-message').addEventListener('click', () => apply('message.hide'));

  // --- Deroule --------------------------------------------------------------
  $('#part-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const title = $('#part-title').value.trim();
    if (!title) return;
    apply('session.parts.add', { part: { title, durationMs: parseDuration($('#part-duration').value, 'm') ?? 10 * MS.m } });
    $('#part-title').value = '';
    $('#part-title').focus();
  });
  $('#btn-next').addEventListener('click', () => apply('session.next'));
  $('#btn-prev').addEventListener('click', () => apply('session.prev'));
  $('#btn-clear-parts').addEventListener('click', () => {
    if (confirm('Supprimer toutes les parties ?')) apply('session.replace', {});
  });

  // --- Affichage ------------------------------------------------------------
  for (const input of $$('[data-setting]')) {
    input.addEventListener('change', () => apply('settings.update', { patch: { [input.dataset.setting]: input.checked } }));
  }
  $('#theme-select').addEventListener('change', (event) => apply('settings.update', { patch: { theme: event.target.value } }));
  $('#btn-blackout').addEventListener('click', () => apply('settings.update', { patch: { blackout: !room.state.settings.blackout } }));
  $('#btn-fullscreen').addEventListener('click', () => toggleFullscreen($('#preview-stage').parentElement));
  $('#btn-open-display').addEventListener('click', () => {
    // Relatif a la page courante : fonctionne aussi bien sur /offline que sur
    // un hebergement statique place dans un sous-dossier.
    const url = new URL(location.pathname + '?view=display', location.href);
    window.open(url, 'timestage-offline-display', 'noopener');
  });

  // --- Raccourcis -----------------------------------------------------------
  document.addEventListener('keydown', (event) => {
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    switch (event.key) {
      case ' ': event.preventDefault(); apply('timer.toggle'); break;
      case 'r': apply('timer.reset'); break;
      case 'R': apply('timer.restart'); break;
      case 'n': case 'N': apply('session.next'); break;
      case 'p': case 'P': apply('session.prev'); break;
      case 'Escape': apply('message.hide'); break;
      case 'ArrowUp': event.preventDefault(); apply('timer.add', { ms: MS.m }); break;
      case 'ArrowDown': event.preventDefault(); apply('timer.add', { ms: -MS.m }); break;
    }
  });

  // --- Etat reseau (informatif) --------------------------------------------
  const updateNet = () => {
    const online = navigator.onLine;
    $('#net-chip').className = 'chip ' + (online ? 'ok' : 'warn');
    $('#net-chip').querySelector('.dot').className = 'dot ' + (online ? 'ok' : 'warn');
    $('#net-text').textContent = online ? 'Reseau disponible' : 'Sans reseau';
  };
  window.addEventListener('online', updateNet);
  window.addEventListener('offline', updateNet);
  updateNet();

  // --- Boucle de rendu ------------------------------------------------------
  const labels = { idle: 'Pret', running: 'En cours', paused: 'En pause', wrapup: 'Bientot fini', final: 'Fin proche', overrun: 'Depassement', clock: 'Horloge' };
  const loop = () => {
    preview.update(room.state, Date.now());
    const view = readTimer(room.state.timer, Date.now());
    const chip = $('#phase-chip');
    chip.textContent = labels[view.phase] || '';
    chip.className = 'chip ' + (view.phase === 'overrun' || view.phase === 'final' ? 'danger' : view.phase === 'wrapup' ? 'warn' : view.phase === 'running' ? 'ok' : '');
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);

  keepAwake();
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register(new URL('../sw.js', import.meta.url)).then(
    () => { const chip = document.getElementById('cache-chip'); if (chip) chip.className = 'chip ok'; },
    () => { const chip = document.getElementById('cache-chip'); if (chip) chip.textContent = 'Cache indisponible'; }
  );
}

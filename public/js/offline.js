/*!
 * TimeStage, chronometre de scene
 * © 2026 Arnisound Tools (Theo Arnissolle). Tous droits reserves.
 * Logiciel proprietaire : toute reproduction, modification, distribution ou
 * exploitation sans autorisation ecrite prealable est interdite. Voir LICENSE.
 */
// Chrono hors ligne : aucun serveur, tout se passe dans le navigateur.
// Deux fenetres du meme appareil se synchronisent par BroadcastChannel.

import { $, $$, el, clear, toast, toggleFullscreen, keepAwake } from './lib/dom.js';
import { createStage } from './lib/stage.js';
import { LocalRoom } from './lib/localroom.js';
import { formatDuration, formatLabel, parseDuration, MS } from '../shared/time.js';
import { readTimer } from '../shared/timer.js';
import { EFFECTS } from '../shared/effects.js';

// Couleurs par defaut de chaque theme : elles amorcent les selecteurs, qui
// ne savent pas representer « aucune couleur choisie ».
const THEME_COLORS = {
  brand: { colorNormal: '#e2ab52', colorText: '#f4f1ea' },
  dark: { colorNormal: '#22c55e', colorText: '#f4f1ea' },
  light: { colorNormal: '#22c55e', colorText: '#0f172a' },
  contrast: { colorNormal: '#ffffff', colorText: '#ffffff' },
};
const PHASE_DEFAULTS = { colorWrapUp: '#facc15', colorFinal: '#ef4444', colorOverrun: '#ef4444' };
const COLOR_FIELDS = {
  '#color-normal': 'colorNormal',
  '#color-wrapup': 'colorWrapUp',
  '#color-final': 'colorFinal',
  '#color-overrun': 'colorOverrun',
  '#color-text': 'colorText',
};

const room = new LocalRoom();
const isDisplayWindow = new URLSearchParams(location.search).get('view') === 'display';

if (isDisplayWindow) {
  document.body.classList.add('offline-display');
  const keyMode = new URLSearchParams(location.search).get('key') === '1';
  document.title = keyMode ? 'Chrono video | TimeStage' : 'Affichage hors ligne | TimeStage';
  const stage = createStage($('#full-stage'));
  if (keyMode) {
    document.body.classList.add('key-mode');
    document.documentElement.classList.add('key-mode');
    $('#full-stage').classList.add('key-mode');
    const raw = (new URLSearchParams(location.search).get('bg') || 'transparent').toLowerCase();
    const backgrounds = { transparent: 'transparent', green: '#00b140', magenta: '#ff00ff', blue: '#0047bb', black: '#000000', white: '#ffffff' };
    $('#full-stage').style.setProperty('--key-bg', backgrounds[raw] || 'transparent');
  }
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

    $('#theme-select').value = state.settings.theme || 'brand';
    renderTuning(state);
    renderColors(state.settings);
    renderEffect(state.effect);
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

  // --- Personnalisation de l'affichage --------------------------------------
  function pct(value) { return Math.round(Number(value) * 100) + ' %'; }

  function renderTuning(state) {
    const st = state.settings;
    const set = (id, value) => { if (document.activeElement !== $(id)) $(id).value = value; };
    set('#timer-scale', st.timerScale ?? 1);
    set('#text-scale', st.textScale ?? 1);
    set('#logo-size', st.logoSize ?? 12);
    set('#logo-opacity', st.logoOpacity ?? 100);
    set('#logo-position', st.logoPosition || 'top-right');
    $('#timer-scale-out').textContent = pct(st.timerScale ?? 1);
    $('#text-scale-out').textContent = pct(st.textScale ?? 1);
    $('#logo-size-out').textContent = Math.round(st.logoSize ?? 12) + ' %';
    $('#logo-opacity-out').textContent = Math.round(st.logoOpacity ?? 100) + ' %';
    for (const button of $$('#align-seg button')) {
      button.setAttribute('aria-pressed', String(button.dataset.align === (st.timerAlign || 'center')));
    }
    for (const button of $$('#logo-seg button')) {
      button.setAttribute('aria-pressed', String(button.dataset.logo === (st.logoMode || 'none')));
    }
    $('#btn-logo-remove').disabled = !state.logoUrl;
    $('#btn-logo-upload').textContent = state.logoUrl ? 'Remplacer l\'image…' : 'Choisir une image…';
  }

  const bindRange = (id, key, format) => {
    const node = $(id);
    const push = () => apply('settings.update', { patch: { [key]: Number(node.value) } });
    node.addEventListener('input', () => { format(Number(node.value)); push(); });
    node.addEventListener('change', push);
  };
  bindRange('#timer-scale', 'timerScale', (v) => ($('#timer-scale-out').textContent = pct(v)));
  bindRange('#text-scale', 'textScale', (v) => ($('#text-scale-out').textContent = pct(v)));
  bindRange('#logo-size', 'logoSize', (v) => ($('#logo-size-out').textContent = Math.round(v) + ' %'));
  bindRange('#logo-opacity', 'logoOpacity', (v) => ($('#logo-opacity-out').textContent = Math.round(v) + ' %'));

  for (const button of $$('#align-seg button')) {
    button.addEventListener('click', () => apply('settings.update', { patch: { timerAlign: button.dataset.align } }));
  }
  for (const button of $$('#logo-seg button')) {
    button.addEventListener('click', () => {
      if (button.dataset.logo === 'custom' && !room.state.logoUrl) return pickLogo();
      apply('settings.update', { patch: { logoMode: button.dataset.logo } });
    });
  }
  $('#logo-position').addEventListener('change', (event) => {
    apply('settings.update', { patch: { logoPosition: event.target.value } });
  });

  // Hors ligne, le logo reste dans ce navigateur : il voyage en data URL vers
  // la fenetre d'affichage par le meme canal que le reste de l'etat.
  function pickLogo() {
    const input = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/svg+xml', style: { display: 'none' } });
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      input.remove();
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = String(reader.result);
        if (file.type === 'image/svg+xml') return apply('logo.set', { dataUrl });
        const img = new Image();
        img.onload = () => {
          const ratio = Math.min(1, 512 / Math.max(img.width, img.height));
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(img.width * ratio));
          canvas.height = Math.max(1, Math.round(img.height * ratio));
          canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
          apply('logo.set', { dataUrl: canvas.toDataURL('image/png') });
        };
        img.onerror = () => toast('Image illisible.', 'error');
        img.src = dataUrl;
      };
      reader.onerror = () => toast('Lecture impossible.', 'error');
      reader.readAsDataURL(file);
    });
    document.body.append(input);
    input.click();
  }

  $('#btn-logo-upload').addEventListener('click', pickLogo);
  $('#btn-logo-remove').addEventListener('click', () => apply('logo.set', { dataUrl: '' }));

  // --- Animations ------------------------------------------------------------
  const fxGrid = $('#fx-grid');
  for (const [name, effect] of Object.entries(EFFECTS)) {
    fxGrid.append(
      el('button', {
        class: 'btn fx-btn',
        type: 'button',
        dataset: { fx: name },
        title: effect.label,
        onclick: () => apply('effect.play', {
          name,
          intensity: Number($('#fx-intensity').value),
          durationMs: Number($('#fx-duration').value),
          loop: $('#fx-loop').checked,
        }),
      }, [
        el('span', { class: 'fx-icon', text: effect.icon, 'aria-hidden': 'true' }),
        el('span', { text: effect.label }),
      ])
    );
  }
  $('#fx-intensity').addEventListener('input', (event) => {
    $('#fx-intensity-out').textContent = event.target.value + ' %';
  });
  $('#btn-fx-stop').addEventListener('click', () => apply('effect.stop', {}));

  function renderEffect(current) {
    const chip = $('#effect-state');
    const active = current?.name ? EFFECTS[current.name] : null;
    chip.textContent = active ? active.label + (current.loop ? ' (boucle)' : '') : 'Aucune';
    chip.className = 'chip ' + (active ? 'accent' : '');
    for (const button of $$('.fx-btn')) {
      button.setAttribute('aria-pressed', String(!!active && button.dataset.fx === current.name));
    }
    $('#btn-fx-stop').disabled = !active;
  }

  // --- Couleurs du chrono ---------------------------------------------------

  function renderColors(settings) {
    const theme = THEME_COLORS[settings.theme] || THEME_COLORS.brand;
    for (const [selector, key] of Object.entries(COLOR_FIELDS)) {
      const node = $(selector);
      if (document.activeElement === node) continue;
      const value = settings[key] || theme[key] || PHASE_DEFAULTS[key] || '#ffffff';
      if (node.value !== value) node.value = value;
    }
  }

  for (const [selector, key] of Object.entries(COLOR_FIELDS)) {
    const node = $(selector);
    node.addEventListener('input', () => apply('settings.update', { patch: { [key]: node.value } }));
  }
  $('#btn-colors-reset').addEventListener('click', () =>
    apply('settings.update', { patch: { colorNormal: '', colorWrapUp: '', colorFinal: '', colorOverrun: '', colorText: '' } })
  );

  $('#btn-open-video').addEventListener('click', () => {
    const url = new URL(location.pathname + '?view=display&key=1', location.href);
    window.open(url, 'timestage-offline-video', 'noopener');
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

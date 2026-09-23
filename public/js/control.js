/*!
 * TimeStage, chronometre de scene
 * © 2026 Arnisound Tools (Theo Arnissolle). Tous droits reserves.
 * Logiciel proprietaire : toute reproduction, modification, distribution ou
 * exploitation sans autorisation ecrite prealable est interdite. Voir LICENSE.
 */
// Fenetre de regie : pilote la salle via WebSocket.

import { $, $$, el, clear, toast, copyText, qrUrl, download, pickFile, relativeTime } from './lib/dom.js';
import { createStage } from './lib/stage.js';
import { RoomConnection, roomUrls } from './lib/net.js';
import { formatDuration, formatLabel, parseDuration, MS } from '../shared/time.js';
import { readTimer } from '../shared/timer.js';
import { EFFECTS } from '../shared/effects.js';

// --- Identification de la salle --------------------------------------------
const params = new URLSearchParams(location.search);
const hashParams = new URLSearchParams(location.hash.replace(/^#/, ''));
const code = (location.pathname.match(/^\/c\/([A-Za-z0-9]{3,8})$/)?.[1] || params.get('room') || '').toUpperCase();

if (!code) location.replace('/');

const tokenKey = 'timestage:token:' + code;
let token = hashParams.get('t') || params.get('token') || localStorage.getItem(tokenKey) || '';
if (hashParams.get('t')) {
  try { localStorage.setItem(tokenKey, token); } catch { /* mode prive */ }
  history.replaceState(null, '', location.pathname + location.search);
}
const conn = new RoomConnection({ code, role: 'control', token });
const previewStage = createStage($('#preview-stage'));
$('#preview-stage').dataset.compact = 'true';
let state = null;
let questionTab = 'pending';

const cmd = (name, payload) => {
  if (!conn.command(name, payload)) toast('Hors ligne : commande non transmise.', 'error');
};
const focused = (node) => document.activeElement === node;
const setValue = (node, value) => { if (!focused(node) && node.value !== String(value)) node.value = value; };

$('#room-code').textContent = code;

// --- Connexion --------------------------------------------------------------
conn.addEventListener('status', (event) => {
  const status = event.detail.status;
  const chip = $('#status');
  chip.className = 'chip ' + (status === 'online' ? 'ok' : status === 'offline' ? 'danger' : '');
  chip.querySelector('.dot').className = 'dot ' + (status === 'online' ? 'ok' : status === 'offline' ? 'danger' : 'warn');
  $('#status-text').textContent =
    status === 'online'
      ? 'Connecte'
      : conn.missingRoom
        ? 'Salle perdue, recreer'
        : status === 'connecting'
          ? 'Connexion…'
          : status === 'offline'
            ? 'Reconnexion…'
            : 'Deconnecte';
  chip.style.cursor = conn.missingRoom ? 'pointer' : '';
  chip.title = conn.missingRoom ? 'Recreer la salle avec le meme code' : '';
});

conn.addEventListener('remote-error', (event) => {
  const { code: errCode, message } = event.detail;
  if (errCode === 'forbidden') {
    askForKey('Cle de regie refusee.');
  } else if (errCode === 'no_room') {
    offerRestore();
  } else {
    toast(message || 'Commande refusee', 'error');
  }
});

conn.addEventListener('state', (event) => {
  state = event.detail;
  saveSnapshot(state);
  render();
});

conn.connect();

// --- Rendu ------------------------------------------------------------------
let lastSignature = '';

function render() {
  if (!state) return;
  const t = state.timer;

  previewStage.update(state, conn.now());
  $('#preview-stage').dataset.theme = state.settings.theme || 'dark';

  setValue($('#session-name'), state.session.name || '');
  setValue($('#title-input'), t.title || '');
  setValue($('#speaker-input'), t.speaker || '');
  setValue($('#display-name'), state.settings.displayName || '');
  setValue($('#duration-input'), formatDuration(t.durationMs, { h: 'auto', m: 'on', s: 'on', ms: 0 }));
  setValue($('#wrapup-input'), formatDuration(t.wrapUpMs, { h: 'off', m: 'on', s: 'on', ms: 0 }));
  setValue($('#final-input'), formatDuration(t.finalMs, { h: 'off', m: 'on', s: 'on', ms: 0 }));

  $('#btn-toggle').textContent = t.running ? 'Pause' : 'Demarrer';
  $('#btn-toggle').className = 'btn lg ' + (t.running ? 'warn' : 'ok');

  for (const button of $$('#mode-seg button')) {
    button.setAttribute('aria-pressed', String(button.dataset.mode === t.mode));
  }
  if (!focused($('#fmt-h'))) $('#fmt-h').value = t.format.h;
  if (!focused($('#fmt-m'))) $('#fmt-m').value = t.format.m;
  if (!focused($('#fmt-s'))) $('#fmt-s').value = t.format.s;
  if (!focused($('#fmt-ms'))) $('#fmt-ms').value = String(t.format.ms);
  $('#format-label').textContent = formatLabel(t.format);
  $('#overrun-input').checked = !!t.overrun;

  $('#auto-advance').checked = !!state.session.autoAdvance;
  $('#questions-open').checked = !!state.settings.questionsOpen;
  $('#questions-chip').textContent = state.settings.questionsOpen ? 'Ouvertes' : 'Fermees';
  $('#questions-chip').className = 'chip ' + (state.settings.questionsOpen ? 'ok' : '');
  $('#require-approval').checked = !!state.settings.requireApproval;
  $('#theme-select').value = state.settings.theme || 'brand';
  renderTuning(state.settings);
  renderColors(state.settings);
  renderEffect(state.effect);
  renderSecurity();
  for (const input of $$('[data-setting]')) input.checked = !!state.settings[input.dataset.setting];
  $('#btn-blackout').setAttribute('aria-pressed', String(!!state.settings.blackout));
  $('#btn-blackout').textContent = state.settings.blackout ? 'Quitter l\'ecran noir' : 'Ecran noir';

  const counts = state.questions.reduce((acc, q) => ((acc[q.status] = (acc[q.status] || 0) + 1), acc), {});
  $('#count-pending').textContent = counts.pending || 0;
  $('#count-approved').textContent = counts.approved || 0;
  $('#parts-count').textContent = `${state.session.parts.length} partie${state.session.parts.length > 1 ? 's' : ''}`;
  const a = state.audience || { display: 0, viewer: 0 };
  $('#audience').textContent = `${a.display} ecran${a.display > 1 ? 's' : ''} · ${a.viewer} public`;

  $('#message-state').textContent = state.message.visible ? 'A l\'ecran' : 'Masque';
  $('#message-state').className = 'chip ' + (state.message.visible ? 'accent' : '');

  // Les listes sont couteuses : on ne les reconstruit qu'en cas de changement.
  const signature = JSON.stringify([
    state.session.parts,
    state.session.activeId,
    state.questions,
    state.shownQuestionId,
    state.presets,
    questionTab,
  ]);
  if (signature !== lastSignature) {
    lastSignature = signature;
    renderParts();
    renderQuestions();
    renderPresets();
  }
}

function renderParts() {
  const list = clear($('#parts-list'));
  if (!state.session.parts.length) {
    list.append(el('li', { class: 'empty', text: 'Aucune partie. Ajoutez le deroule de votre session.' }));
    return;
  }
  state.session.parts.forEach((part, index) => {
    const active = part.id === state.session.activeId;
    const item = el('li', { class: 'list-item' + (active ? ' active' : '') + (part.done ? ' done' : '') }, [
      el('div', { class: 'part-row grow' }, [
        el('span', { class: 'part-index', text: String(index + 1) }),
        el('div', { class: 'part-main' }, [
          el('div', { class: 'part-title', text: part.title }),
          el('div', { class: 'part-meta' }, [
            el('span', { class: 'mono', text: formatDuration(part.durationMs, { h: 'auto', m: 'on', s: 'on', ms: 0 }) }),
            part.speaker ? el('span', { text: '· ' + part.speaker }) : null,
            part.mode === 'countup' ? el('span', { text: '· chrono' }) : null,
            part.notes ? el('span', { text: '· notes' }) : null,
          ]),
        ]),
        el('div', { class: 'part-actions' }, [
          el('button', { class: 'btn sm' + (active ? ' primary' : ''), text: 'Charger', title: 'Charger dans le chrono',
            onclick: () => cmd('session.load', { id: part.id }) }),
          el('button', { class: 'btn sm ghost', text: '▲', title: 'Monter', disabled: index === 0,
            onclick: () => cmd('session.parts.move', { id: part.id, index: index - 1 }) }),
          el('button', { class: 'btn sm ghost', text: '▼', title: 'Descendre', disabled: index === state.session.parts.length - 1,
            onclick: () => cmd('session.parts.move', { id: part.id, index: index + 1 }) }),
          el('button', { class: 'btn sm ghost', text: '✎', title: 'Modifier', onclick: () => editPart(part) }),
          el('button', { class: 'btn sm ghost', text: '✕', title: 'Supprimer', onclick: () => {
            if (confirm(`Supprimer « ${part.title} » ?`)) cmd('session.parts.remove', { id: part.id });
          } }),
        ]),
      ]),
    ]);
    if (part.notes) item.title = part.notes;
    list.append(item);
  });
}

function renderQuestions() {
  const list = clear($('#questions-list'));
  const questions = state.questions
    .filter((q) => (questionTab === 'all' ? true : q.status === questionTab))
    .sort((a, b) => b.createdAt - a.createdAt);

  // La question a l'ecran reste toujours visible, quel que soit l'onglet.
  const onAirQuestion = state.questions.find((q) => q.id === state.shownQuestionId);
  if (onAirQuestion && !questions.includes(onAirQuestion)) questions.unshift(onAirQuestion);

  if (!questions.length) {
    list.append(el('li', {
      class: 'empty',
      text: questionTab === 'pending' ? 'Aucune question en attente.' : 'Rien a afficher ici.',
    }));
    return;
  }

  for (const q of questions) {
    const onAir = state.shownQuestionId === q.id;
    list.append(
      el('li', { class: 'list-item q-item' + (onAir ? ' on-air' : ''), dataset: { status: q.status } }, [
        el('div', { class: 'q-head' }, [
          el('span', { text: q.author ? q.author : 'Anonyme' }),
          el('span', { text: relativeTime(q.createdAt) + (onAir ? ' · a l\'ecran' : '') }),
        ]),
        el('div', { class: 'q-body', text: q.text }),
        el('div', { class: 'q-actions' }, [
          onAir
            ? el('button', { class: 'btn sm warn', text: 'Retirer', onclick: () => cmd('question.hide', {}) })
            : el('button', { class: 'btn sm primary', text: 'Afficher', onclick: () => cmd('question.show', { id: q.id }) }),
          q.status !== 'approved'
            ? el('button', { class: 'btn sm', text: 'Valider', onclick: () => cmd('question.setStatus', { id: q.id, status: 'approved' }) })
            : el('button', { class: 'btn sm', text: 'Archiver', onclick: () => cmd('question.setStatus', { id: q.id, status: 'archived' }) }),
          q.status !== 'rejected'
            ? el('button', { class: 'btn sm ghost', text: 'Rejeter', onclick: () => cmd('question.setStatus', { id: q.id, status: 'rejected' }) })
            : null,
          el('button', { class: 'btn sm danger', text: 'Supprimer', onclick: () => cmd('question.remove', { id: q.id }) }),
        ]),
      ])
    );
  }
}

function renderPresets() {
  const grid = clear($('#presets'));
  for (const preset of state.presets) {
    grid.append(
      el('button', {
        class: 'btn preset',
        type: 'button',
        dataset: { style: preset.style },
        title: 'Envoyer (clic droit pour supprimer)',
        text: preset.text,
        onclick: () => cmd('message.send', { text: preset.text, style: preset.style }),
        oncontextmenu: (event) => {
          event.preventDefault();
          if (!confirm(`Supprimer le preset « ${preset.text} » ?`)) return;
          cmd('message.presets.set', { presets: state.presets.filter((p) => p.id !== preset.id) });
        },
      })
    );
  }
  if (!state.presets.length) grid.append(el('div', { class: 'empty', text: 'Aucun preset.' }));
}

// Rafraichit l'apercu en continu meme sans nouvel etat.
function loop() {
  if (state) {
    previewStage.update(state, conn.now());
    const view = readTimer(state.timer, conn.now());
    const chip = $('#phase-chip');
    const labels = { idle: 'Pret', running: 'En cours', paused: 'En pause', wrapup: 'Bientot fini', final: 'Fin proche', overrun: 'Depassement', clock: 'Horloge' };
    chip.textContent = labels[view.phase] || '';
    chip.className = 'chip ' + (view.phase === 'overrun' || view.phase === 'final' ? 'danger' : view.phase === 'wrapup' ? 'warn' : view.phase === 'running' ? 'ok' : '');
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

// --- Transport --------------------------------------------------------------
$('#btn-toggle').addEventListener('click', () => cmd('timer.toggle'));
$('#btn-reset').addEventListener('click', () => cmd('timer.reset'));
$('#btn-restart').addEventListener('click', () => cmd('timer.restart'));
for (const button of $$('[data-add]')) button.addEventListener('click', () => cmd('timer.add', { ms: Number(button.dataset.add) }));
for (const button of $$('[data-seek]')) button.addEventListener('click', () => cmd('timer.seek', { ms: Number(button.dataset.seek) }));

$('#duration-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const ms = parseDuration($('#duration-input').value, 'm');
  if (ms == null || ms < 0) return toast('Duree illisible. Essayez 5, 5:30, 1h15 ou 90s.', 'error');
  cmd('timer.setDuration', { ms });
  $('#duration-input').blur();
});

const bindText = (selector, build) => {
  const node = $(selector);
  const commit = () => build(node.value);
  node.addEventListener('change', commit);
  node.addEventListener('blur', commit);
  node.addEventListener('keydown', (event) => { if (event.key === 'Enter') { commit(); node.blur(); } });
};
bindText('#title-input', (value) => cmd('timer.setTitle', { title: value }));
bindText('#speaker-input', (value) => cmd('timer.setTitle', { speaker: value }));
bindText('#session-name', (value) => cmd('session.set', { name: value }));
bindText('#display-name', (value) => cmd('settings.update', { patch: { displayName: value } }));
bindText('#wrapup-input', (value) => {
  const ms = parseDuration(value, 'm');
  if (ms != null && ms >= 0) cmd('timer.setThresholds', { wrapUpMs: ms });
});
bindText('#final-input', (value) => {
  const ms = parseDuration(value, 's');
  if (ms != null && ms >= 0) cmd('timer.setThresholds', { finalMs: ms });
});
$('#overrun-input').addEventListener('change', (event) => cmd('timer.setThresholds', { overrun: event.target.checked }));

for (const button of $$('#mode-seg button')) {
  button.addEventListener('click', () => cmd('timer.setMode', { mode: button.dataset.mode }));
}
for (const button of $$('[data-format]')) {
  button.addEventListener('click', () => cmd('timer.setFormat', { format: JSON.parse(button.dataset.format) }));
}
const sendFormat = () =>
  cmd('timer.setFormat', {
    format: { h: $('#fmt-h').value, m: $('#fmt-m').value, s: $('#fmt-s').value, ms: Number($('#fmt-ms').value) },
  });
for (const id of ['#fmt-h', '#fmt-m', '#fmt-s', '#fmt-ms']) $(id).addEventListener('change', sendFormat);

// --- Deroule ----------------------------------------------------------------
$('#btn-prev').addEventListener('click', () => cmd('session.prev'));
$('#btn-next').addEventListener('click', () => cmd('session.next'));
$('#auto-advance').addEventListener('change', (event) => cmd('session.set', { autoAdvance: event.target.checked }));

$('#part-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const title = $('#part-title').value.trim();
  if (!title) return;
  const durationMs = parseDuration($('#part-duration').value, 'm') ?? 10 * MS.m;
  cmd('session.parts.add', { part: { title, durationMs } });
  $('#part-title').value = '';
  $('#part-title').focus();
});

$('#btn-clear-parts').addEventListener('click', () => {
  if (confirm('Supprimer toutes les parties du deroule ?')) cmd('session.replace', { parts: [] });
});

$('#btn-export').addEventListener('click', () => {
  const payload = {
    format: 'timestage.session.v1',
    name: state?.session.name || '',
    exportedAt: new Date().toISOString(),
    parts: (state?.session.parts || []).map(({ id, done, ...rest }) => rest),
  };
  const slug = (payload.name || 'session').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  download(`timestage-${slug || 'session'}.json`, JSON.stringify(payload, null, 2));
});

$('#btn-import').addEventListener('click', async () => {
  const file = await pickFile();
  if (!file) return;
  try {
    const data = JSON.parse(file.text);
    const parts = Array.isArray(data) ? data : data.parts;
    if (!Array.isArray(parts)) throw new Error('aucune partie trouvee');
    cmd('session.replace', { parts, name: data.name || state?.session.name });
    toast(`${parts.length} partie(s) importee(s)`, 'ok');
  } catch (err) {
    toast('Import impossible : ' + err.message, 'error');
  }
});

let editing = null;
function editPart(part) {
  editing = part;
  $('#edit-title').value = part.title;
  $('#edit-speaker').value = part.speaker || '';
  $('#edit-duration').value = formatDuration(part.durationMs, { h: 'auto', m: 'on', s: 'on', ms: 0 });
  $('#edit-mode').value = part.mode || 'countdown';
  $('#edit-notes').value = part.notes || '';
  $('#part-dialog').showModal();
}
$('#part-dialog').addEventListener('close', () => {
  if ($('#part-dialog').returnValue !== 'save' || !editing) return;
  cmd('session.parts.update', {
    id: editing.id,
    patch: {
      title: $('#edit-title').value.trim() || editing.title,
      speaker: $('#edit-speaker').value.trim(),
      durationMs: parseDuration($('#edit-duration').value, 'm') ?? editing.durationMs,
      mode: $('#edit-mode').value,
      notes: $('#edit-notes').value,
    },
  });
  editing = null;
});

// --- Affichage / reglages ---------------------------------------------------
for (const input of $$('[data-setting]')) {
  input.addEventListener('change', () => cmd('settings.update', { patch: { [input.dataset.setting]: input.checked } }));
}
$('#theme-select').addEventListener('change', (event) => cmd('settings.update', { patch: { theme: event.target.value } }));
$('#btn-blackout').addEventListener('click', () => cmd('settings.update', { patch: { blackout: !state?.settings.blackout } }));

// --- Personnalisation de l'affichage ----------------------------------------
function pct(value) { return Math.round(Number(value) * 100) + ' %'; }

function renderTuning(settings) {
  const set = (id, value) => { if (document.activeElement !== $(id)) $(id).value = value; };
  set('#timer-scale', settings.timerScale ?? 1);
  set('#text-scale', settings.textScale ?? 1);
  set('#logo-size', settings.logoSize ?? 12);
  set('#logo-opacity', settings.logoOpacity ?? 100);
  set('#logo-position', settings.logoPosition || 'top-right');
  $('#timer-scale-out').textContent = pct(settings.timerScale ?? 1);
  $('#text-scale-out').textContent = pct(settings.textScale ?? 1);
  $('#logo-size-out').textContent = Math.round(settings.logoSize ?? 12) + ' %';
  $('#logo-opacity-out').textContent = Math.round(settings.logoOpacity ?? 100) + ' %';
  for (const button of $$('#align-seg button')) {
    button.setAttribute('aria-pressed', String(button.dataset.align === (settings.timerAlign || 'center')));
  }
  for (const button of $$('#logo-seg button')) {
    button.setAttribute('aria-pressed', String(button.dataset.logo === (settings.logoMode || 'none')));
  }
  const hasLogo = !!state?.logoUrl;
  $('#btn-logo-remove').disabled = !hasLogo;
  $('#btn-logo-upload').textContent = hasLogo ? 'Remplacer l\'image…' : 'Choisir une image…';
}

// Les curseurs envoient en continu : on limite la cadence pour ne pas noyer
// la liaison, et on confirme toujours la valeur finale.
function throttledSetting(key, node, format) {
  let timer = null;
  let pending = null;
  const flush = () => {
    timer = null;
    if (pending === null) return;
    cmd('settings.update', { patch: { [key]: pending } });
    pending = null;
  };
  node.addEventListener('input', () => {
    const value = Number(node.value);
    if (format) format(value);
    pending = value;
    if (!timer) timer = setTimeout(flush, 120);
  });
  node.addEventListener('change', () => {
    pending = Number(node.value);
    if (timer) clearTimeout(timer);
    flush();
  });
}

throttledSetting('timerScale', $('#timer-scale'), (v) => ($('#timer-scale-out').textContent = pct(v)));
throttledSetting('textScale', $('#text-scale'), (v) => ($('#text-scale-out').textContent = pct(v)));
throttledSetting('logoSize', $('#logo-size'), (v) => ($('#logo-size-out').textContent = Math.round(v) + ' %'));
throttledSetting('logoOpacity', $('#logo-opacity'), (v) => ($('#logo-opacity-out').textContent = Math.round(v) + ' %'));

for (const button of $$('#align-seg button')) {
  button.addEventListener('click', () => cmd('settings.update', { patch: { timerAlign: button.dataset.align } }));
}
for (const button of $$('#logo-seg button')) {
  button.addEventListener('click', async () => {
    if (button.dataset.logo === 'custom' && !state?.logoUrl) return uploadLogo();
    cmd('settings.update', { patch: { logoMode: button.dataset.logo } });
  });
}
$('#logo-position').addEventListener('change', (event) => {
  cmd('settings.update', { patch: { logoPosition: event.target.value } });
});
$('#btn-tune-reset').addEventListener('click', () => {
  cmd('settings.update', {
    patch: { timerScale: 1, textScale: 1, timerAlign: 'center', logoSize: 12, logoOpacity: 100, logoPosition: 'top-right' },
  });
});

const LOGO_KEY = 'timestage:logo:' + code;
const ACCESS_KEY = 'timestage:access:' + code;

// --- Animations -------------------------------------------------------------
let fxLayer = 'auto';

const fxGrid = $('#fx-grid');
for (const [name, effect] of Object.entries(EFFECTS)) {
  fxGrid.append(
    el('button', {
      class: 'btn fx-btn',
      type: 'button',
      dataset: { fx: name },
      title: effect.label,
      onclick: () => playEffect(name),
    }, [
      el('span', { class: 'fx-icon', text: effect.icon, 'aria-hidden': 'true' }),
      el('span', { text: effect.label }),
    ])
  );
}

function playEffect(name) {
  cmd('effect.play', {
    name,
    intensity: Number($('#fx-intensity').value),
    durationMs: Number($('#fx-duration').value),
    loop: $('#fx-loop').checked,
    ...(fxLayer === 'auto' ? {} : { layer: fxLayer }),
  });
}

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

$('#fx-intensity').addEventListener('input', (event) => {
  $('#fx-intensity-out').textContent = event.target.value + ' %';
});
for (const button of $$('#fx-layer-seg button')) {
  button.addEventListener('click', () => {
    fxLayer = button.dataset.layer;
    for (const other of $$('#fx-layer-seg button')) {
      other.setAttribute('aria-pressed', String(other === button));
    }
  });
}
$('#btn-fx-stop').addEventListener('click', () => cmd('effect.stop', {}));

// --- Sections de la regie ---------------------------------------------------
// L'etat plie/deplie suit l'utilisateur d'une session a l'autre.
const SECTIONS_KEY = 'timestage:sections';
let openSections = null;
try { openSections = JSON.parse(localStorage.getItem(SECTIONS_KEY) || 'null'); } catch { /* prive */ }
for (const section of $$('details.section')) {
  const name = section.dataset.section;
  if (openSections && name in openSections) section.open = !!openSections[name];
  section.addEventListener('toggle', () => {
    const map = {};
    for (const other of $$('details.section')) map[other.dataset.section] = other.open;
    try { localStorage.setItem(SECTIONS_KEY, JSON.stringify(map)); } catch { /* prive */ }
  });
}

// --- Couleurs du chrono -----------------------------------------------------
// Une couleur vide veut dire « celle du theme » : le selecteur natif ne sait
// pas representer ce vide, on l'amorce donc avec la valeur du theme courant.
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

function renderColors(settings) {
  const theme = THEME_COLORS[settings.theme] || THEME_COLORS.brand;
  for (const [selector, key] of Object.entries(COLOR_FIELDS)) {
    const node = $(selector);
    if (document.activeElement === node) continue;
    const value = settings[key] || theme[key] || PHASE_DEFAULTS[key] || '#ffffff';
    if (node.value !== value) node.value = value;
    node.classList.toggle('is-default', !settings[key]);
  }
}

for (const [selector, key] of Object.entries(COLOR_FIELDS)) {
  const node = $(selector);
  let timer = null;
  const push = () => cmd('settings.update', { patch: { [key]: node.value } });
  node.addEventListener('input', () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(push, 120);
  });
  node.addEventListener('change', () => {
    if (timer) clearTimeout(timer);
    push();
  });
}

$('#btn-colors-reset').addEventListener('click', () => {
  cmd('settings.update', {
    patch: { colorNormal: '', colorWrapUp: '', colorFinal: '', colorOverrun: '', colorText: '' },
  });
  toast('Couleurs du theme retablies', 'ok');
});

// --- Securite de la session -------------------------------------------------
const readAccess = () => { try { return localStorage.getItem(ACCESS_KEY) || ''; } catch { return ''; } };
const writeAccess = (value) => { try { localStorage.setItem(ACCESS_KEY, value || ''); } catch { /* prive */ } };

function renderSecurity() {
  const on = !!state?.hasAccessCode;
  const chip = $('#security-state');
  chip.textContent = on ? 'Salle protegee' : 'Salle ouverte';
  chip.className = 'chip ' + (on ? 'ok' : 'warn');
  if (document.activeElement !== $('#access-input')) $('#access-input').value = on ? readAccess() : '';
  $('#btn-access-clear').disabled = !on;
}

$('#access-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const value = $('#access-input').value.trim();
  if (value.length < 4) return toast('Le code doit faire au moins 4 caracteres.', 'error');
  writeAccess(value);
  urls = roomUrls(code, token, value);
  cmd('room.setAccessCode', { code: value });
  toast('Salle protegee. Les QR codes contiennent le code.', 'ok', 6000);
});

$('#btn-access-clear').addEventListener('click', () => {
  if (!confirm('Retirer le code d\'acces ? La salle redeviendra ouverte a qui connait son code.')) return;
  writeAccess('');
  urls = roomUrls(code, token, null);
  cmd('room.setAccessCode', { code: '' });
});

$('#btn-rotate-key').addEventListener('click', () => {
  if (!confirm('Renouveler la cle de regie ? Les liens de regie deja partages cesseront de fonctionner.')) return;
  cmd('room.rotateKey', {});
});

// Le serveur renvoie la nouvelle cle a la seule regie qui l'a demandee.
conn.addEventListener('message', (event) => {
  if (event.detail.t !== 'key' || !event.detail.ownerToken) return;
  token = event.detail.ownerToken;
  try { localStorage.setItem(tokenKey, token); } catch { /* prive */ }
  conn.token = token;
  urls = roomUrls(code, token, readAccess() || null);
  toast('Cle renouvelee. Repartagez le QR code de regie.', 'ok', 7000);
});

/**
 * Prepare l'image : les matriciels sont redimensionnes a 512 px de cote, ce qui
 * suffit largement pour un ecran de scene et garde la salle legere. Les SVG
 * passent tels quels, ils sont vectoriels.
 */
function prepareLogo(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('lecture impossible'));
    reader.onload = () => {
      const dataUrl = String(reader.result);
      if (file.type === 'image/svg+xml') return resolve(dataUrl);
      const img = new Image();
      img.onerror = () => reject(new Error('image illisible'));
      img.onload = () => {
        const max = 512;
        const ratio = Math.min(1, max / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.width * ratio));
        canvas.height = Math.max(1, Math.round(img.height * ratio));
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/png'));
      };
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
  });
}

async function sendLogo(dataUrl) {
  const response = await fetch(`/api/rooms/${code}/logo`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, dataUrl }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'envoi impossible');
  return data;
}

async function uploadLogo() {
  const input = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/svg+xml', style: { display: 'none' } });
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    input.remove();
    if (!file) return;
    try {
      const dataUrl = await prepareLogo(file);
      await sendLogo(dataUrl);
      // Conserve pour pouvoir le renvoyer si la salle doit etre recreee.
      try { localStorage.setItem(LOGO_KEY, dataUrl); } catch { /* quota */ }
      toast('Logo envoye', 'ok');
    } catch (err) {
      toast('Logo refuse : ' + err.message, 'error', 6000);
    }
  });
  document.body.append(input);
  input.click();
}

$('#btn-logo-upload').addEventListener('click', uploadLogo);
$('#btn-logo-remove').addEventListener('click', async () => {
  try {
    await fetch(`/api/rooms/${code}/logo`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    try { localStorage.removeItem(LOGO_KEY); } catch { /* prive */ }
    toast('Logo retire', 'ok');
  } catch (err) {
    toast('Retrait impossible : ' + err.message, 'error');
  }
});

// --- Messages ---------------------------------------------------------------
$('#message-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const text = $('#message-text').value.trim();
  if (!text) return toast('Message vide.', 'error');
  cmd('message.send', {
    text,
    style: $('#message-style').value,
    flash: $('#message-flash').checked,
    autoHideMs: Number($('#message-auto').value),
  });
});
$('#btn-hide-message').addEventListener('click', () => cmd('message.hide'));
$('#btn-save-preset').addEventListener('click', () => {
  const text = $('#message-text').value.trim();
  if (!text) return toast('Ecrivez d\'abord un message.', 'error');
  cmd('message.presets.set', {
    presets: [...(state?.presets || []), { text, style: $('#message-style').value }],
  });
  toast('Preset ajoute', 'ok');
});

// --- Questions --------------------------------------------------------------
for (const tab of $$('#q-tabs button')) {
  tab.addEventListener('click', () => {
    questionTab = tab.dataset.tab;
    for (const other of $$('#q-tabs button')) other.setAttribute('aria-selected', String(other === tab));
    lastSignature = '';
    render();
  });
}
$('#questions-open').addEventListener('change', (event) => cmd('settings.update', { patch: { questionsOpen: event.target.checked } }));
$('#require-approval').addEventListener('change', (event) => cmd('settings.update', { patch: { requireApproval: event.target.checked } }));
$('#btn-clear-questions').addEventListener('click', () => {
  if (confirm('Effacer toutes les questions ?')) cmd('question.clear', {});
});

// --- Partage ----------------------------------------------------------------
let urls = roomUrls(code, token, (() => { try { return localStorage.getItem('timestage:access:' + code) || null; } catch { return null; } })());
$('#btn-open-display').addEventListener('click', () => window.open(urls.display, 'timestage-display-' + code, 'noopener'));
$('#btn-qr-ask').addEventListener('click', () => openShare('ask'));
$('#btn-share').addEventListener('click', () => openShare());

function openShare(focus = null) {
  $('#share-code').textContent = code;
  const grid = clear($('#qr-grid'));
  const cards = [
    { key: 'display', title: 'Affichage', hint: state?.hasAccessCode ? 'Code d\'acces inclus' : 'Ecran de scene, retour, second appareil', url: urls.display },
    { key: 'video', title: 'Chrono video (alpha)', hint: 'Source navigateur pour melangeur video', url: urls.video },
    { key: 'ask', title: 'Questions du public', hint: state?.hasAccessCode ? 'Code d\'acces inclus' : 'A projeter ou imprimer', url: urls.ask },
    { key: 'control', title: 'Regie (cle incluse)', hint: 'Prendre la main depuis une tablette', url: urls.control },
  ].filter((card) => !focus || card.key === focus);

  for (const card of cards) {
    grid.append(
      el('div', { class: 'qr-card' }, [
        el('strong', { text: card.title }),
        el('div', { class: 'qr-frame' }, [el('img', { src: qrUrl(card.url), alt: 'QR code ' + card.title, width: 220, height: 220, loading: 'lazy' })]),
        el('small', { class: 'muted', text: card.hint }),
        el('div', { class: 'qr-link', text: card.url }),
        el('div', { class: 'row tight' }, [
          el('button', { class: 'btn sm', text: 'Copier le lien', onclick: async () => {
            const ok = await copyText(card.url);
            toast(ok ? 'Lien copie' : 'Copie impossible', ok ? 'ok' : 'error');
          } }),
          el('a', { class: 'btn sm ghost', href: card.url, target: '_blank', rel: 'noopener', text: 'Ouvrir' }),
        ]),
      ])
    );
  }
  $('#share-dialog').showModal();
}

for (const button of $$('[data-close]')) {
  button.addEventListener('click', () => button.closest('dialog')?.close());
}
$('#btn-help').addEventListener('click', () => $('#help-dialog').showModal());

// --- Salle perdue : sauvegarde locale et retablissement ----------------------
// L'hebergement gratuit redemarre (mise en veille, deploiement) et les salles
// vivent en memoire. On garde donc ici de quoi rebatir la salle a l'identique,
// avec le meme code : les QR codes distribues restent valables et les ecrans
// ouverts se reconnectent tout seuls.
const snapshotKey = 'timestage:snapshot:' + code;

function saveSnapshot(current) {
  if (!current) return;
  const t = current.timer;
  const snapshot = {
    at: Date.now(),
    name: current.session.name,
    parts: current.session.parts,
    autoAdvance: current.session.autoAdvance,
    settings: current.settings,
    presets: current.presets,
    hadAccessCode: !!current.hasAccessCode,
    timer: {
      mode: t.mode,
      durationMs: t.durationMs,
      format: t.format,
      wrapUpMs: t.wrapUpMs,
      finalMs: t.finalMs,
      overrun: t.overrun,
      title: t.title,
      speaker: t.speaker,
    },
  };
  try { localStorage.setItem(snapshotKey, JSON.stringify(snapshot)); } catch { /* mode prive */ }
}

function loadSnapshot() {
  try { return JSON.parse(localStorage.getItem(snapshotKey) || 'null'); } catch { return null; }
}

let restoreDismissed = false;
function offerRestore() {
  const dialog = $('#lost-dialog');
  if (dialog.open || restoreDismissed || $('#key-dialog').open) return;
  $('#lost-code').textContent = code;
  $('#lost-status').classList.add('hidden');
  $('#lost-restore').disabled = false;
  dialog.showModal();
}

/** Rejoue la session sauvegardee sur une salle fraichement creee. */
function replaySnapshot(snapshot) {
  if (!snapshot) return;
  if (snapshot.parts?.length || snapshot.name) {
    cmd('session.replace', { parts: snapshot.parts || [], name: snapshot.name || '' });
  }
  if (snapshot.autoAdvance) cmd('session.set', { autoAdvance: true });
  if (snapshot.settings) cmd('settings.update', { patch: snapshot.settings });
  if (snapshot.presets?.length) cmd('message.presets.set', { presets: snapshot.presets });
  const savedAccess = readAccess();
  if (savedAccess && snapshot.hadAccessCode) cmd('room.setAccessCode', { code: savedAccess });
  // Le logo televerse vit sur le serveur : on le renvoie apres une recreation.
  let storedLogo = null;
  try { storedLogo = localStorage.getItem(LOGO_KEY); } catch { /* prive */ }
  if (storedLogo && snapshot.settings?.logoMode === 'custom') {
    sendLogo(storedLogo).catch(() => toast('Logo a renvoyer manuellement.', 'error', 6000));
  }
  const t = snapshot.timer;
  if (!t) return;
  if (t.mode && t.mode !== 'countdown') cmd('timer.setMode', { mode: t.mode });
  cmd('timer.setDuration', { ms: t.durationMs });
  cmd('timer.setFormat', { format: t.format });
  cmd('timer.setThresholds', { wrapUpMs: t.wrapUpMs, finalMs: t.finalMs, overrun: t.overrun });
  if (t.title || t.speaker) cmd('timer.setTitle', { title: t.title, speaker: t.speaker });
}

async function recreateRoom({ keepCode }) {
  const snapshot = loadSnapshot();
  const status = $('#lost-status');
  status.classList.remove('hidden');
  status.textContent = keepCode ? 'Recreation de la salle…' : 'Creation d\'une nouvelle salle…';
  $('#lost-restore').disabled = true;

  try {
    const response = await fetch('/api/rooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: snapshot?.name || '', ...(keepCode ? { code } : {}) }),
    });
    const data = await response.json().catch(() => ({}));

    if (response.status === 409) {
      // Le code a ete repris entre-temps : la salle est peut-etre revenue.
      status.textContent = 'Ce code est de nouveau pris. Tentative de reconnexion…';
      conn.attempt = 0;
      conn.connect();
      return;
    }
    if (!response.ok) throw new Error(data.error || 'creation impossible');

    try { localStorage.setItem('timestage:token:' + data.code, data.ownerToken); } catch { /* prive */ }

    if (data.code !== code) {
      // Nouveau code : on recharge la regie dessus, la session sera rejouee.
      try { localStorage.setItem('timestage:snapshot:' + data.code, JSON.stringify(snapshot || {})); } catch { /* prive */ }
      location.href = `/c/${data.code}#t=${encodeURIComponent(data.ownerToken)}&restore=1`;
      return;
    }

    token = data.ownerToken;
    try { localStorage.setItem(tokenKey, token); } catch { /* prive */ }
    urls = roomUrls(code, token);
    pendingRestore = snapshot;
    conn.token = token;
    conn.closedByUser = false;
    conn.attempt = 0;
    conn.connect();
    $('#lost-dialog').close();
  } catch (err) {
    status.textContent = 'Echec : ' + err.message;
    $('#lost-restore').disabled = false;
  }
}

let pendingRestore = hashParams.get('restore') === '1' ? loadSnapshot() : null;
conn.addEventListener('welcome', () => {
  restoreDismissed = false;
  if (!pendingRestore) return;
  const snapshot = pendingRestore;
  pendingRestore = null;
  replaySnapshot(snapshot);
  toast('Salle retablie. Les ecrans se reconnectent automatiquement.', 'ok', 7000);
});

$('#lost-restore').addEventListener('click', () => recreateRoom({ keepCode: true }));
$('#lost-new').addEventListener('click', () => recreateRoom({ keepCode: false }));
$('#lost-ignore').addEventListener('click', () => {
  restoreDismissed = true;
  $('#lost-dialog').close();
  toast('Cliquez sur l\'etat de connexion pour recreer la salle.', '', 6000);
});
// L'indicateur de connexion redonne acces au retablissement.
$('#status').addEventListener('click', () => {
  if (!conn.missingRoom) return;
  restoreDismissed = false;
  offerRestore();
});

// --- Cle de regie manquante -------------------------------------------------
function askForKey(reason = '') {
  const dialog = $('#key-dialog');
  if (dialog.open) return;
  $('#key-code').textContent = code;
  $('#key-display-link').href = urls.display;
  if (reason) toast(reason, 'error', 6000);
  dialog.showModal();
}

$('#key-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const raw = $('#key-input').value.trim();
  // On accepte le lien complet comme la cle seule.
  const match = raw.match(/[#&?]t=([^&\s]+)/);
  const value = decodeURIComponent(match ? match[1] : raw);
  if (!value) return toast('Collez le lien de regie ou la cle.', 'error');
  token = value;
  try { localStorage.setItem(tokenKey, token); } catch { /* mode prive */ }
  $('#key-dialog').close();
  $('#key-input').value = '';
  urls = roomUrls(code, token);
  conn.token = token;
  conn.closedByUser = false;
  conn.attempt = 0;
  conn.connect();
});

if (!token) askForKey();

// --- Raccourcis clavier -----------------------------------------------------
document.addEventListener('keydown', (event) => {
  const tag = document.activeElement?.tagName;
  const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || document.activeElement?.isContentEditable;
  if (event.key === 'Escape' && !document.querySelector('dialog[open]')) {
    cmd('message.hide');
    return;
  }
  if (typing || event.metaKey || event.ctrlKey || event.altKey) return;

  switch (event.key) {
    case ' ':
      event.preventDefault();
      cmd('timer.toggle');
      break;
    case 'r': cmd('timer.reset'); break;
    case 'R': cmd('timer.restart'); break;
    case 'n': case 'N': cmd('session.next'); break;
    case 'p': case 'P': cmd('session.prev'); break;
    case 'b': case 'B': cmd('settings.update', { patch: { blackout: !state?.settings.blackout } }); break;
    case 'm': case 'M':
      event.preventDefault();
      $('#message-text').focus();
      break;
    case 'ArrowUp': event.preventDefault(); cmd('timer.add', { ms: MS.m }); break;
    case 'ArrowDown': event.preventDefault(); cmd('timer.add', { ms: -MS.m }); break;
  }
});

window.addEventListener('beforeunload', (event) => {
  if (state?.timer.running) {
    event.preventDefault();
    event.returnValue = '';
  }
});

if ('serviceWorker' in navigator) navigator.serviceWorker.register(new URL('../sw.js', import.meta.url)).catch(() => {});

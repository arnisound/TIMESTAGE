// Fenetre de regie : pilote la salle via WebSocket.

import { $, $$, el, clear, toast, copyText, qrUrl, download, pickFile, relativeTime } from './lib/dom.js';
import { createStage } from './lib/stage.js';
import { RoomConnection, roomUrls } from './lib/net.js';
import { formatDuration, formatLabel, parseDuration, MS } from '../shared/time.js';
import { readTimer } from '../shared/timer.js';

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
        ? 'Salle perdue — recreer'
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
  $('#require-approval').checked = !!state.settings.requireApproval;
  $('#theme-select').value = state.settings.theme || 'dark';
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
        title: 'Envoyer — clic droit pour supprimer',
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
let urls = roomUrls(code, token);
$('#btn-open-display').addEventListener('click', () => window.open(urls.display, 'timestage-display-' + code, 'noopener'));
$('#btn-qr-ask').addEventListener('click', () => openShare('ask'));
$('#btn-share').addEventListener('click', () => openShare());

function openShare(focus = null) {
  $('#share-code').textContent = code;
  const grid = clear($('#qr-grid'));
  const cards = [
    { key: 'display', title: 'Affichage', hint: 'Ecran de scene, retour, second appareil', url: urls.display },
    { key: 'ask', title: 'Questions du public', hint: 'A projeter ou imprimer', url: urls.ask },
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

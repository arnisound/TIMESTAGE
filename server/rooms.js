// Etat des salles TimeStage : chrono, deroule de session, messages et questions.
// Tout est garde en memoire et sauvegarde periodiquement sur disque pour
// survivre a un redemarrage du serveur.

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { MS } from '../shared/time.js';
import * as T from '../shared/timer.js';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sans I, O, 0, 1
const CODE_LENGTH = 5;
const MAX_PARTS = 200;
const MAX_QUESTIONS = 400;
const MAX_PRESETS = 20;
const ROOM_TTL_MS = 48 * MS.h;

const CODE_RE = new RegExp(`^[${CODE_ALPHABET}]{4,8}$`);

/** Normalise un code fourni par un client ; null s'il est inexploitable. */
export function normalizeCode(value) {
  const code = String(value == null ? '' : value).trim().toUpperCase();
  return CODE_RE.test(code) ? code : null;
}

export function makeCode(length = CODE_LENGTH) {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

export function makeToken() {
  return randomBytes(24).toString('base64url');
}

export function makeId(prefix = 'id') {
  return prefix + '_' + randomBytes(8).toString('base64url');
}

/** Nettoie un texte libre venant d'un client. */
export function cleanText(value, maxLength = 200, { multiline = false } = {}) {
  let s = String(value == null ? '' : value);
  s = s.replace(multiline ? /[\u0000-\u0009\u000b-\u001f\u007f]/g : /[\u0000-\u001f\u007f]/g, ' ');
  if (multiline) s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim().slice(0, maxLength);
}

function clampInt(value, min, max, fallback = min) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * Schema des reglages : type par cle, pour valider ce qui arrive du client.
 * 'bool' | 'text:<max>' | ['a','b'] (enum) | {min, max} (nombre borne)
 */
const SETTINGS_SCHEMA = {
  questionsOpen: 'bool',
  requireApproval: 'bool',
  showTitle: 'bool',
  showSpeaker: 'bool',
  showClock: 'bool',
  showProgress: 'bool',
  showNextPart: 'bool',
  blackout: 'bool',
  flashOnEnd: 'bool',
  theme: ['dark', 'brand', 'light', 'contrast'],
  displayName: 'text:80',
  // Personnalisation de l'affichage
  timerScale: { min: 0.4, max: 1.6 },
  timerAlign: ['top', 'center', 'bottom'],
  textScale: { min: 0.5, max: 2 },
  logoMode: ['none', 'timestage', 'custom'],
  logoPosition: ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'center'],
  logoSize: { min: 4, max: 60 },
  logoOpacity: { min: 10, max: 100 },
};

export function defaultSettings() {
  return {
    questionsOpen: true,
    requireApproval: true,
    showTitle: true,
    showSpeaker: true,
    showClock: true,
    showProgress: true,
    showNextPart: true,
    blackout: false,
    theme: 'brand',
    flashOnEnd: true,
    displayName: '',
    timerScale: 1,
    timerAlign: 'center',
    textScale: 1,
    logoMode: 'none',
    logoPosition: 'top-right',
    logoSize: 12,
    logoOpacity: 100,
  };
}

/** Applique un lot de reglages en respectant le schema. Renvoie le nombre retenu. */
export function applySettings(settings, patch = {}) {
  let applied = 0;
  for (const [key, rule] of Object.entries(SETTINGS_SCHEMA)) {
    if (!(key in patch)) continue;
    const value = patch[key];
    if (rule === 'bool') settings[key] = !!value;
    else if (typeof rule === 'string' && rule.startsWith('text:')) {
      settings[key] = cleanText(value, Number(rule.slice(5)));
    } else if (Array.isArray(rule)) {
      if (!rule.includes(value)) continue;
      settings[key] = value;
    } else {
      const n = Number(value);
      if (!Number.isFinite(n)) continue;
      settings[key] = Math.min(rule.max, Math.max(rule.min, Math.round(n * 100) / 100));
    }
    applied += 1;
  }
  return applied;
}

export function defaultMessage() {
  return { text: '', style: 'info', visible: false, flash: false, sentAt: 0, autoHideMs: 0 };
}

export function defaultPresets() {
  return [
    { id: makeId('p'), text: 'Merci de conclure', style: 'warn' },
    { id: makeId('p'), text: 'Parlez plus fort', style: 'info' },
    { id: makeId('p'), text: 'Ralentissez', style: 'info' },
    { id: makeId('p'), text: 'Temps ecoule', style: 'alert' },
  ];
}

export function createRoomState(code, name = '') {
  const now = Date.now();
  return {
    code,
    ownerToken: makeToken(),
    createdAt: now,
    updatedAt: now,
    rev: 1,
    timer: T.defaultTimer(),
    session: { name: cleanText(name, 80), autoAdvance: false, activeId: null, parts: [] },
    message: defaultMessage(),
    presets: defaultPresets(),
    questions: [],
    shownQuestionId: null,
    settings: defaultSettings(),
    logo: null, // { data: base64, type: 'image/png', version: n }
  };
}

const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'];
const LOGO_MAX_BYTES = 400 * 1024;

/**
 * Enregistre le logo de l'evenement, fourni en data URL par la regie.
 * Stocke a part de l'etat : il ne transite pas a chaque diffusion.
 */
export function setRoomLogo(room, dataUrl, now = Date.now()) {
  const match = /^data:([\w/+.-]+);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || '').trim());
  if (!match) return { ok: false, error: 'Image illisible.' };
  const [, type, base64] = match;
  if (!LOGO_TYPES.includes(type)) return { ok: false, error: 'Format accepte : PNG, JPEG, WebP ou SVG.' };
  const bytes = Math.floor((base64.length * 3) / 4);
  if (bytes > LOGO_MAX_BYTES) return { ok: false, error: 'Image trop lourde (400 ko maximum).' };

  room.logo = { data: base64, type, version: (room.logo?.version || 0) + 1, at: now };
  room.settings.logoMode = 'custom';
  room.updatedAt = now;
  room.rev += 1;
  return { ok: true, version: room.logo.version };
}

export function clearRoomLogo(room, now = Date.now()) {
  if (!room.logo) return false;
  room.logo = null;
  if (room.settings.logoMode === 'custom') room.settings.logoMode = 'none';
  room.updatedAt = now;
  room.rev += 1;
  return true;
}

/** Vue publique : ni jeton de controle, ni binaire du logo. */
export function publicState(room) {
  const { ownerToken, logo, ...rest } = room;
  return {
    ...rest,
    // L'image est servie par une route dediee, versionnee pour le cache.
    logoUrl: logo ? `/api/rooms/${room.code}/logo?v=${logo.version}` : '',
  };
}

/** Vue destinee a l'affichage et au public : pas de questions en attente. */
export function viewerState(room) {
  const state = publicState(room);
  const shown = room.questions.find((q) => q.id === room.shownQuestionId && q.status === 'approved');
  return {
    ...state,
    questions: shown ? [shown] : [],
    questionCounts: countQuestions(room),
  };
}

export function countQuestions(room) {
  const counts = { pending: 0, approved: 0, rejected: 0, archived: 0, total: room.questions.length };
  for (const q of room.questions) counts[q.status] = (counts[q.status] || 0) + 1;
  return counts;
}

function sanitizePart(input, fallbackId) {
  return {
    id: cleanText(input?.id, 64) || fallbackId || makeId('part'),
    title: cleanText(input?.title, 120) || 'Sans titre',
    speaker: cleanText(input?.speaker, 120),
    durationMs: clampInt(input?.durationMs, 0, 24 * MS.h, 5 * MS.m),
    notes: cleanText(input?.notes, 2000, { multiline: true }),
    mode: T.MODES.includes(input?.mode) ? input.mode : 'countdown',
    done: !!input?.done,
  };
}

function partIndex(room, id) {
  return room.session.parts.findIndex((p) => p.id === id);
}

// ---------------------------------------------------------------------------
// Commandes de la fenetre de controle
// ---------------------------------------------------------------------------

/**
 * Applique une commande sur une salle.
 * @returns {{ok:boolean, error?:string}}
 */
export function applyCommand(room, name, payload = {}, now = Date.now()) {
  const p = payload || {};
  switch (name) {
    case 'timer.start':
      room.timer = T.start(room.timer, now);
      break;
    case 'timer.pause':
      room.timer = T.pause(room.timer, now);
      break;
    case 'timer.toggle':
      room.timer = T.toggle(room.timer, now);
      break;
    case 'timer.reset':
      room.timer = T.reset(room.timer, now);
      break;
    case 'timer.restart':
      room.timer = T.restart(room.timer, now);
      break;
    case 'timer.add':
      room.timer = T.addTime(room.timer, now, clampInt(p.ms, -24 * MS.h, 24 * MS.h, 0));
      break;
    case 'timer.seek':
      room.timer = T.seek(room.timer, now, clampInt(p.ms, -24 * MS.h, 24 * MS.h, 0));
      break;
    case 'timer.setDuration':
      room.timer = T.setDuration(room.timer, now, p.ms, { restart: !!p.restart });
      break;
    case 'timer.setMode':
      room.timer = T.setMode(room.timer, now, p.mode);
      break;
    case 'timer.setFormat':
      room.timer = T.sanitizeTimer({ ...room.timer, format: p.format });
      break;
    case 'timer.setThresholds':
      room.timer = T.sanitizeTimer({
        ...room.timer,
        wrapUpMs: p.wrapUpMs ?? room.timer.wrapUpMs,
        finalMs: p.finalMs ?? room.timer.finalMs,
        overrun: p.overrun ?? room.timer.overrun,
      });
      break;
    case 'timer.setTitle':
      room.timer = {
        ...room.timer,
        title: cleanText(p.title ?? room.timer.title, 120),
        speaker: cleanText(p.speaker ?? room.timer.speaker, 120),
      };
      break;

    case 'session.set':
      if (p.name !== undefined) room.session.name = cleanText(p.name, 80);
      if (p.autoAdvance !== undefined) room.session.autoAdvance = !!p.autoAdvance;
      break;
    case 'session.parts.add': {
      if (room.session.parts.length >= MAX_PARTS) return { ok: false, error: 'trop de parties' };
      const part = sanitizePart(p.part, makeId('part'));
      const at = p.index == null ? room.session.parts.length : clampInt(p.index, 0, room.session.parts.length, room.session.parts.length);
      room.session.parts.splice(at, 0, part);
      break;
    }
    case 'session.parts.update': {
      const i = partIndex(room, p.id);
      if (i < 0) return { ok: false, error: 'partie inconnue' };
      room.session.parts[i] = sanitizePart({ ...room.session.parts[i], ...(p.patch || {}) }, p.id);
      break;
    }
    case 'session.parts.remove': {
      const i = partIndex(room, p.id);
      if (i < 0) return { ok: false, error: 'partie inconnue' };
      room.session.parts.splice(i, 1);
      if (room.session.activeId === p.id) room.session.activeId = null;
      break;
    }
    case 'session.parts.move': {
      const i = partIndex(room, p.id);
      if (i < 0) return { ok: false, error: 'partie inconnue' };
      const to = clampInt(p.index, 0, room.session.parts.length - 1, i);
      const [part] = room.session.parts.splice(i, 1);
      room.session.parts.splice(to, 0, part);
      break;
    }
    case 'session.replace': {
      const parts = Array.isArray(p.parts) ? p.parts.slice(0, MAX_PARTS) : [];
      room.session.parts = parts.map((part, i) => sanitizePart(part, makeId('part')));
      if (p.name !== undefined) room.session.name = cleanText(p.name, 80);
      if (!room.session.parts.some((x) => x.id === room.session.activeId)) room.session.activeId = null;
      break;
    }
    case 'session.load': {
      const i = partIndex(room, p.id);
      if (i < 0) return { ok: false, error: 'partie inconnue' };
      loadPart(room, i, now, !!p.autostart);
      break;
    }
    case 'session.next': {
      const i = partIndex(room, room.session.activeId);
      const next = i + 1;
      if (next >= room.session.parts.length) return { ok: false, error: 'derniere partie' };
      if (i >= 0) room.session.parts[i].done = true;
      loadPart(room, next, now, !!p.autostart);
      break;
    }
    case 'session.prev': {
      const i = partIndex(room, room.session.activeId);
      const prev = i - 1;
      if (prev < 0) return { ok: false, error: 'premiere partie' };
      loadPart(room, prev, now, !!p.autostart);
      break;
    }
    case 'session.markDone': {
      const i = partIndex(room, p.id);
      if (i < 0) return { ok: false, error: 'partie inconnue' };
      room.session.parts[i].done = p.done === undefined ? true : !!p.done;
      break;
    }

    case 'message.send': {
      const text = cleanText(p.text, 400, { multiline: true });
      if (!text) return { ok: false, error: 'message vide' };
      room.message = {
        text,
        style: ['info', 'warn', 'alert', 'success'].includes(p.style) ? p.style : 'info',
        visible: true,
        flash: !!p.flash,
        sentAt: now,
        autoHideMs: clampInt(p.autoHideMs, 0, 10 * MS.m, 0),
      };
      break;
    }
    case 'message.hide':
      room.message = { ...room.message, visible: false };
      break;
    case 'message.presets.set': {
      const list = Array.isArray(p.presets) ? p.presets.slice(0, MAX_PRESETS) : [];
      room.presets = list
        .map((x) => ({
          id: cleanText(x?.id, 64) || makeId('p'),
          text: cleanText(x?.text, 200),
          style: ['info', 'warn', 'alert', 'success'].includes(x?.style) ? x.style : 'info',
        }))
        .filter((x) => x.text);
      break;
    }

    case 'question.setStatus': {
      const q = room.questions.find((x) => x.id === p.id);
      if (!q) return { ok: false, error: 'question inconnue' };
      if (!['pending', 'approved', 'rejected', 'archived'].includes(p.status)) {
        return { ok: false, error: 'statut invalide' };
      }
      q.status = p.status;
      q.moderatedAt = now;
      if (q.status !== 'approved' && room.shownQuestionId === q.id) room.shownQuestionId = null;
      break;
    }
    case 'question.show': {
      const q = room.questions.find((x) => x.id === p.id);
      if (!q) return { ok: false, error: 'question inconnue' };
      q.status = 'approved';
      q.shownAt = now;
      room.shownQuestionId = q.id;
      break;
    }
    case 'question.hide':
      room.shownQuestionId = null;
      break;
    case 'question.remove': {
      const i = room.questions.findIndex((x) => x.id === p.id);
      if (i < 0) return { ok: false, error: 'question inconnue' };
      room.questions.splice(i, 1);
      if (room.shownQuestionId === p.id) room.shownQuestionId = null;
      break;
    }
    case 'question.clear':
      room.questions = p.keepApproved ? room.questions.filter((q) => q.status === 'approved') : [];
      room.shownQuestionId = null;
      break;

    case 'settings.update':
      applySettings(room.settings, p.patch || {});
      break;

    case 'room.reset':
      room.timer = T.defaultTimer();
      room.message = defaultMessage();
      room.shownQuestionId = null;
      room.session.activeId = null;
      for (const part of room.session.parts) part.done = false;
      break;

    default:
      return { ok: false, error: 'commande inconnue: ' + name };
  }

  room.timer = T.sanitizeTimer(room.timer);
  room.updatedAt = now;
  room.rev += 1;
  return { ok: true };
}

function loadPart(room, index, now, autostart) {
  const part = room.session.parts[index];
  if (!part) return;
  room.session.activeId = part.id;
  room.timer = T.sanitizeTimer({
    ...room.timer,
    mode: part.mode || 'countdown',
    durationMs: part.durationMs,
    title: part.title,
    speaker: part.speaker,
    partId: part.id,
    running: false,
    startedAt: null,
    elapsedMs: 0,
  });
  if (autostart) room.timer = T.start(room.timer, now);
  room.message = { ...room.message, visible: false };
}

/** Ajout d'une question du public (hors commandes protegees). */
export function addQuestion(room, { text, author }, now = Date.now()) {
  if (!room.settings.questionsOpen) return { ok: false, error: 'Les questions sont fermees.' };
  const clean = cleanText(text, 500, { multiline: true });
  if (clean.length < 3) return { ok: false, error: 'Question trop courte.' };
  if (room.questions.length >= MAX_QUESTIONS) {
    room.questions = room.questions.filter((q) => q.status === 'pending' || q.status === 'approved');
    if (room.questions.length >= MAX_QUESTIONS) return { ok: false, error: 'Trop de questions.' };
  }
  const duplicate = room.questions.find(
    (q) => q.text.toLowerCase() === clean.toLowerCase() && now - q.createdAt < 60_000
  );
  if (duplicate) return { ok: false, error: 'Question deja envoyee.' };

  const question = {
    id: makeId('q'),
    text: clean,
    author: cleanText(author, 60),
    createdAt: now,
    status: room.settings.requireApproval ? 'pending' : 'approved',
    votes: 0,
  };
  room.questions.push(question);
  room.updatedAt = now;
  room.rev += 1;
  return { ok: true, question };
}

/** Expire les messages a masquage automatique. Renvoie true si l'etat a change. */
export function tickRoom(room, now = Date.now()) {
  let changed = false;
  const m = room.message;
  if (m.visible && m.autoHideMs > 0 && now - m.sentAt >= m.autoHideMs) {
    m.visible = false;
    changed = true;
  }
  if (room.session.autoAdvance && room.timer.mode === 'countdown' && room.timer.running) {
    const remaining = room.timer.durationMs - T.elapsedOf(room.timer, now);
    if (remaining <= 0) {
      const i = room.session.parts.findIndex((x) => x.id === room.session.activeId);
      if (i >= 0 && i + 1 < room.session.parts.length) {
        room.session.parts[i].done = true;
        loadPart(room, i + 1, now, true);
        changed = true;
      }
    }
  }
  if (changed) {
    room.updatedAt = now;
    room.rev += 1;
  }
  return changed;
}

// ---------------------------------------------------------------------------
// Magasin de salles
// ---------------------------------------------------------------------------

export class RoomStore {
  constructor({ file = null, ttlMs = ROOM_TTL_MS } = {}) {
    this.rooms = new Map();
    this.file = file;
    this.ttlMs = ttlMs;
    this.saveTimer = null;
    if (file) this.load();
  }

  /**
   * Cree une salle. `requestedCode` permet de reprendre un code precis apres
   * un redemarrage du serveur : les QR codes deja distribues restent valables.
   * @returns {{ok:true, room:object} | {ok:false, error:string, reason:string}}
   */
  create(name = '', requestedCode = null) {
    if (requestedCode != null) {
      const code = normalizeCode(requestedCode);
      if (!code) return { ok: false, reason: 'invalid_code', error: 'Code de salle invalide.' };
      if (this.rooms.has(code)) return { ok: false, reason: 'taken', error: 'Ce code est deja utilise.' };
      const room = createRoomState(code, name);
      this.rooms.set(code, room);
      this.scheduleSave();
      return { ok: true, room };
    }
    let code = makeCode();
    let guard = 0;
    while (this.rooms.has(code) && guard++ < 50) code = makeCode();
    const room = createRoomState(code, name);
    this.rooms.set(code, room);
    this.scheduleSave();
    return { ok: true, room };
  }

  get(code) {
    if (!code) return null;
    return this.rooms.get(String(code).toUpperCase().trim()) || null;
  }

  delete(code) {
    const ok = this.rooms.delete(String(code || '').toUpperCase().trim());
    if (ok) this.scheduleSave();
    return ok;
  }

  isOwner(room, token) {
    return !!room && !!token && String(token) === room.ownerToken;
  }

  cleanup(now = Date.now()) {
    let removed = 0;
    for (const [code, room] of this.rooms) {
      if (now - room.updatedAt > this.ttlMs) {
        this.rooms.delete(code);
        removed++;
      }
    }
    if (removed) this.scheduleSave();
    return removed;
  }

  scheduleSave() {
    if (!this.file || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, 2000);
    if (this.saveTimer.unref) this.saveTimer.unref();
  }

  save() {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const payload = JSON.stringify({ v: 1, rooms: [...this.rooms.values()] });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, payload);
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error('[timestage] sauvegarde impossible:', err.message);
    }
  }

  load() {
    try {
      if (!fs.existsSync(this.file)) return;
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const room of data.rooms || []) {
        if (!room?.code) continue;
        room.timer = T.sanitizeTimer(room.timer);
        // Un chrono en cours lors de l'arret reprend en pause a sa valeur.
        if (room.timer.running) {
          room.timer.elapsedMs = T.elapsedOf(room.timer, room.updatedAt || Date.now());
          room.timer.running = false;
          room.timer.startedAt = null;
        }
        room.settings = { ...defaultSettings(), ...(room.settings || {}) };
        room.logo = room.logo?.data ? room.logo : null;
        room.message = { ...defaultMessage(), ...(room.message || {}) };
        room.questions = Array.isArray(room.questions) ? room.questions : [];
        room.presets = Array.isArray(room.presets) && room.presets.length ? room.presets : defaultPresets();
        this.rooms.set(room.code, room);
      }
      this.cleanup();
      console.log(`[timestage] ${this.rooms.size} salle(s) restauree(s)`);
    } catch (err) {
      console.error('[timestage] restauration impossible:', err.message);
    }
  }
}

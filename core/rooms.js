/*!
 * TimeStage, chronometre de scene
 * © 2026 Arnisound Tools (Theo Arnissolle). Tous droits reserves.
 * Logiciel proprietaire : toute reproduction, modification, distribution ou
 * exploitation sans autorisation ecrite prealable est interdite. Voir LICENSE.
 */
// Etat d'une salle TimeStage : chrono, deroule de session, messages, questions
// et sondages. Ce module ne contient que de la logique pure, sans acces au
// disque ni au reseau : il est partage tel quel par le serveur Node et par le
// Worker Cloudflare, qui n'en different que par la facon de ranger l'etat.

import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

import { MS } from '../shared/time.js';
import { EFFECT_NAMES, EFFECT_LAYERS, EFFECTS, DEFAULT_EFFECT_DURATION } from '../shared/effects.js';
import { POLL_LIMITS } from '../shared/poll.js';
import * as T from '../shared/timer.js';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sans I, O, 0, 1
const CODE_LENGTH = 5;
const MAX_PARTS = 200;
const MAX_QUESTIONS = 400;
const MAX_PRESETS = 20;
// Un sondage garde la trace de ceux qui ont vote pour qu'un meme appareil ne
// compte qu'une fois. Ce plafond borne la memoire d'une salle tres suivie.
const MAX_VOTERS = 5000;
// Duree de vie d'une salle : 24 h sans usage, et 50 h au maximum, meme si un
// ecran reste branche. Le plafond evite qu'un appareil oublie dans une salle
// garde vivante une session finie depuis longtemps.
export const ROOM_TTL_MS = 24 * MS.h;
export const ROOM_MAX_MS = 50 * MS.h;

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
  logoPosition: ['above', 'below', 'top-left', 'top-right', 'bottom-left', 'bottom-right', 'center'],
  logoSize: { min: 4, max: 60 },
  logoOpacity: { min: 10, max: 100 },
  // Couleurs du chrono. Vide = la couleur du theme pour cette phase.
  colorNormal: 'color',
  colorWrapUp: 'color',
  colorFinal: 'color',
  colorOverrun: 'color',
  colorText: 'color',
};

const COLOR_RE = /^#[0-9a-f]{6}$/i;

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
    colorNormal: '',
    colorWrapUp: '',
    colorFinal: '',
    colorOverrun: '',
    colorText: '',
  };
}

/** Applique un lot de reglages en respectant le schema. Renvoie le nombre retenu. */
export function applySettings(settings, patch = {}) {
  let applied = 0;
  for (const [key, rule] of Object.entries(SETTINGS_SCHEMA)) {
    if (!(key in patch)) continue;
    const value = patch[key];
    if (rule === 'bool') settings[key] = !!value;
    else if (rule === 'color') {
      // Seule la chaine vide rend la main au theme ; tout le reste doit etre
      // un #rrggbb valide, sinon la couleur en place est conservee.
      if (typeof value !== 'string') continue;
      const color = value.trim().toLowerCase();
      if (color !== '' && !COLOR_RE.test(color)) continue;
      settings[key] = color;
    } else if (typeof rule === 'string' && rule.startsWith('text:')) {
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
    emptyAt: now, // instant ou le dernier appareil s'est deconnecte
    effect: null, // { id, name, intensity, startedAt, durationMs, loop, layer }
    poll: null, // sondage du public, voir createPoll()
    settings: defaultSettings(),
    logo: null, // { data: base64, type: 'image/png', version: n }
    access: null, // { salt, hash } quand la salle est protegee
  };
}

// ---------------------------------------------------------------------------
// Acces a la salle
//
// Le code d'acces est un secret de session, pas un mot de passe : il protege
// une salle le temps d'un evenement. Il est stocke hache et sale, jamais en
// clair, et la verification est a temps constant. La vraie protection contre
// la force brute est la limitation de debit cote serveur.
// ---------------------------------------------------------------------------

const ACCESS_MIN = 4;
const ACCESS_MAX = 32;

function hashAccess(salt, code) {
  return createHash('sha256').update(salt + ':' + code).digest('hex');
}

/** Definit (ou retire, avec une valeur vide) le code d'acces d'une salle. */
export function setAccessCode(room, code, now = Date.now()) {
  const clean = String(code == null ? '' : code).trim();
  if (!clean) {
    room.access = null;
    room.updatedAt = now;
    room.rev += 1;
    return { ok: true, enabled: false };
  }
  if (clean.length < ACCESS_MIN || clean.length > ACCESS_MAX) {
    return { ok: false, error: `Le code doit faire entre ${ACCESS_MIN} et ${ACCESS_MAX} caracteres.` };
  }
  const salt = randomBytes(12).toString('hex');
  room.access = { salt, hash: hashAccess(salt, clean) };
  room.updatedAt = now;
  room.rev += 1;
  return { ok: true, enabled: true };
}

/** Vrai si la salle est ouverte, ou si le code fourni correspond. */
export function checkAccess(room, code) {
  if (!room?.access) return true;
  const given = Buffer.from(hashAccess(room.access.salt, String(code == null ? '' : code).trim()), 'hex');
  const expected = Buffer.from(room.access.hash, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Vrai si ce jeton est celui de la regie de cette salle. */
export function isOwner(room, token) {
  return !!room && !!token && String(token) === room.ownerToken;
}

/**
 * Renouvelle la cle de regie : les liens de regie deja distribues cessent
 * aussitot de fonctionner. A utiliser si un QR code de regie a fuite.
 */
export function rotateOwnerToken(room, now = Date.now()) {
  room.ownerToken = makeToken();
  room.updatedAt = now;
  room.rev += 1;
  return room.ownerToken;
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

// ---------------------------------------------------------------------------
// Sondages du public
//
// Un seul sondage a la fois par salle : c'est ce qui se tient sur un ecran de
// scene et ce que le public comprend sans explication. Le vote est identifie
// par un jeton tire par le navigateur : il n'identifie personne, il empeche
// seulement un meme appareil de compter plusieurs fois. Changer d'avis reste
// possible tant que le vote est ouvert.
// ---------------------------------------------------------------------------

/**
 * Construit un sondage a partir de ce qu'envoie la regie.
 * @returns {{ok:true, poll:object} | {ok:false, error:string}}
 */
export function createPoll(question, options, now = Date.now()) {
  const clean = cleanText(question, POLL_LIMITS.question);
  if (!clean) return { ok: false, error: 'La question du sondage est vide.' };
  const labels = (Array.isArray(options) ? options : [])
    .map((entry) => cleanText(typeof entry === 'string' ? entry : entry?.label, POLL_LIMITS.option))
    .filter(Boolean)
    .slice(0, POLL_LIMITS.maxOptions);
  if (labels.length < POLL_LIMITS.minOptions) {
    return { ok: false, error: `Il faut au moins ${POLL_LIMITS.minOptions} reponses.` };
  }
  return {
    ok: true,
    poll: {
      id: makeId('poll'),
      question: clean,
      options: labels.map((label) => ({ id: makeId('o'), label, votes: 0 })),
      open: true, // le public peut voter
      reveal: false, // les chiffres restent a la regie tant qu'elle ne les ouvre pas
      onStage: false, // le sondage n'est pas encore a l'ecran
      createdAt: now,
      closedAt: 0,
      voters: {}, // jeton de votant -> reponse choisie, jamais diffuse
    },
  };
}

/**
 * Enregistre (ou deplace) la voix d'un votant.
 * @returns {{ok:true, changed:boolean, optionId:string} | {ok:false, error:string}}
 */
export function addVote(room, { optionId, voterId, pollId } = {}, now = Date.now()) {
  const poll = room.poll;
  if (!poll) return { ok: false, error: 'Aucun sondage en cours.' };
  // Le sondage a pu etre remplace pendant que le telephone votait.
  if (pollId && pollId !== poll.id) return { ok: false, error: 'Ce sondage est termine.' };
  if (!poll.open) return { ok: false, error: 'Le vote est clos.' };

  const option = poll.options.find((x) => x.id === optionId);
  if (!option) return { ok: false, error: 'Reponse inconnue.' };
  const voter = cleanText(voterId, 64);
  if (!voter) return { ok: false, error: 'Vote sans identifiant.' };

  const previous = poll.voters[voter];
  if (previous === option.id) return { ok: true, changed: false, optionId: option.id };
  if (previous) {
    const old = poll.options.find((x) => x.id === previous);
    if (old) old.votes = Math.max(0, old.votes - 1);
  } else if (Object.keys(poll.voters).length >= MAX_VOTERS) {
    return { ok: false, error: 'Trop de votes enregistres pour ce sondage.' };
  }
  poll.voters[voter] = option.id;
  option.votes += 1;
  room.updatedAt = now;
  room.rev += 1;
  return { ok: true, changed: true, optionId: option.id };
}

/**
 * Vue diffusable d'un sondage : la liste des votants ne sort jamais du serveur.
 * `withResults` a faux masque les compteurs, pour que l'annonce des resultats
 * reste la decision de la regie et n'influence pas ceux qui votent encore.
 */
function pollView(poll, withResults) {
  if (!poll) return null;
  const { voters, ...rest } = poll;
  const visible = !!(withResults || poll.reveal);
  return {
    ...rest,
    options: poll.options.map((option) => ({ ...option, votes: visible ? option.votes : 0 })),
    voterCount: Object.keys(voters || {}).length,
    resultsVisible: visible,
  };
}

/** Vue publique : ni jeton de controle, ni binaire du logo, ni code d'acces. */
export function publicState(room) {
  const { ownerToken, logo, access, poll, ...rest } = room;
  return {
    ...rest,
    // La regie depouille en direct, meme avant d'ouvrir les resultats.
    poll: pollView(poll, true),
    hasAccessCode: !!access,
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
    poll: pollView(room.poll, false),
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

    case 'effect.play': {
      if (!EFFECT_NAMES.includes(p.name)) return { ok: false, error: 'Animation inconnue.' };
      room.effect = {
        id: makeId('fx'),
        name: p.name,
        intensity: clampInt(p.intensity, 0, 100, 60),
        durationMs: clampInt(p.durationMs, MS.s, 10 * MS.m, DEFAULT_EFFECT_DURATION),
        loop: !!p.loop,
        layer: EFFECT_LAYERS.includes(p.layer) ? p.layer : EFFECTS[p.name].layer,
        startedAt: now,
      };
      break;
    }
    case 'effect.stop':
      room.effect = null;
      break;

    case 'poll.set': {
      const result = createPoll(p.question, p.options, now);
      if (!result.ok) return result;
      // Un sondage deja a l'ecran cede la place au suivant sans que la regie
      // ait a le remettre a l'antenne.
      result.poll.onStage = !!room.poll?.onStage;
      room.poll = result.poll;
      break;
    }
    case 'poll.open':
      if (!room.poll) return { ok: false, error: 'Aucun sondage.' };
      room.poll.open = p.open === undefined ? true : !!p.open;
      if (!room.poll.open) room.poll.closedAt = now;
      break;
    case 'poll.reveal':
      if (!room.poll) return { ok: false, error: 'Aucun sondage.' };
      room.poll.reveal = p.reveal === undefined ? true : !!p.reveal;
      break;
    case 'poll.stage':
      if (!room.poll) return { ok: false, error: 'Aucun sondage.' };
      room.poll.onStage = p.onStage === undefined ? true : !!p.onStage;
      break;
    case 'poll.reset':
      if (!room.poll) return { ok: false, error: 'Aucun sondage.' };
      for (const option of room.poll.options) option.votes = 0;
      room.poll.voters = {};
      break;
    case 'poll.clear':
      room.poll = null;
      break;

    case 'room.setAccessCode': {
      const result = setAccessCode(room, p.code, now);
      if (!result.ok) return result;
      break;
    }

    case 'room.reset':
      room.timer = T.defaultTimer();
      room.message = defaultMessage();
      room.effect = null;
      room.shownQuestionId = null;
      if (room.poll) room.poll.onStage = false;
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

/**
 * Prochaine echeance qui demande au service de se reveiller : masquage d'un
 * message, fin d'une animation, enchainement automatique, expiration de la
 * salle. Fonction pure, pour que les deux plateformes calculent la meme chose.
 *
 * `busy` dit si des appareils sont connectes. Une salle affichee est une salle
 * en usage : son compte a rebours d'expiration ne court que lorsque plus rien
 * n'est connecte. Sans cela, une echeance deja passee ferait redemander un
 * reveil immediat a chaque fois, en boucle.
 */
export function nextDeadline(room, { now = Date.now(), busy = false, ttlMs = ROOM_TTL_MS, maxMs = ROOM_MAX_MS } = {}) {
  if (!room) return 0;
  const due = [];

  const message = room.message;
  if (message?.visible && message.autoHideMs > 0) due.push(message.sentAt + message.autoHideMs);

  if (room.effect && !room.effect.loop) {
    due.push(room.effect.startedAt + room.effect.durationMs + 3 * MS.s);
  }

  if (room.session?.autoAdvance && room.timer.mode === 'countdown' && room.timer.running) {
    const i = room.session.parts.findIndex((x) => x.id === room.session.activeId);
    if (i >= 0 && i + 1 < room.session.parts.length) {
      due.push(now + Math.max(0, room.timer.durationMs - T.elapsedOf(room.timer, now)));
    }
  }

  // Inactivite : le compte a rebours repart a chaque commande, et tant qu'un
  // appareil est connecte. Plafond : il ne repart jamais au-dela.
  due.push(idleSince(room, busy, now) + ttlMs);
  due.push(room.updatedAt + maxMs);
  return Math.min(...due);
}

/**
 * Depuis quand la salle ne sert plus : la derniere commande, ou le moment ou
 * le dernier appareil s'est deconnecte, selon ce qui est le plus recent. Tant
 * qu'un appareil est la, la salle sert, donc le point de depart est maintenant.
 */
function idleSince(room, busy, now) {
  if (busy) return now;
  return Math.max(room.updatedAt, room.emptyAt || 0);
}

/** Vrai si la salle n'a plus servi depuis assez longtemps pour etre effacee. */
export function isExpired(room, { now = Date.now(), busy = false, ttlMs = ROOM_TTL_MS, maxMs = ROOM_MAX_MS } = {}) {
  if (!room) return false;
  // Le plafond l'emporte : passe ce delai la salle part, ecran branche ou non.
  if (now - room.updatedAt > maxMs) return true;
  return now - idleSince(room, busy, now) > ttlMs;
}

/** Note que la salle vient de se vider : le delai d'inactivite repart de la. */
export function markEmpty(room, now = Date.now()) {
  if (!room) return;
  room.emptyAt = now;
}

/** Expire les messages a masquage automatique. Renvoie true si l'etat a change. */
export function tickRoom(room, now = Date.now()) {
  let changed = false;
  const m = room.message;
  if (m.visible && m.autoHideMs > 0 && now - m.sentAt >= m.autoHideMs) {
    m.visible = false;
    changed = true;
  }
  // Une animation ponctuelle disparait de l'etat une fois jouee : inutile de
  // la trainer, et un ecran qui se connecte apres coup ne la rejoue pas.
  if (room.effect && !room.effect.loop && now - room.effect.startedAt > room.effect.durationMs + 3 * MS.s) {
    room.effect = null;
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

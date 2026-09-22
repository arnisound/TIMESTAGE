// Machine a etats du chronometre. Fonctions pures partagees entre le serveur
// (source de verite en ligne) et le navigateur (mode hors ligne + rendu).

import { DEFAULT_FORMAT, normalizeFormat, MS, timeOfDayMs } from './time.js';

export const MODES = ['countdown', 'countup', 'clock'];

export function defaultTimer() {
  return {
    mode: 'countdown',
    durationMs: 5 * MS.m,
    running: false,
    startedAt: null, // horodatage serveur du debut du segment en cours
    elapsedMs: 0, // temps accumule avant la mise en pause
    format: { ...DEFAULT_FORMAT },
    wrapUpMs: 2 * MS.m, // seuil "il reste peu" (ambre)
    finalMs: 30 * MS.s, // seuil critique (rouge)
    overrun: true, // continuer en negatif apres zero
    title: '',
    speaker: '',
    partId: null,
  };
}

export function sanitizeTimer(input) {
  const base = defaultTimer();
  const t = { ...base, ...(input || {}) };
  return {
    mode: MODES.includes(t.mode) ? t.mode : base.mode,
    durationMs: clampInt(t.durationMs, 0, 24 * MS.h, base.durationMs),
    running: !!t.running,
    startedAt: Number.isFinite(t.startedAt) ? Math.round(t.startedAt) : null,
    elapsedMs: clampInt(t.elapsedMs, -24 * MS.h, 48 * MS.h, 0),
    format: normalizeFormat(t.format),
    wrapUpMs: clampInt(t.wrapUpMs, 0, 24 * MS.h, base.wrapUpMs),
    finalMs: clampInt(t.finalMs, 0, 24 * MS.h, base.finalMs),
    overrun: t.overrun !== false,
    title: String(t.title || '').slice(0, 120),
    speaker: String(t.speaker || '').slice(0, 120),
    partId: t.partId == null ? null : String(t.partId).slice(0, 64),
  };
}

function clampInt(value, min, max, fallback) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Temps ecoule du segment courant, en millisecondes. */
export function elapsedOf(timer, now) {
  if (!timer) return 0;
  if (timer.running && timer.startedAt != null) {
    return timer.elapsedMs + Math.max(0, now - timer.startedAt);
  }
  return timer.elapsedMs;
}

/**
 * Etat de lecture pret a afficher.
 * @returns {{mode,elapsedMs,remainingMs,displayMs,negative,phase,progress}}
 */
export function readTimer(timer, now) {
  const t = timer || defaultTimer();
  const elapsed = elapsedOf(t, now);

  if (t.mode === 'clock') {
    return {
      mode: 'clock',
      elapsedMs: elapsed,
      remainingMs: 0,
      displayMs: timeOfDayMs(new Date(now)),
      negative: false,
      phase: 'clock',
      progress: 0,
    };
  }

  if (t.mode === 'countup') {
    const target = t.durationMs > 0 ? t.durationMs : 0;
    const remaining = target > 0 ? target - elapsed : 0;
    return {
      mode: 'countup',
      elapsedMs: elapsed,
      remainingMs: remaining,
      displayMs: elapsed,
      negative: false,
      phase: phaseFor(t, target > 0 ? remaining : Infinity, t.running),
      progress: target > 0 ? Math.min(1, elapsed / target) : 0,
    };
  }

  // Compte a rebours
  let remaining = t.durationMs - elapsed;
  if (!t.overrun && remaining < 0) remaining = 0;
  return {
    mode: 'countdown',
    elapsedMs: elapsed,
    remainingMs: remaining,
    displayMs: Math.abs(remaining),
    negative: remaining < 0,
    phase: phaseFor(t, remaining, t.running),
    progress: t.durationMs > 0 ? Math.min(1, Math.max(0, elapsed / t.durationMs)) : 0,
  };
}

function phaseFor(timer, remaining, running) {
  if (remaining < 0) return 'overrun';
  if (remaining <= timer.finalMs) return 'final';
  if (remaining <= timer.wrapUpMs) return 'wrapup';
  if (!running && timer.elapsedMs === 0) return 'idle';
  return running ? 'running' : 'paused';
}

/** Vrai si le chrono a ete demarre au moins une fois sur ce segment. */
export function isStarted(timer) {
  return !!(timer && (timer.running || timer.elapsedMs !== 0));
}

// ---------------------------------------------------------------------------
// Transitions. Toutes renvoient un nouvel objet timer.
// ---------------------------------------------------------------------------

export function start(timer, now) {
  if (timer.running) return timer;
  return { ...timer, running: true, startedAt: now };
}

export function pause(timer, now) {
  if (!timer.running) return timer;
  return { ...timer, running: false, startedAt: null, elapsedMs: elapsedOf(timer, now) };
}

export function toggle(timer, now) {
  return timer.running ? pause(timer, now) : start(timer, now);
}

export function reset(timer, now, { keepRunning = false } = {}) {
  const running = keepRunning && timer.running;
  return { ...timer, running, startedAt: running ? now : null, elapsedMs: 0 };
}

export function restart(timer, now) {
  return { ...timer, running: true, startedAt: now, elapsedMs: 0 };
}

/** Ajoute (ou retire) du temps : positif = plus de temps a l'antenne. */
export function addTime(timer, now, deltaMs) {
  const delta = Math.round(Number(deltaMs) || 0);
  if (!delta) return timer;
  if (timer.mode === 'countup') {
    // En compte a rebours inverse, ajouter du temps deplace l'objectif.
    return { ...timer, durationMs: Math.max(0, timer.durationMs + delta) };
  }
  return { ...timer, durationMs: Math.max(0, timer.durationMs + delta) };
}

/** Deplace la tete de lecture (avance/recul sans changer la duree). */
export function seek(timer, now, deltaMs) {
  const delta = Math.round(Number(deltaMs) || 0);
  if (!delta) return timer;
  const elapsed = Math.max(0, elapsedOf(timer, now) + delta);
  return timer.running
    ? { ...timer, startedAt: now, elapsedMs: elapsed }
    : { ...timer, elapsedMs: elapsed };
}

export function setDuration(timer, now, durationMs, { restart: doRestart = false } = {}) {
  const duration = Math.max(0, Math.round(Number(durationMs) || 0));
  const next = { ...timer, durationMs: duration };
  if (doRestart) return reset(next, now, { keepRunning: false });
  return next;
}

export function setMode(timer, now, mode) {
  if (!MODES.includes(mode) || mode === timer.mode) return timer;
  return { ...timer, mode, running: false, startedAt: null, elapsedMs: 0 };
}

/*!
 * TimeStage, chronometre de scene
 * © 2026 Arnisound Tools (Theo Arnissolle). Tous droits reserves.
 * Logiciel proprietaire : toute reproduction, modification, distribution ou
 * exploitation sans autorisation ecrite prealable est interdite. Voir LICENSE.
 */
// Rendu de la scene (fenetre d'affichage). Utilise aussi bien en ligne que par
// le mode hors ligne : il suffit de lui passer un etat compatible.

import { formatDuration, formatClock, timeOfDayMs, MS } from '../../shared/time.js';
import { readTimer } from '../../shared/timer.js';
import { el, clear } from './dom.js';
import { createEffects } from './effects.js';

const PHASE_LABEL = {
  idle: 'Pret',
  running: 'En cours',
  paused: 'En pause',
  wrapup: 'Bientot fini',
  final: 'Derniere ligne droite',
  overrun: 'Depassement',
  clock: 'Heure',
};

export function createStage(root) {
  clear(root);
  root.classList.add('stage');

  const titleNode = el('div', { class: 'stage-title' });
  const speakerNode = el('div', { class: 'stage-speaker' });
  const clockNode = el('div', { class: 'stage-clock mono' });
  const timeNode = el('div', { class: 'stage-time mono' });
  const subNode = el('div', { class: 'stage-sub mono' });
  const bar = el('div', { class: 'bar' });
  const progress = el('div', { class: 'stage-progress' }, [bar]);
  const nextNode = el('div', { class: 'stage-next' });
  const stateNode = el('div', { class: 'stage-state' });
  const messageNode = el('div', { class: 'stage-overlay stage-message hidden', role: 'status' });
  const questionNode = el('div', { class: 'stage-overlay stage-question hidden' });
  const flash = el('div', { class: 'stage-flash' });
  const logoNode = el('img', { class: 'stage-logo', alt: '', hidden: true });
  const effectsCanvas = el('canvas', { class: 'stage-effects', 'aria-hidden': 'true' });

  root.append(
    el('div', { class: 'stage-top' }, [
      el('div', { class: 'stage-ident' }, [titleNode, speakerNode]),
      clockNode,
    ]),
    el('div', { class: 'stage-main' }, [timeNode, subNode]),
    progress,
    el('div', { class: 'stage-bottom' }, [nextNode, stateNode]),
    messageNode,
    questionNode,
    logoNode,
    effectsCanvas,
    flash
  );

  const effects = createEffects(effectsCanvas);

  // Le chrono occupe toute la place disponible dans sa zone : on mesure la
  // zone centrale, qui se reduit quand un message ou une question s'affiche.
  const mainNode = timeNode.parentElement;
  let lastFit = '';
  const fit = (force = false) => {
    const text = timeNode.textContent || '';
    const width = mainNode.clientWidth || root.clientWidth || window.innerWidth;
    // Un logo place dans le flux prend de la hauteur : elle sort du budget.
    const inFlowLogo = logoNode.parentElement === mainNode && !logoNode.hidden ? logoNode.offsetHeight : 0;
    const height = Math.max(40, (mainNode.clientHeight || root.clientHeight || window.innerHeight) - inFlowLogo);
    const scale = Number(root.dataset.timerScale) || 1;
    const key = `${text.length}|${width}|${height}|${scale}`;
    if (!force && key === lastFit) return;
    lastFit = key;
    // ~0.6em par caractere en chiffres tabulaires, avec une marge de securite.
    const byWidth = (width * 0.96) / Math.max(4, text.length) / 0.6;
    const byHeight = height * (subNode.classList.contains('hidden') ? 0.92 : 0.74);
    const fitted = Math.min(byWidth, byHeight);
    // Le reglage de la regie agrandit ou reduit, mais ne fait jamais deborder :
    // un chiffre coupe sur un ecran de scene n'est pas rattrapable.
    const ceiling = Math.min(byWidth, height * 0.98);
    timeNode.style.fontSize = Math.max(14, Math.min(fitted * scale, ceiling)) + 'px';
  };
  window.addEventListener('resize', () => fit(true));
  if (window.ResizeObserver) new ResizeObserver(() => fit(true)).observe(mainNode);

  function update(state, now = Date.now()) {
    const timer = state.timer;
    const settings = state.settings || {};
    const view = readTimer(timer, now);

    // --- Valeur principale -------------------------------------------------
    let text;
    if (view.mode === 'clock') {
      text = formatDuration(timeOfDayMs(new Date(now)), { ...timer.format, h: 'on' }, { round: 'floor' });
    } else {
      const round = view.mode === 'countdown' && !view.negative ? 'ceil' : 'floor';
      text = formatDuration(view.displayMs, timer.format, { round });
      if (view.negative) text = '-' + text;
    }
    if (timeNode.textContent !== text) timeNode.textContent = text;
    fit();

    // --- Phase et couleurs -------------------------------------------------
    const phase = view.phase;
    if (root.dataset.phase !== phase) root.dataset.phase = phase;

    // Couleur choisie par la regie ; vide = celle du theme pour cette phase.
    const custom = {
      running: settings.colorNormal,
      idle: settings.colorNormal,
      paused: settings.colorNormal,
      clock: settings.colorNormal,
      wrapup: settings.colorWrapUp,
      final: settings.colorFinal,
      overrun: settings.colorOverrun,
    }[phase] || '';
    if (custom) root.style.setProperty('--stage-accent', custom);
    else root.style.removeProperty('--stage-accent');
    if (settings.colorText) root.style.setProperty('--stage-fg', settings.colorText);
    else root.style.removeProperty('--stage-fg');
    root.dataset.running = String(!!timer.running);
    stateNode.textContent = timer.running ? PHASE_LABEL[phase] || '' : PHASE_LABEL[phase] === 'Heure' ? 'Heure' : timer.elapsedMs || phase === 'overrun' ? 'En pause' : 'Pret';

    // --- Entetes -----------------------------------------------------------
    const title = settings.showTitle === false ? '' : timer.title || '';
    const speaker = settings.showSpeaker === false ? '' : timer.speaker || '';
    titleNode.textContent = title;
    speakerNode.textContent = speaker;
    titleNode.classList.toggle('hidden', !title);
    speakerNode.classList.toggle('hidden', !speaker);

    clockNode.textContent = settings.showClock === false ? '' : formatClock(new Date(now), false);
    clockNode.classList.toggle('hidden', settings.showClock === false);

    // --- Sous-titre --------------------------------------------------------
    let sub = '';
    if (view.mode === 'countdown' && timer.durationMs > 0) {
      sub = 'sur ' + formatDuration(timer.durationMs, { h: 'auto', m: 'on', s: 'on', ms: 0 });
      if (view.negative) sub = 'Depassement, ' + sub;
    } else if (view.mode === 'countup' && timer.durationMs > 0) {
      sub = 'objectif ' + formatDuration(timer.durationMs, { h: 'auto', m: 'on', s: 'on', ms: 0 });
    }
    subNode.textContent = sub;
    subNode.classList.toggle('hidden', !sub);

    // --- Progression -------------------------------------------------------
    const showProgress = settings.showProgress !== false && view.mode !== 'clock' && timer.durationMs > 0;
    progress.classList.toggle('hidden', !showProgress);
    if (showProgress) bar.style.width = (view.progress * 100).toFixed(2) + '%';

    // --- Partie suivante ---------------------------------------------------
    let nextText = '';
    if (settings.showNextPart !== false && state.session?.parts?.length) {
      const i = state.session.parts.findIndex((p) => p.id === state.session.activeId);
      const next = state.session.parts[i + 1];
      if (next) nextText = 'Ensuite : ' + next.title;
    }
    nextNode.textContent = nextText;

    // --- Message de la regie ----------------------------------------------
    const message = state.message;
    const messageVisible = !!(message && message.visible && message.text);
    messageNode.classList.toggle('hidden', !messageVisible);
    if (messageVisible) {
      if (messageNode.textContent !== message.text) messageNode.textContent = message.text;
      messageNode.dataset.style = message.style || 'info';
      messageNode.classList.toggle('flash', !!message.flash);
    }

    // --- Question affichee -------------------------------------------------
    const question = (state.questions || []).find((q) => q.id === state.shownQuestionId);
    questionNode.classList.toggle('hidden', !question);
    if (question) {
      // Les questions longues passent dans une taille plus sobre.
      questionNode.dataset.size = question.text.length > 140 ? 'sm' : question.text.length > 60 ? 'md' : 'lg';
      clear(questionNode);
      questionNode.append(
        el('div', { class: 'q-label', text: 'Question du public' }),
        el('div', { class: 'q-text', text: question.text }),
        question.author ? el('div', { class: 'q-author', text: 'par ' + question.author }) : null
      );
    }

    // --- Personnalisation de l'affichage -----------------------------------
    const timerScale = clampNumber(settings.timerScale, 0.4, 1.6, 1);
    if (root.dataset.timerScale !== String(timerScale)) {
      root.dataset.timerScale = String(timerScale);
      fit(true);
    }
    root.style.setProperty('--text-scale', clampNumber(settings.textScale, 0.5, 2, 1));
    root.dataset.align = ['top', 'center', 'bottom'].includes(settings.timerAlign) ? settings.timerAlign : 'center';

    const logoSrc = logoSource(state, settings);
    if (logoSrc) {
      if (logoNode.getAttribute('src') !== logoSrc) logoNode.setAttribute('src', logoSrc);
      logoNode.hidden = false;
      const position = settings.logoPosition || 'top-right';
      logoNode.dataset.pos = position;
      // « Au-dessus » et « en dessous » placent le logo dans le flux : le chrono
      // se reduit pour lui laisser la place au lieu d'etre recouvert.
      if (position === 'above' || position === 'below') {
        const first = position === 'above';
        const misplaced =
          logoNode.parentElement !== mainNode ||
          (first ? mainNode.firstChild !== logoNode : mainNode.lastChild !== logoNode);
        if (misplaced) {
          if (first) mainNode.prepend(logoNode);
          else mainNode.append(logoNode);
          fit(true);
        }
      } else if (logoNode.parentElement !== root) {
        root.append(logoNode);
        fit(true);
      }
      root.style.setProperty('--logo-size', clampNumber(settings.logoSize, 4, 60, 12) + '%');
      root.style.setProperty('--logo-opacity', clampNumber(settings.logoOpacity, 10, 100, 100) / 100);
    } else if (!logoNode.hidden) {
      logoNode.hidden = true;
      fit(true);
    }

    // --- Ecran noir --------------------------------------------------------
    root.classList.toggle('blackout', !!settings.blackout);

    // --- Animations --------------------------------------------------------
    const effect = state.effect && state.effect.name ? state.effect : null;
    effectsCanvas.dataset.layer = effect?.layer === 'front' ? 'front' : 'back';
    effects.update(settings.blackout ? null : effect, now);

    // --- Flash de fin ------------------------------------------------------
    const shouldFlash =
      settings.flashOnEnd !== false &&
      view.mode === 'countdown' &&
      timer.running &&
      view.negative &&
      Math.abs(view.remainingMs) < 10 * MS.s;
    flash.classList.toggle('on', shouldFlash);
  }

  return { update, fit: () => fit(true), nodes: { timeNode, messageNode, questionNode } };
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * Source du logo affiche sur scene.
 * - 'timestage' : le logo de l'application, servi a cote de ce module ;
 * - 'custom'    : l'image televersee par la regie. L'appelant fournit son URL
 *                 dans l'etat (URL servie par le serveur, ou data URL locale
 *                 en mode hors ligne).
 */
function logoSource(state, settings) {
  if (settings.logoMode === 'custom') return state.logoUrl || '';
  if (settings.logoMode === 'timestage') return new URL('../../icons/logo.png', import.meta.url).href;
  return '';
}

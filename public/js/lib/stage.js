// Rendu de la scene (fenetre d'affichage). Utilise aussi bien en ligne que par
// le mode hors ligne : il suffit de lui passer un etat compatible.

import { formatDuration, formatClock, timeOfDayMs, MS } from '../../shared/time.js';
import { readTimer } from '../../shared/timer.js';
import { el, clear } from './dom.js';

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
    flash
  );

  // Le chrono occupe toute la place disponible dans sa zone : on mesure la
  // zone centrale, qui se reduit quand un message ou une question s'affiche.
  const mainNode = timeNode.parentElement;
  let lastFit = '';
  const fit = (force = false) => {
    const text = timeNode.textContent || '';
    const width = mainNode.clientWidth || root.clientWidth || window.innerWidth;
    const height = mainNode.clientHeight || root.clientHeight || window.innerHeight;
    const key = `${text.length}|${width}|${height}`;
    if (!force && key === lastFit) return;
    lastFit = key;
    // ~0.6em par caractere en chiffres tabulaires, avec une marge de securite.
    const byWidth = (width * 0.96) / Math.max(4, text.length) / 0.6;
    const byHeight = height * (subNode.classList.contains('hidden') ? 0.92 : 0.74);
    timeNode.style.fontSize = Math.max(14, Math.min(byWidth, byHeight)) + 'px';
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
      if (view.negative) sub = 'Depassement — ' + sub;
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
        question.author ? el('div', { class: 'q-author', text: '— ' + question.author }) : null
      );
    }

    // --- Ecran noir --------------------------------------------------------
    root.classList.toggle('blackout', !!settings.blackout);

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

// Salle locale : meme forme d'etat que le serveur, mais entierement dans le
// navigateur. Persistee dans localStorage et partagee entre les fenetres du
// meme appareil par BroadcastChannel — donc sans aucun reseau.

import * as T from '../../shared/timer.js';
import { DEFAULT_FORMAT } from '../../shared/time.js';

const STORAGE_KEY = 'timestage:offline:v1';
const CHANNEL = 'timestage-offline';

function defaultState() {
  return {
    timer: T.defaultTimer(),
    message: { text: '', style: 'info', visible: false, flash: false, sentAt: 0, autoHideMs: 0 },
    presets: [
      { id: 'p1', text: 'Merci de conclure', style: 'warn' },
      { id: 'p2', text: 'Parlez plus fort', style: 'info' },
      { id: 'p3', text: 'Temps ecoule', style: 'alert' },
    ],
    session: { name: 'Session hors ligne', autoAdvance: false, activeId: null, parts: [] },
    questions: [],
    shownQuestionId: null,
    settings: {
      showTitle: true,
      showSpeaker: true,
      showClock: true,
      showProgress: true,
      showNextPart: true,
      blackout: false,
      theme: 'dark',
      flashOnEnd: true,
      displayName: '',
      questionsOpen: false,
      requireApproval: true,
    },
    rev: 1,
  };
}

const uid = () => 'l' + Math.random().toString(36).slice(2, 10);

export class LocalRoom extends EventTarget {
  constructor() {
    super();
    this.state = this.read() || defaultState();
    this.channel = null;
    if ('BroadcastChannel' in window) {
      this.channel = new BroadcastChannel(CHANNEL);
      this.channel.addEventListener('message', (event) => {
        if (event.data?.type !== 'state' || event.data.state?.rev === this.state.rev) return;
        this.state = event.data.state;
        this.emit(false);
      });
    }
    // Repli pour les navigateurs sans BroadcastChannel.
    window.addEventListener('storage', (event) => {
      if (event.key !== STORAGE_KEY || !event.newValue) return;
      try {
        const next = JSON.parse(event.newValue);
        if (next?.rev === this.state.rev) return;
        this.state = next;
        this.emit(false);
      } catch { /* ignore */ }
    });
    setInterval(() => this.tick(), 250);
  }

  read() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const state = JSON.parse(raw);
      state.timer = T.sanitizeTimer(state.timer);
      const base = defaultState();
      return {
        ...base,
        ...state,
        settings: { ...base.settings, ...(state.settings || {}) },
        session: { ...base.session, ...(state.session || {}) },
        message: { ...base.message, ...(state.message || {}) },
      };
    } catch {
      return null;
    }
  }

  persist() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state)); } catch { /* quota / prive */ }
  }

  emit(broadcast = true) {
    this.dispatchEvent(new CustomEvent('state', { detail: this.state }));
    if (!broadcast) return;
    this.persist();
    this.channel?.postMessage({ type: 'state', state: this.state });
  }

  now() {
    return Date.now();
  }

  /** Applique une commande locale. Memes noms que les commandes serveur. */
  apply(name, payload = {}) {
    const now = Date.now();
    const s = this.state;
    const p = payload || {};
    switch (name) {
      case 'timer.toggle': s.timer = T.toggle(s.timer, now); break;
      case 'timer.start': s.timer = T.start(s.timer, now); break;
      case 'timer.pause': s.timer = T.pause(s.timer, now); break;
      case 'timer.reset': s.timer = T.reset(s.timer, now); break;
      case 'timer.restart': s.timer = T.restart(s.timer, now); break;
      case 'timer.add': s.timer = T.addTime(s.timer, now, p.ms); break;
      case 'timer.seek': s.timer = T.seek(s.timer, now, p.ms); break;
      case 'timer.setDuration': s.timer = T.setDuration(s.timer, now, p.ms, { restart: !!p.restart }); break;
      case 'timer.setMode': s.timer = T.setMode(s.timer, now, p.mode); break;
      case 'timer.setFormat': s.timer = { ...s.timer, format: { ...DEFAULT_FORMAT, ...p.format } }; break;
      case 'timer.setThresholds':
        s.timer = {
          ...s.timer,
          wrapUpMs: p.wrapUpMs ?? s.timer.wrapUpMs,
          finalMs: p.finalMs ?? s.timer.finalMs,
          overrun: p.overrun ?? s.timer.overrun,
        };
        break;
      case 'timer.setTitle':
        s.timer = { ...s.timer, title: p.title ?? s.timer.title, speaker: p.speaker ?? s.timer.speaker };
        break;

      case 'message.send':
        s.message = {
          text: String(p.text || '').slice(0, 400),
          style: p.style || 'info',
          visible: true,
          flash: !!p.flash,
          sentAt: now,
          autoHideMs: Number(p.autoHideMs) || 0,
        };
        break;
      case 'message.hide': s.message = { ...s.message, visible: false }; break;

      case 'session.parts.add':
        s.session.parts.push({
          id: uid(),
          title: String(p.part?.title || 'Sans titre').slice(0, 120),
          speaker: String(p.part?.speaker || '').slice(0, 120),
          durationMs: Math.max(0, Number(p.part?.durationMs) || 0),
          mode: p.part?.mode === 'countup' ? 'countup' : 'countdown',
          notes: '',
          done: false,
        });
        break;
      case 'session.parts.remove':
        s.session.parts = s.session.parts.filter((x) => x.id !== p.id);
        if (s.session.activeId === p.id) s.session.activeId = null;
        break;
      case 'session.replace':
        s.session.parts = [];
        s.session.activeId = null;
        break;
      case 'session.load': {
        const part = s.session.parts.find((x) => x.id === p.id);
        if (!part) break;
        s.session.activeId = part.id;
        s.timer = T.sanitizeTimer({
          ...s.timer,
          mode: part.mode,
          durationMs: part.durationMs,
          title: part.title,
          speaker: part.speaker,
          running: false,
          startedAt: null,
          elapsedMs: 0,
        });
        if (p.autostart) s.timer = T.start(s.timer, now);
        break;
      }
      case 'session.next': case 'session.prev': {
        const i = s.session.parts.findIndex((x) => x.id === s.session.activeId);
        const target = s.session.parts[name === 'session.next' ? i + 1 : i - 1];
        if (!target) break;
        if (name === 'session.next' && i >= 0) s.session.parts[i].done = true;
        return this.apply('session.load', { id: target.id, autostart: p.autostart });
      }

      case 'settings.update': Object.assign(s.settings, p.patch || {}); break;
      case 'room.reset':
        this.state = { ...defaultState(), presets: s.presets, session: s.session, settings: s.settings };
        break;
      default:
        return false;
    }
    this.state.timer = T.sanitizeTimer(this.state.timer);
    this.state.rev = (this.state.rev || 0) + 1;
    this.emit();
    return true;
  }

  tick() {
    const s = this.state;
    let changed = false;
    if (s.message.visible && s.message.autoHideMs > 0 && Date.now() - s.message.sentAt >= s.message.autoHideMs) {
      s.message.visible = false;
      changed = true;
    }
    if (changed) {
      s.rev = (s.rev || 0) + 1;
      this.emit();
    }
  }
}

/*!
 * TimeStage, chronometre de scene
 * © 2026 Arnisound Tools (Theo Arnissolle). Tous droits reserves.
 * Logiciel proprietaire : toute reproduction, modification, distribution ou
 * exploitation sans autorisation ecrite prealable est interdite. Voir LICENSE.
 */
// Une salle TimeStage sous forme de Durable Object.
//
// Sur Cloudflare il n'y a pas de serveur qui tourne en continu : un Worker vit
// le temps d'une requete. Le Durable Object est la piece qui manque, un objet
// unique et persistant par salle, qui tient l'etat, les WebSockets ouverts et
// l'horloge de reference. Le code d'une salle donne toujours le meme objet,
// ou que soit l'appareil qui s'y connecte.
//
// La logique metier n'est pas dupliquee : elle vient de core/rooms.js, le
// meme module que le serveur Node.

import { DurableObject } from 'cloudflare:workers';

import {
  createRoomState,
  applyCommand,
  addQuestion,
  addVote,
  publicState,
  viewerState,
  tickRoom,
  nextDeadline,
  isExpired,
  markEmpty,
  checkAccess,
  isOwner,
  rotateOwnerToken,
  setRoomLogo,
  clearRoomLogo,
  normalizeCode,
  cleanText,
  defaultSettings,
  defaultMessage,
  defaultPresets,
} from '../core/rooms.js';
import * as T from '../shared/timer.js';

const json = (data, status = 200) => Response.json(data, { status });

/**
 * Limitation de debit, gardee en memoire de l'objet. Elle tombe si l'objet
 * s'endort, exactement comme elle tombait au redemarrage du serveur Node :
 * c'est un garde-fou contre l'emballement, pas un quota comptable.
 */
class RateLimiter {
  constructor() {
    this.buckets = new Map();
  }

  take(key, limit, windowMs, now) {
    const bucket = this.buckets.get(key);
    if (!bucket || now > bucket.reset) {
      this.buckets.set(key, { count: 1, reset: now + windowMs });
      return true;
    }
    bucket.count += 1;
    if (bucket.count > limit) return false;
    // Menage opportuniste : la carte ne grossit pas indefiniment.
    if (this.buckets.size > 500) {
      for (const [k, b] of this.buckets) if (now > b.reset) this.buckets.delete(k);
    }
    return true;
  }
}

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.room = null;
    this.logoData = '';
    this.limiter = new RateLimiter();
    // Rien ne doit repondre avant que l'etat soit relu du stockage.
    ctx.blockConcurrencyWhile(async () => {
      const stored = await ctx.storage.get(['room', 'logoData']);
      const room = stored.get('room');
      if (room) {
        this.room = hydrate(room);
        this.logoData = stored.get('logoData') || '';
        if (this.room.logo) this.room.logo.data = this.logoData;
      }
    });
  }

  // --- Stockage -------------------------------------------------------------

  /**
   * Range l'etat. L'image du logo est rangee a part : elle pese jusqu'a
   * quelques centaines de kilo-octets et ne doit pas etre reecrite a chaque
   * demarrage de chrono.
   */
  async persist({ logo = false } = {}) {
    const room = this.room;
    const light = { ...room, logo: room.logo ? { type: room.logo.type, version: room.logo.version, at: room.logo.at } : null };
    const writes = { room: light };
    if (logo) writes.logoData = this.logoData;
    await this.ctx.storage.put(writes);
  }

  // --- Cycle de vie ---------------------------------------------------------

  async fetch(request) {
    const url = new URL(request.url);
    const now = Date.now();
    const ip = request.headers.get('x-timestage-ip') || 'inconnu';

    if (url.pathname === '/create') {
      const body = await request.json();
      if (this.room) return json({ error: 'Ce code est deja utilise.', reason: 'taken' }, 409);
      const code = normalizeCode(body.code);
      if (!code) return json({ error: 'Code de salle invalide.', reason: 'invalid_code' }, 400);
      this.room = createRoomState(code, cleanText(body.name, 80));
      await this.persist();
      await this.rearm(now);
      return json({ code: this.room.code, ownerToken: this.room.ownerToken, state: publicState(this.room) }, 201);
    }

    if (!this.room) return json({ error: 'Salle introuvable.' }, 404);

    switch (url.pathname) {
      case '/info':
        // Salle protegee : on confirme seulement qu'elle existe.
        if (this.room.access) return json({ code: this.room.code, protected: true });
        return json({
          code: this.room.code,
          protected: false,
          name: this.room.session.name,
          questionsOpen: this.room.settings.questionsOpen,
          displayName: this.room.settings.displayName,
        });

      case '/questions':
        return this.handleQuestion(await request.json(), ip, now);

      case '/vote':
        return this.handleVote(await request.json(), ip, now);

      case '/logo':
        return this.handleLogo(request, url, now);

      case '/ws':
        return this.handleUpgrade(request, ip);

      default:
        return json({ error: 'Route inconnue.' }, 404);
    }
  }

  // --- Questions et votes (repli HTTP) --------------------------------------

  handleQuestion(body, ip, now) {
    if (!checkAccess(this.room, body.access)) {
      const ok = this.limiter.take(`access:${ip}`, 10, 10 * 60_000, now);
      return json({ error: 'Code d acces requis.', code: 'access_denied' }, ok ? 403 : 429);
    }
    if (!this.limiter.take(`q:${ip}`, 5, 60_000, now)) {
      return json({ error: 'Patientez un instant avant la prochaine question.' }, 429);
    }
    const result = addQuestion(this.room, { text: body.text, author: body.author }, now);
    if (!result.ok) return json({ error: result.error }, 400);
    return this.commit(now, () => json({ ok: true, id: result.question.id, status: result.question.status }, 201));
  }

  handleVote(body, ip, now) {
    if (!checkAccess(this.room, body.access)) {
      const ok = this.limiter.take(`access:${ip}`, 10, 10 * 60_000, now);
      return json({ error: 'Code d acces requis.', code: 'access_denied' }, ok ? 403 : 429);
    }
    const guard = this.voteAllowed(ip, body.voterId, now);
    if (!guard.ok) return json({ error: guard.error }, 429);
    const result = addVote(this.room, { optionId: body.optionId, voterId: body.voterId, pollId: body.pollId }, now);
    if (!result.ok) return json({ error: result.error }, 400);
    const reply = () => json({ ok: true, pollId: this.room.poll.id, optionId: result.optionId });
    return result.changed ? this.commit(now, reply) : reply();
  }

  /**
   * Deux garde-fous pour le vote. Le plafond par votant est serre : il laisse
   * changer d'avis quelques fois, pas marteler le serveur. Le plafond par
   * adresse est volontairement tres haut, car dans une salle tout le public
   * sort souvent par la meme connexion.
   */
  voteAllowed(ip, voterId, now) {
    const voter = String(voterId || '').slice(0, 64);
    if (!this.limiter.take(`vote:${voter}`, 10, 60_000, now)) {
      return { ok: false, error: 'Trop de changements de vote, patientez un instant.' };
    }
    if (!this.limiter.take(`votes:${ip}`, 600, 60_000, now)) {
      return { ok: false, error: 'Trop de votes depuis ce reseau, patientez un instant.' };
    }
    return { ok: true };
  }

  // --- Logo de l'evenement --------------------------------------------------

  async handleLogo(request, url, now) {
    if (request.method === 'GET') {
      if (!this.room.logo || !this.logoData) return new Response('Aucun logo.', { status: 404 });
      return new Response(base64ToBytes(this.logoData), {
        headers: {
          'content-type': this.room.logo.type,
          // L'URL est versionnee : une version donnee ne change jamais.
          'cache-control': url.searchParams.get('v') ? 'public, max-age=31536000, immutable' : 'no-cache',
        },
      });
    }

    const body = await request.json();
    if (!isOwner(this.room, body.token)) return json({ error: 'Reserve a la regie.' }, 403);

    if (request.method === 'DELETE') {
      if (clearRoomLogo(this.room, now)) {
        this.logoData = '';
        await this.persist({ logo: true });
        this.broadcast(now);
      }
      return json({ ok: true });
    }

    const result = setRoomLogo(this.room, body.dataUrl, now);
    if (!result.ok) return json({ error: result.error }, 400);
    this.logoData = this.room.logo.data;
    await this.persist({ logo: true });
    this.broadcast(now);
    return json({ ok: true, version: result.version });
  }

  // --- WebSocket ------------------------------------------------------------

  handleUpgrade(request, ip) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Attendu : une connexion WebSocket.', { status: 426 });
    }
    const pair = new WebSocketPair();
    // L'hibernation laisse l'objet s'endormir sans couper les ecrans ouverts :
    // un chrono affiche toute une soiree ne coute rien entre deux commandes.
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({ role: 'viewer', authorized: false, ip });
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws, raw) {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return send(ws, { t: 'error', code: 'bad_json', message: 'Message illisible.' });
    }
    const now = Date.now();
    const who = ws.deserializeAttachment() || { role: 'viewer', authorized: false, ip: 'inconnu' };

    switch (msg?.t) {
      case 'hello': {
        if (!this.room) return send(ws, { t: 'error', code: 'no_room', message: 'Salle introuvable.' });
        const wantsControl = msg.role === 'control';
        const owner = isOwner(this.room, msg.token);
        if (wantsControl && !owner) {
          return send(ws, { t: 'error', code: 'forbidden', message: 'Jeton de controle invalide.' });
        }
        // Le code d'acces vaut pour tout le monde, regie comprise. La cle de
        // regie voyage dans un QR code, que l'on projette ou que l'on
        // photographie ; le code, lui, ne quitte pas ceux a qui on le donne.
        // Prendre la main demande donc les deux.
        if (!checkAccess(this.room, msg.access)) {
          const ok = this.limiter.take(`access:${who.ip}`, 10, 10 * 60_000, now);
          return send(ws, {
            t: 'error',
            code: ok ? 'access_denied' : 'rate_limited',
            message: ok ? 'Code d acces requis.' : 'Trop de tentatives, patientez.',
          });
        }
        who.role = wantsControl ? 'control' : msg.role === 'display' ? 'display' : 'viewer';
        who.authorized = true;
        ws.serializeAttachment(who);
        send(ws, { t: 'welcome', serverTime: now, role: who.role, state: this.stateFor(who.role) });
        this.broadcast(now);
        return;
      }

      case 'ping':
        return send(ws, { t: 'pong', ts: msg.ts, serverTime: now });

      case 'cmd': {
        if (!this.room) return send(ws, { t: 'error', code: 'no_room', message: 'Salle introuvable.' });
        if (who.role !== 'control') {
          return send(ws, { t: 'error', code: 'forbidden', message: 'Commande reservee a la regie.' });
        }
        // Le renouvellement de cle se traite ici, et non dans applyCommand : il
        // faut savoir quelle regie l'a demande pour ne pas la deconnecter avec
        // les autres.
        if (msg.name === 'room.rotateKey') {
          const ownerToken = rotateOwnerToken(this.room, now);
          send(ws, { t: 'key', ownerToken });
          for (const other of this.ctx.getWebSockets()) {
            if (other === ws) continue;
            const meta = other.deserializeAttachment() || {};
            if (meta.role !== 'control') continue;
            send(other, { t: 'error', code: 'forbidden', message: 'Cle de regie renouvelee.' });
            other.close(1000, 'cle renouvelee');
          }
          await this.persist();
          this.broadcast(now);
          return this.rearm(now);
        }
        const result = applyCommand(this.room, msg.name, msg.payload, now);
        if (!result.ok) {
          return send(ws, { t: 'error', code: 'cmd_failed', message: result.error, cmd: msg.name });
        }
        await this.persist();
        this.broadcast(now);
        if (msg.ack) send(ws, { t: 'ack', ack: msg.ack });
        return this.rearm(now);
      }

      case 'question': {
        if (!this.room) return send(ws, { t: 'error', code: 'no_room', message: 'Salle introuvable.' });
        if (!who.authorized) {
          return send(ws, { t: 'error', code: 'access_denied', message: 'Code d acces requis.' });
        }
        if (!this.limiter.take(`qws:${who.ip}`, 5, 60_000, now)) {
          return send(ws, { t: 'error', code: 'rate_limited', message: 'Patientez avant la prochaine question.' });
        }
        const result = addQuestion(this.room, { text: msg.text, author: msg.author }, now);
        if (!result.ok) return send(ws, { t: 'error', code: 'question_refused', message: result.error });
        await this.persist();
        this.broadcast(now);
        return send(ws, { t: 'question_ok', id: result.question.id, status: result.question.status });
      }

      case 'vote': {
        if (!this.room) return send(ws, { t: 'error', code: 'no_room', message: 'Salle introuvable.' });
        if (!who.authorized) {
          return send(ws, { t: 'error', code: 'access_denied', message: 'Code d acces requis.' });
        }
        const guard = this.voteAllowed(who.ip, msg.voterId, now);
        if (!guard.ok) return send(ws, { t: 'error', code: 'rate_limited', message: guard.error });
        const result = addVote(this.room, { optionId: msg.optionId, voterId: msg.voterId, pollId: msg.pollId }, now);
        if (!result.ok) return send(ws, { t: 'error', code: 'vote_refused', message: result.error });
        if (result.changed) {
          await this.persist();
          this.broadcast(now);
        }
        return send(ws, { t: 'vote_ok', pollId: this.room.poll.id, optionId: result.optionId });
      }

      default:
        send(ws, { t: 'error', code: 'unknown', message: 'Type de message inconnu.' });
    }
  }

  async webSocketClose() {
    await this.onDeparture();
  }

  async webSocketError() {
    await this.onDeparture();
  }

  /**
   * Un appareil s'en va. Les autres doivent voir le compte changer, et si
   * c'etait le dernier, le delai d'inactivite repart de cet instant precis :
   * sans cela il courrait depuis la derniere commande, et une salle affichee
   * pendant des heures disparaitrait aussitot l'ecran eteint.
   */
  async onDeparture() {
    if (!this.room) return;
    const now = Date.now();
    this.broadcast(now);
    if (this.liveSockets().length === 0) {
      markEmpty(this.room, now);
      await this.persist();
    }
    await this.rearm(now);
  }

  // --- Diffusion ------------------------------------------------------------

  /**
   * Les sockets encore vivants. Un socket en train de se fermer figure encore
   * dans la liste de l'objet : le compter afficherait un ecran de plus qu'il
   * n'y en a, et ferait croire la salle occupee alors qu'elle vient de se
   * vider.
   */
  liveSockets() {
    return this.ctx.getWebSockets().filter((ws) => ws.readyState === WebSocket.READY_STATE_OPEN);
  }

  audience() {
    const counts = { control: 0, display: 0, viewer: 0 };
    for (const ws of this.liveSockets()) {
      const meta = ws.deserializeAttachment() || {};
      if (!meta.authorized) continue;
      counts[meta.role === 'control' ? 'control' : meta.role === 'display' ? 'display' : 'viewer'] += 1;
    }
    return counts;
  }

  stateFor(role) {
    const state = role === 'control' ? publicState(this.room) : viewerState(this.room);
    return { ...state, audience: this.audience() };
  }

  broadcast(now = Date.now()) {
    const cache = {};
    for (const ws of this.liveSockets()) {
      const meta = ws.deserializeAttachment() || {};
      if (!meta.authorized) continue;
      const role = meta.role === 'control' ? 'control' : 'viewer';
      cache[role] ??= this.stateFor(meta.role === 'control' ? 'control' : 'display');
      send(ws, { t: 'state', serverTime: now, state: cache[role] });
    }
  }

  /** Range l'etat, previent tout le monde, reprogramme l'alarme, puis repond. */
  async commit(now, reply) {
    await this.persist();
    this.broadcast(now);
    await this.rearm(now);
    return reply();
  }

  // --- Alarme ---------------------------------------------------------------

  /**
   * Le serveur Node balayait toutes les salles quatre fois par seconde. Ici on
   * fait l'inverse : on calcule la prochaine echeance reelle (masquage d'un
   * message, fin d'une animation, enchainement automatique, expiration de la
   * salle) et on ne se reveille qu'a ce moment-la. Rien ne tourne entre-temps.
   */
  async rearm(now = Date.now()) {
    const deadline = nextDeadline(this.room, { now, busy: this.liveSockets().length > 0 });
    if (!deadline) return;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || Math.abs(current - deadline) > 250) {
      await this.ctx.storage.setAlarm(Math.max(deadline, now + 50));
    }
  }

  async alarm() {
    const now = Date.now();
    if (!this.room) return;

    // Salle oubliee : elle disparait avec tout ce qu'elle contenait.
    if (isExpired(this.room, { now, busy: this.liveSockets().length > 0 })) {
      this.room = null;
      this.logoData = '';
      await this.ctx.storage.deleteAll();
      return;
    }

    if (tickRoom(this.room, now)) {
      await this.persist();
      this.broadcast(now);
    }
    await this.rearm(now);
  }
}

function send(ws, payload) {
  try {
    ws.send(JSON.stringify(payload));
  } catch {
    // Socket deja parti : rien a rattraper.
  }
}

/** Remet d'aplomb un etat relu du stockage, comme le fait le serveur Node. */
function hydrate(room) {
  room.timer = T.sanitizeTimer(room.timer);
  // Un chrono en cours lors de la mise en sommeil reprend a sa valeur, en pause.
  if (room.timer.running) {
    room.timer.elapsedMs = T.elapsedOf(room.timer, room.updatedAt || Date.now());
    room.timer.running = false;
    room.timer.startedAt = null;
  }
  room.settings = { ...defaultSettings(), ...(room.settings || {}) };
  room.message = { ...defaultMessage(), ...(room.message || {}) };
  room.questions = Array.isArray(room.questions) ? room.questions : [];
  room.presets = Array.isArray(room.presets) && room.presets.length ? room.presets : defaultPresets();
  room.effect = room.effect?.name ? room.effect : null;
  room.poll = room.poll?.id
    ? { ...room.poll, voters: room.poll.voters && typeof room.poll.voters === 'object' ? room.poll.voters : {} }
    : null;
  room.access = room.access?.hash ? room.access : null;
  // Une salle relue n'a plus personne : le delai repart de maintenant.
  room.emptyAt = Math.max(Number(room.emptyAt) || 0, Number(room.updatedAt) || 0);
  return room;
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

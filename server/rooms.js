/*!
 * TimeStage, chronometre de scene
 * © 2026 Arnisound Tools (Theo Arnissolle). Tous droits reserves.
 * Logiciel proprietaire : toute reproduction, modification, distribution ou
 * exploitation sans autorisation ecrite prealable est interdite. Voir LICENSE.
 */
// Magasin de salles du serveur Node : garde les salles en memoire et les
// sauvegarde periodiquement sur disque pour survivre a un redemarrage.
//
// La logique d'une salle vit dans core/rooms.js, partagee avec le Worker
// Cloudflare. Ce fichier la reexporte pour que le serveur et les tests aient
// un seul point d'entree.

import fs from 'node:fs';
import path from 'node:path';

import { createRoomState, makeCode, normalizeCode, defaultSettings, defaultMessage, defaultPresets, isOwner, ROOM_TTL_MS } from '../core/rooms.js';
import * as T from '../shared/timer.js';

export * from '../core/rooms.js';

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
    return isOwner(room, token);
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
        room.access = room.access?.hash ? room.access : null;
        room.effect = room.effect?.name ? room.effect : null;
        room.poll = room.poll?.id
          ? { ...room.poll, voters: room.poll.voters && typeof room.poll.voters === 'object' ? room.poll.voters : {} }
          : null;
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

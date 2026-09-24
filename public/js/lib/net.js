/*!
 * TimeStage, chronometre de scene
 * © 2026 Arnisound Tools (Theo Arnissolle). Tous droits reserves.
 * Logiciel proprietaire : toute reproduction, modification, distribution ou
 * exploitation sans autorisation ecrite prealable est interdite. Voir LICENSE.
 */
// Client WebSocket : reconnexion automatique et synchronisation d'horloge avec
// le serveur (indispensable pour que toutes les fenetres affichent la meme
// valeur a quelques millisecondes pres).

export class RoomConnection extends EventTarget {
  constructor({ code, role = 'viewer', token = null, access = null } = {}) {
    super();
    this.code = String(code || '').toUpperCase();
    this.role = role;
    this.token = token;
    this.access = access; // code d'acces de la salle, si elle est protegee
    this.ws = null;
    this.state = null;
    this.status = 'idle'; // idle | connecting | online | offline
    this.offset = 0; // serverTime - Date.now()
    this.rtt = 0;
    this.samples = [];
    this.attempt = 0;
    this.closedByUser = false;
    this.missingRoom = false; // la salle n'existe pas (encore) cote serveur
    this.pingTimer = null;
    this.reconnectTimer = null;
  }

  /** Horodatage aligne sur l'horloge du serveur. */
  now() {
    return Date.now() + this.offset;
  }

  setStatus(status, detail) {
    if (this.status === status) return;
    this.status = status;
    this.dispatchEvent(new CustomEvent('status', { detail: { status, detail } }));
  }

  connect() {
    this.closedByUser = false;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    this.setStatus('connecting');
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    let ws;
    try {
      // Le code voyage dans l'URL : sur Cloudflare, il designe le Durable
      // Object a reveiller avant meme que la connexion soit acceptee. Le
      // serveur Node l'ignore et lit le « hello » comme avant.
      ws = new WebSocket(`${proto}//${location.host}/ws?room=${encodeURIComponent(this.code)}`);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.addEventListener('open', () => {
      this.attempt = 0;
      this.send({ t: 'hello', room: this.code, role: this.role, token: this.token, access: this.access });
      this.startPing();
    });

    ws.addEventListener('message', (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      this.handle(msg);
    });

    ws.addEventListener('close', () => {
      this.stopPing();
      if (this.closedByUser) return this.setStatus('idle');
      this.setStatus('offline');
      this.scheduleReconnect();
    });

    ws.addEventListener('error', () => {
      // 'close' suit toujours : rien a faire ici.
    });
  }

  handle(msg) {
    switch (msg.t) {
      case 'welcome':
        this.missingRoom = false;
        this.applyTime(msg.serverTime);
        this.state = msg.state;
        this.role = msg.role || this.role;
        this.setStatus('online');
        this.dispatchEvent(new CustomEvent('state', { detail: msg.state }));
        this.dispatchEvent(new CustomEvent('welcome', { detail: msg }));
        break;
      case 'state':
        this.applyTime(msg.serverTime);
        this.state = msg.state;
        this.dispatchEvent(new CustomEvent('state', { detail: msg.state }));
        break;
      case 'pong': {
        const rtt = Date.now() - msg.ts;
        this.rtt = rtt;
        // Le serveur a repondu a mi-parcours : on compense la moitie du trajet.
        const offset = msg.serverTime + rtt / 2 - Date.now();
        this.samples.push({ rtt, offset });
        if (this.samples.length > 9) this.samples.shift();
        const best = [...this.samples].sort((a, b) => a.rtt - b.rtt).slice(0, 3);
        this.offset = Math.round(best.reduce((sum, s) => sum + s.offset, 0) / best.length);
        break;
      }
      case 'error':
        this.dispatchEvent(new CustomEvent('remote-error', { detail: msg }));
        if (msg.code === 'forbidden') {
          // Jeton invalide : inutile d'insister.
          this.closedByUser = true;
          this.ws?.close();
          this.setStatus('idle', msg.code);
        } else if (msg.code === 'access_denied' || msg.code === 'rate_limited') {
          // Inutile de marteler le serveur : on attend le bon code.
          this.closedByUser = true;
          this.ws?.close();
          this.setStatus('idle', msg.code);
        } else if (msg.code === 'no_room') {
          // La salle peut revenir (redemarrage du serveur, salle recreee avec
          // le meme code) : on ferme pour relancer le cycle de reconnexion.
          this.missingRoom = true;
          this.ws?.close();
          this.setStatus('offline', 'no_room');
        }
        break;
      default:
        this.dispatchEvent(new CustomEvent('message', { detail: msg }));
    }
  }

  applyTime(serverTime) {
    if (!serverTime || this.samples.length) return;
    this.offset = serverTime - Date.now();
  }

  startPing() {
    this.stopPing();
    const ping = () => this.send({ t: 'ping', ts: Date.now() });
    ping();
    setTimeout(ping, 400);
    setTimeout(ping, 1200);
    this.pingTimer = setInterval(ping, 10_000);
  }

  stopPing() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  scheduleReconnect() {
    if (this.reconnectTimer || this.closedByUser) return;
    this.attempt += 1;
    const delay = Math.min(15_000, 500 * 2 ** Math.min(this.attempt, 5)) + Math.random() * 400;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  send(payload) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
      return true;
    }
    return false;
  }

  command(name, payload = {}) {
    return this.send({ t: 'cmd', name, payload });
  }

  askQuestion(text, author = '') {
    return this.send({ t: 'question', text, author });
  }

  /** Vote du public sur le sondage en cours. */
  vote(pollId, optionId, voterId) {
    return this.send({ t: 'vote', pollId, optionId, voterId });
  }

  close() {
    this.closedByUser = true;
    this.stopPing();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.ws?.close();
  }
}

/** Construit les URL partageables de la salle. */
export function roomUrls(code, token = null, access = null) {
  const base = location.origin;
  // Le code d'acces voyage dans le fragment : il n'est pas envoye au serveur
  // dans l'URL, donc il ne finit ni dans les journaux ni dans les referers.
  const tail = access ? `#a=${encodeURIComponent(access)}` : '';
  return {
    display: `${base}/d/${code}${tail}`,
    video: `${base}/k/${code}${tail}`,
    ask: `${base}/q/${code}${tail}`,
    control: token ? `${base}/c/${code}#t=${encodeURIComponent(token)}` : `${base}/c/${code}`,
  };
}

/** Lit le code d'acces d'une URL (#a=… ou ?a=…) puis le retire de la barre. */
export function readAccessFromUrl(roomCode) {
  const key = 'timestage:access:' + roomCode;
  const hash = new URLSearchParams(location.hash.replace(/^#/, ''));
  const query = new URLSearchParams(location.search);
  const found = hash.get('a') || query.get('a');
  if (found) {
    try { localStorage.setItem(key, found); } catch { /* mode prive */ }
    history.replaceState(null, '', location.pathname);
    return found;
  }
  try { return localStorage.getItem(key) || ''; } catch { return ''; }
}

export function rememberAccess(roomCode, access) {
  try { localStorage.setItem('timestage:access:' + roomCode, access || ''); } catch { /* prive */ }
}

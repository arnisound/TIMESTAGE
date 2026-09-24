/*!
 * TimeStage, chronometre de scene
 * © 2026 Arnisound Tools (Theo Arnissolle). Tous droits reserves.
 * Logiciel proprietaire : toute reproduction, modification, distribution ou
 * exploitation sans autorisation ecrite prealable est interdite. Voir LICENSE.
 */
// Le hall d'entree : un seul objet pour tout le service, dont le seul role est
// de limiter le nombre de salles creees depuis une meme adresse.
//
// Il lui faut un point unique, car deux requetes de creation peuvent arriver
// dans deux centres de donnees differents et ne partagent alors aucune memoire.
// C'est une operation rare, quelques fois par evenement : ce passage oblige ne
// coute rien a l'usage.

import { DurableObject } from 'cloudflare:workers';

const LIMIT = 30;
const WINDOW_MS = 60 * 60 * 1000;

export class Lobby extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.buckets = new Map();
  }

  async fetch(request) {
    const { ip } = await request.json();
    const now = Date.now();
    const key = String(ip || 'inconnu');
    const bucket = this.buckets.get(key);

    if (!bucket || now > bucket.reset) {
      this.buckets.set(key, { count: 1, reset: now + WINDOW_MS });
      if (this.buckets.size > 2000) {
        for (const [k, b] of this.buckets) if (now > b.reset) this.buckets.delete(k);
      }
      return Response.json({ ok: true });
    }

    bucket.count += 1;
    if (bucket.count > LIMIT) return Response.json({ ok: false }, { status: 429 });
    return Response.json({ ok: true });
  }
}

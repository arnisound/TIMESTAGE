/*!
 * TimeStage, chronometre de scene
 * © 2026 Arnisound Tools (Theo Arnissolle). Tous droits reserves.
 * Logiciel proprietaire : toute reproduction, modification, distribution ou
 * exploitation sans autorisation ecrite prealable est interdite. Voir LICENSE.
 */
// Sondages du public : limites et depouillement, partages par le serveur, la
// regie, l'ecran et la page publique. Un seul endroit decide des bornes, donc
// la regie ne peut pas proposer ce que le serveur refuserait.

export const POLL_LIMITS = {
  minOptions: 2,
  maxOptions: 6,
  question: 160,
  option: 80,
};

/** Lettre d'une reponse : A, B, C… Repere commun a l'ecran et au telephone. */
export function pollLetter(index) {
  return String.fromCharCode(65 + (Number(index) || 0));
}

/**
 * Depouille un sondage : total, part de chaque reponse et reponse en tete.
 * Les compteurs sont assainis ici, car ils peuvent venir d'un etat masque
 * (le public recoit des zeros tant que les resultats ne sont pas reveles).
 */
export function pollTally(poll) {
  const options = Array.isArray(poll?.options) ? poll.options : [];
  const counts = options.map((option) => Math.max(0, Math.round(Number(option?.votes) || 0)));
  const total = counts.reduce((sum, n) => sum + n, 0);
  const best = counts.length ? Math.max(...counts) : 0;
  return {
    total,
    options: options.map((option, i) => ({
      id: option?.id || '',
      label: option?.label || '',
      votes: counts[i],
      share: total ? counts[i] / total : 0,
      // En tete seulement s'il y a des voix : sans vote, rien ne domine.
      leading: total > 0 && counts[i] === best,
    })),
  };
}

/** Libelle court du nombre de votes, pour une puce ou un pied de tableau. */
export function pollVoteLabel(total) {
  return `${total} vote${total > 1 ? 's' : ''}`;
}

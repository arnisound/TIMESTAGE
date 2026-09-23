/*!
 * TimeStage, chronometre de scene
 * © 2026 Arnisound Tools (Theo Arnissolle). Tous droits reserves.
 * Logiciel proprietaire : toute reproduction, modification, distribution ou
 * exploitation sans autorisation ecrite prealable est interdite. Voir LICENSE.
 */
// Catalogue des animations de scene. Partage entre le serveur (validation des
// commandes), la fenetre de regie (boutons) et le moteur de rendu.

export const EFFECTS = {
  fire: { label: 'Flammes', layer: 'back', icon: '🔥' },
  rain: { label: 'Pluie', layer: 'back', icon: '🌧️' },
  flood: { label: 'Inondation', layer: 'back', icon: '🌊' },
  wind: { label: 'Vent', layer: 'back', icon: '💨' },
  plants: { label: 'Plantes', layer: 'back', icon: '🌱' },
  confetti: { label: 'Confettis', layer: 'front', icon: '🎉' },
  snow: { label: 'Neige', layer: 'front', icon: '❄️' },
  smoke: { label: 'Fumee', layer: 'back', icon: '🌫️' },
};

export const EFFECT_NAMES = Object.keys(EFFECTS);
export const EFFECT_LAYERS = ['back', 'front'];

/** Duree par defaut d'un effet, en millisecondes. */
export const DEFAULT_EFFECT_DURATION = 12000;

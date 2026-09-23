/*!
 * TimeStage — chronometre de scene
 * © 2026 Arnisound Tools — Theo Arnissolle. Tous droits reserves.
 * Logiciel proprietaire : toute reproduction, modification, distribution ou
 * exploitation sans autorisation ecrite prealable est interdite. Voir LICENSE.
 */
// Formatage et analyse des durees, partages entre le serveur, la fenetre de
// controle, l'affichage et le mode hors ligne.

export const MS = { h: 3600000, m: 60000, s: 1000 };

/** Format par defaut : heures automatiques, minutes et secondes, pas de ms. */
export const DEFAULT_FORMAT = { h: 'auto', m: 'on', s: 'on', ms: 0 };

export function normalizeFormat(fmt) {
  const f = { ...DEFAULT_FORMAT, ...(fmt || {}) };
  const tri = (v) => (v === 'on' || v === 'off' || v === 'auto' ? v : 'auto');
  const bi = (v) => (v === 'off' ? 'off' : 'on');
  return {
    h: tri(f.h),
    m: bi(f.m),
    s: bi(f.s),
    ms: Math.min(3, Math.max(0, Math.round(Number(f.ms) || 0))),
  };
}

/** Unites reellement affichees pour une valeur donnee. */
export function visibleUnits(fmt, valueMs = 0) {
  const f = normalizeFormat(fmt);
  const units = [];
  if (f.h === 'on' || (f.h === 'auto' && Math.abs(valueMs) >= MS.h)) units.push('h');
  if (f.m === 'on') units.push('m');
  if (f.s === 'on') units.push('s');
  if (units.length === 0) units.push(f.ms > 0 ? 's' : 'm');
  return units;
}

/**
 * Formate une duree en millisecondes.
 * @param {number} value duree (peut etre negative : depassement)
 * @param {object} fmt   {h,m,s,ms}
 * @param {object} opts  {round:'floor'|'ceil'|'nearest', signed:boolean}
 */
export function formatDuration(value, fmt = DEFAULT_FORMAT, opts = {}) {
  const f = normalizeFormat(fmt);
  const round = opts.round || 'floor';
  const negative = value < 0;
  let t = Math.abs(Number(value) || 0);

  // On arrondit d'abord a la granularite affichee pour eviter les sauts.
  let units = visibleUnits(f, t);
  const smallest = units[units.length - 1];
  const granularity = f.ms > 0 ? 10 ** (3 - f.ms) : MS[smallest];
  const div = t / granularity;
  t = (round === 'ceil' ? Math.ceil(div) : round === 'nearest' ? Math.round(div) : Math.floor(div)) * granularity;

  // L'arrondi peut faire apparaitre l'heure en mode auto (59:59.9 -> 1:00:00).
  units = visibleUnits(f, t);

  let rest = t;
  const chunks = [];
  for (const u of units) {
    const step = MS[u];
    const v = Math.floor(rest / step);
    rest -= v * step;
    chunks.push(String(v).padStart(2, '0'));
  }
  let out = chunks.join(':');
  if (f.ms > 0) {
    const frac = Math.floor(rest / 10 ** (3 - f.ms));
    out += '.' + String(frac).padStart(f.ms, '0');
  }
  const sign = negative ? '-' : opts.signed ? '+' : '';
  return sign + out;
}

/** Libelle court du format, ex. "HH:MM:SS.cc". */
export function formatLabel(fmt) {
  const f = normalizeFormat(fmt);
  const parts = [];
  if (f.h === 'on') parts.push('HH');
  else if (f.h === 'auto') parts.push('(HH)');
  if (f.m === 'on') parts.push('MM');
  if (f.s === 'on') parts.push('SS');
  let label = parts.join(':') || 'MM';
  if (f.ms === 1) label += '.d';
  else if (f.ms === 2) label += '.cc';
  else if (f.ms === 3) label += '.mmm';
  return label;
}

const UNIT_RE = /(-?\d+(?:[.,]\d+)?)\s*(ms|h|m|s)?/gi;

/**
 * Analyse une duree saisie par l'utilisateur.
 * Accepte "90", "5:00", "1:02:03", "1:02:03.250", "5m", "1h30", "2m30s", "750ms".
 * @param {string|number} input
 * @param {'h'|'m'|'s'|'ms'} defaultUnit unite d'un nombre nu
 * @returns {number|null} millisecondes, ou null si illisible
 */
export function parseDuration(input, defaultUnit = 'm') {
  if (typeof input === 'number' && Number.isFinite(input)) return Math.round(input);
  if (typeof input !== 'string') return null;
  const raw = input.trim().toLowerCase().replace(/\s+/g, '');
  if (!raw) return null;
  const negative = raw.startsWith('-');
  const body = negative ? raw.slice(1) : raw;

  let total = null;
  if (body.includes(':')) {
    const segs = body.split(':');
    if (segs.length > 3 || segs.some((s) => s !== '' && !/^\d+([.,]\d+)?$/.test(s))) return null;
    const nums = segs.map((s) => (s === '' ? 0 : Number(s.replace(',', '.'))));
    // Le dernier segment est toujours la seconde : m:s ou h:m:s.
    const scale = [MS.s, MS.m, MS.h];
    total = 0;
    for (let i = 0; i < nums.length; i++) {
      const value = nums[nums.length - 1 - i];
      if (!Number.isFinite(value)) return null;
      total += value * scale[i];
    }
  } else if (/^\d+([.,]\d+)?$/.test(body)) {
    const unit = defaultUnit === 'ms' ? 1 : MS[defaultUnit] || MS.m;
    total = Number(body.replace(',', '.')) * unit;
  } else {
    // Forme "1h30", "2m30s", "750ms"
    if (!/^(\d+(?:[.,]\d+)?(ms|h|m|s)?)+$/.test(body)) return null;
    total = 0;
    let matched = false;
    let lastUnit = null;
    UNIT_RE.lastIndex = 0;
    let m;
    while ((m = UNIT_RE.exec(body)) !== null) {
      if (m[0] === '') break;
      matched = true;
      const value = Number(m[1].replace(',', '.'));
      let unit = m[2];
      if (!unit) {
        // "1h30" -> le nombre nu suit l'unite precedente d'un cran.
        unit = lastUnit === 'h' ? 'm' : lastUnit === 'm' ? 's' : defaultUnit;
      }
      lastUnit = unit;
      total += value * (unit === 'ms' ? 1 : MS[unit]);
    }
    if (!matched) return null;
  }
  if (total === null || !Number.isFinite(total)) return null;
  return Math.round(negative ? -total : total);
}

/** Heure du jour d'une date, en millisecondes depuis minuit (heure locale). */
export function timeOfDayMs(date = new Date()) {
  return (
    date.getHours() * MS.h +
    date.getMinutes() * MS.m +
    date.getSeconds() * MS.s +
    date.getMilliseconds()
  );
}

/** Formate une heure d'horloge (HH:MM ou HH:MM:SS). */
export function formatClock(date = new Date(), withSeconds = true) {
  const p = (n) => String(n).padStart(2, '0');
  return (
    p(date.getHours()) + ':' + p(date.getMinutes()) + (withSeconds ? ':' + p(date.getSeconds()) : '')
  );
}

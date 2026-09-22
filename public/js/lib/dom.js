// Petites aides DOM, sans dependance.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Cree un element. Le texte passe par textContent : jamais d'injection HTML. */
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (key in node && key !== 'list') node[key] = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of [].concat(children)) {
    if (child == null || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

let toastHost = null;
export function toast(message, kind = '', ms = 3200) {
  if (!toastHost) {
    toastHost = el('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastHost);
  }
  const node = el('div', { class: 'toast ' + kind, text: message });
  toastHost.append(node);
  setTimeout(() => {
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 200);
  }, ms);
  return node;
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = el('textarea', { value: text, style: { position: 'fixed', opacity: '0' } });
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }
}

export function qrUrl(data, { size = 320, dark = '#000000', light = '#ffffff' } = {}) {
  const params = new URLSearchParams({ data, dark, light, margin: '1' });
  return '/api/qr.svg?' + params.toString();
}

/** Plein ecran avec repli silencieux. */
export async function toggleFullscreen(target = document.documentElement) {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await target.requestFullscreen();
    return true;
  } catch {
    return false;
  }
}

/** Empeche la mise en veille de l'ecran tant que la page est visible. */
export function keepAwake() {
  let lock = null;
  const request = async () => {
    if (!('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
    try { lock = await navigator.wakeLock.request('screen'); } catch { /* ignore */ }
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') request();
  });
  request();
  return () => lock?.release?.();
}

export function download(filename, text, type = 'application/json') {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function pickFile(accept = '.json,application/json') {
  return new Promise((resolve) => {
    const input = el('input', { type: 'file', accept, style: { display: 'none' } });
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      input.remove();
      if (!file) return resolve(null);
      const reader = new FileReader();
      reader.onload = () => resolve({ name: file.name, text: String(reader.result) });
      reader.onerror = () => resolve(null);
      reader.readAsText(file);
    });
    document.body.append(input);
    input.click();
  });
}

export function relativeTime(ts, now = Date.now()) {
  const diff = Math.max(0, now - ts);
  const s = Math.round(diff / 1000);
  if (s < 60) return "a l'instant";
  const m = Math.round(s / 60);
  if (m < 60) return `il y a ${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `il y a ${h} h`;
  return `il y a ${Math.round(h / 24)} j`;
}

// Shared helpers for the archived pages. No inline scripts anywhere: the site runs under a strict CSP.
// Paths are relative so the archive works at the custom domain and at a github.io project path.
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const IST = 'Asia/Kolkata';
const timeFmt = new Intl.DateTimeFormat('en-IN', { timeZone: IST, hour: 'numeric', minute: '2-digit' });
const dayTimeFmt = new Intl.DateTimeFormat('en-IN', { timeZone: IST, day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
export const fmtTime = (iso) => (iso ? timeFmt.format(new Date(iso)) : '');
export const fmtDayTime = (iso) => (iso ? dayTimeFmt.format(new Date(iso)) : '');
export const pct = (x, digits = 0) => `${(x * 100).toFixed(digits)}%`;
export const num = (n) => Number(n || 0).toLocaleString('en-IN');

// The archive bundles its data: each file is fetched once, never polled.
export async function loadJson(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`Could not load ${path} (${r.status})`);
  return r.json();
}

export function showLoadError(box) {
  box.removeAttribute('aria-busy');
  box.innerHTML = '<p class="empty"><strong>Could not load the archived results</strong>Reload the page to try again.</p>';
}

// Header bits common to every page: site title from results.json.
export function applySiteSettings(settings) {
  if (!settings) return;
  const brand = $('.brand-title');
  if (brand && settings.title) brand.textContent = settings.title;
  if (settings.title) document.title = `${document.title.split(' | ')[0]} | ${settings.title}`;
}

export function partyLookup(parties) {
  const m = Object.fromEntries((parties || []).map((p) => [p.id, p]));
  return (id) => m[id] || { id: null, name: 'Unaffiliated', colour: '#8d97a2' };
}

// ---- motion helpers: all of them do nothing when the visitor prefers reduced motion ----
const motionQuery = matchMedia('(prefers-reduced-motion: reduce)');
export const reducedMotion = () => motionQuery.matches;

// Count a number up to its value.
export function countUp(el, from, to, ms = 700) {
  if (reducedMotion() || from === to) { el.textContent = num(to); return; }
  const start = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - start) / ms);
    const eased = 1 - (1 - t) ** 3;
    el.textContent = num(Math.round(from + (to - from) * eased));
    if (t < 1) requestAnimationFrame(step);
  };
  el.textContent = num(from);
  requestAnimationFrame(step);
}

// Smoothly open or close a block by animating its height. Resolves when finished.
export function expand(el) {
  if (!el || reducedMotion() || !el.animate) return Promise.resolve();
  const h = el.scrollHeight;
  return el.animate([{ height: '0px', opacity: 0 }, { height: `${h}px`, opacity: 1 }], { duration: 260, easing: 'cubic-bezier(.2,.7,.2,1)' }).finished.catch(() => {});
}
export function collapse(el) {
  if (!el || reducedMotion() || !el.animate) return Promise.resolve();
  const h = el.scrollHeight;
  return el.animate([{ height: `${h}px`, opacity: 1 }, { height: '0px', opacity: 0 }], { duration: 200, easing: 'cubic-bezier(.4,0,.2,1)', fill: 'forwards' }).finished.catch(() => {});
}

// Shared helpers for every page. No inline scripts anywhere: the site runs under a strict CSP.
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const IST = 'Asia/Kolkata';
const timeFmt = new Intl.DateTimeFormat('en-IN', { timeZone: IST, hour: 'numeric', minute: '2-digit' });
const dayTimeFmt = new Intl.DateTimeFormat('en-IN', { timeZone: IST, day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
export const fmtTime = (iso) => (iso ? timeFmt.format(new Date(iso)) : '');
export const fmtDayTime = (iso) => (iso ? dayTimeFmt.format(new Date(iso)) : '');
export function ago(iso) {
  if (!iso) return '';
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return fmtTime(iso);
}
export const pct = (x, digits = 0) => `${(x * 100).toFixed(digits)}%`;
export const num = (n) => Number(n || 0).toLocaleString('en-IN');

let configPromise;
export function loadConfig() {
  configPromise = configPromise || fetch('/config.json', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
  return configPromise;
}

export async function api(path, { method = 'GET', body, token } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetch(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, cache: 'no-store' });
  } catch {
    const e = new Error('Could not reach the server. Check your connection and try again.');
    e.status = 0;
    throw e;
  }
  let data = {};
  try { data = await res.json(); } catch { /* WAF or CDN error pages are not JSON */ }
  if (!res.ok) {
    const fallback = res.status === 429 || res.status === 403
      ? 'Too many requests from your network right now. Wait a minute and try again.'
      : `The server returned an error (${res.status}). Try again.`;
    const e = new Error(data.error || fallback);
    e.status = res.status;
    e.data = data;
    throw e;
  }
  return data;
}

// Fetch a published JSON file on an interval; pauses while the tab is hidden.
export function poll(url, ms, onData, onError) {
  let timer;
  let last = '';
  const tick = async () => {
    clearTimeout(timer);
    try {
      const r = await fetch(url, { cache: 'no-store' });
      if (!r.ok) throw new Error(String(r.status));
      const text = await r.text();
      if (text !== last) { last = text; onData(JSON.parse(text)); }
      else onData(null);
    } catch (e) {
      if (onError) onError(e);
    }
    if (!document.hidden) timer = setTimeout(tick, ms);
  };
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
  tick();
  return { refresh: tick };
}

// ---- university ID: validated and hashed on this device; only the hash is sent ----
export const ID_SALT = 'cetunion2026:';
export function normaliseId(raw) { return String(raw || '').toUpperCase().replace(/[\s-]/g, ''); }
export function idLooksValid(raw, pattern) {
  try { return new RegExp(pattern || '^L?TVE\\d{2}[A-Z]{1,6}\\d{1,4}$').test(normaliseId(raw)); } catch { return true; }
}
export async function hashId(raw) {
  const data = new TextEncoder().encode(ID_SALT + normaliseId(raw));
  const buf = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Wires an ID input: validates format, shows exactly what will leave the device.
export function idField(input, out, pattern) {
  const update = async () => {
    const v = input.value.trim();
    if (!v) { out.textContent = ''; input.classList.remove('invalid'); return; }
    if (!idLooksValid(v, pattern)) {
      input.classList.add('invalid');
      out.textContent = 'That does not look like a university ID (for example TVE23CS045 or LTVE23ME012).';
      return;
    }
    input.classList.remove('invalid');
    const h = await hashId(v);
    out.innerHTML = `Sent to the server instead of your ID: <code>${h.slice(0, 16)}…</code>`;
  };
  input.addEventListener('input', update);
  update();
  return {
    async value() {
      const v = input.value.trim();
      if (!v) throw new Error('Enter your university ID.');
      if (!idLooksValid(v, pattern)) throw new Error('That does not look like a university ID. Check it and try again.');
      return hashId(v);
    },
  };
}

// ---- optional Cloudflare Turnstile human check ----
let tsLoad;
export function humanCheck(container, siteKey) {
  if (!siteKey) return { token: async () => '', reset() {} };
  tsLoad = tsLoad || new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    s.async = true;
    s.onload = resolve;
    s.onerror = () => reject(new Error('The human check could not load. Disable content blockers for this site and reload.'));
    document.head.appendChild(s);
  });
  let widgetId = null;
  let current = '';
  const ready = tsLoad.then(() => {
    widgetId = window.turnstile.render(container, {
      sitekey: siteKey, theme: 'auto', size: 'flexible',
      callback: (t) => { current = t; },
      'expired-callback': () => { current = ''; },
    });
  });
  return {
    async token() {
      await ready;
      if (!current) throw new Error('Complete the "verify you are human" check first.');
      return current;
    },
    reset() { current = ''; if (widgetId !== null) window.turnstile.reset(widgetId); },
  };
}

export function toast(text, isErr = false) {
  const t = document.createElement('div');
  t.className = `toast${isErr ? ' err' : ''}`;
  t.setAttribute('role', 'status');
  t.textContent = text;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), isErr ? 5000 : 2600);
}

export function showMsg(el, text, kind = 'err') {
  if (!text) { el.hidden = true; el.textContent = ''; return; }
  el.hidden = false;
  el.className = `msg ${kind}`;
  el.textContent = text;
}

// Header bits common to public pages: site title + notice banner from results.json.
export function applySiteSettings(settings) {
  if (!settings) return;
  const brand = $('.brand-title');
  if (brand && settings.title) brand.textContent = settings.title;
  if (settings.title) document.title = `${document.title.split(' | ')[0]} | ${settings.title}`;
  const n = $('#notice');
  if (n) {
    n.hidden = !settings.notice;
    $('.wrap', n).textContent = settings.notice || '';
  }
}

export function partyLookup(parties) {
  const m = Object.fromEntries((parties || []).map((p) => [p.id, p]));
  return (id) => m[id] || { id: null, name: 'Unaffiliated', colour: '#8d97a2' };
}

// ---- motion helpers: all of them do nothing when the visitor prefers reduced motion ----
const motionQuery = matchMedia('(prefers-reduced-motion: reduce)');
export const reducedMotion = () => motionQuery.matches;

// Count a number up (or down) to its new value.
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

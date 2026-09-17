// Token, API, cache, version check. ARCHITECTURE.md §4.1, §4.7, CONTRACTS.md §4.

const TOKEN_KEY = 'room.token';
const DB_NAME = 'room';
const STORES = ['events', 'places', 'me', 'plans', 'meta'];

// ---------- token ----------
export function claimTokenFromUrl() {
  const m = /^#\/join\/([a-z2-7]{26})$/.exec(location.hash);
  if (!m) return null;
  const token = m[1];
  localStorage.setItem(TOKEN_KEY, token);
  history.replaceState(null, '', location.pathname + location.search);
  return token;
}

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(t) {
  localStorage.setItem(TOKEN_KEY, t);
}
export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

// ---------- IndexedDB ----------
let dbPromise = null;
function idb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      for (const s of STORES) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }).catch(() => null);
  return dbPromise;
}

export async function cacheGet(store, key = 'all') {
  try {
    const db = await idb();
    if (!db) return null;
    return await new Promise((resolve) => {
      const r = db.transaction(store, 'readonly').objectStore(store).get(key);
      r.onsuccess = () => resolve(r.result ?? null);
      r.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

export async function cacheSet(store, value, key = 'all') {
  try {
    const db = await idb();
    if (!db) return;
    await new Promise((resolve) => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).put(value, key);
      tx.oncomplete = tx.onerror = tx.onabort = () => resolve();
    });
  } catch {
    /* cache is an accelerator, never a source of truth */
  }
}

// Home anchor never leaves the device. It lives here and is never put in a request body.
export async function getHomeAnchor() {
  return (await cacheGet('meta', 'home_anchor')) ?? null;
}
export async function setHomeAnchor(anchor) {
  await cacheSet('meta', anchor, 'home_anchor');
}

// ---------- API ----------
export class ApiError extends Error {
  constructor(status, code, detail) {
    super(detail || code);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

export async function api(path, { method = 'GET', body, raw = false } = {}) {
  const token = getToken();
  const isWrite = method !== 'GET';
  if (isWrite && navigator.onLine === false) throw new ApiError(0, 'offline_write', 'You need a connection to save that.');
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  let res;
  try {
    res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError(0, isWrite ? 'offline_write' : 'offline', isWrite ? 'You need a connection to save that.' : 'No connection.');
  }
  if (res.status === 204) return null;
  if (raw) {
    if (!res.ok) throw new ApiError(res.status, 'bad_request', 'That did not work.');
    return res.text();
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error || 'bad_request', data.detail || 'That did not work.');
  return data;
}

// ---------- always load the newest version ----------
export function watchVersion(current, onStale) {
  let stopped = false;
  const check = async () => {
    if (stopped || document.visibilityState !== 'visible') return;
    try {
      const r = await fetch('/api/version', { cache: 'no-store' });
      const { version } = await r.json();
      if (version && current && version !== current) onStale(version);
    } catch {
      /* offline is not stale */
    }
  };
  document.addEventListener('visibilitychange', check);
  window.addEventListener('focus', check);
  const timer = setInterval(check, 10 * 60 * 1000);
  return () => {
    stopped = true;
    clearInterval(timer);
    document.removeEventListener('visibilitychange', check);
    window.removeEventListener('focus', check);
  };
}

export function reloadForNewVersion() {
  // Hashed asset names mean a plain reload is enough; the Worker sends the HTML no-store.
  location.reload();
}

// ---------- small helpers used across tabs ----------
export const TZ = 'America/Chicago';

export function todayInAustin() {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const g = (t) => p.find((x) => x.type === t).value;
  return `${g('year')}-${g('month')}-${g('day')}`;
}

export function timeLabel(iso) {
  return new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
}

export function dayLabel(ymd) {
  const d = new Date(`${ymd}T12:00:00Z`);
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }).format(d);
}

export function addDays(ymd, n) {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Straight-line km, used only to trim the fallback list against the on-device home anchor. */
export function km(a, b) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Austin arterials make miles lie, so this is a rough minutes estimate, labeled as rough in the UI. */
export function roughMinutes(distanceKm) {
  return Math.max(3, Math.round((distanceKm / 35) * 60));
}

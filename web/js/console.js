// Client for the Dune Docker Console API, with the API key the admin created there
// (Settings > API Keys, scopes maps: Read and bases: Read).
//
// Security rules of this file:
//  * Every request carries the key as Authorization: Bearer and credentials: 'omit', so the
//    browser never attaches the logged-in admin's session cookie. The addon has exactly the
//    rights of that key and nothing else.
//  * Only GET requests are made.
//  * The key lives in memory ONLY. It is never written to the addon storage (shared by every
//    user of the console), localStorage, sessionStorage, IndexedDB or the Cache API. It has to
//    be entered again each time the addon page is opened (a password manager can fill it).
import { store } from './store.js';

const LEGACY_KEY = 'console.key'; // versions up to 0.2.0 stored the key here; removed on start
const LABEL_STORE = 'instance.names';
const KEY_PATTERN = /^dak_[A-Za-z0-9_-]{8,200}$/;
const LABEL_PATTERN = /^[\p{L}\p{N} ._\-()/+&]{1,40}$/u;

let token = null;
let purged = false;

// Errors carry a code the UI translates (err.<code> in i18n.js) and an optional detail.
function fail(code, detail = '') {
  const e = new Error(`${code}: ${detail}`);
  e.code = code;
  e.detail = detail;
  return e;
}

// ---------- key ----------

// Nothing is loaded from storage: the key exists only after the user entered it in this page.
// The first call also deletes a key an older version left in the shared addon storage.
export async function loadToken() {
  if (!purged) {
    purged = true;
    await store.purgeLegacyKey(LEGACY_KEY);
  }
  return token;
}

export const hasToken = () => token !== null;
export const keyId = () => (token ? token.split('_')[1] : '');

export async function dropToken() {
  token = null;
  cache.clear();
}

// Checks the key against the console and keeps it in memory. Both scopes are verified up front
// so a key without bases: Read is rejected with a clear message instead of failing later.
export async function saveToken(candidate) {
  const key = String(candidate ?? '').trim();
  if (!KEY_PATTERN.test(key)) throw fail('token_format');
  const probe = async (path) => {
    let r;
    try {
      r = await fetch(path, { credentials: 'omit', cache: 'no-store', headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' } });
    } catch (e) {
      throw fail('unreachable', e.message);
    }
    return r;
  };
  const maps = await probe('/api/map/partitions');
  if (maps.status === 401 || maps.status === 403) throw fail('token_rejected');
  if (maps.status !== 200) throw fail('http_status', String(maps.status));
  try { await maps.json(); } catch { throw fail('not_console'); }
  // bases: Read is needed for the 3D buildings. An unknown base id answers 404/400 when
  // the scope is present and 403 when it is missing.
  const bases = await probe('/api/bases/0/export');
  if (bases.status === 403) throw fail('token_scope_bases');
  if (bases.status === 401) throw fail('token_rejected');
  token = key;
  cache.clear();
}

// ---------- requests with caching ----------

const cache = new Map(); // path -> { at, status, body, pending }

// Live data of the console, at most `ttl` ms old. Parallel requests share one call.
// A failed call keeps serving older data (better than none); unknown things (404) are
// remembered for 15 minutes so a broken entry does not hit the console again and again.
export async function consoleGet(path, ttl) {
  if (!token) throw fail('token_rejected');
  const c = cache.get(path);
  if (c?.pending) return c.pending;
  if (c && (Date.now() - c.at < ttl || (c.status === 404 && Date.now() - c.at < 15 * 60 * 1000))) {
    if (c.status >= 400) throw fail('http_status', String(c.status));
    return c.body;
  }
  const pending = (async () => {
    let r;
    try {
      r = await fetch(path, { credentials: 'omit', cache: 'no-store', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
    } catch (e) {
      if (c?.body) return c.body;
      throw fail('unreachable', e.message);
    }
    if (r.status === 401 || r.status === 403) {
      cache.delete(path);
      throw fail('token_rejected');
    }
    if (r.status === 429 && c?.body) { cache.set(path, { ...c, at: Date.now() }); return c.body; }
    if (!r.ok) {
      cache.set(path, { at: Date.now(), status: r.status, body: null });
      throw fail('http_status', String(r.status));
    }
    const body = await r.json();
    cache.set(path, { at: Date.now(), status: 200, body });
    return body;
  })();
  cache.set(path, { ...(c ?? { at: 0, status: 0, body: null }), pending });
  try { return await pending; } finally {
    const cur = cache.get(path);
    if (cur?.pending === pending) { const { pending: _p, ...rest } = cur; cache.set(path, rest); }
  }
}

// A GET to the console that is read as a stream (Realtime Data: server-sent events). Same rules
// as every other call: the key as Authorization: Bearer, credentials: 'omit', GET only. EventSource
// cannot send a header, so the caller reads the response body itself. Throws like consoleGet.
export async function consoleStream(path, signal) {
  if (!token) throw fail('token_rejected');
  let r;
  try {
    r = await fetch(path, { method: 'GET', credentials: 'omit', cache: 'no-store', signal, headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream, application/json' } });
  } catch (e) {
    if (e?.name === 'AbortError') throw e;
    throw fail('unreachable', e.message);
  }
  if (r.status === 401 || r.status === 403) throw fail('token_rejected');
  if (!r.ok) throw fail('http_status', String(r.status));
  return r;
}

// The console's own map image (public file of the console UI, no key needed) and its
// calibration from the markers answer.
export async function mapImage(liveName) {
  const doc = await consoleGet(`/api/map/markers?map=${encodeURIComponent(liveName)}`, 60 * 60 * 1000);
  const info = doc?.maps?.[liveName];
  if (!info?.image) return null;
  // only paths of the console itself get the key; the image is fetched like the old server did
  if (!String(info.image).startsWith('/')) return null;
  const r = await fetch(info.image, { credentials: 'omit', cache: 'force-cache', headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) return null;
  return { blob: await r.blob(), bounds: [info.minX, info.maxX, info.minY, info.maxY, !!info.flipY] };
}

// ---------- instances (partitions) and their names ----------

// Names of the maps with a running server instance, from the console's mapsList output
// ("<Map> Current: .. Assigned: n"). Hagga Basin always runs.
export function parseActive(stdout) {
  const names = ['Survival_1'];
  for (const line of String(stdout).split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length < 2 || !f[1].startsWith('Current:')) continue;
    for (let i = 0; i + 1 < f.length; i++) if (f[i] === 'Assigned:' && f[i + 1] !== '0') names.push(f[0]);
  }
  return names;
}

export async function activeMaps() {
  try {
    const st = await consoleGet('/api/map/status', 60 * 1000);
    const out = st?.maps?.stdout;
    return out ? new Set(parseActive(out)) : null;
  } catch { return null; }
}

export async function partitions() {
  try { return (await consoleGet('/api/map/partitions', 60 * 1000))?.rows ?? []; } catch { return []; }
}

export async function customLabels() {
  const v = await store.get(LABEL_STORE).catch(() => null);
  return v && typeof v === 'object' ? v : {};
}

export async function saveLabels(labels) {
  const out = {};
  for (const [k, raw] of Object.entries(labels ?? {})) {
    const v = String(raw).trim();
    if (!/^\d+$/.test(k) || !v) continue;
    if (!LABEL_PATTERN.test(v)) throw fail('name_invalid', v);
    out[k] = v;
  }
  try { await store.put(LABEL_STORE, out); } catch (e) { throw fail('save_failed', e.message); }
  return out;
}

function cleanLabel(label, mapTitle) {
  let l = String(label ?? '').trim();
  if (l.startsWith(mapTitle)) l = l.slice(mapTitle.length).trim();
  if (l.toUpperCase() === 'PVE') return 'PvE';
  if (l.toUpperCase() === 'PVP') return 'PvP';
  return l;
}

const autoLabels = new Map();
// Name of an instance as the server reports it: its display name, otherwise PvP/PvE from the PvP switch.
export async function autoLabel(source, title, partition, internal) {
  const key = `${source}/${partition}`;
  if (autoLabels.has(key)) return autoLabels.get(key);
  const values = async (scope) => {
    try {
      const doc = await consoleGet(`/api/maps/user-settings/values?scope=${scope}&map=${encodeURIComponent(source)}&partitionId=${partition}`, 10 * 60 * 1000);
      const out = {};
      for (const l of String(doc?.stdout ?? '').split('\n')) {
        const t = l.indexOf('\t');
        if (t > 0) out[l.slice(0, t)] = l.slice(t + 1).trim();
      }
      return out;
    } catch { return {}; }
  };
  let label = cleanLabel((await values('partitionEngine')).server_display_name, title);
  if (!label) {
    const pvp = String((await values('partition')).partition_pvp_enabled ?? '').toLowerCase();
    label = pvp === 'true' ? `PvP (${internal})` : pvp === 'false' ? `PvE (${internal})` : internal;
  }
  autoLabels.set(key, label);
  return label;
}

// Coriolis cycle of the Deep Desert (layout, seed, next change) from the markers answer.
export async function coriolis(liveName) {
  if (liveName !== 'DeepDesert') return null;
  try {
    const doc = await consoleGet(`/api/map/markers?map=${liveName}`, 5 * 60 * 1000);
    if (doc?.coriolisLayout == null) return null;
    return { layout: doc.coriolisLayout, seed: doc.coriolisSeed, nextCycle: doc.coriolisNextCycleAt };
  } catch { return null; }
}

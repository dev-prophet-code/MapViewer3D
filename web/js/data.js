// Terrain data, streamed from GitHub (see config.js). Replaces the data part of the old
// viewer server: catalog of maps, terrain tiles ("patch"), height sampling.
//
// Everything that is loaded is checked against a hash that is itself pinned:
//   catalog.json  against CATALOG_SHA256 (config.js),
//   m/<map>.json  against the sha256 listed in the catalog,
//   tiles         against the content id in their file name (first 16 hex of SHA-256).
// A mirror that returns something else is skipped; if none matches the load fails.
import { CATALOG_SHA256, DATA_MIRRORS } from './config.js';

const CACHE_NAME = 'mapviewer3d-data-v1';
const MAX_PARALLEL = 8;

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
// crypto.subtle only exists in secure contexts (https, localhost); a console served over
// plain http gets the small pure-JS implementation below instead.
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
function sha256js(buf) {
  const bytes = new Uint8Array(buf);
  const len = bytes.length;
  const total = ((len + 9 + 63) >> 6) << 6;
  const msg = new Uint8Array(total);
  msg.set(bytes);
  msg[len] = 0x80;
  const dv = new DataView(msg.buffer);
  dv.setUint32(total - 8, Math.floor(len / 0x20000000));
  dv.setUint32(total - 4, (len << 3) >>> 0);
  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + 4 * i);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
  }
  const out = new Uint8Array(32);
  const odv = new DataView(out.buffer);
  H.forEach((v, i) => odv.setUint32(4 * i, v));
  return out.buffer;
}
export const sha256 = async (buf) => hex(globalThis.crypto?.subtle ? await crypto.subtle.digest('SHA-256', buf) : sha256js(buf));

// Cache API wrapper: tiles are content-addressed, so a cached copy never goes stale.
async function openCache() {
  try { return await caches.open(CACHE_NAME); } catch { return null; }
}
const cachePromise = openCache();

// Fetches one data file from the mirrors; `check(buf)` returns true for acceptable content.
async function fetchData(path, check) {
  const cache = await cachePromise;
  const key = new Request(DATA_MIRRORS[0](path));
  if (cache) {
    try {
      const hit = await cache.match(key);
      if (hit) {
        const buf = await hit.arrayBuffer();
        if (await check(buf)) return buf;
        await cache.delete(key); // damaged or outdated entry
      }
    } catch { /* cache unavailable */ }
  }
  let last = null;
  for (const mirror of DATA_MIRRORS) {
    try {
      const r = await fetch(mirror(path), { credentials: 'omit', referrerPolicy: 'no-referrer' });
      if (!r.ok) { last = new Error(`${path}: HTTP ${r.status}`); continue; }
      const buf = await r.arrayBuffer();
      if (!(await check(buf))) { last = new Error(`${path}: content does not match its checksum`); continue; }
      if (cache) { try { await cache.put(key, new Response(buf.slice(0))); } catch { /* quota */ } }
      return buf;
    } catch (e) { last = e; }
  }
  throw last ?? new Error(`${path}: no data mirror`);
}

// ---------- catalog and map indexes ----------

let catalogPromise = null;
export function loadCatalog() {
  catalogPromise ??= fetchData('catalog.json', async (b) => (await sha256(b)) === CATALOG_SHA256)
    .then((b) => JSON.parse(new TextDecoder().decode(b)))
    .catch((e) => { catalogPromise = null; throw e; });
  return catalogPromise;
}

const indexes = new Map();
export function loadIndex(name) {
  if (!indexes.has(name)) {
    const p = loadCatalog().then(async (cat) => {
      const entry = cat.maps.find((m) => m.name === name);
      if (!entry) throw new Error(`unknown map ${name}`);
      const buf = await fetchData(entry.file, async (b) => (await sha256(b)) === entry.sha256);
      return JSON.parse(new TextDecoder().decode(buf));
    });
    p.catch(() => indexes.delete(name));
    indexes.set(name, p);
  }
  return indexes.get(name);
}

// ---------- tiles ----------

// FORMAT 1 (see tools/tilepack.mjs): gzip( low-byte plane | high-byte plane | materials ),
// heights delta-coded along rows. Returns heights (uint16) followed by materials (uint8),
// the layout terrain.js expects.
async function gunzip(buf) {
  const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function decodeTile(raw, patchQuads) {
  const N = patchQuads + 1, NN = N * N;
  if (raw.length !== 3 * NN) throw new Error('tile has the wrong size');
  const out = new ArrayBuffer(3 * NN);
  const h = new Uint16Array(out, 0, NN);
  for (let j = 0; j < N; j++) {
    let prev = 0;
    for (let i = 0; i < N; i++) {
      prev = (prev + (raw[j * N + i] | (raw[NN + j * N + i] << 8))) & 0xffff;
      h[j * N + i] = prev;
    }
  }
  new Uint8Array(out, 2 * NN).set(raw.subarray(2 * NN));
  return out;
}

let running = 0;
const waiting = [];
async function slot() {
  if (running >= MAX_PARALLEL) await new Promise((r) => waiting.push(r));
  running++;
}
function release() {
  running--;
  waiting.shift()?.();
}

const empty = new Map(); // patchQuads -> zero tile
const tiles = new Map(); // "map/l/x/y" -> Promise<ArrayBuffer>, a small LRU of decoded tiles
const MAX_TILES = 600;

// One terrain tile (level l, column x, row y) of a map; zeros where the map has no data.
export function getTile(name, l, x, y) {
  const key = `${name}/${l}/${x}/${y}`;
  if (tiles.has(key)) {
    const p = tiles.get(key);
    tiles.delete(key); tiles.set(key, p); // most recently used last
    return p.then((b) => b.slice(0)); // callers may keep the buffer
  }
  const p = (async () => {
    const idx = await loadIndex(name);
    const level = idx.levels[l];
    const id = level && x >= 0 && y >= 0 && x < level.nx && y < level.ny ? level.cells[y * level.nx + x] : -1;
    if (id < 0) {
      if (!empty.has(idx.patchQuads)) empty.set(idx.patchQuads, new ArrayBuffer(3 * (idx.patchQuads + 1) ** 2));
      return empty.get(idx.patchQuads);
    }
    const hash = idx.ids[id];
    await slot();
    try {
      const gz = await fetchData(`p/${hash.slice(0, 2)}/${hash.slice(2)}.z`, async (b) => {
        try { return (await sha256(await gunzip(b))).startsWith(hash); } catch { return false; }
      });
      return await decodeTile(await gunzip(gz), idx.patchQuads);
    } finally { release(); }
  })();
  p.catch(() => tiles.delete(key));
  tiles.set(key, p);
  while (tiles.size > MAX_TILES) tiles.delete(tiles.keys().next().value);
  return p.then((b) => b.slice(0));
}

// ---------- height sampling ----------

// Terrain height (cm) at world position x/y (cm), bilinear; null outside the map or where there is no data.
// Same maths as the old server (backend/server/terrain.go heightAt).
export async function sampleHeights(name, pts) {
  const idx = await loadIndex(name);
  const m = idx.meta, Q = idx.patchQuads, N = Q + 1;
  const unit = (m.maxZ - m.minZ) / 65534;
  const byTile = new Map();
  const out = new Array(pts.length).fill(null);
  pts.forEach((p, k) => {
    const fx = (p[0] - m.originX) / m.spacing, fy = (p[1] - m.originY) / m.spacing;
    if (!(fx >= 0 && fy >= 0 && fx <= m.width - 1 && fy <= m.height - 1)) return;
    const i = Math.floor(fx), j = Math.floor(fy);
    const tx = Math.floor(i / Q), ty = Math.floor(j / Q);
    const key = `${tx},${ty}`;
    if (!byTile.has(key)) byTile.set(key, { tx, ty, items: [] });
    byTile.get(key).items.push({ k, fx, fy, i, j });
  });
  await Promise.all([...byTile.values()].map(async ({ tx, ty, items }) => {
    const buf = await getTile(name, 0, tx, ty);
    const h = new Uint16Array(buf, 0, N * N);
    for (const { k, fx, fy, i, j } of items) {
      const i1 = Math.min(i + 1, m.width - 1), j1 = Math.min(j + 1, m.height - 1);
      const u = fx - i, v = fy - j;
      let sum = 0, wsum = 0;
      for (const [cx, cy, w] of [[i, j, (1 - u) * (1 - v)], [i1, j, u * (1 - v)], [i, j1, (1 - u) * v], [i1, j1, u * v]]) {
        const hv = h[(cy - ty * Q) * N + (cx - tx * Q)];
        if (hv !== 0 && w > 0) { sum += w * (m.minZ + (hv - 1) * unit); wsum += w; }
      }
      if (wsum > 0) out[k] = Math.round(sum / wsum);
    }
  }));
  return out;
}

// ---------- building models ----------

export async function loadBuildablesIndex() {
  const cat = await loadCatalog();
  if (!cat.buildables) return { rows: {}, meshes: [] };
  const buf = await fetchData('buildables/index.json', async (b) => (await sha256(b)) === cat.buildables.index);
  return JSON.parse(new TextDecoder().decode(buf));
}

export async function loadMesh(id) {
  const cat = await loadCatalog();
  const want = cat.buildables?.meshes?.[id];
  if (!want) throw new Error(`unknown building model ${id}`);
  await slot();
  try {
    return await fetchData(`buildables/mesh/${id}.bin`, async (b) => (await sha256(b)).startsWith(want));
  } finally { release(); }
}

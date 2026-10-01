#!/usr/bin/env node
// Unit/integration test of the data path without a browser:
// synthetic map -> tools/tilepack.mjs -> local HTTP server -> web/js/data.js (the code the addon runs).
//   node tests/unit.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mv3d-'));
const dataIn = path.join(tmp, 'in'), out = path.join(tmp, 'out');
let failures = 0;
const test = async (name, fn) => {
  try { await fn(); console.log(`ok   ${name}`); } catch (e) { failures++; console.error(`FAIL ${name}\n     ${e.stack ?? e}`); }
};

// ---- synthetic map: 300 x 300 samples, one hole of "no data" (height 0), two materials
const W = 300, H = 300, spacing = 100, minZ = -1000, maxZ = 9000, originX = -15000, originY = -15000;
const heights = new Uint16Array(W * H), mats = new Uint8Array(W * H);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const hole = x >= 130 && x < 150 && y >= 20 && y < 40;
  heights[y * W + x] = hole ? 0 : 1 + ((x * 97 + y * 53 + ((x * y) % 31) * 17) % 60000);
  mats[y * W + x] = hole ? 0 : 1 + ((x + y) % 3);
}
fs.mkdirSync(path.join(dataIn, 'synth'), { recursive: true });
fs.writeFileSync(path.join(dataIn, 'synth', 'height.u16'), Buffer.from(heights.buffer));
fs.writeFileSync(path.join(dataIn, 'synth', 'material.u8'), Buffer.from(mats));
const meta = { name: 'synth', source: 'Synth_1', title: 'Synth', group: 'Offene Welt', live: 'SynthLive', width: W, height: H, originX, originY, spacing, minZ, maxZ, components: 1, blocks: 1, meshes: 1, levels: 3, material: true };
fs.writeFileSync(path.join(dataIn, 'synth', 'meta.json'), JSON.stringify(meta));
fs.mkdirSync(path.join(dataIn, 'buildables', 'mesh'), { recursive: true });
fs.writeFileSync(path.join(dataIn, 'buildables', 'index.json'), JSON.stringify({ rows: { a: 1 }, meshes: [7] }));
fs.writeFileSync(path.join(dataIn, 'buildables', 'mesh', '7.bin'), Buffer.from('mesh-bytes'));

const log = execFileSync('node', [path.join(root, 'tools', 'tilepack.mjs'), dataIn, out], { encoding: 'utf8' });
const catalogSha = /sha256 ([0-9a-f]{64})/.exec(log)[1];

// ---- the data "mirror": raw.githubusercontent.com look-alike
const server = http.createServer((req, res) => {
  const f = path.join(out, decodeURIComponent(req.url.split('?')[0]));
  if (!f.startsWith(out) || !fs.existsSync(f) || !fs.statSync(f).isFile()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Access-Control-Allow-Origin': '*' });
  res.end(fs.readFileSync(f));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;
globalThis.location = { search: `?data=${encodeURIComponent(base)}&catalog=${catalogSha}`, origin: base, hostname: '127.0.0.1' };

const data = await import(pathToFileURL(path.join(root, 'web', 'js', 'data.js')).href);

// direct reference: what the old Go server computed from the raw files
const ref = (x, y) => {
  const fx = (x - originX) / spacing, fy = (y - originY) / spacing;
  if (fx < 0 || fy < 0 || fx > W - 1 || fy > H - 1) return null;
  const i = Math.floor(fx), j = Math.floor(fy), i1 = Math.min(i + 1, W - 1), j1 = Math.min(j + 1, H - 1), u = fx - i, v = fy - j;
  const unit = (maxZ - minZ) / 65534;
  let s = 0, w = 0;
  for (const [cx, cy, ww] of [[i, j, (1 - u) * (1 - v)], [i1, j, u * (1 - v)], [i, j1, (1 - u) * v], [i1, j1, u * v]]) {
    const h = heights[cy * W + cx];
    if (h !== 0 && ww > 0) { s += ww * (minZ + (h - 1) * unit); w += ww; }
  }
  return w ? Math.round(s / w) : null;
};

await test('catalog is verified and lists the map and the building models', async () => {
  const cat = await data.loadCatalog();
  assert.equal(cat.maps.length, 1);
  assert.equal(cat.maps[0].name, 'synth');
  assert.equal(Object.keys(cat.buildables.meshes).length, 1);
});

await test('tiles equal the patches the old server produced (all levels, incl. hole and edges)', async () => {
  const idx = await data.loadIndex('synth');
  const Q = idx.patchQuads, N = Q + 1;
  for (let l = 0; l <= idx.maxLevel; l++) {
    const { nx, ny } = idx.levels[l];
    for (let py = 0; py < ny; py++) for (let px = 0; px < nx; px++) {
      const buf = await data.getTile('synth', l, px, py);
      const h = new Uint16Array(buf, 0, N * N), m = new Uint8Array(buf, 2 * N * N, N * N);
      const step = 1 << l;
      for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
        const x = px * Q * step + i * step, y = py * Q * step + j * step;
        const inside = x < W && y < H;
        assert.equal(h[j * N + i], inside ? heights[y * W + x] : 0, `h l${l} ${px},${py} ${i},${j}`);
        assert.equal(m[j * N + i], inside ? mats[y * W + x] : 0, `m l${l} ${px},${py} ${i},${j}`);
      }
    }
  }
});

await test('sampleHeights matches the reference formula (random points, tile borders, outside, hole)', async () => {
  const pts = [[originX, originY], [originX + 128 * spacing, originY + 128 * spacing], [originX + 127.5 * spacing, originY + 255.9 * spacing],
    [originX + (W - 1) * spacing, originY + (H - 1) * spacing], [originX - 1, 0], [originX + 140 * spacing, originY + 30 * spacing], [1e9, 1e9]];
  for (let k = 0; k < 400; k++) pts.push([originX + Math.random() * (W - 1) * spacing, originY + Math.random() * (H - 1) * spacing]);
  const got = await data.sampleHeights('synth', pts);
  pts.forEach((p, k) => assert.equal(got[k], ref(p[0], p[1]), `point ${p}`));
});

await test('a damaged tile is refused (content checksum)', async () => {
  const idx = await data.loadIndex('synth');
  const id = idx.ids[idx.levels[idx.maxLevel].cells.find((c) => c >= 0)];
  const file = path.join(out, 'p', id.slice(0, 2), id.slice(2) + '.z');
  const good = fs.readFileSync(file);
  const bad = Buffer.from(good); bad[bad.length - 12] ^= 0xff;
  fs.writeFileSync(file, bad);
  try {
    // fresh module state: a new import with a query string
    const fresh = await import(pathToFileURL(path.join(root, 'web', 'js', 'data.js')).href + '?x=1');
    await assert.rejects(() => fresh.getTile('synth', idx.maxLevel, 0, 0));
  } finally { fs.writeFileSync(file, good); }
});

await test('a tampered catalog is refused (pinned checksum)', async () => {
  const f = path.join(out, 'catalog.json');
  const good = fs.readFileSync(f);
  fs.writeFileSync(f, good.toString().replace('Synth', 'Evil!'));
  try {
    const fresh = await import(pathToFileURL(path.join(root, 'web', 'js', 'data.js')).href + '?x=2');
    await assert.rejects(() => fresh.loadCatalog());
  } finally { fs.writeFileSync(f, good); }
});

await test('building models are verified', async () => {
  assert.equal(JSON.stringify(await data.loadBuildablesIndex()), JSON.stringify({ rows: { a: 1 }, meshes: [7] }));
  assert.equal(Buffer.from(await data.loadMesh('7')).toString(), 'mesh-bytes');
  await assert.rejects(() => data.loadMesh('8'));
});

await test('SHA-256 fallback (console served over plain http) gives the same result', async () => {
  const real = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { value: {}, configurable: true });
  try {
    const fresh = await import(pathToFileURL(path.join(root, 'web', 'js', 'data.js')).href + '?x=3');
    for (const n of [0, 1, 55, 56, 64, 1000, 70000]) {
      const b = crypto.randomBytes(n);
      assert.equal(await fresh.sha256(b), crypto.createHash('sha256').update(b).digest('hex'), `len ${n}`);
    }
  } finally { Object.defineProperty(globalThis, 'crypto', real); }
});

server.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} test(s) failed` : '\nall tests passed');
process.exit(failures ? 1 : 0);

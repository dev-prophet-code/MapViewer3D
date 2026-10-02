#!/usr/bin/env node
// Realtime Data in the addon (web/js/realtime.js): the console passes the MapViewer3D position
// agent's data on at /api/realtime/* to API keys with the scope "Realtime Data". These tests run
// the addon's real console.js / realtime.js against a mock console.
//   node tests/realtime.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mv3d-rt-'));
const KEY = 'dak_test_test_test_test'; // obvious dummy (gitleaks generic-api-key)
let failures = 0;
const test = async (name, fn) => {
  try { await fn(); console.log(`ok   ${name}`); } catch (e) { failures++; console.error(`FAIL ${name}\n     ${e.stack ?? e}`); }
};

const SNAP = {
  gen: 1, t: 1,
  sources: [
    { map: 'Survival_1', partition: 1, ready: true, n: 3, weather: { coriolisNext: 1790000000000 } },
    { map: 'Survival_1', partition: 31, ready: true, n: 1 },
    { map: 'DeepDesert_1', partition: 35, ready: true, n: 1 },
  ],
  objects: [
    { i: 1, k: 'worm', c: 'BP_Crea_SandwormArrakis_C', s: 0, x: 100.4, y: 200.6, z: 5 },
    { i: 2, k: 'npc', c: 'BP_Npc_SoldierBase_C', s: 1, x: 300, y: 400, z: 6 },
    { i: 3, k: 'player', c: 'BP_Player_C', s: 0, x: 7, y: 8, z: 9 },
    { i: 4, k: 'worm', c: 'BP_Crea_SandwormArrakis_C', s: 2, x: 1, y: 2, z: 3 },
    { i: 5, k: 'storm', c: 'BP_Storm_C', s: 0, x: 10, y: 20, z: 0, yaw: 45 },
  ],
};
const enc = (name, data) => new TextEncoder().encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);

// A mock console. mode: 'ok' | 'none' (404) | 'scope' (403) | 'agent' (503) | 'revoked' (401)
function mockConsole() {
  const st = { mode: 'ok', requests: [], push: null, open: 0 };
  globalThis.window = { parent: null }; window.parent = window;
  globalThis.location = { protocol: 'https:', hostname: 'dune.example.org' };
  globalThis.fetch = async (url, opts = {}) => {
    st.requests.push({ url: String(url), method: opts.method ?? 'GET', credentials: opts.credentials, auth: opts.headers?.Authorization });
    assert.equal(opts.credentials, 'omit', 'every call must omit credentials');
    assert.ok((opts.method ?? 'GET') === 'GET', 'GET only');
    if (opts.headers?.Authorization !== `Bearer ${KEY}` || st.mode === 'revoked') return { status: 401, ok: false, json: async () => ({}) };
    const u = String(url);
    if (u.includes('/api/map/partitions')) return { status: 200, ok: true, json: async () => ({ rows: [] }) };
    if (u.includes('/api/bases/0/export')) return { status: 404, ok: false, json: async () => ({}) };
    if (u.startsWith('/api/realtime/')) {
      if (st.mode === 'none') return { status: 404, ok: false, json: async () => ({}) };
      if (st.mode === 'scope') return { status: 403, ok: false, json: async () => ({ error: 'This API key is not permitted to use this endpoint.' }) };
      if (st.mode === 'agent') return { status: 503, ok: false, json: async () => ({ available: false }) };
      if (u.endsWith('/healthz')) return { status: 200, ok: true, json: async () => ({ available: true, version: 1, ok: true }) };
      if (u.endsWith('/objects')) return { status: 200, ok: true, json: async () => SNAP };
      if (u.endsWith('/stream')) {
        st.open++;
        let ctrl;
        const body = new ReadableStream({ start(c) { ctrl = c; c.enqueue(enc('snap', SNAP)); c.enqueue(new TextEncoder().encode(': keepalive\n\n')); st.push = (name, d) => ctrl.enqueue(enc(name, d)); st.end = () => ctrl.close(); } });
        opts.signal?.addEventListener('abort', () => { st.open--; try { ctrl.close(); } catch { /* closed */ } });
        return { status: 200, ok: true, body };
      }
    }
    return { status: 404, ok: false, json: async () => ({}) };
  };
  return st;
}

let n = 0;
async function modules() {
  const dir = path.join(tmp, `m${n++}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ['console.js', 'store.js', 'realtime.js']) fs.copyFileSync(path.join(root, 'web', 'js', f), path.join(dir, f));
  const url = (f) => pathToFileURL(path.join(dir, f)).href;
  return { cons: await import(url('console.js')), rt: await import(url('realtime.js')) };
}
const settle = (ms = 80) => new Promise((r) => setTimeout(r, ms));

await test('available only when the console answers Realtime Data for this key', async () => {
  const c = mockConsole();
  const { cons, rt } = await modules();
  await cons.saveToken(KEY);
  assert.equal(await rt.isAvailable(true), true);
  const probe = c.requests.find((r) => r.url === '/api/realtime/healthz');
  assert.deepEqual([probe.method, probe.credentials, probe.auth], ['GET', 'omit', `Bearer ${KEY}`]);
  for (const mode of ['none', 'scope', 'agent']) {
    c.mode = mode;
    const m = await modules(); // fresh state: consoleGet remembers answers
    await m.cons.saveToken(KEY).catch(() => {});
    c.mode = 'ok'; await m.cons.saveToken(KEY); c.mode = mode;
    assert.equal(await m.rt.isAvailable(true), false, `mode ${mode}: switches must stay hidden, without an error`);
  }
});

await test('stream: each layer gets only its map and instance, never players', async () => {
  const c = mockConsole();
  const { cons, rt } = await modules();
  await cons.saveToken(KEY);
  const hagga = []; const dd = []; const pvp = [];
  const h1 = rt.attach('Survival_1', null, { snap: (v) => hagga.push(v), pos: (p) => hagga.push(p) });
  await settle();
  const snap = hagga[0];
  assert.deepEqual(snap.objects.map((o) => o.i).sort(), [1, 2, 5], 'Hagga Basin without the Deep Desert worm and without the player');
  assert.equal(snap.connected, true);
  assert.deepEqual(snap.objects.find((o) => o.i === 1), { i: 1, k: 'worm', c: 'BP_Crea_SandwormArrakis_C', p: 1, x: 100, y: 201, z: 5 }, 'rounded, partition added');
  assert.equal(snap.objects.find((o) => o.i === 5).yaw, 45);
  assert.deepEqual(snap.weather, { coriolisNext: 1790000000000 });
  const h2 = rt.attach('DeepDesert_1', null, { snap: (v) => dd.push(v), pos: (p) => dd.push(p) });
  const h3 = rt.attach('Survival_1', 31, { snap: (v) => pvp.push(v), pos: (p) => pvp.push(p) });
  assert.deepEqual(dd[0].objects.map((o) => o.i), [4]);
  assert.deepEqual(pvp[0].objects.map((o) => o.i), [2], 'a single instance only');
  assert.equal(c.open, 1, 'one shared connection for all layers');
  // position updates: only for the objects a layer knows; a player update never passes
  c.push('pos', { gen: 1, t: 2, d: [[1, 111, 222, 6], [4, 9, 9, 9], [3, 70, 80, 90]], r: [] });
  await settle();
  assert.deepEqual(hagga.at(-1).d.map((d) => d[0]), [1]);
  assert.deepEqual(dd.at(-1).d.map((d) => d[0]), [4]);
  assert.equal(pvp.length, 1, 'no update for objects of another instance');
  c.push('pos', { gen: 1, t: 3, d: [], r: [1, 3] });
  await settle();
  assert.deepEqual(hagga.at(-1).r, [1], 'removal only for known objects');
  h1.close(); h2.close(); h3.close();
  await settle();
  assert.equal(c.open, 0, 'the connection closes with the last layer');
});

await test('every request carries the key, omits cookies and is a GET', async () => {
  const c = mockConsole();
  const { cons, rt } = await modules();
  await cons.saveToken(KEY);
  const h = rt.attach('Survival_1', null, { snap() {}, pos() {} });
  await rt.snapshot('Survival_1', null);
  await settle();
  h.close();
  const mine = c.requests.filter((r) => r.url.startsWith('/api/realtime/'));
  assert.ok(mine.length >= 2);
  for (const r of mine) assert.deepEqual([r.method, r.credentials, r.auth], ['GET', 'omit', `Bearer ${KEY}`], r.url);
});

await test('a revoked key ends the stream for good and the feature switches off', async () => {
  const c = mockConsole();
  const { cons, rt } = await modules();
  await cons.saveToken(KEY);
  c.mode = 'revoked';
  let errors = 0;
  const h = rt.attach('Survival_1', null, { snap() {}, pos() {}, error: () => errors++ });
  await settle(200);
  const streams = c.requests.filter((r) => r.url === '/api/realtime/stream').length;
  await settle(1300);
  assert.equal(c.requests.filter((r) => r.url === '/api/realtime/stream').length, streams, 'no retry after the key was refused');
  assert.ok(errors >= 1);
  assert.equal(await rt.isAvailable(), false);
  h.close();
});

await test('plain HTTP away from this machine is reported, HTTPS and localhost are not', async () => {
  mockConsole();
  const { rt } = await modules();
  globalThis.location = { protocol: 'http:', hostname: '203.0.113.7' };
  assert.equal(rt.plainHttp(), true);
  globalThis.location = { protocol: 'http:', hostname: '127.0.0.1' };
  assert.equal(rt.plainHttp(), false);
  globalThis.location = { protocol: 'https:', hostname: 'dune.example.org' };
  assert.equal(rt.plainHttp(), false);
});

await test('static: realtime.js stores nothing and never uses a non-GET or cookie path', async () => {
  const src = fs.readFileSync(path.join(root, 'web', 'js', 'realtime.js'), 'utf8').replace(/^\s*\/\/.*$/gm, ''); // code only, not comments
  for (const bad of ['localStorage', 'sessionStorage', 'indexedDB', 'caches.', 'document.cookie', "method: 'POST'", "method: 'PUT'", 'XMLHttpRequest', 'EventSource']) {
    assert.ok(!src.includes(bad), `realtime.js must not use ${bad}`);
  }
  assert.ok(!/credentials:\s*'include'/.test(src));
});

if (failures) { console.error(`\n${failures} test(s) failed`); process.exit(1); }
console.log('\nall realtime tests passed');
process.exit(0);

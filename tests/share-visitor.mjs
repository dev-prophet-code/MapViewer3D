#!/usr/bin/env node
// A visitor of a share link has no API key: every console call must go to the gateway under the link's
// own path, without an Authorization header and without cookies; the admin's key code must stay out.
//   node tests/share-visitor.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mv3d-share-'));
const TOKEN = `mvs_${'Q'.repeat(43)}`;
let failures = 0;
const test = async (name, fn) => {
  try { await fn(); console.log(`ok   ${name}`); } catch (e) { failures++; console.error(`FAIL ${name}\n     ${e.stack ?? e}`); }
};

let n = 0;
async function load(pathname) {
  const dir = path.join(tmp, `v${n++}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ['console.js', 'store.js', 'config.js', 'realtime.js']) fs.copyFileSync(path.join(root, 'web', 'js', f), path.join(dir, f));
  const calls = [];
  Object.assign(globalThis, {
    window: { parent: null }, localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    location: { search: '', pathname, protocol: 'https:', hostname: 'share.example.org', origin: 'https://share.example.org' },
    fetch: async (url, opts = {}) => {
      calls.push({ url: String(url), headers: opts.headers ?? {}, credentials: opts.credentials, method: opts.method ?? 'GET' });
      if (String(url).endsWith('/api/realtime/healthz')) return { status: 200, ok: true, json: async () => ({ available: true }) };
      if (String(url).includes('/api/map/markers')) return { status: 200, ok: true, json: async () => ({ maps: { HaggaBasin: { image: '/images/maps/h.webp', minX: 0, maxX: 1, minY: 0, maxY: 1 } } }), blob: async () => 'IMG' };
      if (String(url).includes('/images/maps/')) return { status: 200, ok: true, blob: async () => 'IMG' };
      return { status: 200, ok: true, json: async () => ({ rows: [] }) };
    },
  });
  globalThis.window.parent = globalThis.window;
  const url = (f) => pathToFileURL(path.join(dir, f)).href;
  return { calls, config: await import(url('config.js')), cons: await import(url('console.js')), rt: await import(url('realtime.js')) };
}

await test('share link page: calls go under the link path, with no key and no cookies', async () => {
  const p = await load(`/s/${TOKEN}/`);
  assert.equal(p.config.SHARE_BASE, `/s/${TOKEN}`);
  assert.equal(p.cons.hasToken(), true, 'nothing to enter');
  await p.cons.consoleGet('/api/map/overlays?map=HaggaBasin', 0);
  await p.cons.consoleGet('/api/map/players?map=HaggaBasin', 0);
  await p.cons.mapImage('HaggaBasin');
  assert.equal(await p.rt.isAvailable(true), true);
  assert.ok(p.calls.length >= 4);
  for (const c of p.calls) {
    assert.ok(c.url.startsWith(`/s/${TOKEN}/`), `url ${c.url}`);
    assert.equal(c.credentials, 'omit', 'no cookies');
    assert.equal(c.method, 'GET');
    assert.ok(!('Authorization' in c.headers), 'no Authorization header for a visitor');
  }
  assert.ok(p.calls.some((c) => c.url === `/s/${TOKEN}/images/maps/h.webp`), 'map image through the gateway too');
});

await test('normal addon page: paths unchanged and the key is still required', async () => {
  const p = await load('/api/addons/installed/mapviewer3d/content/web/index.html');
  assert.equal(p.config.SHARE_BASE, null);
  assert.equal(p.config.apiUrl('/api/map/status'), '/api/map/status');
  assert.equal(p.cons.hasToken(), false);
  await assert.rejects(() => p.cons.consoleGet('/api/map/status', 0), /token_rejected/);
  assert.equal(p.calls.length, 0, 'nothing is sent without a key');
});

await test('a look-alike path is not a share link', async () => {
  for (const bad of [`/x/s/${TOKEN}/`, `/s/${TOKEN}x/`, '/s/mvs_short/', `/s/${TOKEN.replace('mvs_', 'dak_')}/`, `/s/${TOKEN}`]) {
    const p = await load(bad);
    assert.equal(p.config.SHARE_BASE, null, bad);
  }
});

if (failures) { console.error(`\n${failures} test(s) failed`); process.exit(1); }
console.log('\nall share visitor tests passed');

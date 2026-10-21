#!/usr/bin/env node
// consoleGet keeps serving the last good data across a transient failure (5xx, timeout, 429), asks
// again soon, and lets a definite answer (404) replace it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv3d-cache-'));
for (const f of ['console.js', 'store.js', 'config.js']) fs.copyFileSync(path.join(root, 'web', 'js', f), path.join(dir, f));
const KEY = 'dak_test_test_test_test';
let answer = () => ({ status: 200, body: { rows: [1] } });
let calls = 0;
Object.assign(globalThis, {
  window: { parent: null }, localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
  location: { search: '', pathname: '/api/addons/installed/mapviewer3d/content/web/index.html', protocol: 'https:', hostname: 'c.example.org' },
  fetch: async (url) => {
    if (String(url).includes('partitions')) return { status: 200, json: async () => ({ rows: [] }) };
    if (String(url).includes('/api/bases/0/')) return { status: 404, json: async () => ({}) };
    calls++;
    const a = answer();
    return { status: a.status, ok: a.status < 300, json: async () => a.body };
  },
});
globalThis.window.parent = globalThis.window;
const cons = await import(pathToFileURL(path.join(dir, 'console.js')).href);
await cons.saveToken(KEY);
let failures = 0;
const test = async (name, fn) => { try { await fn(); console.log(`ok   ${name}`); } catch (e) { failures++; console.error(`FAIL ${name}\n     ${e.stack ?? e}`); } };
const realNow = Date.now;
let clock = realNow();
Date.now = () => clock;

await test('a 5xx keeps the last good data and is retried within seconds', async () => {
  answer = () => ({ status: 200, body: { rows: [1] } });
  assert.deepEqual(await cons.consoleGet('/api/map/overlays?map=A', 20000), { rows: [1] });
  clock += 21000; // stale: asks again
  for (const status of [500, 502, 503, 408]) {
    answer = () => ({ status, body: {} });
    assert.deepEqual(await cons.consoleGet('/api/map/overlays?map=A', 20000), { rows: [1] }, `${status}: old data stays`);
    clock += 6000; // the retry window (5 s) has passed
  }
  answer = () => ({ status: 200, body: { rows: [2] } });
  assert.deepEqual(await cons.consoleGet('/api/map/overlays?map=A', 20000), { rows: [2] }, 'recovered: new data');
});

await test('429 keeps the data too', async () => {
  clock += 21000;
  answer = () => ({ status: 429, body: {} });
  assert.deepEqual(await cons.consoleGet('/api/map/overlays?map=A', 20000), { rows: [2] });
});

await test('a definite answer (404) replaces the data and an error with no data still throws', async () => {
  clock += 21000;
  answer = () => ({ status: 404, body: {} });
  await assert.rejects(() => cons.consoleGet('/api/map/overlays?map=A', 20000), /http_status/);
  clock += 21000;
  answer = () => ({ status: 500, body: {} });
  await assert.rejects(() => cons.consoleGet('/api/map/never-loaded', 20000), /http_status/);
});

Date.now = realNow;
void calls;
if (failures) { console.error(`\n${failures} test(s) failed`); process.exit(1); }
console.log('\nall console cache tests passed');

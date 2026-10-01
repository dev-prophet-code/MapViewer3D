#!/usr/bin/env node
// The API key must never be persisted. The console isolates addon storage per ADDON, not per
// signed-in user (addon.storage.* in the console's bridge), so anything stored there is readable
// by every user who can reach the bridge. These tests run the addon's real console.js/store.js
// against a model of that shared storage and of every browser storage API.
//   node tests/key-storage.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mv3d-key-'));
const KEY = 'dak_test_test_test_test'; // obvious dummy (gitleaks generic-api-key)
let failures = 0;
const test = async (name, fn) => {
  try { await fn(); console.log(`ok   ${name}`); } catch (e) { failures++; console.error(`FAIL ${name}\n     ${e.stack ?? e}`); }
};

// ---- the console's addon storage: one JSON map PER ADDON, shared by every user
const sharedStorage = new Map();
const bridgeCalls = [];
function consoleBridge(user) {
  return async (action, payload) => {
    bridgeCalls.push({ user, action, key: payload?.key });
    if (action === 'addon.storage.get') {
      return sharedStorage.has(payload.key) ? { found: true, key: payload.key, version: 1, value: sharedStorage.get(payload.key) } : { found: false, key: payload.key, version: 0 };
    }
    if (action === 'addon.storage.put') { sharedStorage.set(payload.key, payload.value); return { ok: true, key: payload.key }; }
    if (action === 'addon.storage.delete') { sharedStorage.delete(payload.key); return { ok: true, deleted: true }; }
    if (action === 'addon.storage.list') return { keys: [...sharedStorage.keys()] };
    throw new Error(`unsupported ${action}`);
  };
}

// ---- every browser storage API records what is done to it
function browserStorages() {
  const rec = { writes: [], reads: [], removes: [], idb: 0, cache: 0 };
  const mk = (name, seed = {}) => {
    const m = new Map(Object.entries(seed));
    return {
      getItem: (k) => { rec.reads.push(`${name}:${k}`); return m.has(k) ? m.get(k) : null; },
      setItem: (k, v) => { rec.writes.push(`${name}:${k}=${v}`); m.set(k, String(v)); },
      removeItem: (k) => { rec.removes.push(`${name}:${k}`); m.delete(k); },
      has: (k) => m.has(k),
    };
  };
  return { rec, mk };
}

// A fresh copy of the modules per scenario (their state is module level).
let n = 0;
async function page({ user, inFrame, withBridge, legacyLocal = false }) {
  const dir = path.join(tmp, `p${n++}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ['console.js', 'store.js']) fs.copyFileSync(path.join(root, 'web', 'js', f), path.join(dir, f));
  const { rec, mk } = browserStorages();
  const local = mk('localStorage', legacyLocal ? { 'mapviewer3d.dev.console.key': JSON.stringify({ token: KEY }) } : {});
  const session = mk('sessionStorage');
  const win = { parent: inFrame ? {} : null };
  win.parent ??= win; // top-level page: parent === window
  if (withBridge) win.DuneAddon = { request: consoleBridge(user) };
  Object.assign(globalThis, {
    window: win, localStorage: local, sessionStorage: session,
    indexedDB: { open() { rec.idb++; throw new Error('indexedDB must not be used'); } },
    caches: { open() { rec.cache++; throw new Error('Cache API must not be used'); } },
    fetch: async (url, opts) => {
      assert.equal(opts.credentials, 'omit');
      const ok = opts.headers.Authorization === `Bearer ${KEY}`;
      if (!ok) return { status: 401, json: async () => ({}) };
      if (String(url).includes('/api/map/partitions')) return { status: 200, json: async () => ({ rows: [] }) };
      return { status: 404, json: async () => ({}) }; // bases probe: scope present
    },
  });
  const mod = await import(pathToFileURL(path.join(dir, 'console.js')).href);
  return { mod, rec, local, session };
}

const dump = () => JSON.stringify([...sharedStorage.entries()]);

await test('two users: user A enters the key, user B can never get it from the shared storage', async () => {
  sharedStorage.clear();
  const a = await page({ user: 'A', inFrame: true, withBridge: true });
  await a.mod.loadToken();
  await a.mod.saveToken(KEY);
  assert.equal(a.mod.hasToken(), true, 'A works with the key in memory');
  assert.ok(!dump().includes(KEY), 'the key must not be in the shared addon storage');
  assert.ok(!bridgeCalls.some((c) => c.action === 'addon.storage.put' && c.key === 'console.key'), 'no put of console.key');
  // user B opens the same addon
  const b = await page({ user: 'B', inFrame: true, withBridge: true });
  assert.equal(await b.mod.loadToken(), null, 'B starts without a key');
  assert.equal(b.mod.hasToken(), false);
  assert.ok(!dump().includes(KEY), 'still nothing to steal');
  // even asking the bridge for everything yields no key
  const all = await consoleBridge('B')('addon.storage.list', {});
  for (const k of all.keys) assert.ok(!JSON.stringify(sharedStorage.get(k)).includes(KEY), `value of ${k}`);
});

await test('non-secret data (instance names) still persists in the shared storage', async () => {
  sharedStorage.clear();
  const a = await page({ user: 'A', inFrame: true, withBridge: true });
  await a.mod.saveLabels({ 1: 'Main PvE' });
  const b = await page({ user: 'B', inFrame: true, withBridge: true });
  assert.deepEqual(await b.mod.customLabels(), { 1: 'Main PvE' });
});

await test('direct page access (no parent frame, no bridge): nothing is persisted anywhere', async () => {
  sharedStorage.clear(); bridgeCalls.length = 0;
  const p = await page({ user: 'direct', inFrame: false, withBridge: false });
  await p.mod.loadToken();
  await p.mod.saveToken(KEY);
  assert.equal(p.mod.hasToken(), true);
  assert.deepEqual(p.rec.writes, [], 'no setItem on localStorage/sessionStorage');
  assert.equal(p.rec.idb + p.rec.cache, 0, 'no IndexedDB / Cache API');
  assert.equal(bridgeCalls.length, 0, 'no bridge call');
  assert.ok(!dump().includes(KEY));
  await p.mod.saveLabels({ 2: 'Local' });
  assert.deepEqual(p.rec.writes, [], 'labels are memory-only outside the console too');
});

await test('framed but without the bridge script: still nothing is persisted', async () => {
  sharedStorage.clear(); bridgeCalls.length = 0;
  const p = await page({ user: 'frame', inFrame: true, withBridge: false });
  await p.mod.saveToken(KEY);
  assert.deepEqual(p.rec.writes, []);
  assert.equal(bridgeCalls.length, 0);
});

await test('a wrong key is rejected and nothing is kept', async () => {
  sharedStorage.clear();
  const p = await page({ user: 'A', inFrame: true, withBridge: true });
  await assert.rejects(() => p.mod.saveToken('dak_wrong_wrong_wrong_wrong'), { code: 'token_rejected' });
  assert.equal(p.mod.hasToken(), false);
  assert.deepEqual(p.rec.writes, []);
});

await test('migration: a key left by version <= 0.2.0 is deleted, never adopted', async () => {
  sharedStorage.clear(); bridgeCalls.length = 0;
  sharedStorage.set('console.key', { token: KEY });
  sharedStorage.set('instance.names', { 1: 'Main' });
  const p = await page({ user: 'A', inFrame: true, withBridge: true, legacyLocal: true });
  assert.equal(await p.mod.loadToken(), null, 'the stored key is not used');
  assert.equal(p.mod.hasToken(), false);
  assert.equal(sharedStorage.has('console.key'), false, 'removed from the shared addon storage');
  assert.deepEqual(sharedStorage.get('instance.names'), { 1: 'Main' }, 'other data untouched');
  assert.deepEqual(p.rec.removes, ['localStorage:mapviewer3d.dev.console.key'], 'development copy removed');
  assert.equal(p.local.has('mapviewer3d.dev.console.key'), false);
});

await test('migration also works outside the console (legacy localStorage copy)', async () => {
  const p = await page({ user: 'x', inFrame: false, withBridge: false, legacyLocal: true });
  assert.equal(await p.mod.loadToken(), null);
  assert.equal(p.local.has('mapviewer3d.dev.console.key'), false);
});

await test('forgetting the key drops it from memory', async () => {
  const p = await page({ user: 'A', inFrame: true, withBridge: true });
  await p.mod.saveToken(KEY);
  await p.mod.dropToken();
  assert.equal(p.mod.hasToken(), false);
});

await test('static: key code uses no browser storage API for reading/writing', async () => {
  for (const f of ['console.js', 'store.js']) {
    const src = fs.readFileSync(path.join(root, 'web', 'js', f), 'utf8').replace(/\/\/.*$/gm, '');
    for (const bad of [/\.getItem\(/, /\.setItem\(/, /sessionStorage/, /indexedDB/, /caches\.open/, /document\.cookie/]) {
      assert.ok(!bad.test(src), `${f} contains ${bad}`);
    }
  }
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} test(s) failed` : '\nall key-storage tests passed');
process.exit(failures ? 1 : 0);

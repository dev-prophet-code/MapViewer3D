#!/usr/bin/env node
// The live-data layer of the sandbox edition (sandbox/live-data.js) on the stand-in game database:
// the REST-shaped answers the viewer reads, the sharing of one query between feeds, and the bridge's
// budget of 60 calls a minute.
import assert from 'node:assert/strict';
import { createFixtureDb } from './fixtures/dune-fixture.mjs';

const db = await createFixtureDb(); // before the page stand-in below: PGlite behaves differently when it sees a window
// bridge.js, imported by live-data.js, wants a page
globalThis.window = { parent: {}, addEventListener() {}, crypto: globalThis.crypto, location: { origin: 'null' } };
globalThis.document = { documentElement: { dataset: {} } };
const { createLive } = await import('../sandbox/live-data.js');

let failures = 0;
const test = async (name, fn) => { try { await fn(); console.log(`ok   ${name}`); } catch (e) { failures++; console.error(`FAIL ${name}\n     ${e.stack ?? e}`); } };
const clock = { t: 1_000_000 };
const fresh = (overrides = {}) => {
  const queries = [];
  const live = createLive({
    call: async (q) => { queries.push(q); const r = await db.query(q); return { rows: r.rows }; },
    now: () => clock.t, sleep: async (ms) => { clock.t += ms; }, ...overrides,
  });
  return { live, queries };
};

await test('players and overlays come from one shared query', async () => {
  const { live, queries } = fresh();
  const players = await live.get('/api/map/players?map=HaggaBasin', 5000);
  const overlays = await live.get('/api/map/overlays?map=HaggaBasin', 20000);
  assert.equal(queries.length, 1, 'one query for both');
  assert.ok(players.rows.some((p) => p.name === 'Anna Atreides' || p.character_name === 'Anna Atreides' || JSON.stringify(p).includes('Anna')));
  assert.ok(Array.isArray(overlays.rows));
});

await test('a fresh answer is reused, an old one is asked again', async () => {
  const { live, queries } = fresh();
  await live.get('/api/map/players?map=HaggaBasin', 5000);
  clock.t += 1000;
  await live.get('/api/map/players?map=HaggaBasin', 5000);
  assert.equal(queries.length, 1);
  clock.t += 6000;
  await live.get('/api/map/players?map=HaggaBasin', 5000);
  assert.equal(queries.length, 2);
});

await test('markers, partitions and spice', async () => {
  const { live } = fresh();
  const poi = await live.get('/api/map/poi?map=HaggaBasin', 0);
  assert.ok(poi.rows.length > 0);
  const parts = await live.get('/api/map/partitions', 0);
  assert.ok(parts.rows.some((r) => r.map === 'HaggaBasin' && r.alive));
  assert.deepEqual(await live.get('/api/map/spice?map=HaggaBasin', 0), { rows: [] });
});

await test('a base export, and an unknown base is a 404', async () => {
  const { live } = fresh();
  const rows = (await db.query("select id from dune.buildings order by id limit 1")).rows;
  if (rows.length) assert.ok(await live.get(`/api/bases/${rows[0].id}/export`, 0));
  await assert.rejects(live.get('/api/bases/999999999/export', 0), (e) => e.code === 'http_status');
  await assert.rejects(live.get('/api/bases/abc/export', 0), (e) => e.code === 'http_status');
  await assert.rejects(live.get('/api/settings', 0), (e) => e.code === 'http_status');
});

await test('never more than 50 calls in any minute', async () => {
  const stamps = [];
  const { live } = fresh({ call: async () => { stamps.push(clock.t); return { rows: [{}] }; } });
  for (let i = 0; i < 130; i++) await live.get(`/api/bases/${1000 + i}/export`, 0).catch(() => {});
  for (let i = 0; i < stamps.length; i++) assert.ok(stamps.filter((s) => s > stamps[i] - 60000 && s <= stamps[i]).length <= 50, `window at ${i}`);
});

await test('a bridge error becomes a bridge error, and the last good data survives a failure', async () => {
  let fail = false;
  const { live } = fresh({ call: async (q) => { if (fail) throw new Error('database unavailable'); const r = await db.query(q); return { rows: r.rows }; } });
  const first = await live.get('/api/map/players?map=HaggaBasin', 1000);
  fail = true;
  clock.t += 10000;
  assert.deepEqual(await live.get('/api/map/players?map=HaggaBasin', 1000), first);
  const { live: cold } = fresh({ call: async () => { throw new Error('database unavailable'); } });
  await assert.rejects(cold.get('/api/map/players?map=HaggaBasin', 0), (e) => e.code === 'bridge' && /unavailable/.test(e.detail ?? e.message));
});

await db.close();
if (failures) { console.error(`\n${failures} test(s) failed`); process.exit(1); }
console.log('\nall sandbox live-data tests passed');

#!/usr/bin/env node
// The SQL of the sandbox edition (sandbox/sql.js) against a stand-in game database: it must run,
// return what the viewer draws, pass the console's read-only guard and refuse bad input.
import assert from 'node:assert/strict';
import { createFixtureDb } from './fixtures/dune-fixture.mjs';
import { baseExportSql, intLiteral, mapLiteral, partitionsSql, poiSql, shapeBaseExport, shapePoi, shapeSnapshot, snapshotSql, vehicleSubtype, yawDegrees } from '../sandbox/sql.js';

let failures = 0;
const test = async (name, fn) => { try { await fn(); console.log(`ok   ${name}`); } catch (e) { failures++; console.error(`FAIL ${name}\n     ${e.stack ?? e}`); } };
const db = await createFixtureDb();
const run = async (sql) => (await db.query(sql)).rows;

// The console's own guard for database.query (console/api/src/db.js, isReadOnlySql), copied so that a query
// it would refuse is caught here and not on a server.
const stripSqlComments = (q) => String(q).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ').trim();
const consoleAccepts = (q) => /^(select|with|show|explain)\b/i.test(stripSqlComments(q))
  && !/\b(insert|update|delete|drop|alter|truncate|create|grant|revoke|copy\s+.*\s+from)\b/i.test(stripSqlComments(q));

await test('every query passes the console guard (no forbidden word anywhere)', () => {
  for (const sql of [snapshotSql('Survival_1'), snapshotSql('DeepDesert_1'), partitionsSql(), poiSql('Survival_1'), baseExportSql(1001)]) {
    assert.ok(consoleAccepts(sql), `refused: ${sql.slice(0, 80)}`);
    assert.ok(!/--|\/\*/.test(sql), 'no comments in the text sent');
  }
});

await test('values are validated, nothing is written into the text unchecked', () => {
  for (const bad of ["x'; select 1 --", 'a b', '', '1;2', '../x']) assert.throws(() => mapLiteral(bad), /invalid/);
  for (const bad of ['1 or 1=1', '-1', 'abc', '', '1.5', '1234567890123']) assert.throws(() => intLiteral(bad), /invalid/);
  assert.throws(() => snapshotSql("Survival_1' or '1'='1"));
  assert.throws(() => baseExportSql('1; select 1'));
});

await test('snapshot: players, vehicles, bases and storage of one map', async () => {
  const [row] = await run(snapshotSql('Survival_1'));
  const s = shapeSnapshot(row);
  assert.deepEqual(s.players.map((p) => [p.name, p.online_status]).sort(), [['Anna Atreides', 'Online'], ['Boris Harkonnen', 'Offline']]);
  const anna = s.players.find((p) => p.name === 'Anna Atreides');
  assert.deepEqual([anna.x, anna.y, anna.z, anna.partition_id, anna.type], [-12000, 8000, 5000, 1, 'player']);
  assert.ok(!('sector' in anna), 'Hagga Basin has no sector grid');
  const kinds = s.overlays.map((r) => r.type).sort();
  assert.deepEqual(kinds, ['base', 'storage', 'vehicle', 'vehicle'], 'the stored vehicle (VehicleBackup) is not shown');
  const buggy = s.overlays.find((r) => r.type === 'vehicle' && r.class.includes('Buggy'));
  assert.equal(buggy.owner_name, 'Anna Atreides');
  assert.equal(buggy.subtype, 'Buggy');
  const base = s.overlays.find((r) => r.type === 'base');
  assert.deepEqual([base.name, base.base_type, base.id, base.x], ['Anna Outpost', 'Sub-Fief', '1001', -9000]);
  const store = s.overlays.find((r) => r.type === 'storage');
  assert.equal(store.item_count, 3);
  for (const r of [...s.players, ...s.overlays]) {
    assert.ok(typeof r.id === 'string' && Number.isFinite(r.x) && Number.isFinite(r.y), 'string ids, numeric positions');
    for (const secret of ['fls_id', 'funcom_id', 'account_id', 'owner_account_id']) assert.ok(!(secret in r), `no ${secret}`);
  }
});

await test('snapshot: the Deep Desert rows carry their sector', async () => {
  const [row] = await run(snapshotSql('DeepDesert_1'));
  const s = shapeSnapshot(row);
  assert.equal(s.players.length, 1);
  assert.match(s.players[0].sector, /^[A-I][1-9]$/);
  assert.equal(s.overlays.length, 0);
});

await test('partitions: only the maps with a server, with their state', async () => {
  const rows = await run(partitionsSql());
  assert.deepEqual(rows.map((r) => [r.partition_id, r.map, r.alive]), [[8, 'DeepDesert', true], [1, 'HaggaBasin', true]]);
});

await test('markers: grouped like the console, NoIcon dropped, per map', async () => {
  const rows = shapePoi(await run(poiSql('Survival_1')), 'Survival_1');
  assert.deepEqual(rows.map((r) => [r.type, r.subtype]).sort(), [['enemy', 'EnemyCamp'], ['hazard', 'Hazard_Quicksand'], ['ore', 'AzuriteOre'], ['poi', 'Cave_Small'], ['poi', 'TradingPost_Atreides']].sort());
  assert.equal(rows.find((r) => r.type === 'ore').subtypeLabel, 'Copper');
  const dd = shapePoi(await run(poiSql('DeepDesert_1')), 'DeepDesert_1');
  assert.equal(dd.length, 1);
  assert.match(dd[0].sector, /^[A-I][1-9]$/);
});

await test('base export: pieces relative to the anchor, yaw only, claim console left out', async () => {
  const [row] = await run(baseExportSql(1001));
  const b = shapeBaseExport(row);
  assert.deepEqual([b.base_id, b.name, b.x, b.y, b.z], ['1001', 'Anna Outpost', -9000, 9000, 4500]);
  assert.equal(b.instances.length, 3);
  assert.deepEqual([b.instances[0].x, b.instances[0].y, b.instances[0].z, Math.round(b.instances[0].rotation)], [0, 0, 0, 0]);
  assert.deepEqual([b.instances[1].x, b.instances[1].z, Math.round(b.instances[1].rotation)], [200, 100, 90]);
  assert.equal(b.placeables.length, 1);
  assert.deepEqual([b.placeables[0].building_type, b.placeables[0].x, b.placeables[0].y, Math.round(b.placeables[0].ry)], ['StorageContainer_Placeable', -100, 50, 90]);
  assert.deepEqual(await run(baseExportSql(99999)), [], 'an unknown base answers with no row');
});

await test('helpers: vehicle subtypes and yaw', () => {
  assert.equal(vehicleSubtype('BP_Assault_Ornithopter_C'), 'AssaultOrnithopter');
  assert.equal(vehicleSubtype('BP_Whatever'), 'Other');
  assert.equal(Math.round(yawDegrees(0.7071, 0.7071)), 90);
});

if (failures) { console.error(`\n${failures} test(s) failed`); process.exit(1); }
console.log('\nall sandbox SQL tests passed');
process.exit(0);

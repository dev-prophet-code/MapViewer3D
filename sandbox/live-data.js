// Live data of the sandbox edition: the console's REST answers the viewer already understands
// (/api/map/players, /overlays, /poi, /partitions, /api/bases/<id>/export), produced from the game
// database through the addon bridge (see sql.js). Nothing here touches the network.
//
// The bridge allows 60 calls a minute for the addon, so:
//  * one query returns players, vehicles, bases and storage of a map together and is shared by every
//    feed that asks within its maximum age,
//  * calls are spaced so that at most MAX_PER_MINUTE are made,
//  * markers and partitions change slowly and are asked for rarely.
import { fail } from '../web/js/errors.js';
import { request } from './bridge.js';
import { baseExportSql, partitionsSql, poiSql, shapeBaseExport, shapePoi, shapeSnapshot, snapshotSql } from './sql.js';

const SOURCE_OF = { HaggaBasin: 'Survival_1', DeepDesert: 'DeepDesert_1' };
const MAX_PER_MINUTE = 50;
const MIN_SNAPSHOT_MS = 4000;
const POI_TTL = 5 * 60 * 1000;
const PARTITIONS_TTL = 60 * 1000;
const BASE_TTL = 2 * 60 * 1000;

export function createLive({ call = (query) => request('database.query', { query }), now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const stamps = [];
  const stats = { calls: 0 };
  let noVehicleState = false;

  // spaces the calls: waits until fewer than MAX_PER_MINUTE happened in the last minute
  async function slot() {
    for (;;) {
      const t = now();
      while (stamps.length && stamps[0] <= t - 60000) stamps.shift();
      if (stamps.length < MAX_PER_MINUTE) { stamps.push(t); return; }
      await sleep(stamps[0] + 60000 - t + 25);
    }
  }

  async function query(sql, retried = false) {
    await slot();
    stats.calls++;
    try {
      const result = await call(sql);
      return result?.rows ?? [];
    } catch (e) {
      const message = String(e?.message ?? e);
      if (!retried && /too many|rate limit|retry/i.test(message)) { await sleep(5000); return query(sql, true); }
      throw fail('bridge', message);
    }
  }

  const cached = new Map(); // key -> { at, value, pending }
  async function memo(key, maxAge, load) {
    const c = cached.get(key);
    if (c?.pending) return c.pending;
    if (c && now() - c.at < maxAge) return c.value;
    const pending = load().then((value) => { cached.set(key, { at: now(), value }); return value; })
      .catch((e) => {
        if (c?.value !== undefined) { cached.set(key, { at: now() - maxAge + 5000, value: c.value }); return c.value; } // keep the last good data, ask again soon
        cached.delete(key);
        throw e;
      });
    cached.set(key, { ...(c ?? { at: 0 }), pending });
    return pending.finally(() => { const cur = cached.get(key); if (cur?.pending === pending) { const { pending: _p, ...rest } = cur; cached.set(key, rest); } });
  }

  const snapshot = (source, maxAge) => memo(`snap/${source}`, Math.max(maxAge, MIN_SNAPSHOT_MS), async () => {
    let rows;
    try {
      rows = await query(snapshotSql(source, { vehicleState: !noVehicleState }));
    } catch (e) {
      if (!noVehicleState && /\bstate\b/i.test(e.detail ?? '')) { noVehicleState = true; rows = await query(snapshotSql(source, { vehicleState: false })); } else throw e;
    }
    return shapeSnapshot(rows[0] ?? {});
  });

  async function get(path, ttl = 0) {
    const url = new URL(path, 'http://sandbox.invalid');
    const p = url.pathname;
    const source = SOURCE_OF[url.searchParams.get('map')] ?? url.searchParams.get('map');
    if (p === '/api/map/players') return { rows: (await snapshot(source, ttl)).players };
    if (p === '/api/map/overlays') return { rows: (await snapshot(source, ttl)).overlays };
    if (p === '/api/map/poi') return { rows: await memo(`poi/${source}`, Math.max(ttl, POI_TTL), async () => shapePoi(await query(poiSql(source)), source)) };
    if (p === '/api/map/spice') return { rows: [] }; // active and static spice fields are not in the database
    if (p === '/api/map/partitions') return { rows: await memo('partitions', Math.max(ttl, PARTITIONS_TTL), () => query(partitionsSql())) };
    const base = /^\/api\/bases\/([0-9]{1,12})\/export$/.exec(p);
    if (base) {
      return memo(`base/${base[1]}`, Math.max(ttl, BASE_TTL), async () => {
        const rows = await query(baseExportSql(base[1]));
        if (!rows.length) throw fail('http_status', '404');
        return shapeBaseExport(rows[0]);
      });
    }
    throw fail('http_status', '404');
  }

  return { get, stats };
}

export const live = createLive();

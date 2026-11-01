// What the viewer calls "the API", for the sandbox edition inside the Dune Docker Console.
// Same method names as web/js/api.js. Live data comes from the game database through the addon
// bridge (live-data.js); terrain, models and marker images are in the page (data-embedded.js).
import { ADDON_VERSION } from '../web/js/config.js';
import { customLabels, saveLabels } from '../web/js/labels.js';
import * as data from './data-embedded.js';
import { live } from './live-data.js';
import { maps as embeddedMaps } from './embedded.js';

const WORLD = new Map();

// Deep Desert exists once per Coriolis layout. The layout in use is not in the database, so the plain
// dune template (no layout) is shown, else the lowest layout number.
function pickLayouts(entries) {
  const bySource = new Map();
  for (const e of entries) {
    if (!bySource.has(e.source)) bySource.set(e.source, []);
    bySource.get(e.source).push(e);
  }
  return [...bySource.values()].map((group) => group.reduce((best, e) => ((!e.layout ? 0 : 1 + e.layout) < (!best.layout ? 0 : 1 + best.layout) ? e : best)));
}

const mapRank = (source) => (source === 'Survival_1' ? 0 : source === 'DeepDesert_1' ? 1 : 2);
const viewRank = (label) => {
  for (const [i, k] of ['PvE', 'PVE', 'PvP', 'PVP', 'Creative'].entries()) if (label.startsWith(k)) return Math.floor(i / 2);
  return 9;
};

async function listMaps() {
  const catalog = await data.loadCatalog();
  catalog.maps.forEach((m) => WORLD.set(m.name, m));
  const parts = (await live.get('/api/map/partitions', 0).catch(() => ({ rows: [] }))).rows;
  const custom = await customLabels();
  const list = [];
  for (const m of pickLayouts(catalog.maps)) {
    const views = parts.filter((r) => r.map === m.live && r.alive)
      .map((r) => ({ partition: r.partition_id, internal: r.name, label: custom[String(r.partition_id)] || r.name }))
      .sort((a, b) => viewRank(a.label) - viewRank(b.label) || a.partition - b.partition);
    list.push({ ...m, views: views.length ? views : undefined, version: 1 });
  }
  list.sort((a, b) => mapRank(a.source) - mapRank(b.source) || a.title.localeCompare(b.title));
  return list;
}

const liveName = (folder) => WORLD.get(folder)?.live;
const TTL = { players: 5000, overlays: 20000, poi: 5 * 60 * 1000, spice: 2 * 60 * 1000 };

const b64blob = (dataUri) => {
  const [head, b64] = dataUri.split(',');
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: /data:([^;]+)/.exec(head)?.[1] ?? 'image/png' });
};

export const api = {
  isAdminPage: () => true,
  shareInfo: () => Promise.resolve(null),

  // ---- connection: the console's own session through the bridge, nothing to enter ----
  setupStatus: async () => ({ configured: true, stored: true, admin: true, bridge: true, server: 'Console', fingerprint: '' }),
  setupSave: async () => api.setupStatus(),
  setupDelete: async () => {},
  labels: async () => {
    const maps = await listMaps();
    const custom = await customLabels();
    return maps.flatMap((m) => (m.views ?? []).map((v) => ({
      map: m.title, partition: v.partition, internal: v.internal, auto: v.internal, custom: custom[String(v.partition)] ?? '',
    })));
  },
  saveLabels,

  // ---- maps and terrain ----
  maps: listMaps,
  version: async () => ({ version: ADDON_VERSION }),
  patch: (map, l, x, y) => data.getTile(map, l, x, y),
  mapImage: async (map) => {
    const name = liveName(map);
    const img = name ? embeddedMaps()[name] : null;
    return img ? { blob: b64blob(img.dataUri), bounds: img.bounds } : null;
  },
  sample: (map, pts) => data.sampleHeights(map, pts),

  // ---- live data ----
  liveStatus: async () => ({ enabled: true, public: false, agent: false }),
  agent: () => Promise.reject(Object.assign(new Error('Realtime Data is not available in the Console sandbox'), { code: 'bad_request' })),
  agentStream: () => ({ close() {} }),
  liveFeed: (map, feed) => {
    const name = liveName(map);
    if (!name || !TTL[feed]) throw Object.assign(new Error('no live data for this map'), { code: 'http_status', detail: '404' });
    return live.get(`/api/map/${feed}?map=${encodeURIComponent(name)}`, TTL[feed]);
  },
  liveBase: (id) => {
    if (!/^[0-9]{1,12}$/.test(String(id))) throw Object.assign(new Error('invalid base id'), { code: 'bad_request' });
    return live.get(`/api/bases/${id}/export`, 2 * 60 * 1000);
  },

  // ---- building models ----
  buildables: data.loadBuildablesIndex,
  buildableMesh: data.loadMesh,
};

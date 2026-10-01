// What the viewer calls "the API". It used to be the viewer server (backend/server); in the
// addon everything runs in the browser: terrain comes from GitHub (data.js), live data from
// the console with the admin's API key (console.js). The method names are unchanged.
import { ADDON_VERSION } from './config.js';
import * as data from './data.js';
import * as cons from './console.js';

const WORLD = new Map(); // folder name -> catalog entry, filled by maps()

// Deep Desert exists once per Coriolis layout; pick the one the server currently uses,
// otherwise the plain dune template (no layout), otherwise the lowest layout number.
function pickLayouts(entries, liveLayouts) {
  const bySource = new Map();
  for (const e of entries) {
    if (!bySource.has(e.source)) bySource.set(e.source, []);
    bySource.get(e.source).push(e);
  }
  const out = [];
  for (const group of bySource.values()) {
    const live = liveLayouts.get(group[0].source);
    const rank = (e) => (live != null && (e.layout ?? 0) === live ? 0 : !e.layout ? 1 : 2 + e.layout);
    out.push(group.reduce((best, e) => (rank(e) < rank(best) ? e : best)));
  }
  return out;
}

const mapRank = (source) => (source === 'Survival_1' ? 0 : source === 'DeepDesert_1' ? 1 : 2);
const groupRank = (g) => {
  const i = ['Offene Welt', 'Städte', 'Dungeons & Ecolabs', 'Instanzen'].indexOf(g);
  return i < 0 ? 99 : i;
};
const viewRank = (label) => {
  for (const [i, k] of ['PvE', 'PVE', 'PvP', 'PVP', 'Creative'].entries()) if (label.startsWith(k)) return Math.floor(i / 2);
  return 9;
};

async function listMaps() {
  const catalog = await data.loadCatalog();
  catalog.maps.forEach((m) => WORLD.set(m.name, m));
  const active = await cons.activeMaps(); // null = unknown, then show all
  const entries = catalog.maps.filter((m) => !active || active.has(m.source));
  const live = new Map();
  const cor = new Map();
  for (const m of entries) {
    if (m.live && !cor.has(m.live)) {
      const c = await cons.coriolis(m.live);
      cor.set(m.live, c);
      if (c) live.set(m.source, c.layout);
    }
  }
  const parts = await cons.partitions();
  const custom = await cons.customLabels();
  const list = [];
  for (const m of pickLayouts(entries, live)) {
    const views = [];
    for (const r of parts) {
      if (r.map !== m.live || !r.alive) continue;
      const label = custom[String(r.partition_id)] || await cons.autoLabel(m.source, m.title, r.partition_id, r.name);
      views.push({ partition: r.partition_id, internal: r.name, label });
    }
    views.sort((a, b) => viewRank(a.label) - viewRank(b.label) || a.partition - b.partition);
    const c = m.live ? cor.get(m.live) : null;
    const { file, sha256, ...meta } = m;
    list.push({
      ...meta,
      views: views.length ? views : undefined,
      coriolis: c ? { ...c, match: (m.layout ?? 0) === c.layout } : undefined,
      version: 1, // data never changes under a tag; cache busting is not needed
      patchQuads: m.patchQuads,
      maxLevel: m.maxLevel,
    });
  }
  list.sort((a, b) => groupRank(a.group) - groupRank(b.group) || mapRank(a.source) - mapRank(b.source) || a.title.localeCompare(b.title));
  return list;
}

const liveName = (folder) => WORLD.get(folder)?.live;
const TTL = { players: 3000, overlays: 20000, poi: 5 * 60 * 1000, spice: 2 * 60 * 1000 };

export const api = {
  // ---- connection (API key) ----
  setupStatus: async () => {
    await cons.loadToken();
    return {
      configured: cons.hasToken(), stored: cons.hasToken(), admin: true,
      server: location.host, fingerprint: cons.keyId(),
    };
  },
  setupSave: async (_server, _port, token) => {
    await cons.saveToken(token);
    return api.setupStatus();
  },
  setupDelete: () => cons.dropToken(),
  labels: async () => {
    const maps = await listMaps();
    const custom = await cons.customLabels();
    return maps.flatMap((m) => (m.views ?? []).map((v) => ({
      map: m.title, partition: v.partition, internal: v.internal,
      auto: v.label, custom: custom[String(v.partition)] ?? '',
    })));
  },
  saveLabels: (labels) => cons.saveLabels(labels),

  // ---- maps and terrain ----
  maps: listMaps,
  version: async () => ({ version: ADDON_VERSION }),
  patch: (map, l, x, y) => data.getTile(map, l, x, y),
  mapImage: (map) => {
    const name = liveName(map);
    return name ? cons.mapImage(name) : Promise.resolve(null);
  },
  sample: (map, pts) => data.sampleHeights(map, pts),

  // ---- live data ----
  liveStatus: async () => ({ enabled: cons.hasToken(), public: false }),
  liveFeed: (map, feed) => {
    const name = liveName(map);
    if (!name || !TTL[feed]) throw Object.assign(new Error('no live data for this map'), { code: 'http_status', detail: '404' });
    return cons.consoleGet(`/api/map/${feed}?map=${encodeURIComponent(name)}`, TTL[feed]);
  },
  liveBase: (id) => {
    if (!/^[0-9]{1,12}$/.test(String(id))) throw Object.assign(new Error('invalid base id'), { code: 'bad_request' });
    return cons.consoleGet(`/api/bases/${id}/export`, 2 * 60 * 1000);
  },

  // ---- building models (streamed from GitHub like the terrain) ----
  buildables: data.loadBuildablesIndex,
  buildableMesh: data.loadMesh,
};

// Terrain and building models from the page itself (see embedded.js). The same functions as
// web/js/data.js, which streams them from GitHub: that cannot run inside the Console (no network).
// Embedded are only the coarser levels (core().minLevel and up), the 50 MiB limit of an addon package
// does not allow the finest; terrain.js draws what exists.
import { decodeTile, gunzip, sampleHeightsAt } from '../web/js/tiles.js';
import { bytes, core, models } from './embedded.js';

export { decodeTile };

export async function loadCatalog() {
  return core().catalog;
}

export async function loadIndex(name) {
  const idx = core().indexes[name];
  if (!idx) throw new Error(`unknown map ${name}`);
  return idx;
}

const empty = new Map();
const decoded = new Map(); // "map/l/x/y" -> Promise<ArrayBuffer>, a small LRU
const MAX_TILES = 600;

export function getTile(name, l, x, y) {
  const key = `${name}/${l}/${x}/${y}`;
  if (decoded.has(key)) {
    const p = decoded.get(key);
    decoded.delete(key); decoded.set(key, p);
    return p.then((b) => b.slice(0));
  }
  const p = (async () => {
    const idx = await loadIndex(name);
    const level = idx.levels[l];
    const id = level && x >= 0 && y >= 0 && x < level.nx && y < level.ny ? level.cells[y * level.nx + x] : -1;
    const hash = id >= 0 ? idx.ids[id] : null;
    const b64 = hash ? core().tiles[hash] : null;
    if (!b64) { // no data here (or a finer level than the package carries): flat zeros
      if (!empty.has(idx.patchQuads)) empty.set(idx.patchQuads, new ArrayBuffer(3 * (idx.patchQuads + 1) ** 2));
      return empty.get(idx.patchQuads);
    }
    return decodeTile(await gunzip(bytes(b64)), idx.patchQuads);
  })();
  p.catch(() => decoded.delete(key));
  decoded.set(key, p);
  while (decoded.size > MAX_TILES) decoded.delete(decoded.keys().next().value);
  return p.then((b) => b.slice(0));
}

export async function sampleHeights(name, pts) {
  const idx = await loadIndex(name);
  return sampleHeightsAt(idx, pts, core().minLevel, (l, x, y) => getTile(name, l, x, y));
}

export async function loadBuildablesIndex() {
  return models().index ?? { rows: {}, meshes: [] };
}

export async function loadMesh(id) {
  const b64 = models().meshes[id];
  if (!b64) throw new Error(`unknown building model ${id}`);
  return bytes(b64).buffer;
}

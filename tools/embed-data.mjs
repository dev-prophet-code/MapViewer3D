#!/usr/bin/env node
// Packs what the sandbox edition needs into one JSON document, for build-sandbox.mjs to inline.
//
// Inside the Console the addon page cannot fetch anything (CSP connect-src 'none'), so terrain,
// building models and marker images have to be IN the page. The pinned data release (config.js:
// DATA_TAG, CATALOG_SHA256) is read from a checkout and verified on the way:
//   catalog.json against CATALOG_SHA256, every map index against the catalog, every tile and model
//   against its content id, so the package cannot carry data that is not exactly the pinned release.
//
// The 50 MiB limit of an addon package does not allow the finest tiles; the levels from MIN_LEVEL on
// (4 x coarser than the finest, about 4 m between height samples on Hagga Basin) are embedded.
//
//   node tools/embed-data.mjs <dataDir> <iconsDir> <mapImagesDir> <out.json>
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const MIN_LEVEL = 2;
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const [dataDir, iconsDir, mapImagesDir, outFile] = process.argv.slice(2);
if (!dataDir || !iconsDir || !mapImagesDir || !outFile) { console.error('usage: embed-data.mjs <dataDir> <iconsDir> <mapImagesDir> <out.json>'); process.exit(2); }
const die = (m) => { console.error(m); process.exit(1); };
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const same = (digest, want) => (want.length === 64 ? digest === want : want.length === 16 && digest.startsWith(want));

const config = fs.readFileSync(path.join(root, 'web', 'js', 'config.js'), 'utf8');
const pinned = /CATALOG_SHA256 = '([0-9a-f]{64})'/.exec(config)?.[1] ?? die('config.js pins no catalog checksum');
const catalogBytes = fs.readFileSync(path.join(dataDir, 'catalog.json'));
if (sha(catalogBytes) !== pinned) die(`catalog.json of ${dataDir} does not match the pinned checksum ${pinned}`);
const catalog = JSON.parse(catalogBytes.toString('utf8'));

const tiles = {};
const indexes = {};
const maps = [];
let tileBytes = 0;
for (const entry of catalog.maps) {
  const bytes = fs.readFileSync(path.join(dataDir, entry.file));
  if (sha(bytes) !== entry.sha256) die(`${entry.file} does not match the catalog`);
  const idx = JSON.parse(bytes.toString('utf8'));
  const ids = [];
  const remap = new Map();
  const levels = idx.levels.map((lv, l) => {
    if (l < MIN_LEVEL) return { nx: 0, ny: 0, cells: [] };
    const cells = lv.cells.map((c) => {
      if (c < 0) return -1;
      if (!remap.has(c)) {
        const id = idx.ids[c];
        const gz = fs.readFileSync(path.join(dataDir, 'p', id.slice(0, 2), `${id.slice(2, 16)}.z`));
        if (!same(sha(zlib.gunzipSync(gz)), id)) die(`tile ${id} does not match its content id`);
        remap.set(c, ids.length);
        ids.push(id);
        if (!tiles[id]) { tiles[id] = gz.toString('base64'); tileBytes += gz.length; }
      }
      return remap.get(c);
    });
    return { nx: lv.nx, ny: lv.ny, cells };
  });
  indexes[idx.meta.name] = { format: idx.format, patchQuads: idx.patchQuads, maxLevel: idx.maxLevel, meta: idx.meta, ids, levels };
  const { file, sha256, ...rest } = entry;
  maps.push({ ...rest, minLevel: MIN_LEVEL });
}

// building models
const buildables = catalog.buildables;
const meshes = {};
let buildablesIndex = { rows: {}, meshes: [] };
let meshBytes = 0;
if (buildables) {
  const indexBytes = fs.readFileSync(path.join(dataDir, 'buildables', 'index.json'));
  if (sha(indexBytes) !== buildables.index) die('buildables/index.json does not match the catalog');
  buildablesIndex = JSON.parse(indexBytes.toString('utf8'));
  for (const [id, want] of Object.entries(buildables.meshes)) {
    const b = fs.readFileSync(path.join(dataDir, 'buildables', 'mesh', `${id}.bin`));
    if (!same(sha(b), want)) die(`model ${id} does not match the catalog`);
    meshes[id] = b.toString('base64');
    meshBytes += b.length;
  }
}

// marker images of the Console's Live Map (Red-Blink/dune-awakening-selfhost-docker, MIT licence)
const mime = { '.webp': 'image/webp', '.png': 'image/png' };
const icons = {};
for (const f of fs.readdirSync(iconsDir).sort()) {
  const ext = path.extname(f);
  const full = path.join(iconsDir, f);
  if (!mime[ext] || fs.statSync(full).size > 150 * 1024) continue; // the two map backgrounds are handled below
  icons[f] = `data:${mime[ext]};base64,${fs.readFileSync(full).toString('base64')}`;
}
const mapImages = {};
for (const [live, m] of Object.entries(JSON.parse(fs.readFileSync(path.join(root, 'sandbox', 'map-images.json'), 'utf8')))) {
  mapImages[live] = { dataUri: `data:image/png;base64,${fs.readFileSync(path.join(mapImagesDir, m.file)).toString('base64')}`, bounds: [...m.bounds, !!m.flipY] };
}

const doc = { minLevel: MIN_LEVEL, catalog: { format: catalog.format, maps }, indexes, tiles, buildablesIndex, meshes, icons, mapImages };
fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(doc));
const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;
console.log(`embedded: ${Object.keys(tiles).length} tiles (${mb(tileBytes)}), ${Object.keys(meshes).length} models (${mb(meshBytes)}), ${Object.keys(icons).length} icons, ${Object.keys(mapImages).length} map images; ${mb(fs.statSync(outFile).size)} of JSON`);

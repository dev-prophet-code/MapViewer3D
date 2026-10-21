#!/usr/bin/env node
// Upgrades a data release whose tile and model ids are only the first 64 bits of the SHA-256 (data-v1)
// to full 256-bit digests. The files themselves are not touched (tiles keep their names, which use the
// first 16 hex characters); only the map indexes (m/<map>.json), the model checksums and catalog.json
// change, so the new release is a small commit on top of the old one.
//
//   node tools/upgrade-ids.mjs <dataDir>        dataDir = a checkout of the old data release
//
// Every tile is read and hashed; an id whose first 64 bits do not match its tile's content stops the run.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const dir = process.argv[2];
if (!dir) { console.error('usage: upgrade-ids.mjs <dataDir>'); process.exit(2); }
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const die = (m) => { console.error(m); process.exit(1); };

const catPath = path.join(dir, 'catalog.json');
const catalog = JSON.parse(fs.readFileSync(catPath, 'utf8'));
const cache = new Map(); // old 16-hex id -> full digest (tiles are shared across maps)
let tiles = 0;

for (const entry of catalog.maps) {
  const file = path.join(dir, entry.file);
  const idx = JSON.parse(fs.readFileSync(file, 'utf8'));
  idx.ids = idx.ids.map((id) => {
    if (id.length === 64) return id; // already upgraded
    if (!cache.has(id)) {
      const raw = zlib.gunzipSync(fs.readFileSync(path.join(dir, 'p', id.slice(0, 2), `${id.slice(2)}.z`)));
      const full = sha(raw);
      if (!full.startsWith(id)) die(`tile ${id}: its content hashes to ${full}`);
      cache.set(id, full);
      tiles++;
    }
    return cache.get(id);
  });
  const text = JSON.stringify(idx);
  fs.writeFileSync(file, text);
  entry.sha256 = sha(Buffer.from(text));
}

if (catalog.buildables?.meshes) {
  for (const [id, want] of Object.entries(catalog.buildables.meshes)) {
    if (want.length === 64) continue;
    const full = sha(fs.readFileSync(path.join(dir, 'buildables', 'mesh', `${id}.bin`)));
    if (!full.startsWith(want)) die(`model ${id}: its content hashes to ${full}`);
    catalog.buildables.meshes[id] = full;
  }
}

const out = JSON.stringify(catalog, null, 1);
fs.writeFileSync(catPath, out);
console.log(`upgraded ${tiles} tiles, ${Object.keys(catalog.buildables?.meshes ?? {}).length} models; catalog.json sha256 ${sha(Buffer.from(out))}`);

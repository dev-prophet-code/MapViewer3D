#!/usr/bin/env node
// Cuts extracted map data (data/<map>/height.u16 + material.u8 + meta.json) into the
// terrain tiles the addon streams from GitHub.
//
//   node tools/tilepack.mjs <dataDir> <outDir> [mapFolder ...]
//
// Output (in <outDir>):
//   m/<map>.json     tile index of one map (meta, levels, tile -> content id)
//   p/<xx>/<rest>.z  one tile, named by the SHA-256 of its content, so identical tiles
//                    (the repeated dune template of Deep Desert, open sea, ...) are stored
//                    once across all maps and layouts
//
// Tile = the patch the viewer asks for: (128+1)^2 heights (uint16) followed by the same
// number of material bytes, from raster position (x,y)*128*2^l with step 2^l (the same
// definition as backend/server/server.go "patch"). Stored as FORMAT 1:
//   heights are delta-coded along rows (mod 65536), split into a low-byte plane and a
//   high-byte plane, then materials; the whole thing is gzip(9). The browser undoes this
//   in js/data.js (decodeTile). Tiles without any height are not stored at all.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const PATCH_QUADS = 128;
const N = PATCH_QUADS + 1;
const FORMAT = 1;

const [dataDir, outDir, ...only] = process.argv.slice(2);
if (!dataDir || !outDir) {
  console.error('usage: tilepack.mjs <dataDir> <outDir> [mapFolder ...]');
  process.exit(2);
}

function encodeTile(heights, mats) {
  const out = Buffer.alloc(3 * N * N);
  const lo = 0, hi = N * N, mt = 2 * N * N;
  for (let j = 0; j < N; j++) {
    let prev = 0;
    for (let i = 0; i < N; i++) {
      const v = heights[j * N + i];
      const d = (v - prev) & 0xffff;
      prev = v;
      out[lo + j * N + i] = d & 0xff;
      out[hi + j * N + i] = d >> 8;
    }
  }
  mats.copy ? mats.copy(out, mt) : out.set(mats, mt);
  return out;
}

function packMap(name) {
  const dir = path.join(dataDir, name);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  const rawH = fs.readFileSync(path.join(dir, 'height.u16'));
  const H = new Uint16Array(rawH.buffer, rawH.byteOffset, rawH.length / 2);
  const matFile = path.join(dir, 'material.u8');
  const M = fs.existsSync(matFile) ? fs.readFileSync(matFile) : null;
  const W = meta.width, Hh = meta.height;
  if (H.length !== W * Hh) throw new Error(`${name}: height.u16 has ${H.length} values, expected ${W * Hh}`);

  const n = Math.max(W, Hh) - 1;
  let maxLevel = 0;
  while ((PATCH_QUADS << maxLevel) < n) maxLevel++;

  const table = new Map(); // content id -> index
  const ids = [];
  const levels = [];
  let stored = 0, reused = 0, empty = 0, bytes = 0;
  const heights = new Uint16Array(N * N);
  const mats = Buffer.alloc(N * N);

  for (let l = 0; l <= maxLevel; l++) {
    const step = 1 << l;
    const nx = Math.ceil(W / (PATCH_QUADS * step));
    const ny = Math.ceil(Hh / (PATCH_QUADS * step));
    const cells = new Int32Array(nx * ny).fill(-1);
    for (let py = 0; py < ny; py++) {
      for (let px = 0; px < nx; px++) {
        heights.fill(0);
        mats.fill(0);
        let any = false;
        const x0 = px * PATCH_QUADS * step, y0 = py * PATCH_QUADS * step;
        for (let j = 0; j < N; j++) {
          const y = y0 + j * step;
          if (y >= Hh) break;
          for (let i = 0; i < N; i++) {
            const x = x0 + i * step;
            if (x >= W) break;
            const k = y * W + x;
            const h = H[k];
            heights[j * N + i] = h;
            if (M) mats[j * N + i] = M[k];
            else if (h !== 0) mats[j * N + i] = 1; // MatLandscape
            if (h !== 0) any = true;
          }
        }
        if (!any) { empty++; continue; }
        const raw = encodeTile(heights, mats);
        const id = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
        let idx = table.get(id);
        if (idx === undefined) {
          idx = ids.length;
          ids.push(id);
          table.set(id, idx);
          const file = path.join(outDir, 'p', id.slice(0, 2), id.slice(2) + '.z');
          if (!fs.existsSync(file)) {
            const z = zlib.gzipSync(raw, { level: 9 });
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, z);
            bytes += z.length;
            stored++;
          } else {
            reused++; // already stored by another map / layout
          }
        } else {
          reused++;
        }
        cells[py * nx + px] = idx;
      }
    }
    levels.push({ nx, ny, cells: Array.from(cells) });
  }

  const index = { format: FORMAT, patchQuads: PATCH_QUADS, maxLevel, meta, ids, levels };
  fs.mkdirSync(path.join(outDir, 'm'), { recursive: true });
  fs.writeFileSync(path.join(outDir, 'm', `${name}.json`), JSON.stringify(index));
  console.log(`${name}: ${maxLevel + 1} levels, ${stored} new tiles (${(bytes / 1048576).toFixed(1)} MB), ${reused} shared, ${empty} empty`);
}

const maps = only.length ? only : fs.readdirSync(dataDir).filter((d) => fs.existsSync(path.join(dataDir, d, 'meta.json')));
for (const m of maps) packMap(m);

// Building models (data/buildables/index.json + mesh/*.bin) are copied as they are; the
// catalog lists a checksum of the index and of every mesh so the addon can verify them.
let buildables = null;
const bSrc = path.join(dataDir, 'buildables');
if (fs.existsSync(path.join(bSrc, 'index.json'))) {
  const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
  fs.mkdirSync(path.join(outDir, 'buildables', 'mesh'), { recursive: true });
  const indexBytes = fs.readFileSync(path.join(bSrc, 'index.json'));
  fs.writeFileSync(path.join(outDir, 'buildables', 'index.json'), indexBytes);
  const meshes = {};
  for (const f of fs.readdirSync(path.join(bSrc, 'mesh')).filter((n) => /^[0-9]+\.bin$/.test(n)).sort()) {
    const bytes = fs.readFileSync(path.join(bSrc, 'mesh', f));
    fs.writeFileSync(path.join(outDir, 'buildables', 'mesh', f), bytes);
    meshes[f.replace('.bin', '')] = sha(bytes).slice(0, 16);
  }
  buildables = { index: sha(indexBytes), meshes };
  console.log(`buildables: ${Object.keys(meshes).length} meshes`);
}

// catalog.json: one entry per map index in <outDir>/m (the addon reads this first)
const catalog = fs.readdirSync(path.join(outDir, 'm')).filter((f) => f.endsWith('.json')).sort().map((f) => {
  const bytes = fs.readFileSync(path.join(outDir, 'm', f));
  const idx = JSON.parse(bytes.toString('utf8'));
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  return { file: `m/${f}`, sha256, patchQuads: idx.patchQuads, maxLevel: idx.maxLevel, ...idx.meta };
});
const catalogJson = JSON.stringify({ format: FORMAT, maps: catalog, buildables }, null, 1);
fs.writeFileSync(path.join(outDir, 'catalog.json'), catalogJson);
console.log(`catalog.json: ${catalog.length} maps, sha256 ${crypto.createHash('sha256').update(catalogJson).digest('hex')}`);

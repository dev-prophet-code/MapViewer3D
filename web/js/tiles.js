// Terrain tile decoding and height sampling, shared by the two ways the viewer gets its data:
// streamed from GitHub (data.js) and embedded in the package of the sandbox edition (sandbox/data-embedded.js).

// FORMAT 1 (see tools/tilepack.mjs): gzip( low-byte plane | high-byte plane | materials ),
// heights delta-coded along rows. Returns heights (uint16) followed by materials (uint8),
// the layout terrain.js expects.
export async function gunzip(buf) {
  const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function decodeTile(raw, patchQuads) {
  const N = patchQuads + 1, NN = N * N;
  if (raw.length !== 3 * NN) throw new Error('tile has the wrong size');
  const out = new ArrayBuffer(3 * NN);
  const h = new Uint16Array(out, 0, NN);
  for (let j = 0; j < N; j++) {
    let prev = 0;
    for (let i = 0; i < N; i++) {
      prev = (prev + (raw[j * N + i] | (raw[NN + j * N + i] << 8))) & 0xffff;
      h[j * N + i] = prev;
    }
  }
  new Uint8Array(out, 2 * NN).set(raw.subarray(2 * NN));
  return out;
}

// Terrain height (cm) at world positions x/y (cm), bilinear, taken from the tiles of one level
// (0 = the finest; a coarser level has 2^level times the sample spacing). null outside the map or
// where there is no data. At level 0 this is the maths of the old viewer server (terrain.go heightAt).
// getTile(l, x, y) returns the decoded tile of that level.
export async function sampleHeightsAt(idx, pts, level, getTile) {
  const m = idx.meta, Q = idx.patchQuads, N = Q + 1;
  const step = 2 ** level, span = Q * step; // raster samples one tile covers along an axis
  const unit = (m.maxZ - m.minZ) / 65534;
  const byTile = new Map();
  const out = new Array(pts.length).fill(null);
  pts.forEach((p, k) => {
    const fx = (p[0] - m.originX) / m.spacing, fy = (p[1] - m.originY) / m.spacing;
    if (!(fx >= 0 && fy >= 0 && fx <= m.width - 1 && fy <= m.height - 1)) return;
    const tx = Math.floor(fx / span), ty = Math.floor(fy / span);
    const key = `${tx},${ty}`;
    if (!byTile.has(key)) byTile.set(key, { tx, ty, items: [] });
    byTile.get(key).items.push({ k, gx: (fx - tx * span) / step, gy: (fy - ty * span) / step });
  });
  await Promise.all([...byTile.values()].map(async ({ tx, ty, items }) => {
    const buf = await getTile(level, tx, ty);
    const h = new Uint16Array(buf, 0, N * N);
    for (const { k, gx, gy } of items) {
      const i = Math.floor(gx), j = Math.floor(gy);
      const i1 = Math.min(i + 1, N - 1), j1 = Math.min(j + 1, N - 1);
      const u = gx - i, v = gy - j;
      let sum = 0, wsum = 0;
      for (const [cx, cy, w] of [[i, j, (1 - u) * (1 - v)], [i1, j, u * (1 - v)], [i, j1, (1 - u) * v], [i1, j1, u * v]]) {
        const hv = h[cy * N + cx];
        if (hv !== 0 && w > 0) { sum += w * (m.minZ + (hv - 1) * unit); wsum += w; }
      }
      if (wsum > 0) out[k] = Math.round(sum / wsum);
    }
  }));
  return out;
}

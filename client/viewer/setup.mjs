// Holt three.js (MIT, 0.170.0) und OrbitControls aus dem Branch mva-v2 dieses Repos nach ./three/.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'three');
fs.mkdirSync(dir, { recursive: true });
const base = 'https://raw.githubusercontent.com/dev-prophet-code/MapViewer3D/mva-v2/vendor/three/';
for (const f of ['three.module.js', 'OrbitControls.js']) {
  const r = await fetch(base + f);
  if (!r.ok) throw new Error(`${f}: HTTP ${r.status}`);
  const b = Buffer.from(await r.arrayBuffer());
  if (b.length < 10000) throw new Error(`${f}: unerwartet klein`);
  fs.writeFileSync(path.join(dir, f), b);
  console.log(f, b.length, 'Byte');
}

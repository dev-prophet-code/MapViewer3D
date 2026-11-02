// Bettet die Körper aus dem cdn-Branch (Ordner creatures/) ins Addon ein: node tools/embed-creatures.mjs <creatures-Ordner>
// Der Ordner enthält index.json und mesh/<n>.bin. Ergebnis: addon/data/creatures.json (wird von scripts/build.mjs eingelesen).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const dir = process.argv[2];
if (!dir) { console.error('Aufruf: node tools/embed-creatures.mjs <creatures-Ordner> [catalog.json]'); process.exit(1); }
const index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
const cat = process.argv[3] ? JSON.parse(fs.readFileSync(process.argv[3], 'utf8')).creatures : null;
const meshes = {};
for (const m of index.meshes || []) {
  const buf = fs.readFileSync(path.join(dir, 'mesh', m.id + '.bin'));
  const h = crypto.createHash('sha256').update(buf).digest('hex');
  if (cat && !h.startsWith(String((cat.meshes || {})[m.id]))) throw new Error('Netz ' + m.id + ' passt nicht zum Katalog');
  if (buf.subarray(0, 4).toString() !== 'DML1') throw new Error('Netz ' + m.id + ' hat kein DML1-Format');
  meshes[m.id] = buf.toString('base64');
}
fs.mkdirSync('addon/data', { recursive: true });
const rows = {}; for (const [k, r] of Object.entries(index.rows || {})) rows[k] = { mesh: r.mesh, kind: r.kind, match: r.match, yaw: r.yaw };
fs.writeFileSync('addon/data/creatures.json', JSON.stringify({ index: { rows }, meshes }));
console.log('eingebettet:', Object.keys(meshes).length, 'Netze');

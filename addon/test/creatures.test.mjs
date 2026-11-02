// Prüft den Körper-Lader (viewer/creatures.js) mit den echten Netzen aus dem cdn-Branch (addon/data/creatures.json).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const rd = (p) => fs.readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const ctx = vm.createContext({ console, performance, setTimeout, clearTimeout, setInterval, clearInterval });
ctx.globalThis = ctx;
for (const f of ['three.js', 'orbit.js', 'core.js', 'meshes.js', 'marker-defs.js', 'markers.js', 'creatures.js']) vm.runInContext(rd('../../companion/public/' + f), ctx);
const { MV } = ctx;
const data = fs.existsSync(fileURLToPath(new URL('../data/creatures.json', import.meta.url))) ? JSON.parse(rd('../data/creatures.json')) : null;
const src = (d) => ({ index: d.index, bin: async (id) => { const b = Buffer.from(d.meshes[id], 'base64'); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); } });

test('Körper: Spieler-Figur ~1,8 m, Fahrzeug-Varianten nach Klassenname, Wurm bleibt ohne Körper', { skip: !data }, async () => {
  const n = await MV.Creatures.load(src(data));
  assert.ok(n >= 2);
  const human = MV.Markers.build('player');
  assert.ok(human);
  assert.ok(human.radius > 0.5 && human.radius < 3, 'Figur-Radius ' + human.radius);
  assert.equal(MV.Creatures.variantFor('vehicle', 'BP_MediumOrnithopter_C'), 'ornithopter_medium');
  assert.equal(MV.Creatures.variantFor('vehicle', 'Unbekannt'), '');
  assert.equal(MV.Creatures.variantFor('worm', 'Sandworm'), '');
});

test('Körper: kaputte oder fremde Daten lassen die Platzhalter stehen', async () => {
  assert.equal(await MV.Creatures.load(null), 0);
  assert.equal(await MV.Creatures.load({ index: { rows: { x: { mesh: 0, kind: 'worm', match: ['a'] } } }, bin: async () => new ArrayBuffer(8) }), 0);
  assert.equal(await MV.Creatures.load({ index: { rows: { x: { mesh: -1, kind: 'worm', match: ['a'] }, y: { mesh: 0, kind: 'evil', match: 'a' } } }, bin: async () => { throw new Error('x'); } }), 0);
});

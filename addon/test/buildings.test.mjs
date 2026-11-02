// Prüft den Bauteil-Dekodierer und die Koordinatenumrechnung (viewer/buildings.js) ohne Browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const pub = (f) => fs.readFileSync(fileURLToPath(new URL('../../companion/public/' + f, import.meta.url)), 'utf8');
const ctx = vm.createContext({ console, performance, setTimeout, clearTimeout, setInterval, clearInterval });
ctx.globalThis = ctx;
for (const f of ['three.js', 'orbit.js', 'core.js', 'meshes.js', 'marker-defs.js', 'markers.js', 'creatures.js', 'buildings.js']) vm.runInContext(pub(f), ctx);
const { MV, THREE } = ctx;

// Ein Netz im Format DML1: 3 Eckpunkte (uint16, zwischen lo und hi), ein Dreieck
function dml(nv = 3, tri = [0, 1, 2], lo = [0, 0, 0], hi = [100, 200, 300]) {
  const b = Buffer.alloc(36 + nv * 6 + (nv * 6) % 4 + tri.length * 2 + 4); b.write('DML1', 0, 'latin1'); b.writeUInt32LE(nv, 4); b.writeUInt32LE(tri.length, 8);
  lo.concat(hi).forEach((v, k) => b.writeFloatLE(v, 12 + 4 * k));
  const q = [0, 0, 0, 65535, 0, 0, 0, 65535, 65535].slice(0, nv * 3); q.forEach((v, k) => b.writeUInt16LE(v, 36 + 2 * k));
  let off = 36 + nv * 6; if (off % 4) off += 2; tri.forEach((v, k) => b.writeUInt16LE(v, off + 2 * k));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

test('DML1: Eckpunkte in Metern, Y oben (Unreal x,y,z → three x,z,y), Dreiecksfolge umgedreht, Tönung vorhanden', () => {
  const g = MV.decodeMesh(dml());
  const p = g.getAttribute('position').array;
  assert.deepEqual([...p.slice(0, 3)], [0, 0, 0]);
  assert.ok(Math.abs(p[3] - 1) < 1e-5 && p[4] === 0 && p[5] === 0);                       // Unreal x=100 cm → three x=1 m
  assert.ok(p[6] === 0 && Math.abs(p[7] - 3) < 1e-5 && Math.abs(p[8] - 2) < 1e-5);          // Unreal y=200 cm → three z=2 m, z=300 cm → Höhe 3 m
  assert.deepEqual([...g.index.array], [0, 2, 1]);                                           // gespiegelt → Reihenfolge getauscht
  assert.equal(g.getAttribute('tone').count, 3); assert.equal(g.getAttribute('normal').count, 3);
});

test('DML1: kaputte oder bösartige Dateien werfen, statt Speicher zu lesen', () => {
  const ok = dml();
  assert.throws(() => MV.decodeMesh(new ArrayBuffer(8)), /DML1/);
  const copy = () => Buffer.from(new Uint8Array(ok)); // echte Kopie, kein gemeinsamer Speicher
  const wrong = copy(); wrong.write('XXXX', 0, 'latin1'); assert.throws(() => MV.decodeMesh(wrong.buffer.slice(wrong.byteOffset, wrong.byteOffset + wrong.byteLength)), /DML1/);
  const huge = copy(); huge.writeUInt32LE(0x7fffffff, 4); assert.throws(() => MV.decodeMesh(huge.buffer.slice(huge.byteOffset, huge.byteOffset + huge.byteLength)), /Größe/);
  const cut = ok.slice(0, 40); assert.throws(() => MV.decodeMesh(cut), /abgeschnitten|Größe/);
  assert.throws(() => MV.decodeMesh(dml(3, [0, 1, 9])), /Index/);                           // Index außerhalb der Eckpunkte
  assert.throws(() => MV.decodeMesh(dml(3, [0, 1])), /Größe/);                               // Indexzahl nicht durch 3 teilbar
});

test('Unreal → three.js: Ort in Zentimetern wird Meter (x,z,y), Gier dreht um die Hochachse', () => {
  const { ueMatrix, ueToThree } = MV._ue;
  const m = ueToThree(ueMatrix([100, 200, 300], [0, 0, 0], [1, 1, 1]));
  const p = new THREE.Vector3().setFromMatrixPosition(m);
  assert.deepEqual([p.x, p.y, p.z].map((v) => Math.round(v * 1000) / 1000), [1, 3, 2]);
  // Gier 90°: lokal +X (vorwärts) zeigt in Unreal nach +Y, in three.js nach +Z
  const r = ueToThree(ueMatrix([0, 0, 0], [0, 90, 0], [1, 1, 1]));
  const d = new THREE.Vector3(1, 0, 0).applyMatrix4(r);
  assert.deepEqual([d.x, d.y, d.z].map((v) => Math.round(v * 1000) / 1000), [0, 0, 1]);
  // die Hochachse bleibt oben (Höhe wird nicht gedreht)
  const up = new THREE.Vector3(0, 1, 0).applyMatrix4(r);
  assert.deepEqual([up.x, up.y, up.z].map((v) => Math.round(v * 1000) / 1000), [0, 1, 0]);
});

test('Marker-Stile: Symbol, Größe und Rückfall wie im CSS der Console', () => {
  const t = MV.markerStyle('ore', 'TitaniumOre');
  assert.equal(t.icon, 'titaniumore.webp'); assert.equal(t.size, 20);
  assert.equal(MV.markerStyle('vehicle', 'Sandbike').size, 32);
  assert.equal(MV.markerStyle('poi', 'TradingPost').size, 32);
  assert.equal(MV.markerStyle('spice', 'Medium').size, 34);
  const h = MV.markerStyle('hazard', 'Hazard_Quicksand'); assert.equal(h.icon, null); assert.ok(h.hazard);
  const u = MV.markerStyle('etwas-neues', ''); assert.equal(u.icon, null); assert.ok(u.disc); assert.equal(u.size, 12);   // unbekannte Art: einfacher Punkt
});

test('Marker-Stile: feindliche Typen/Untertypen der Console (Prototyp-Namen, Sonderzeichen) ergeben nie ein fremdes Symbol oder eine Klasse', () => {
  for (const bad of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', '</script>', 'a b', '../x']) {
    const st = MV.markerStyle('ore', bad); assert.ok(st.icon === null || typeof st.icon === 'string', bad); assert.equal(typeof st.size, 'number'); assert.ok(Number.isFinite(st.size), bad);
    const st2 = MV.markerStyle(bad, 'x'); assert.ok(st2.icon === null || typeof st2.icon === 'string', bad); assert.ok(Number.isFinite(st2.size), bad);
  }
});

test('Symbole ohne Console-Bild: Beschreibung gültig (Raster 24, Farben, Primitive) und das erzeugte CSS ist aktuell', async () => {
  vm.runInContext(pub('marker-extra.js'), ctx);
  const G = ctx.MV.GLYPHS; assert.deepEqual(Object.keys(G).sort(), ['base', 'bases3d', 'beams', 'civilian', 'coriolis', 'labels', 'npc', 'offline', 'player', 'storm', 'vehicle', 'worm']);
  for (const [k, g] of Object.entries(G)) {
    assert.match(g.c, /^#[0-9a-f]{6}$/i, k); assert.ok(g.p.length >= 2, k);
    for (const q of g.p) {
      assert.ok(['circle', 'rect', 'ring'].includes(q[0]), k + ' ' + q[0]);
      const col = q[0] === 'rect' ? q[5] : q[4]; assert.match(col, /^#[0-9a-f]{6}$/i, k);
      const nums = q[0] === 'rect' ? q.slice(1, 5) : q.slice(1, 4);
      for (const n of nums) assert.ok(Number.isFinite(n) && n >= 0 && n <= 24, k + ' Zahl ' + n);
      if (q[0] === 'rect') assert.ok(q[1] + q[3] <= 24.01 && q[2] + q[4] <= 24.01, k + ' rect ragt aus dem Raster');
      else assert.ok(q[1] - q[3] >= -0.01 && q[1] + q[3] <= 24.01 && q[2] - q[3] >= -0.01 && q[2] + q[3] <= 24.01, k + ' Kreis ragt aus dem Raster');
    }
  }
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync(process.execPath, [fileURLToPath(new URL('../../tools/gen-marker-extra.mjs', import.meta.url)), '--check'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!/url\(/.test(fs.readFileSync(fileURLToPath(new URL('../../viewer/marker-extra.css', import.meta.url)), 'utf8')), 'Piktogramme sind reines CSS ohne url()');
});

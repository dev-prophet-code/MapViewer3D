// Prüft die 3D-Modelle für Marker (viewer/meshes.js) ohne Browser: Geometrie, Fußpunkt, Größen, Ersetzbarkeit.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const pub = (f) => fs.readFileSync(fileURLToPath(new URL('../../companion/public/' + f, import.meta.url)), 'utf8');
const ctx = vm.createContext({ console, performance, setTimeout, clearTimeout });
ctx.globalThis = ctx;
vm.runInContext(pub('three.js'), ctx); // klassische Skripte, wie im Browser
vm.runInContext(pub('orbit.js'), ctx);
vm.runInContext(pub('core.js'), ctx);
vm.runInContext(pub('meshes.js'), ctx);
const { MV, THREE } = ctx;

const KINDS = ['player', 'base', 'worm', 'vehicle', 'npc', 'civilian', 'storm', 'coriolis'];
// Erwartete Größenordnung der Höhe in Metern (min, max): grob, damit Modelle nicht versehentlich ihren Maßstab verlieren
// Der Sandwurm taucht absichtlich ein paar Meter in den Sand ein (er kommt aus dem Boden).
const FOOT_MIN = { worm: -4, coriolis: -20 }; // Randring des Coriolis-Sturms liegt halb im Boden
const HEIGHT = { player: [3, 6], base: [8, 14], worm: [15, 30], vehicle: [2.5, 5], npc: [1.5, 3], civilian: [1.5, 3], storm: [300, 500], coriolis: [500, 900] };

test('jede Art hat ein gültiges Modell: Normalen, Tönung, endliche Werte, Fußpunkt bei y = 0', () => {
  for (const kind of KINDS) {
    const m = MV.Markers.build(kind), g = m.geo, p = g.getAttribute('position'), n = g.getAttribute('normal'), t = g.getAttribute('tone');
    assert.ok(p.count > 0 && p.count % 3 === 0, kind + ': Dreiecke');
    assert.equal(n.count, p.count, kind); assert.equal(t.count, p.count, kind);
    for (const arr of [p.array, n.array, t.array]) for (let i = 0; i < arr.length; i++) assert.ok(Number.isFinite(arr[i]), kind + ': nicht endlich');
    g.computeBoundingBox(); const b = g.boundingBox, h = b.max.y - b.min.y;
    assert.ok(b.min.y >= (FOOT_MIN[kind] ?? -1) && b.min.y < 1, kind + ': Fußpunkt bei y=' + b.min.y);
    assert.ok(h >= HEIGHT[kind][0] && h <= HEIGHT[kind][1], kind + ': Höhe ' + h.toFixed(1) + ' m');
    assert.ok(m.radius > 0, kind + ': Radius');
    assert.equal(Boolean(m.translucent), kind === 'storm' || kind === 'coriolis', kind + ': durchscheinend');
  }
});

test('unbekannte Art fällt auf ein Standardmodell zurück, nichts wirft', () => {
  assert.ok(MV.Markers.build('gibt-es-nicht').geo.getAttribute('position').count > 0);
});

test('Modelle sind ersetzbar: register() setzt ein eigenes Mesh für eine Art ein', () => {
  const geo = new THREE.BoxGeometry(2, 2, 2); geo.translate(0, 1, 0);
  MV.Markers.register('mein-modell', geo, 3);
  const m = MV.Markers.build('mein-modell');
  assert.equal(m.geo, geo); assert.equal(m.radius, 3); assert.equal(m.translucent, 0);
});

test('Schichten: gleiche Schnittstelle wie Punkte (set, count, obj.visible) und globaler Umschalter', () => {
  assert.equal(typeof MV.Layer, 'function'); assert.equal(typeof MV.Layer.setModels, 'function'); assert.equal(MV.Layer.models, true);
  assert.equal(MV.Markers.models.worm.length, 0); // Baufunktionen ohne Parameter
});

// MapViewer 3D v2 - Basen aus echten Bauteilen (nur Companion).
// Die Bauteil-Modelle (Format "DML1") und ihr Katalog liegen im cdn-Branch und werden vom Companion Hash-geprüft ausgeliefert
// (/cdn/buildables/…). Die Teile einer Basis kommen aus /api/base?id=… (Console: GET /api/bases/<id>/export, Recht "Bases: Read").
// Umrechnung Unreal → three.js und der Zusammenbau folgen dem MapViewer3D-Addon (MIT).
(function () {
  'use strict';
  const MV = globalThis.MV;
  const NEAR = 1200, FAR = 1800, MAX_LOADED = 24, PARALLEL = 3; // Meter; Basen näher als NEAR werden aufgebaut, weiter als FAR abgebaut

  // Farben je Fraktion/Kategorie des Bauteils
  const GROUP_COLORS = { Harkonnen: 0x4a4d52, Atreides: 0x7d8a6a, Choam: 0xb9a584, Choam_Level2: 0xc7b391, Choam_Shelter: 0xa8946f, Smugglers: 0x8a6a4c, Sardaukar: 0x5b4e45,
    Watershippers: 0x6f8791, MiniSets: 0x9c8a70, Blockout: 0x9a9a9a, Functional: 0x8f8a82, Functional_1510: 0x8f8a82, Functional_PolarCap: 0x8f8a82, Decoration: 0xa38b6d, Vehicle: 0x7c7f86 };

  // Unreal (cm, Z oben, linkshändig) → three.js (m, Y oben). Das Vertauschen von Y und Z spiegelt zugleich die Händigkeit.
  const C = new THREE.Matrix4().set(0.01, 0, 0, 0, 0, 0, 0.01, 0, 0, 0.01, 0, 0, 0, 0, 0, 1), CInv = C.clone().invert();
  function ueRotation(pitch, yaw, roll) {
    const d = Math.PI / 180, sp = Math.sin(pitch * d), cp = Math.cos(pitch * d), sy = Math.sin(yaw * d), cy = Math.cos(yaw * d), sr = Math.sin(roll * d), cr = Math.cos(roll * d);
    return new THREE.Matrix4().set(cp * cy, sr * sp * cy - cr * sy, -(cr * sp * cy + sr * sy), 0, cp * sy, sr * sp * sy + cr * cy, cy * sr - cr * sp * sy, 0, sp, -sr * cp, cr * cp, 0, 0, 0, 0, 1);
  }
  function ueMatrix(loc, rot, scale) {
    const m = ueRotation(rot[0], rot[1], rot[2]); m.scale(new THREE.Vector3(scale[0], scale[1], scale[2])); m.setPosition(loc[0], loc[1], loc[2]); return m;
  }
  const ueToThree = (m) => new THREE.Matrix4().multiplyMatrices(C, m).multiply(CInv);
  MV._ue = { ueMatrix, ueToThree }; // für Tests

  // MV.decodeMesh (Netzformat DML1) steht in creatures.js

  // api(path) → JSON; bin(path) → ArrayBuffer. Beide liefert die App (mit Cookie, Fehler als Ausnahme mit .status).
  MV.Buildings = function (env, io, opts) {
    opts = opts || {};
    const B = { bases: new Map(), index: null, indexP: null, geos: new Map(), mats: new Map(), loading: 0, disabled: '', onChange: opts.onChange || (() => {}), dead: false, timer: 0 };
    const group = new THREE.Group(); group.frustumCulled = false; env.sc.add(group);
    const cam = env.cam.position;

    function getIndex() { return B.indexP || (B.indexP = io.api('/cdn/buildables/index.json').then((j) => (B.index = j && j.rows ? j : { rows: {} }))); }
    function geometry(id) {
      if (!B.geos.has(id)) { const p = io.bin('/cdn/buildables/mesh/' + id + '.bin').then((b) => MV.decodeMesh(b)); p.catch(() => B.geos.delete(id)); B.geos.set(id, p); }
      return B.geos.get(id);
    }
    function material(row) {
      const color = GROUP_COLORS[row.group] != null ? GROUP_COLORS[row.group] : 0x9a8f80;
      if (!B.mats.has(color)) B.mats.set(color, MV.meshMaterial(env, color));
      return B.mats.get(color);
    }
    // Basis aus Export bauen: eine InstancedMesh je Netz
    async function build(exp) {
      const idx = await getIndex(), grp = new THREE.Group(), by = new Map(), base = [exp.x, exp.y, exp.z];
      const add = (type, loc, rot) => {
        const row = idx.rows[type]; if (!row || !(row.mesh >= 0)) return;
        let m = ueMatrix([base[0] + loc[0], base[1] + loc[1], base[2] + loc[2]], rot, [1, 1, 1]);
        if (row.offset || row.rot || row.scale) { const s = row.scale && row.scale.some((v) => v) ? row.scale : [1, 1, 1]; m = m.multiply(ueMatrix(row.offset || [0, 0, 0], row.rot || [0, 0, 0], s)); }
        if (!by.has(row.mesh)) by.set(row.mesh, { row, mats: [] }); by.get(row.mesh).mats.push(ueToThree(m));
      };
      for (const p of exp.i || []) add(p[0], [p[1], p[2], p[3]], [0, p[4], 0]);
      for (const p of exp.p || []) add(p[0], [p[1], p[2], p[3]], [p[4], p[5], p[6]]);
      await Promise.all([...by].map(async ([id, { row, mats }]) => {
        let geo; try { geo = await geometry(id); } catch (e) { return; } // einzelnes Bauteil fehlt: die Basis bleibt trotzdem sichtbar
        const im = new THREE.InstancedMesh(geo, material(row), mats.length);
        mats.forEach((m, i) => im.setMatrixAt(i, m)); im.frustumCulled = false; grp.add(im);
      }));
      return grp;
    }
    async function load(b) {
      b.state = 'loading'; B.loading++; const token = (b.token = {});
      try {
        const exp = await io.api('/api/base?id=' + b.id), grp = await build(exp);
        if (B.dead || b.token !== token || b.state !== 'loading' || B.bases.get(b.id) !== b) { grp.traverse((o) => o.isInstancedMesh && o.dispose()); return; }
        b.grp = grp; b.state = 'ready'; group.add(grp); B.onChange();
      } catch (e) {
        if (e && e.status === 403) B.disabled = 'scope'; // Token ohne "Bases: Read": nicht weiter versuchen (Hinweis über den Aufrufer)
        b.state = 'error'; b.retryAt = performance.now() + 60000;
      } finally { B.loading--; }
    }
    function drop(b) { if (b.grp) { group.remove(b.grp); b.grp.traverse((o) => o.isInstancedMesh && o.dispose()); b.grp = null; } b.state = 'idle'; b.token = null; B.onChange(); }
    function tick() {
      if (B.dead || B.disabled) return;
      const now = performance.now(), want = [];
      for (const b of B.bases.values()) {
        const d = Math.hypot(b.x - cam.x, b.y - cam.y, b.z - cam.z);
        if (b.state === 'ready' || b.state === 'loading') { if (d > FAR) drop(b); } else if (d < NEAR && (b.state !== 'error' || now > b.retryAt)) want.push({ b, d });
      }
      want.sort((p, q) => p.d - q.d);
      let ready = [...B.bases.values()].filter((b) => b.state === 'ready').length;
      for (const { b } of want) { if (B.loading >= PARALLEL || ready >= MAX_LOADED) break; b.state = 'queued'; load(b); ready++; }
    }
    // rows: [{i, x, y, z}] Basen mit Console-ID und Lage in Zentimetern. Vorhandene bleiben erhalten.
    B.setBases = function (rows) {
      const keep = new Set();
      for (const r of rows) {
        if (!r.i) continue; keep.add(r.i);
        const x = r.x / 100, z = r.y / 100, y = r.z / 100; // three.js: x, Höhe, y der Karte
        const b = B.bases.get(r.i); if (b) { b.x = x; b.y = y; b.z = z; } else B.bases.set(r.i, { id: r.i, x, y, z, state: 'idle' });
      }
      for (const [id, b] of B.bases) if (!keep.has(id)) { drop(b); B.bases.delete(id); }
    };
    B.setVisible = (on) => { group.visible = !!on; };
    B.realIds = () => new Set([...B.bases.values()].filter((b) => b.state === 'ready').map((b) => b.id));
    B.dispose = function () { B.dead = true; clearInterval(B.timer); for (const b of [...B.bases.values()]) drop(b); env.sc.remove(group); for (const m of B.mats.values()) m.dispose(); };
    B.timer = setInterval(tick, 600);
    return B;
  };
})();

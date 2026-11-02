// MapViewer 3D v2 - Echte Körper für Sandwurm, Figuren und Fahrzeuge (Addon und Companion).
// Der cdn-Branch enthält (Ordner creatures/) maßstabsgetreue Körper aus den Physik-Assets der Spieldateien: Sandwurm (350 m),
// Figur (184 cm), Choam-Ornithopter. Dieses Skript lädt sie und setzt sie anstelle der Platzhalter-Modelle ein
// (MV.Markers.register). Fehlt etwas oder schlägt das Laden fehl, bleiben die Platzhalter.
(function () {
  'use strict';
  const MV = globalThis.MV;

  // Netz im Format DML1 → Geometrie in Metern, Y oben (Dreiecksfolge umgedreht, weil Y/Z getauscht wird)
  MV.decodeMesh = function (buf) {
    const dv = new DataView(buf);
    if (buf.byteLength < 36 || dv.getUint32(0, true) !== 0x314c4d44) throw new Error('kein DML1-Netz');
    const nv = dv.getUint32(4, true), ni = dv.getUint32(8, true);
    if (nv < 1 || nv > 200000 || ni > 600000 || ni % 3) throw new Error('DML1: Größe');
    let off = 36 + nv * 6; if (off % 4) off += 2;
    const wide = nv > 65535; if (off + ni * (wide ? 4 : 2) > buf.byteLength) throw new Error('DML1: abgeschnitten');
    const lo = [0, 1, 2].map((k) => dv.getFloat32(12 + 4 * k, true)), hi = [0, 1, 2].map((k) => dv.getFloat32(24 + 4 * k, true));
    const q = new Uint16Array(buf, 36, nv * 3), src = wide ? new Uint32Array(buf, off, ni) : new Uint16Array(buf, off, ni);
    const sc = [0, 1, 2].map((k) => (hi[k] - lo[k]) / 65535), pos = new Float32Array(nv * 3);
    for (let v = 0; v < nv; v++) { const x = lo[0] + q[3 * v] * sc[0], y = lo[1] + q[3 * v + 1] * sc[1], z = lo[2] + q[3 * v + 2] * sc[2]; pos[3 * v] = x / 100; pos[3 * v + 1] = z / 100; pos[3 * v + 2] = y / 100; }
    const idx = new Uint32Array(ni);
    for (let t = 0; t + 2 < ni; t += 3) { if (src[t] >= nv || src[t + 1] >= nv || src[t + 2] >= nv) throw new Error('DML1: Index'); idx[t] = src[t]; idx[t + 1] = src[t + 2]; idx[t + 2] = src[t + 1]; }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.setAttribute('tone', new THREE.BufferAttribute(new Float32Array(nv).fill(1), 1));
    g.computeVertexNormals(); g.computeBoundingSphere();
    return g;
  };


  const GEO_LIMIT = 200000; // Eckpunkte je Netz (schützt den Dekodierer)
  const C = (MV.Creatures = { rows: {}, loaded: false });

  // source: { index: {rows, meshes}, bin: (id) => Promise<ArrayBuffer> }. Gibt die Zahl der eingesetzten Modelle zurück.
  C.load = async function (source) {
    const idx = source && source.index; if (!idx || typeof idx.rows !== 'object') return 0;
    const geos = new Map(); let n = 0;
    async function geo(id) {
      if (!Number.isInteger(id) || id < 0) return null;
      if (!geos.has(id)) geos.set(id, source.bin(id).then((b) => { const g = MV.decodeMesh(b); if (g.getAttribute('position').count > GEO_LIMIT) throw new Error('Netz zu groß'); g.computeBoundingSphere(); return g; }).catch(() => null));
      return geos.get(id);
    }
    C.rows = {};
    for (const [name, row] of Object.entries(idx.rows)) {
      if (!row || typeof row.kind !== 'string' || !Array.isArray(row.match)) continue;
      const g = await geo(row.mesh); if (!g) continue;
      const rad = Math.max(0.5, g.boundingSphere.radius), dy = row.kind === 'vehicle' ? 0 : 90, fwd = (Number.isFinite(Number(row.yaw)) && row.yaw !== undefined ? Number(row.yaw) : dy) * Math.PI / 180; // ohne Angabe: Wurm/Figur 90° (+Y), Fahrzeug 0° (+X)
      const extra = { yaw: Number.isFinite(fwd) ? fwd : 0, yOffset: 0 };
      C.rows[name] = { kind: row.kind, match: row.match.map((m) => String(m).toLowerCase()).slice(0, 12) };
      // Modelle gibt es nur für Spieler und Fahrzeuge (Gegner, Zivilisten, Würmer und Stürme bleiben Symbole wie auf der Webseite)
      if (row.kind === 'humanoid') MV.Markers.register('player', g, rad, 0, extra);
      else if (row.kind === 'vehicle') { MV.Markers.register('vehicle:' + name, g, rad, 0, extra); if (!C.rows.__vehicleDefault) { C.rows.__vehicleDefault = name; MV.Markers.register('vehicle', g, rad, 0, extra); } }
      else continue;
      n++;
    }
    C.loaded = n > 0;
    if (n && MV.Layer && MV.Layer.reloadModels) MV.Layer.reloadModels();
    return n;
  };

  // Welche Modell-Variante gehört zur Klasse eines Echtzeit-Objekts? ('' = Standardmodell der Art)
  C.variantFor = function (kind, className) {
    if (kind !== 'vehicle' || !C.loaded) return '';
    const c = String(className || '').toLowerCase();
    for (const [name, r] of Object.entries(C.rows)) if (r && r.kind === 'vehicle' && r.match.some((m) => c.includes(m))) return name;
    return '';
  };
})();

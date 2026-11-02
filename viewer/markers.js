// MapViewer 3D v2 - Marker-Atlas der Live-Karte (nur Companion): Symbole der Console als Billboards über dem Gelände.
// Typen, Symbole und Größen stammen aus dem CSS der Console (viewer/marker-defs.js, erzeugt von tools/extract-marker-css.mjs).
// Die Symbole selbst holt der Companion zur Laufzeit von der Console (/icons/<Datei>), es liegen keine Bilder im Repository.
(function () {
  'use strict';
  const MV = globalThis.MV, D = MV.MARKER_DEFS;
  const lc = (s) => String(s || '').toLowerCase();
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined; // Untertypen kommen von der Console: nie über die Prototyp-Kette nachschlagen
  const css = (s) => lc(s).replace(/[^a-z0-9_]/g, ''); // nur Zeichen, die in einem Klassennamen sicher sind

  // Darstellung eines Markers: { icon: Datei | null, size: px, color, disc }
  MV.markerStyle = function (type, subtype) {
    const t = lc(type), s = lc(subtype), hasSub = !!s;
    let icon = (s && own(D.icon.subtype, s)) || own(D.icon.type, t) || null;
    let size;
    if (t === 'spice' || t === 'spice_active') size = /small/.test(s) ? D.spiceTier.small : /medium/.test(s) ? D.spiceTier.medium : D.spiceTier.large;
    else if (hasSub && own(D.size.subtype, s)) size = own(D.size.subtype, s);
    else if (hasSub && icon) size = own(D.groupSize, t) || D.defaultSubtypeSize;
    else size = own(D.size.type, t) || (icon ? D.defaultSubtypeSize : D.defaultDot);
    if (t === 'hazard') { icon = null; size = D.size.type.hazard || 24; }
    return { icon, size, color: own(D.color, t) || (t === 'hazard' ? '#ef4444' : '#9ca3af'), disc: !icon, hazard: t === 'hazard', glow: t === 'spice_active' };
  };

  // Gefüllter Kreis (Marker ohne Symbol, Gefahrenzonen)
  const discs = new Map();
  function disc(color, alpha) {
    const k = color + alpha; if (discs.has(k)) return discs.get(k);
    const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d');
    g.fillStyle = color; g.globalAlpha = alpha; g.beginPath(); g.arc(32, 32, 28, 0, Math.PI * 2); g.fill();
    g.globalAlpha = 1; g.lineWidth = 4; g.strokeStyle = 'rgba(9,11,13,.85)'; g.stroke();
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; discs.set(k, tex); return tex;
  }
  const loader = new THREE.TextureLoader(), cache = new Map();
  function icon(file) {
    if (!cache.has(file)) { const tex = loader.load('icons/' + encodeURIComponent(file)); tex.colorSpace = THREE.SRGBColorSpace; cache.set(file, tex); }
    return cache.get(file);
  }

  // rows: [{t,s,n,id,x,y,z}] mit x/y/z in Zentimetern (wie die Console). Liefert Gruppen je Typ.
  MV.MarkerSet = function (env, rows) {
    const types = new Map(); // Typ -> { type, rows, layers: [Points], visible }
    const byKey = new Map(); // Darstellung -> { style, items }
    for (const r of rows) {
      const st = MV.markerStyle(r.t, r.s), key = r.t + '|' + (st.icon || st.color) + '|' + st.size + (st.glow ? 'g' : '');
      let g = byKey.get(key); if (!g) byKey.set(key, (g = { type: r.t, style: st, items: [] }));
      g.items.push({ x: r.x / 100, y: r.y / 100, z: r.z / 100, n: r.n, s: r.s, t: r.t });
      let ty = types.get(r.t); if (!ty) types.set(r.t, (ty = { type: r.t, count: 0, subs: new Map(), layers: [], visible: true }));
      ty.count++; ty.subs.set(r.s, (ty.subs.get(r.s) || 0) + 1);
    }
    for (const g of byKey.values()) {
      const n = g.items.length, pos = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { const a = g.items[i]; pos[i * 3] = a.x; pos[i * 3 + 1] = a.z + 4; pos[i * 3 + 2] = a.y; }
      const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      const map = g.style.icon ? icon(g.style.icon) : disc(g.style.hazard ? '#ef4444' : g.style.color, g.style.hazard ? 0.5 : 1);
      const mat = new THREE.PointsMaterial({ map, size: g.style.size, sizeAttenuation: false, transparent: true, alphaTest: 0.2, depthWrite: false });
      const pts = new THREE.Points(geo, mat); pts.frustumCulled = false; pts.renderOrder = 5; env.sc.add(pts);
      g.pts = pts; types.get(g.type).layers.push(g);
    }
    const groups = [...types.values()].sort((a, b) => b.count - a.count);
    for (const ty of groups) { // Stellvertreter für die Legende: häufigster Untertyp
      const top = [...ty.subs.entries()].sort((a, b) => b[1] - a[1])[0];
      ty.cls = 'marker-' + css(ty.type) + (top && top[0] ? ' subtype-' + css(top[0]) : '');
    }
    return {
      groups,
      setVisible(type, on) { const ty = types.get(type); if (ty) { ty.visible = on; for (const g of ty.layers) g.pts.visible = on; } },
      // nächster sichtbarer Marker zu einem Bildschirmpunkt (für den Hinweis beim Darüberfahren)
      nearest(px, py, maxPx) {
        const el = env.R.domElement, w = el.clientWidth, h = el.clientHeight, v = new THREE.Vector3(); let best = null, bd = (maxPx || 16) ** 2;
        env.cam.updateMatrixWorld();
        for (const ty of groups) if (ty.visible) for (const g of ty.layers) for (const a of g.items) {
          v.set(a.x, a.z + 4, a.y).project(env.cam); if (v.z > 1 || Math.abs(v.x) > 1.1 || Math.abs(v.y) > 1.1) continue;
          const dx = (v.x * 0.5 + 0.5) * w - px, dy = (-v.y * 0.5 + 0.5) * h - py, d = dx * dx + dy * dy;
          if (d < bd) { bd = d; best = a; }
        }
        return best;
      },
      dispose() { for (const ty of groups) for (const g of ty.layers) { env.sc.remove(g.pts); g.pts.geometry.dispose(); g.pts.material.dispose(); } },
    };
  };
})();

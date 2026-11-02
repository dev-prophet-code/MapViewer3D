// MapViewer 3D v2 - Symbole für Marker ohne echtes Mesh (Addon und Companion).
// Für Spieler, Basen, Fahrzeuge, Sandwürmer, Gegner, Zivilisten, Sandstürme und Coriolis gibt es nur einfache Platzhalter-Modelle.
// Diese Marker bekommen zusätzlich ein Symbol im Stil der Live-Karte der Console (flache Piktogramme, dunkler Schatten, 24-Einheiten-Raster).
// Eine einzige Beschreibung (MV.GLYPHS) liefert beides: das CSS für die Legende (tools/gen-marker-extra.mjs → marker-extra.css)
// und die Textur für die 3D-Ansicht (Canvas), damit Legende und Marker gleich aussehen. Wo die Console selbst ein Symbol hat
// (Spieler, Basis, Fahrzeug), nutzt der Companion deren Bild und CSS; das Piktogramm hier ist der Rückfall (Addon: immer).
(function () {
  'use strict';
  const MV = (globalThis.MV = globalThis.MV || {});

  // Raster 24 × 24. Primitive: ['circle', cx, cy, r, farbe] · ['rect', x, y, b, h, farbe] · ['ring', cx, cy, r, farbe, breite]
  MV.GLYPHS = {
    player: { c: '#2f9bff', p: [['circle', 12, 6.5, 4, '#f0c9a0'], ['rect', 5, 12, 14, 10, '#2f9bff'], ['rect', 9, 12, 6, 3, '#bfe1ff']] },
    offline: { c: '#8a8a8a', p: [['circle', 12, 6.5, 4, '#bdbdbd'], ['rect', 5, 12, 14, 10, '#8a8a8a']] },
    base: { c: '#ff8a1f', p: [['rect', 2, 9, 20, 3, '#a8530a'], ['rect', 4, 12, 16, 10, '#ff8a1f'], ['rect', 10, 15, 4, 7, '#4a2a08'], ['rect', 5, 2, 2, 7, '#dddddd'], ['rect', 7, 2, 6, 4, '#3fa7ff']] },
    vehicle: { c: '#ffffff', p: [['rect', 2, 12, 20, 6, '#e8e8e8'], ['rect', 6, 7, 10, 6, '#9aa4ad'], ['circle', 6.5, 19, 3, '#2b2b2b'], ['circle', 17.5, 19, 3, '#2b2b2b']] },
    worm: { c: '#ff3b30', p: [['circle', 4, 17, 3.4, '#ff3b30'], ['circle', 8, 11, 4.2, '#e0291f'], ['circle', 14, 7.5, 4.8, '#ff3b30'], ['circle', 19.5, 11, 4.2, '#e0291f'], ['circle', 20.5, 18, 3.2, '#ff3b30'], ['ring', 14, 7.5, 2.4, '#4a0e0a', 1.2]] },
    npc: { c: '#ff5a4d', p: [['circle', 12, 12, 8.5, '#14100a'], ['circle', 12, 12, 7, '#ff5a4d']] },
    civilian: { c: '#4dd2c6', p: [['circle', 12, 12, 8.5, '#14100a'], ['circle', 12, 12, 7, '#4dd2c6']] },
    storm: { c: '#c040ff', p: [['rect', 2, 4, 20, 3, '#c040ff'], ['rect', 5, 10, 17, 3, '#a02de0'], ['rect', 2, 16, 14, 3, '#c040ff'], ['circle', 19, 17.5, 2.6, '#e2a0ff']] },
    labels: { c: '#bfe1ff', p: [['rect', 1, 7, 22, 10, '#2a241d'], ['rect', 5, 11, 14, 2, '#bfe1ff']] },
    beams: { c: '#ff9d2e', p: [['rect', 9, 1, 6, 16, '#ff9d2e'], ['circle', 12, 18, 5, '#ffcf8a']] },
    bases3d: { c: '#9aa0a6', p: [['rect', 3, 11, 18, 11, '#6d7278'], ['rect', 10, 14, 4, 8, '#3fa7ff'], ['rect', 1, 6, 22, 5, '#9aa0a6']] },
    coriolis: { c: '#c040ff', p: [['ring', 12, 12, 10, '#c040ff', 3], ['circle', 12, 12, 3.5, '#e2a0ff']] },
  };

  // Textur aus der Beschreibung (Canvas), gemerkt je Schlüssel
  const cache = new Map();
  MV.glyphTexture = function (key) {
    if (cache.has(key)) return cache.get(key);
    const g = MV.GLYPHS[key] || MV.GLYPHS.npc, S = 4, c = document.createElement('canvas'); c.width = c.height = 24 * S;
    const x = c.getContext('2d'); x.scale(S, S);
    x.shadowColor = 'rgba(9,11,13,.75)'; x.shadowBlur = 1.2; x.shadowOffsetY = 0.6; // wie der dunkle Schatten der Console-Marker
    for (const q of g.p) {
      if (q[0] === 'circle') { const [, cx, cy, r, col] = q; x.fillStyle = col; x.beginPath(); x.arc(cx, cy, r, 0, Math.PI * 2); x.fill(); }
      else if (q[0] === 'rect') { const [, rx, ry, w, h, col] = q; x.fillStyle = col; x.fillRect(rx, ry, w, h); }
      else if (q[0] === 'ring') { const [, cx, cy, r, col, lw = 2] = q; x.strokeStyle = col; x.lineWidth = lw; x.beginPath(); x.arc(cx, cy, r - lw / 2, 0, Math.PI * 2); x.stroke(); }
    }
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4; cache.set(key, tex); return tex;
  };

  // Symbole als Billboards (feste Bildschirmgröße), gleiche Schnittstelle wie MV.Points: set(arr), obj, count.
  // opts: { glyph | file (Bild der Console), px, lift (Meter über dem Boden), color }
  const loader = () => (MV._tl || (MV._tl = new THREE.TextureLoader()));
  const files = new Map();
  MV.IconPoints = function (env, opts) {
    opts = opts || {};
    let tex;
    if (opts.file && MV.ICON_FILES) { // Bild der Console über den Companion
      if (!files.has(opts.file)) { const t = loader().load('icons/' + encodeURIComponent(opts.file)); t.colorSpace = THREE.SRGBColorSpace; files.set(opts.file, t); }
      tex = files.get(opts.file);
    } else tex = MV.glyphTexture(opts.glyph || 'npc');
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3));
    // Überblendung nach Entfernung wie im Dune Map Viewer: nah ist das Symbol weg (dort steht das Modell), ab fade[1] voll sichtbar
    const fade = opts.fade || [0, 0], uni = { uMap: { value: tex }, uPx: { value: opts.px || 26 }, uDpr: { value: Math.min(devicePixelRatio || 1, 2) }, uF0: { value: fade[0] }, uF1: { value: fade[1] }, uFadeOn: { value: opts.fade ? 1 : 0 }, uTint: { value: new THREE.Color(opts.color == null ? 0xffffff : opts.color) } };
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, uniforms: uni,
      vertexShader: 'uniform float uPx,uDpr,uF0,uF1,uFadeOn;varying float vFade;void main(){vec4 mv=modelViewMatrix*vec4(position,1.0);float d=-mv.z;vFade=uFadeOn>0.5?smoothstep(uF0,uF1,d):1.0;float shrink=mix(1.0,0.55,smoothstep(2500.0,20000.0,d));gl_Position=projectionMatrix*mv;gl_PointSize=uPx*shrink*uDpr;}',
      fragmentShader: 'uniform sampler2D uMap;uniform vec3 uTint;varying float vFade;void main(){if(vFade<0.01)discard;vec4 c=texture2D(uMap,vec2(gl_PointCoord.x,1.0-gl_PointCoord.y));if(c.a<0.04)discard;gl_FragColor=vec4(c.rgb*uTint,c.a*vFade);\n#include <colorspace_fragment>\n}',
    });
    const pts = new THREE.Points(geo, mat); pts.frustumCulled = false; pts.renderOrder = 6; env.sc.add(pts);
    const api = {
      obj: pts, count: 0, items: [], lift: opts.lift == null ? 4 : opts.lift,
      set(arr) {
        let a = pts.geometry.getAttribute('position');
        if (a.count < arr.length) { pts.geometry.dispose(); pts.geometry = new THREE.BufferGeometry(); a = new THREE.BufferAttribute(new Float32Array(Math.ceil(arr.length * 1.5 + 16) * 3), 3); pts.geometry.setAttribute('position', a); }
        const p = a.array;
        for (let i = 0; i < arr.length; i++) { p[i * 3] = arr[i].x; p[i * 3 + 1] = arr[i].z + api.lift; p[i * 3 + 2] = arr[i].y; }
        a.needsUpdate = true; pts.geometry.setDrawRange(0, arr.length); api.count = arr.length; api.items = arr;
      },
      nearest(px, py, maxPx) {
        const el = env.R.domElement, w = el.clientWidth, h = el.clientHeight, v = new THREE.Vector3(); let best = null, bd = (maxPx || 14) ** 2;
        env.cam.updateMatrixWorld();
        for (const a of api.items) {
          v.set(a.x, a.z + api.lift, a.y).project(env.cam); if (v.z > 1 || Math.abs(v.x) > 1.1 || Math.abs(v.y) > 1.1) continue;
          const dx = (v.x * 0.5 + 0.5) * w - px, dy = (-v.y * 0.5 + 0.5) * h - py, d = dx * dx + dy * dy;
          if (d < bd) { bd = d; best = a; }
        }
        return best;
      },
      setFade(on) { uni.uFadeOn.value = on && opts.fade ? 1 : 0; },
      dispose() { env.sc.remove(pts); pts.geometry.dispose(); mat.dispose(); },
    };
    return api;
  };

  // Namen über den Symbolen (wie im Dune Map Viewer): je Art eine Sichtweite, abhängig von der Kameraentfernung ein- und ausgeblendet.
  // set(kind, items): items = [{x, y, z, text, color, size, range (m), lift}]; setOn(bool) = Schalter "Namen", setKind(kind, bool) = Schicht an/aus
  MV.Labels = function (env) {
    const group = new THREE.Group(); env.sc.add(group); const tex = new Map(), kinds = {}; let on = true;
    function texture(text, color, size) {
      const key = text + '|' + color + '|' + size; let t = tex.get(key); if (t) return t;
      if (tex.size > 600) { for (const v of tex.values()) { v.map.dispose(); } tex.clear(); }
      const fs = Math.round(size * 0.65), S = 2, c = document.createElement('canvas'), x = c.getContext('2d');
      x.font = '600 ' + fs * S + 'px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif'; const w = Math.ceil(x.measureText(text).width) + 14 * S, h = Math.round(fs * 1.6 * S);
      c.width = w; c.height = h; x.font = '600 ' + fs * S + 'px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif';
      x.fillStyle = 'rgba(20,15,10,.72)'; x.beginPath(); if (x.roundRect) x.roundRect(0, 0, w, h, h / 2); else x.rect(0, 0, w, h); x.fill();
      x.fillStyle = color; x.textBaseline = 'middle'; x.textAlign = 'center'; x.fillText(text, w / 2, h / 2 + S);
      const m = new THREE.CanvasTexture(c); m.colorSpace = THREE.SRGBColorSpace; t = { map: m, w: w / S, h: h / S }; tex.set(key, t); return t;
    }
    const api = {
      set(kind, items) {
        const k = kinds[kind] || (kinds[kind] = { on: true, sprites: [], items: [] });
        k.items = items.slice(0, 400);
        while (k.sprites.length > k.items.length) { const sp = k.sprites.pop(); group.remove(sp); sp.material.dispose(); } // vorhandene Sprites wiederverwenden (die Daten kommen mehrmals pro Sekunde)
        k.items.forEach((it, i) => {
          const t = texture(String(it.text).slice(0, 60), it.color || '#cfe3ff', it.size || 20); let sp = k.sprites[i];
          if (!sp) { sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: t.map, depthTest: false, depthWrite: false, transparent: true, sizeAttenuation: false })); sp.renderOrder = 10; sp.visible = false; group.add(sp); k.sprites.push(sp); }
          else if (sp.material.map !== t.map) { sp.material.map = t.map; sp.material.needsUpdate = true; }
          sp.userData = { it, w: t.w, h: t.h }; sp.position.set(it.x, it.z + (it.lift || 6), it.y);
        });
      },
      setOn(v) { on = !!v; }, setKind(kind, v) { (kinds[kind] || (kinds[kind] = { on: true, sprites: [], items: [] })).on = !!v; },
    };
    env.onFrame(() => {
      const el = env.R.domElement, h = el.clientHeight || 600, unit = 2 * Math.tan(env.cam.fov * Math.PI / 360) / h, c = env.cam.position;
      for (const kk in kinds) { const k = kinds[kk]; for (const sp of k.sprites) {
        const it = sp.userData.it, d = Math.hypot(sp.position.x - c.x, sp.position.z - c.z);
        sp.visible = on && k.on && d < (it.range || 1e9);
        if (sp.visible) { sp.scale.set(sp.userData.w * unit, sp.userData.h * unit, 1); sp.center.set(0.5, -((it.px || 26) * 0.5 + 2) / sp.userData.h); }
      } }
    });
    return api;
  };

  // Leuchtsäulen über Spielern (Schalter "Leuchtsäulen"): dünne, nach oben auslaufende Säule
  MV.Beams = function (env, color) {
    const geo = new THREE.CylinderGeometry(1.1, 1.1, 600, 8, 1, true); geo.translate(0, 300, 0);
    const mat = new THREE.ShaderMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, uniforms: { uC: { value: new THREE.Color(color || 0xff9d2e) } },
      vertexShader: 'varying float vY;void main(){vY=position.y/600.0;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
      fragmentShader: 'uniform vec3 uC;varying float vY;void main(){gl_FragColor=vec4(uC,0.55*(1.0-vY));\n#include <colorspace_fragment>\n}' });
    const group = new THREE.Group(); group.visible = false; env.sc.add(group); const pool = [];
    return {
      set(arr) { while (pool.length < arr.length) { const m = new THREE.Mesh(geo, mat); group.add(m); pool.push(m); } pool.forEach((m, i) => { m.visible = i < arr.length; if (i < arr.length) m.position.set(arr[i].x, arr[i].z, arr[i].y); }); },
      setOn(v) { group.visible = !!v; },
    };
  };
})();

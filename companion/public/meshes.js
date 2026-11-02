// MapViewer 3D v2 - 3D-Modelle für Marker (Addon und Companion).
// Klassisches Skript: erwartet THREE und MV (core.js). Statt flacher Punkte zeichnet es Instanzen echter Meshes
// (eine Zeichenanweisung je Art), mit derselben Sonne und demselben Nebel wie das Gelände.
//
// Die Modelle hier sind einfache, im Code erzeugte Platzhalter. Echte Spielmodelle lassen sich später
// ersetzen, ohne den Rest zu ändern:  MV.Markers.register('worm', geometry)  mit einer THREE.BufferGeometry,
// die ihren Fußpunkt bei y = 0 hat und in Metern gemessen ist.
(function () {
  'use strict';
  const MV = globalThis.MV;

  // ---------------------------------------------------------------- Bausteine
  // Mehrere Körper zu einer Geometrie verbinden (ohne Index, mit Normalen), jeder mit eigener Farbe (attribute tone).
  function merge(parts) {
    const pos = [], nor = [], tone = [];
    for (const { geo, tone: t = 1, m } of parts) {
      let g = geo.index ? geo.toNonIndexed() : geo.clone();
      if (m) g.applyMatrix4(m);
      if (!g.attributes.normal) g.computeVertexNormals();
      pos.push(g.attributes.position.array); nor.push(g.attributes.normal.array);
      tone.push(new Float32Array(g.attributes.position.count).fill(t));
      g.dispose();
    }
    const cat = (arrs) => { const n = arrs.reduce((a, b) => a + b.length, 0), out = new Float32Array(n); let o = 0; for (const a of arrs) { out.set(a, o); o += a.length; } return out; };
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.BufferAttribute(cat(pos), 3));
    out.setAttribute('normal', new THREE.BufferAttribute(cat(nor), 3));
    out.setAttribute('tone', new THREE.BufferAttribute(cat(tone), 1));
    out.computeBoundingSphere();
    return out;
  }
  const M4 = (x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) =>
    new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(sx, sy, sz));
  const sphere = (r, w = 10, h = 7) => new THREE.SphereGeometry(r, w, h);
  const box = (x, y, z) => new THREE.BoxGeometry(x, y, z);
  const cyl = (rt, rb, h, s = 10, open = false) => new THREE.CylinderGeometry(rt, rb, h, s, 1, open);
  const cone = (r, h, s = 8) => new THREE.ConeGeometry(r, h, s);

  // ---------------------------------------------------------------- Modelle (Meter, Fußpunkt bei y = 0)
  // tone: 1 = Grundfarbe, <1 dunkler, >1 heller. radius: grobe Größe für die Mindestgröße am Bildschirm.
  const MODELS = {
    // Spieler: Figur mit Leuchtmarke darüber, damit sie auch aus der Ferne erkennbar ist
    player: () => ({ radius: 1.2, geo: merge([
      { geo: cyl(0.45, 0.55, 1.5, 8), tone: 1, m: M4(0, 0.95, 0) }, { geo: sphere(0.38, 8, 6), tone: 1.25, m: M4(0, 2.0, 0) },
      { geo: cone(0.55, 1.4, 8), tone: 1.4, m: M4(0, 4.0, 0, Math.PI) }, { geo: cyl(0.04, 0.04, 1.2, 5), tone: 0.8, m: M4(0, 2.9, 0) },
    ]) }),
    // Basis: Haus mit Dach und Fahne
    base: () => ({ radius: 7, geo: merge([
      { geo: box(11, 5, 9), tone: 1, m: M4(0, 2.5, 0) }, { geo: cone(8.6, 3.6, 4), tone: 0.72, m: M4(0, 6.8, 0, 0, Math.PI / 4, 0, 1, 1, 0.85) },
      { geo: box(2.2, 3, 0.4), tone: 0.55, m: M4(0, 1.5, 4.55) }, { geo: cyl(0.12, 0.12, 5, 5), tone: 0.6, m: M4(4.6, 8.3, 3.4) }, { geo: box(2, 1.2, 0.1), tone: 1.4, m: M4(5.6, 10, 3.4) },
    ]) }),
    // Sandwurm: gebogener Körper aus schrumpfenden Gliedern, dazu ein Maul mit Zähnen
    worm: () => {
      const parts = [], N = 13;
      for (let i = 0; i < N; i++) {
        const t = i / (N - 1), a = Math.PI * (0.05 + 0.9 * t), x = Math.cos(a) * 22, y = Math.sin(a) * 15, r = 6.5 - 4.6 * t;
        parts.push({ geo: sphere(r, 10, 8), tone: 0.78 + 0.28 * (i % 2) + 0.1 * (1 - t), m: M4(x, y + r * 0.2, 0, 0, 0, 0, 1, 0.92, 1) });
      }
      parts.push({ geo: cyl(5.2, 6.5, 2.4, 14, true), tone: 0.5, m: M4(22, 0.3, 0) });
      for (let k = 0; k < 8; k++) { const q = (k / 8) * Math.PI * 2; parts.push({ geo: cone(0.8, 3.2, 5), tone: 1.6, m: M4(22 + Math.cos(q) * 4.6, 2.2, Math.sin(q) * 4.6, 0, 0, 0) }); }
      return { radius: 22, geo: merge(parts) };
    },
    // Fahrzeug: Rumpf, Kabine, vier Räder
    vehicle: () => {
      const parts = [{ geo: box(6.2, 1.3, 3), tone: 1, m: M4(0, 1.25, 0) }, { geo: box(2.8, 1.2, 2.5), tone: 1.3, m: M4(-0.6, 2.5, 0) }, { geo: box(1, 0.5, 3.3), tone: 0.6, m: M4(3.2, 1.0, 0) }];
      for (const sx of [-2.1, 2.1]) for (const sz of [-1.7, 1.7]) parts.push({ geo: cyl(0.75, 0.75, 0.6, 10), tone: 0.45, m: M4(sx, 0.75, sz, Math.PI / 2, 0, 0) });
      return { radius: 3.6, geo: merge(parts) };
    },
    // Gegner/Zivilisten: einfache Figuren
    npc: () => ({ radius: 1.1, geo: merge([{ geo: cyl(0.4, 0.5, 1.4, 6), tone: 1, m: M4(0, 0.9, 0) }, { geo: sphere(0.34, 6, 5), tone: 1.3, m: M4(0, 1.85, 0) }, { geo: cyl(0.05, 0.05, 1.6, 4), tone: 0.6, m: M4(0.55, 1.2, 0) }]) }),
    civilian: () => ({ radius: 1.0, geo: merge([{ geo: cyl(0.38, 0.5, 1.5, 6), tone: 1, m: M4(0, 0.85, 0) }, { geo: sphere(0.32, 6, 5), tone: 1.3, m: M4(0, 1.8, 0) }]) }),
    // Sandsturm: durchscheinender Wirbel (offene Säule, nach oben weiter)
    storm: () => ({ radius: 260, translucent: 0.34, geo: merge([
      { geo: cyl(260, 190, 420, 24, true), tone: 1, m: M4(0, 210, 0) }, { geo: cyl(190, 120, 420, 24, true), tone: 0.8, m: M4(0, 210, 0) }, { geo: cyl(110, 60, 300, 16, true), tone: 1.3, m: M4(0, 150, 0) },
    ]) }),
    // Coriolis-Sturm: große Kuppel
    coriolis: () => ({ radius: 700, translucent: 0.2, geo: merge([{ geo: new THREE.SphereGeometry(700, 28, 12, 0, Math.PI * 2, 0, Math.PI / 2), tone: 1 }, { geo: new THREE.TorusGeometry(700, 18, 6, 40), tone: 1.4, m: M4(0, 6, 0, Math.PI / 2, 0, 0) }]) }),
  };
  const custom = {}; // später eingesetzte Spielmodelle: Art -> { geo, radius, translucent? }

  // ---------------------------------------------------------------- Shader
  const VERT = `
attribute float tone;
uniform float uMinPx,uPxScale,uRadius,uTime,uSway;
varying vec3 vN;varying float vTone,vDist,vH;
void main(){
 #ifdef USE_INSTANCING
  mat4 im=instanceMatrix;
 #else
  mat4 im=mat4(1.0);
 #endif
 vec3 c=(modelMatrix*im*vec4(0.0,0.0,0.0,1.0)).xyz;
 float d=length(cameraPosition-c);
 float s=max(1.0,(uMinPx*d*uPxScale)/uRadius);          // aus der Ferne nie kleiner als uMinPx Bildpunkte
 vec4 wp=modelMatrix*im*vec4(position,1.0);
 wp.xyz=c+(wp.xyz-c)*s;
 if(uSway>0.0){vec2 r=vec2(position.x,position.z);float rl=length(r);if(rl>0.001)wp.xz+=r/rl*sin(uTime*0.8+position.y*0.05+atan(r.y,r.x)*3.0)*uSway*position.y;} // sanftes Wabern (Stürme)
 vN=normalize(mat3(modelMatrix*im)*normal);vTone=tone;vH=position.y;
 vec4 mv=viewMatrix*wp;vDist=-mv.z;gl_Position=projectionMatrix*mv;}`;
  const FRAG = `
uniform vec3 uColor,uSun,uFogColor,uTone;uniform float uFogDensity,uOpacity;
varying vec3 vN;varying float vTone,vDist,vH;
void main(){
 vec3 n=normalize(vN);if(!gl_FrontFacing)n=-n;
 vec3 L=normalize(uSun);float diff=max(dot(n,L),0.0);float sky=0.5+0.5*n.y;
 vec3 light=vec3(1.0,0.95,0.86)*1.05*diff+vec3(0.42,0.47,0.56)*0.55*sky+vec3(0.30,0.20,0.12)*0.25*(1.0-sky)+vec3(0.20,0.18,0.16);
 vec3 col=uColor*vTone*light*uTone;
 float fog=1.0-exp(-pow(vDist*uFogDensity,2.0));
 gl_FragColor=vec4(mix(col,uFogColor,fog),uOpacity);
 #include <tonemapping_fragment>
 #include <colorspace_fragment>
}`;

  // ---------------------------------------------------------------- Marker
  const hash = (n) => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };

  // opts: { color, minPx (Mindestgröße am Bildschirm), scale, yOffset }
  // Gleiche Schnittstelle wie MV.Points: set(arr), obj, count. arr-Einträge: {x,y,z[,id][,yaw]} in Metern.
  MV.Markers = function (env, kind, opts) {
    opts = opts || {};
    const groups = new Map(); // Variante ('' = Standard, sonst z. B. 'ornithopter_light') -> eigenes Modell, eigene Instanzen
    function groupFor(variant) {
      let g = groups.get(variant); if (g) return g;
      const def = (variant && custom[kind + ':' + variant]) || custom[kind] || (MODELS[kind] || MODELS.npc)();
      const uni = {
        uColor: { value: new THREE.Color(opts.color == null ? 0xffffff : opts.color) },
        uSun: env.uniforms.uSun, uTone: env.uniforms.uTone, uFogColor: env.uniforms.uFogColor, uFogDensity: env.uniforms.uFogDensity,
        uMinPx: { value: opts.minPx == null ? 7 : opts.minPx }, uPxScale: { value: 0.001 }, uRadius: { value: def.radius * (opts.scale || 1) },
        uOpacity: { value: def.translucent || 1 }, uTime: { value: 0 }, uSway: { value: def.translucent ? 0.0009 : 0 },
      };
      const mat = new THREE.ShaderMaterial({ uniforms: uni, vertexShader: VERT, fragmentShader: FRAG, transparent: !!def.translucent, depthWrite: !def.translucent, side: def.translucent ? THREE.DoubleSide : THREE.FrontSide });
      g = { def, uni, mat, mesh: null, cap: 0, n: 0 }; groups.set(variant, g); return g;
    }
    let last = new Map(); // id -> {x,y,yaw} für die Blickrichtung aus der Bewegung
    const tmp = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), sc = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    const holder = new THREE.Group(); holder.frustumCulled = false; env.sc.add(holder);

    function ensure(g, n) {
      if (g.mesh && g.cap >= n) return;
      if (g.mesh) { holder.remove(g.mesh); g.mesh.dispose(); }
      g.cap = Math.max(32, Math.ceil(n * 1.5));
      g.mesh = new THREE.InstancedMesh(g.def.geo, g.mat, g.cap); g.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); g.mesh.frustumCulled = false; g.mesh.count = 0;
      holder.add(g.mesh);
    }
    const frame = () => {
      const t = performance.now() / 1000, ps = (2 * Math.tan((env.cam.fov * Math.PI) / 360)) / Math.max(1, env.R.domElement.height / (env.R.getPixelRatio() || 1));
      for (const g of groups.values()) { g.uni.uTime.value = t; g.uni.uPxScale.value = ps; }
    };
    env.onFrame(frame);

    const api = {
      kind, count: 0, items: [],
      get obj() { return holder; },
      set(arr) {
        // Einträge je Variante bündeln (Eintrag.v), jede Variante zeichnet ihr eigenes Modell
        const by = new Map();
        for (const a of arr) { const v = a.v || ''; let l = by.get(v); if (!l) by.set(v, (l = [])); l.push(a); }
        for (const g of groups.values()) g.n = 0;
        const seen = new Set(), k = opts.scale || 1; let idx = 0;
        for (const [variant, list] of by) {
          const g = groupFor(variant); ensure(g, list.length);
          const dy = opts.yOffset != null ? opts.yOffset : (g.def.yOffset != null ? g.def.yOffset : 0.2), fwd = g.def.yaw || 0;
          for (let i = 0; i < list.length; i++, idx++) {
            const a = list[i]; let yaw = a.yaw;
            if (yaw == null) {
              const key = a.id != null ? a.id : null;
              if (key != null) { // Blickrichtung aus der letzten Bewegung; steht das Ding still, behält es seine Richtung
                const prev = last.get(key); seen.add(key);
                if (prev && Math.hypot(a.x - prev.x, a.y - prev.y) > 0.4) yaw = fwd - Math.atan2(a.y - prev.y, a.x - prev.x);
                else yaw = prev ? prev.yaw : hash(key) * 6.2832;
                last.set(key, { x: a.x, y: a.y, yaw });
              } else yaw = hash(idx + 1) * 6.2832;
            }
            q.setFromAxisAngle(up, yaw); p.set(a.x, a.z + dy, a.y); const ks = k * (a.scale || 1); sc.set(ks, ks, ks);
            g.mesh.setMatrixAt(i, tmp.compose(p, q, sc));
          }
          g.n = list.length; g.mesh.count = g.n; g.mesh.instanceMatrix.needsUpdate = true;
        }
        for (const g of groups.values()) if (!g.n && g.mesh) g.mesh.count = 0;
        if (last.size > arr.length * 2 + 64) for (const key of [...last.keys()]) if (!seen.has(key)) last.delete(key);
        api.count = arr.length; api.items = arr;
      },
      // Modelle neu auflösen (nachdem MV.Markers.register echte Modelle eingesetzt hat); danach set() erneut aufrufen
      reload() { for (const g of groups.values()) { if (g.mesh) { holder.remove(g.mesh); g.mesh.dispose(); } g.mat.dispose(); } groups.clear(); },
      // Nächster Eintrag zu einem Bildschirmpunkt (px,py im Zeichenfeld), für Hover-Hinweise
      nearest(px, py, maxPx) {
        const el = env.R.domElement, w = el.clientWidth, h = el.clientHeight, v = new THREE.Vector3();
        let best = null, bd = (maxPx || 14) ** 2;
        env.cam.updateMatrixWorld();
        for (const a of api.items) {
          v.set(a.x, a.z + 1, a.y).project(env.cam); if (v.z > 1) continue;
          const dx = (v.x * 0.5 + 0.5) * w - px, dy = (-v.y * 0.5 + 0.5) * h - py, d = dx * dx + dy * dy;
          if (d < bd) { bd = d; best = a; }
        }
        return best;
      },
      dispose() { const i = env.cb.indexOf(frame); if (i >= 0) env.cb.splice(i, 1); api.reload(); holder.parent && holder.parent.remove(holder); },
    };
    return api;
  };
  // Schicht aus Punkten UND Modellen: schaltbar, gleiche Schnittstelle wie MV.Points (set, obj.visible, count)
  // opts: glyph (Piktogramm aus marker-extra.js), file (Symbol der Console, nur Companion), px (Größe des Symbols), tint, lift/overlay
  // (Symbol zusätzlich über dem Modell, in Metern Höhe). Ohne Modelle zeigt die Schicht nur das Symbol.
  MV.Layer = function (env, kind, color, size, opts) {
    opts = opts || {};
    const mk = MV.Markers(env, kind, { color, minPx: Math.max(6, size * 0.8), scale: opts.scale, yOffset: opts.yOffset });
    const sym = MV.IconPoints(env, { glyph: opts.glyph || kind, file: opts.file, px: opts.px || 26, color: opts.tint, fade: opts.fade });
    let vis = true, data = [], symData = [];
    const modelOn = () => MV.Layer.models && !opts.symOnly; // symOnly: nur Symbol (Gegner, Zivilisten, Würmer, Stürme)
    const showSym = () => vis && (!modelOn() || !!opts.overlay || !!opts.fade);
    const layer = {
      kind, count: 0,
      obj: { get visible() { return vis; }, set visible(v) { vis = !!v; layer.apply(); } },
      apply() { mk.obj.visible = vis && modelOn(); sym.obj.visible = showSym(); sym.setFade(modelOn()); sym.lift = modelOn() ? (opts.lift || 6) : 4; },
      set(arr, symArr) { data = arr; symData = symArr || arr; if (modelOn()) mk.set(arr); if (showSym() || !modelOn()) sym.set(symData); layer.count = arr.length; },
      nearest: (x, y, r) => (vis ? ((modelOn() && mk.nearest(x, y, r)) || (showSym() && sym.nearest(x, y, r)) || null) : null),
    };
    MV.Layer.all.push(layer); layer.apply();
    layer.refresh = () => { layer.apply(); if (modelOn()) mk.set(data); sym.set(symData); };
    layer.reloadModels = () => { mk.reload(); layer.refresh(); }; // nach MV.Markers.register
    return layer;
  };
  MV.Layer.models = true; MV.Layer.all = [];
  MV.Layer.reloadModels = function () { for (const l of MV.Layer.all) l.reloadModels(); };
  MV.Layer.setModels = function (on) { MV.Layer.models = !!on; for (const l of MV.Layer.all) l.refresh(); };

  // Material für fremde Geometrien (z. B. Bauteile der Basen): gleiche Sonne, gleicher Nebel, ohne Mindestgröße.
  // Die Geometrie braucht das Attribut "tone" (Helligkeit je Eckpunkt, 1 = Grundfarbe).
  MV.meshMaterial = function (env, color) {
    return new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(color) }, uSun: env.uniforms.uSun, uTone: env.uniforms.uTone, uFogColor: env.uniforms.uFogColor, uFogDensity: env.uniforms.uFogDensity,
        uMinPx: { value: 0 }, uPxScale: { value: 0.001 }, uRadius: { value: 1 }, uOpacity: { value: 1 }, uTime: { value: 0 }, uSway: { value: 0 } },
      vertexShader: VERT, fragmentShader: FRAG,
    });
  };

  // Eigene Modelle (z. B. echte Spielmodelle) für eine Art einsetzen. radius = grobe Größe in Metern.
  // kind oder 'kind:variante'. extra: { yaw (Blickrichtung des Modells in Bogenmaß, von +x nach +z), yOffset (Meter) }
  MV.Markers.register = function (kind, geometry, radius, translucent, extra) { custom[kind] = Object.assign({ geo: geometry, radius: radius || 2, translucent: translucent || 0 }, extra); };
  MV.Markers.unregister = function (kind) { delete custom[kind]; };
  MV.Markers.models = MODELS;
  MV.Markers.build = (kind) => (custom[kind] || (MODELS[kind] || MODELS.npc)());
})();

// MapViewer 3D v2 - gemeinsamer Viewer-Kern (Addon und Companion).
// Klassisches Skript: erwartet die globalen THREE und OrbitControls (siehe scripts/build.mjs).
// Das Geländeverfahren (Quadtree aus 128-Quad-Kacheln mit Schürzen) und der Shader folgen dem
// Original MapViewer3D (MIT).
(function () {
  'use strict';
  const MV = (globalThis.MV = {});

  // ---------------------------------------------------------------- Shader
  const VERT = `
attribute float valid;attribute float mat;
varying vec3 vWorld;varying vec3 vNormal;varying float vH,vValid,vMat,vDist;
void main(){vH=position.y+modelMatrix[3][1];vValid=valid;vMat=mat;vNormal=normalize(normal);
vec4 wp=modelMatrix*vec4(position,1.0);vWorld=wp.xyz;vec4 mv=viewMatrix*wp;vDist=-mv.z;gl_Position=projectionMatrix*mv;}`;
  const FRAG = `
uniform vec3 uSun,uLodTint,uFogColor;uniform float uMinH,uMaxH,uContours,uGrid,uFogDensity;
varying vec3 vWorld;varying vec3 vNormal;varying float vH,vValid,vMat,vDist;
float hash2(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}
float vnoise(vec2 p){vec2 i=floor(p),f=fract(p);vec2 u=f*f*(3.0-2.0*f);return mix(mix(hash2(i),hash2(i+vec2(1,0)),u.x),mix(hash2(i+vec2(0,1)),hash2(i+vec2(1,1)),u.x),u.y);}
float fbm(vec2 p){float v=0.0,a=0.5;for(int i=0;i<5;i++){v+=a*vnoise(p);p=p*2.03+17.1;a*=0.5;}return v;}
float triFbm(vec3 p,vec3 n,float s){vec3 w=pow(abs(n),vec3(4.0));w/=(w.x+w.y+w.z);return fbm(p.zy*s)*w.x+fbm(p.xz*s)*w.y+fbm(p.xy*s)*w.z;}
float line(float v,float w){float d=abs(fract(v-0.5)-0.5)/fwidth(v);return 1.0-clamp(d/w,0.0,1.0);}
void main(){
 if(vValid<0.5)discard;
 vec3 n=normalize(vNormal);vec2 w=vWorld.xz;
 float t=clamp((vH-uMinH)/max(uMaxH-uMinH,1.0),0.0,1.0);
 float slope=1.0-n.y;
 float isRock=smoothstep(2.5,2.9,vMat);
 float rocky=max(isRock,smoothstep(0.3,0.65,slope));
 float near=1.0-smoothstep(80.0,900.0,vDist);
 float big=fbm(w*0.0025);
 vec3 sand=mix(vec3(0.70,0.49,0.29),vec3(0.93,0.76,0.52),clamp(t*0.7+big*0.6-0.15,0.0,1.0));
 sand*=0.93+0.14*fbm(w*0.03);
 vec2 wind=normalize(vec2(0.82,0.57));
 float phase=dot(w,wind)*2.2+fbm(w*0.04)*9.0+vnoise(w*0.4)*1.5;
 float flat_=1.0-smoothstep(0.05,0.3,slope);
 n=normalize(n+vec3(wind.x,0.0,wind.y)*cos(phase)*0.22*near*flat_*(1.0-rocky));
 sand*=1.0+0.05*sin(phase)*near*flat_;
 sand*=0.96+0.08*vnoise(w*3.0)*near;
 vec3 col=sand;
 if(rocky>0.005){
  float rn=triFbm(vWorld,n,0.08);
  float strata=sin(vH*0.55+rn*6.0+fbm(w*0.01)*8.0);
  vec3 stone=mix(vec3(0.43,0.33,0.27),vec3(0.70,0.58,0.47),clamp(0.35+0.5*t+0.35*big,0.0,1.0));
  stone*=0.72+0.45*rn;stone*=0.93+0.07*strata;
  stone=mix(stone,stone*vec3(0.9,0.82,0.76),smoothstep(0.6,0.95,slope));
  col=mix(sand,stone,rocky);}
 col*=uLodTint;
 vec3 L=normalize(uSun);float diff=max(dot(n,L),0.0);float sky=0.5+0.5*n.y;
 vec3 light=vec3(1.0,0.95,0.86)*1.15*diff+vec3(0.42,0.47,0.56)*0.45*sky+vec3(0.30,0.20,0.12)*0.25*(1.0-sky);
 vec3 lit=col*light;
 if(uContours>0.5){float c=line(vH/10.0,1.0);float c50=line(vH/50.0,1.4);lit=mix(lit,vec3(0.25,0.15,0.08),max(c*0.45,c50*0.75));}
 if(uGrid>0.5){float g=max(line(vWorld.x/1000.0,1.2),line(vWorld.z/1000.0,1.2));lit=mix(lit,vec3(0.1,0.3,0.5),g*0.6);}
 float fog=1.0-exp(-pow(vDist*uFogDensity,2.0));
 gl_FragColor=vec4(mix(lit,uFogColor,fog),1.0);}`;

  const SKY = 0xc9b08c;
  const TINTS = [0xffffff, 0xffb0b0, 0xb0ffb0, 0xb0b0ff, 0xffffa0, 0xffa0ff, 0xa0ffff];

  // Karten, die der Viewer kennt. live = Name der Console-Karte, source = Name der Realtime-Quelle.
  MV.MAPS = {
    hagga: { name: 'survival_1', title: 'Hagga Basin', live: 'HaggaBasin', source: 'Survival_1' },
    deep: { name: 'deepdesert_1', title: 'Deep Desert', live: 'DeepDesert', source: 'DeepDesert_1' },
  };

  // ---------------------------------------------------------------- Umgebung
  MV.createEnv = function (canvas, stage) {
    const R = new THREE.WebGLRenderer({ canvas, antialias: true });
    R.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    const sc = new THREE.Scene();
    sc.background = new THREE.Color(SKY);
    const cam = new THREE.PerspectiveCamera(55, 1, 2, 90000);
    const ctl = new OrbitControls(cam, canvas);
    ctl.maxPolarAngle = 1.52;
    const env = {
      R, sc, cam, ctl, meta: null, group: new THREE.Group(), cb: [],
      uniforms: {
        uSun: { value: new THREE.Vector3(-0.5, 0.8, -0.35) }, uMinH: { value: 0 }, uMaxH: { value: 1 },
        uContours: { value: 0 }, uGrid: { value: 0 }, uFogColor: { value: new THREE.Color(SKY) }, uFogDensity: { value: 0.00004 },
      },
      mats: [],
    };
    sc.add(env.group);
    env.setMeta = function (m) {
      env.meta = m;
      env.ox = m.originX / 100; env.oy = m.originY / 100; env.ext = ((m.width - 1) * m.spacing) / 100;
      env.uniforms.uMinH.value = m.minZ / 100; env.uniforms.uMaxH.value = m.maxZ / 100;
      env.uniforms.uFogDensity.value = 0.35 / env.ext;
      env.home();
    };
    env.home = function () {
      cam.position.set(env.ox + env.ext * 0.5, env.ext * 0.32, env.oy + env.ext * 0.95);
      ctl.target.set(env.ox + env.ext * 0.5, 200, env.oy + env.ext * 0.5);
      ctl.update();
    };
    env.jump = function (x, z, y, dist) {
      ctl.target.set(x, y, z);
      cam.position.set(x + dist * 0.6, y + dist * 0.45, z + dist * 0.8);
      ctl.update();
    };
    env.material = function (level) {
      if (!env.mats[level]) {
        const u = Object.assign({}, env.uniforms, { uLodTint: { value: new THREE.Color(1, 1, 1) } });
        env.mats[level] = new THREE.ShaderMaterial({ uniforms: u, vertexShader: VERT, fragmentShader: FRAG });
      }
      return env.mats[level];
    };
    env.tint = function (on) { env.mats.forEach((m, l) => { if (m) m.uniforms.uLodTint.value.set(on ? TINTS[l % TINTS.length] : 0xffffff); }); };
    env.resize = function () {
      const w = Math.max(1, stage.clientWidth), h = Math.max(1, stage.clientHeight);
      R.setSize(w, h, false); cam.aspect = w / h; cam.updateProjectionMatrix();
    };
    addEventListener('resize', env.resize);
    env.resize();
    env.onFrame = (f) => env.cb.push(f);
    (function loop() { requestAnimationFrame(loop); ctl.update(); for (const f of env.cb) f(); R.render(sc, cam); })();
    env.clear = function () { while (env.group.children.length) { const c = env.group.children.pop(); if (c.geometry) c.geometry.dispose(); } };
    return env;
  };

  // ------------------------------------------------- grobes Gelände (Addon, eingebettet)
  // data: { grid, minZ, maxZ, originX, originY, extent, h } mit h = base64(gzip(uint16 LE))
  MV.CoarseTerrain = async function (env, data, stride) {
    const bin = Uint8Array.from(atob(data.h), (c) => c.charCodeAt(0));
    const raw = new Uint8Array(await new Response(new Blob([bin]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
    const H = new Uint16Array(raw.buffer, raw.byteOffset, raw.byteLength >> 1);
    const G = data.grid, cell = data.extent / 100 / (G - 1);
    const zMin = data.minZ / 100, zRng = (data.maxZ - data.minZ) / 100, ox = data.originX / 100, oy = data.originY / 100;
    const n = Math.floor((G - 1) / stride) + 1, pos = new Float32Array(n * n * 3), valid = new Float32Array(n * n).fill(1), mat = new Float32Array(n * n), idx = [];
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const gi = Math.min(G - 1, i * stride), gj = Math.min(G - 1, j * stride), v = H[gj * G + gi];
      pos.set([ox + gi * cell, zMin + (v / 65535) * zRng, oy + gj * cell], (j * n + i) * 3);
    }
    for (let j = 0; j < n - 1; j++) for (let i = 0; i < n - 1; i++) { const a = j * n + i; idx.push(a, a + n, a + 1, a + 1, a + n, a + n + 1); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('valid', new THREE.BufferAttribute(valid, 1));
    g.setAttribute('mat', new THREE.BufferAttribute(mat, 1));
    g.setIndex(idx); g.computeVertexNormals();
    const mesh = new THREE.Mesh(g, env.material(0)); mesh.frustumCulled = false;
    env.group.add(mesh);
    return { remove() { env.group.remove(mesh); g.dispose(); }, info: () => `Gelände (eingebettet): ${n}×${n} Punkte · ${Math.round((data.extent / 100) / (n - 1))} m Raster` };
  };

  // ------------------------------------------------- Quadtree-Gelände (Companion, gestreamt)
  MV.Terrain = function (env, idx, loadTile) {
    const meta = idx.meta, PQ = idx.patchQuads, N = PQ + 1, MAXL = idx.maxLevel;
    const T = { nodes: new Map(), queue: new Set(), inflight: 0, loaded: 0, drawn: [], frame: 0, detail: 3,
      fr: new THREE.Frustum(), box: new THREE.Box3(), m: new THREE.Matrix4(), errors: 0 };
    const toM = (v) => (meta.minZ + ((v - 1) * (meta.maxZ - meta.minZ)) / 65534) / 100;
    function node(l, x, y) {
      const k = l + '/' + x + '/' + y; let n = T.nodes.get(k);
      if (!n) {
        const span = PQ << l, s = meta.spacing / 100;
        n = { l, x, y, k, state: 'new', mesh: null, used: 0, x0: env.ox + x * span * s, z0: env.oy + y * span * s, size: span * s,
          minH: meta.minZ / 100, maxH: meta.maxZ / 100, inside: x * span < meta.width - 1 && y * span < meta.height - 1 };
        T.nodes.set(k, n);
      }
      return n;
    }
    const kids = (n) => { const o = []; for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) { const c = node(n.l - 1, n.x * 2 + i, n.y * 2 + j); if (c.inside) o.push(c); } return o; };
    const request = (n) => { if (n.state === 'new') { n.state = 'queued'; T.queue.add(n); } };
    function build(n, t) {
      const M = N + 2, step = n.size / PQ, hgt = new Float32Array(N * N);
      let minH = 1e9, maxH = -1e9, any = false;
      for (let i = 0; i < N * N; i++) { if (!t.hg[i]) continue; const h = toM(t.hg[i]); hgt[i] = h; any = true; if (h < minH) minH = h; if (h > maxH) maxH = h; }
      if (!any) { n.state = 'empty'; return; }
      for (let i = 0; i < N * N; i++) if (!t.hg[i]) hgt[i] = minH;
      n.minH = minH; n.maxH = maxH;
      const pos = new Float32Array(M * M * 3), nor = new Float32Array(M * M * 3), valid = new Float32Array(M * M), mat = new Float32Array(M * M), skirt = Math.max(2, n.size * 0.01);
      const H = (i, j) => hgt[Math.min(N - 1, Math.max(0, j)) * N + Math.min(N - 1, Math.max(0, i))];
      for (let j = 0; j < M; j++) for (let i = 0; i < M; i++) {
        const ci = Math.min(N - 1, Math.max(0, i - 1)), cj = Math.min(N - 1, Math.max(0, j - 1)), edge = i === 0 || j === 0 || i === M - 1 || j === M - 1, v = j * M + i;
        pos[3 * v] = ci * step; pos[3 * v + 1] = H(ci, cj) - (edge ? skirt : 0); pos[3 * v + 2] = cj * step;
        const dx = (H(ci + 1, cj) - H(ci - 1, cj)) / (2 * step), dz = (H(ci, cj + 1) - H(ci, cj - 1)) / (2 * step), l = Math.hypot(dx, 1, dz);
        nor[3 * v] = -dx / l; nor[3 * v + 1] = 1 / l; nor[3 * v + 2] = -dz / l;
        valid[v] = t.hg[cj * N + ci] ? 1 : 0; mat[v] = t.mt[cj * N + ci];
      }
      const ix = new Uint32Array((M - 1) * (M - 1) * 6); let p = 0;
      for (let j = 0; j < M - 1; j++) for (let i = 0; i < M - 1; i++) { const a = j * M + i, b = a + 1, c = a + M, d = c + 1; ix[p++] = a; ix[p++] = c; ix[p++] = b; ix[p++] = b; ix[p++] = c; ix[p++] = d; }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
      g.setAttribute('valid', new THREE.BufferAttribute(valid, 1)); g.setAttribute('mat', new THREE.BufferAttribute(mat, 1));
      g.setIndex(new THREE.BufferAttribute(ix, 1));
      const mesh = new THREE.Mesh(g, env.material(n.l)); mesh.position.set(n.x0, 0, n.z0);
      mesh.matrixAutoUpdate = false; mesh.updateMatrix(); mesh.visible = false; mesh.frustumCulled = false;
      n.mesh = mesh; n.state = 'ready'; env.group.add(mesh); T.loaded++;
    }
    function dispose(n) { if (n.mesh) { env.group.remove(n.mesh); n.mesh.geometry.dispose(); n.mesh = null; T.loaded--; } n.state = 'new'; }
    const nodeBox = (n) => { T.box.min.set(n.x0, n.minH, n.z0); T.box.max.set(n.x0 + n.size, n.maxH, n.z0 + n.size); return T.box; };
    function select(n) {
      n.used = T.frame;
      if (n.state === 'empty' || !T.fr.intersectsBox(nodeBox(n))) return;
      const d = T.box.distanceToPoint(env.cam.position);
      if (n.l > 0 && d < T.detail * n.size) {
        const cs = kids(n); let ready = true;
        for (const c of cs) { c.used = T.frame; if (c.state !== 'ready' && c.state !== 'empty') { request(c); ready = false; } }
        if (ready) { for (const c of cs) select(c); return; }
      }
      if (n.state === 'ready') T.drawn.push(n); else request(n);
    }
    function pump() {
      if (T.inflight >= 8 || !T.queue.size) return;
      const q = [...T.queue].filter((n) => n.state === 'queued')
        .sort((a, b) => b.l - a.l || nodeBox(a).distanceToPoint(env.cam.position) - nodeBox(b).distanceToPoint(env.cam.position));
      for (const n of q) {
        if (T.inflight >= 8) break;
        T.queue.delete(n); n.state = 'loading'; T.inflight++;
        loadTile(n, idx, N).then((t) => { if (T.dead) return; if (!t) n.state = 'empty'; else build(n, t); })
          .catch(() => { n.state = 'new'; T.errors++; }).finally(() => { T.inflight--; });
      }
    }
    T.update = function () {
      if (T.dead) return;
      T.frame++; env.cam.updateMatrixWorld();
      T.m.multiplyMatrices(env.cam.projectionMatrix, env.cam.matrixWorldInverse); T.fr.setFromProjectionMatrix(T.m);
      for (const n of T.drawn) n.mesh.visible = false; T.drawn = [];
      select(node(MAXL, 0, 0));
      for (const n of T.drawn) n.mesh.visible = true;
      pump();
      if (T.loaded > 1600) {
        const old = [...T.nodes.values()].filter((n) => n.state === 'ready' && n.used < T.frame - 60 && n.l < MAXL).sort((a, b) => a.used - b.used);
        for (const n of old.slice(0, T.loaded - 1200)) dispose(n);
      }
    };
    T.info = function () {
      const minL = T.drawn.reduce((a, n) => Math.min(a, n.l), 99);
      return `Kacheln: ${T.drawn.length} sichtbar · ${T.loaded} geladen · ${T.inflight} in Arbeit` + (minL === 99 ? '' : ` · feinste Stufe ${minL} (${(meta.spacing / 100) * (1 << minL)} m)`);
    };
    T.dispose = function () { T.dead = true; for (const n of T.nodes.values()) dispose(n); T.nodes.clear(); const i = env.cb.indexOf(T.update); if (i >= 0) env.cb.splice(i, 1); };
    env.onFrame(T.update);
    return T;
  };

  // Kachel aus dem Rohinhalt (Format 1: Höhen zeilenweise delta-codiert, Lo-/Hi-Byte-Ebene, dann Material).
  MV.decodeTile = function (raw, N) {
    if (raw.length !== 3 * N * N) throw new Error('Kachelgröße');
    const hg = new Uint16Array(N * N);
    for (let j = 0; j < N; j++) { let v = 0; for (let i = 0; i < N; i++) { v = (v + (raw[j * N + i] | (raw[N * N + j * N + i] << 8))) & 0xffff; hg[j * N + i] = v; } }
    return { hg, mt: raw.subarray(2 * N * N) };
  };

  // ---------------------------------------------------------------- Marker
  MV.Points = function (env, color, size) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3));
    const obj = new THREE.Points(g, new THREE.PointsMaterial({ color, size, sizeAttenuation: false }));
    obj.frustumCulled = false; env.sc.add(obj);
    return {
      obj,
      // arr: [{x,y,z}] in Metern (x/y Weltkoordinaten, z Höhe)
      set(arr) {
        let a = obj.geometry.getAttribute('position');
        if (a.count < arr.length) { // nur bei Wachstum neu anlegen, sonst Puffer weiterverwenden
          obj.geometry.dispose(); obj.geometry = new THREE.BufferGeometry();
          a = new THREE.BufferAttribute(new Float32Array(Math.ceil(arr.length * 1.5 + 16) * 3), 3); obj.geometry.setAttribute('position', a);
        }
        const p = a.array;
        for (let i = 0; i < arr.length; i++) { p[i * 3] = arr[i].x; p[i * 3 + 1] = arr[i].z + 6; p[i * 3 + 2] = arr[i].y; }
        a.needsUpdate = true; obj.geometry.setDrawRange(0, arr.length); this.count = arr.length;
      },
      count: 0,
    };
  };

  // Hilfen
  MV.el = function (tag, props, text) {
    const e = document.createElement(tag);
    if (props) for (const k in props) e.setAttribute(k, props[k]);
    if (text != null) e.textContent = String(text);
    return e;
  };
  MV.cm2m = (v) => Math.round(Number(v) / 100);
})();

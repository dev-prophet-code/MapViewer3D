// Gelände als Quadtree aus 128×128-Quad-Stücken. Grobe Ebenen laden zuerst,
// feinere ersetzen sie, sobald alle vier Kinder bereit sind. Schürzen am Rand
// verdecken Risse zwischen unterschiedlichen Detailstufen.
import * as THREE from 'three';
import { api } from './api.js';
import { SKY } from './scene.js';

const VERTEX = /* glsl */`
  #include <common>
  #include <logdepthbuf_pars_vertex>
  attribute float valid;
  attribute float mat;
  uniform float uExag;
  varying vec3 vWorld;
  varying vec3 vNormal;
  varying float vH, vValid, vMat, vDist;
  void main() {
    vH = position.y;
    vValid = valid;
    vMat = mat;
    vec3 n = normal; n.y /= uExag;           // Normale an die Überhöhung anpassen
    vNormal = normalize(n);
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz;
    vec4 mv = viewMatrix * wp;
    vDist = -mv.z;
    gl_Position = projectionMatrix * mv;
    #include <logdepthbuf_vertex>
  }`;

const FRAGMENT = /* glsl */`
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform vec3 uSun, uLodTint, uFogColor, uTone;
  uniform float uMinH, uMaxH, uContours, uGrid, uFogDensity, uRock, uDetail, uMapOn, uMapFlip;
  uniform sampler2D uMapImg;
  uniform vec4 uMapBounds; // minX, maxX, minZ, maxZ (m)
  uniform vec4 uCells;     // Kartenraster: minX, minZ, Zellkante (m), an
  varying vec3 vWorld;
  varying vec3 vNormal;
  varying float vH, vValid, vMat, vDist;

  // --- prozedurale Oberflächen (ersetzen die im Serverbuild fehlenden Texturen) ---
  float hash2(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash2(i), hash2(i + vec2(1, 0)), u.x), mix(hash2(i + vec2(0, 1)), hash2(i + vec2(1, 1)), u.x), u.y);
  }
  float fbm(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 5; i++) { v += a * vnoise(p); p = p * 2.03 + 17.1; a *= 0.5; }
    return v;
  }
  // Dreiseitige Projektion für steile Felsflächen
  float triFbm(vec3 p, vec3 n, float s) {
    vec3 w = pow(abs(n), vec3(4.0)); w /= (w.x + w.y + w.z);
    return fbm(p.zy * s) * w.x + fbm(p.xz * s) * w.y + fbm(p.xy * s) * w.z;
  }

  float line(float v, float w) {                 // weiche Linie bei ganzzahligem v
    float d = abs(fract(v - 0.5) - 0.5) / fwidth(v);
    return 1.0 - clamp(d / w, 0.0, 1.0);
  }
  void main() {
    #include <logdepthbuf_fragment>
    if (vValid < 0.5) discard;
    vec3 n = normalize(vNormal);
    vec2 w = vWorld.xz;
    float t = clamp((vH - uMinH) / max(uMaxH - uMinH, 1.0), 0.0, 1.0);
    float slope = 1.0 - n.y;
    float isRock = uRock * smoothstep(2.5, 2.9, vMat);   // Material 3 = Fels/Bauwerk
    float rocky = max(isRock, smoothstep(0.3, 0.65, slope));
    float near = uDetail * (1.0 - smoothstep(80.0, 900.0, vDist));

    // Sand: großflächige Farbfelder, Windriffel, Körnung
    float big = fbm(w * 0.0025);
    vec3 sandLow = vec3(0.70, 0.49, 0.29), sandHigh = vec3(0.93, 0.76, 0.52);
    vec3 sand = mix(sandLow, sandHigh, clamp(t * 0.7 + big * 0.6 - 0.15, 0.0, 1.0));
    sand *= 0.93 + 0.14 * fbm(w * 0.03);
    vec2 wind = normalize(vec2(0.82, 0.57));
    float phase = dot(w, wind) * 2.2 + fbm(w * 0.04) * 9.0 + vnoise(w * 0.4) * 1.5;
    float ripple = sin(phase);
    float flat_ = 1.0 - smoothstep(0.05, 0.3, slope);
    n = normalize(n + vec3(wind.x, 0.0, wind.y) * cos(phase) * 0.22 * near * flat_ * (1.0 - rocky));
    sand *= 1.0 + 0.05 * ripple * near * flat_;
    sand *= 0.96 + 0.08 * vnoise(w * 3.0) * near;

    // Fels: Gesteinsschichten und Struktur, dunklere Rinnen
    float rn = triFbm(vWorld * vec3(1.0, 1.0, 1.0), n, 0.08);
    float strata = sin(vH * 0.55 + rn * 6.0 + fbm(w * 0.01) * 8.0);
    vec3 stone = mix(vec3(0.43, 0.33, 0.27), vec3(0.70, 0.58, 0.47), clamp(0.35 + 0.5 * t + 0.35 * big, 0.0, 1.0));
    stone *= 0.72 + 0.45 * rn;
    stone *= 0.93 + 0.07 * strata;
    stone = mix(stone, stone * vec3(0.9, 0.82, 0.76), smoothstep(0.6, 0.95, slope));

    vec3 col = mix(sand, stone, rocky);

    // Kartenbild der Console als Farbgrundlage; aus der Nähe prägen die
    // prozeduralen Details (Riffel, Körnung, Gestein) die Helligkeit mit.
    float wImg = 0.0;
    if (uMapOn > 0.5) {
      vec2 uv = vec2((vWorld.x - uMapBounds.x) / (uMapBounds.y - uMapBounds.x),
                     (vWorld.z - uMapBounds.z) / (uMapBounds.w - uMapBounds.z));
      if (uMapFlip > 0.5) uv.y = 1.0 - uv.y;
      if (uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0) {
        vec3 img = texture2D(uMapImg, uv).rgb;
        float detail = dot(col, vec3(0.3, 0.5, 0.2)) / 0.42;
        wImg = mix(0.7, 0.92, smoothstep(60.0, 900.0, vDist));
        col = mix(col, img * mix(1.0, detail, near * 0.8), wImg);
      }
    }
    col *= uLodTint;

    // Licht: Sonne, Himmel, warmes Streulicht vom Sand. Das Kartenbild ist schon
    // schattiert, darum wird dort weniger stark nachbeleuchtet.
    vec3 L = normalize(uSun);
    float diff = max(dot(n, L), 0.0);
    float sky = 0.5 + 0.5 * n.y;
    vec3 light = vec3(1.0, 0.95, 0.86) * 1.15 * diff + vec3(0.42, 0.47, 0.56) * 0.45 * sky + vec3(0.30, 0.20, 0.12) * 0.25 * (1.0 - sky);
    light = mix(light, vec3(0.78) + 0.35 * diff, 0.55 * wImg);
    vec3 lit = col * light;

    if (uContours > 0.5) {
      float c = line(vH / 10.0, 1.0);
      float c50 = line(vH / 50.0, 1.4);
      lit = mix(lit, vec3(0.25, 0.15, 0.08), max(c * 0.45, c50 * 0.75));
    }
    if (uGrid > 0.5) {
      float g = max(line(vWorld.x / 1000.0, 1.2), line(vWorld.z / 1000.0, 1.2));
      lit = mix(lit, vec3(0.1, 0.3, 0.5), g * 0.6);
    }
    if (uCells.w > 0.5) {
      vec2 c = (vWorld.xz - uCells.xy) / uCells.z;
      if (c.x > -0.01 && c.y > -0.01 && c.x < 9.01 && c.y < 9.01) {
        float g = max(line(c.x, 2.2), line(c.y, 2.2));
        lit = mix(lit, vec3(1.0, 0.86, 0.45), g * 0.85);
      }
    }
    lit *= uTone; // Tag/Nacht
    float fog = 1.0 - exp(-pow(vDist * uFogDensity, 2.0));
    gl_FragColor = vec4(mix(lit, uFogColor, fog), 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

const LOD_TINTS = [0xffffff, 0xffb0b0, 0xb0ffb0, 0xb0b0ff, 0xffffa0, 0xffa0ff, 0xa0ffff, 0xffd090];
const MAX_INFLIGHT = 8;
const MAX_LOADED = 1600;

export class Terrain {
  constructor(parent) {
    this.group = new THREE.Group();
    parent.add(this.group);
    this.uniforms = {
      uSun: { value: new THREE.Vector3(0, 1, 0) },
      uExag: { value: 1 },
      uMinH: { value: 0 },
      uMaxH: { value: 1 },
      uContours: { value: 0 },
      uGrid: { value: 0 },
      uRock: { value: 1 },
      uLodTint: { value: new THREE.Color(1, 1, 1) },
      uFogColor: { value: SKY },
      uTone: { value: new THREE.Color(1, 1, 1) },
      uFogDensity: { value: 0.00004 },
      uDetail: { value: 1 },
      uMapOn: { value: 0 },
      uMapFlip: { value: 0 },
      uMapImg: { value: null },
      uMapBounds: { value: new THREE.Vector4(0, 1, 0, 1) },
      uCells: { value: new THREE.Vector4(0, 0, 1, 0) },
    };
    this.materials = [];
    this.wireframe = false;
    this.lodColors = false;
    this.detail = 3;
    this.meta = null;
    this.nodes = new Map();
    this.queue = new Set();
    this.inflight = 0;
    this.loaded = 0;
    this.drawn = [];
    this.frame = 0;
    this._frustum = new THREE.Frustum();
    this._box = new THREE.Box3();
    this._m = new THREE.Matrix4();
  }

  // ---- Einstellungen ----
  set exaggeration(e) { this.uniforms.uExag.value = e; }
  get exaggeration() { return this.uniforms.uExag.value; }
  setWireframe(on) { this.wireframe = on; for (const m of this.materials) if (m) m.wireframe = on; }
  setLodColors(on) {
    this.lodColors = on;
    for (const m of this.materials) if (m) m.uniforms.uLodTint.value.copy(on ? m.userData.tint : new THREE.Color(1, 1, 1));
  }

  materialFor(level) {
    if (!this.materials[level]) {
      const u = { ...this.uniforms, uLodTint: { value: new THREE.Color(1, 1, 1) } };
      const m = new THREE.ShaderMaterial({ uniforms: u, vertexShader: VERTEX, fragmentShader: FRAGMENT });
      m.userData.tint = new THREE.Color(LOD_TINTS[level % LOD_TINTS.length]);
      m.wireframe = this.wireframe;
      if (this.lodColors) u.uLodTint.value.copy(m.userData.tint);
      this.materials[level] = m;
    }
    return this.materials[level];
  }

  // ---- Karte ----
  setMap(meta) {
    for (const n of this.nodes.values()) if (n.mesh) this.dispose(n);
    this.nodes.clear();
    this.queue.clear();
    this.drawn = [];
    this.loaded = 0;
    this.meta = meta;
    this.uniforms.uMinH.value = meta.minZ / 100;
    this.uniforms.uMaxH.value = meta.maxZ / 100;
    this.uniforms.uFogDensity.value = 0.35 / this.extent;
    this.loadMapImage(meta);
  }

  // Kartenbild der Console (Welt-Ausdehnung in cm) auf das Gelände legen
  async loadMapImage(meta) {
    this.uniforms.uMapOn.value = 0;
    if (!meta.live) return;
    try {
      const r = await fetch(api.mapImageUrl(meta.name));
      if (!r.ok || this.meta !== meta) return;
      const [minX, maxX, minY, maxY, flip] = (r.headers.get('X-Map-Bounds') ?? '').split(',');
      const bitmap = await createImageBitmap(await r.blob());
      if (this.meta !== meta) return;
      const tex = new THREE.Texture(bitmap);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.flipY = false;
      tex.anisotropy = 8;
      tex.needsUpdate = true;
      this.uniforms.uMapImg.value?.dispose();
      this.uniforms.uMapImg.value = tex;
      this.uniforms.uMapBounds.value.set(minX / 100, maxX / 100, minY / 100, maxY / 100);
      this.uniforms.uMapFlip.value = flip === 'true' ? 1 : 0;
      this.uniforms.uMapOn.value = 1;
    } catch (e) {
      console.warn('Kartenbild', e);
    }
  }

  get extent() { return (this.meta.width - 1) * this.meta.spacing / 100; }
  get origin() { return [this.meta.originX / 100, this.meta.originY / 100]; }

  toMeters(v) {
    const m = this.meta;
    return (m.minZ + (v - 1) * (m.maxZ - m.minZ) / 65534) / 100;
  }

  node(l, x, y) {
    const k = `${l}/${x}/${y}`;
    let n = this.nodes.get(k);
    if (!n) {
      const m = this.meta;
      const span = m.patchQuads << l;
      const s = m.spacing / 100;
      n = {
        l, x, y, k, state: 'new', mesh: null, used: 0, heights: null,
        x0: m.originX / 100 + x * span * s,
        z0: m.originY / 100 + y * span * s,
        size: span * s,
        minH: m.minZ / 100, maxH: m.maxZ / 100,
        inside: x * span < m.width - 1 && y * span < m.height - 1,
      };
      this.nodes.set(k, n);
    }
    return n;
  }

  children(n) {
    const out = [];
    for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
      const c = this.node(n.l - 1, n.x * 2 + i, n.y * 2 + j);
      if (c.inside) out.push(c);
    }
    return out;
  }

  // ---- Laden ----
  request(n) {
    if (n.state === 'new') { n.state = 'queued'; this.queue.add(n); }
  }

  pump(camera) {
    if (this.inflight >= MAX_INFLIGHT || this.queue.size === 0) return;
    const dist = (n) => this.nodeBox(n).distanceToPoint(camera.position);
    const list = [...this.queue].sort((a, b) => (b.l - a.l) || (dist(a) - dist(b)));
    for (const n of list) {
      if (this.inflight >= MAX_INFLIGHT) break;
      this.queue.delete(n);
      if (n.used < this.frame - 2) { n.state = 'new'; continue; } // nicht mehr gebraucht
      n.state = 'loading';
      this.inflight++;
      const meta = this.meta;
      fetch(api.patchUrl(meta.name, n.l, n.x, n.y, meta.version))
        .then((r) => r.arrayBuffer())
        .then((buf) => { if (this.meta === meta) this.build(n, buf); })
        .catch((e) => { console.error('Geländestück', n.k, e); n.state = 'new'; })
        .finally(() => { this.inflight--; });
    }
  }

  build(n, buf) {
    const N = this.meta.patchQuads + 1;
    const data = new Uint16Array(buf, 0, N * N);
    const mats = new Uint8Array(buf, 2 * N * N, N * N);
    const M = N + 2; // mit Schürzenring
    const step = n.size / this.meta.patchQuads;
    const hgt = new Float32Array(N * N);
    let minH = Infinity, maxH = -Infinity, any = false;
    for (let i = 0; i < N * N; i++) {
      if (!data[i]) continue;
      const h = this.toMeters(data[i]);
      hgt[i] = h; any = true;
      if (h < minH) minH = h;
      if (h > maxH) maxH = h;
    }
    if (!any) { n.state = 'empty'; return; }
    for (let i = 0; i < N * N; i++) if (!data[i]) hgt[i] = minH;
    n.minH = minH; n.maxH = maxH;

    const pos = new Float32Array(M * M * 3);
    const nor = new Float32Array(M * M * 3);
    const valid = new Float32Array(M * M);
    const mat = new Float32Array(M * M);
    const skirt = Math.max(2, n.size * 0.01);
    const H = (i, j) => hgt[Math.min(N - 1, Math.max(0, j)) * N + Math.min(N - 1, Math.max(0, i))];
    for (let j = 0; j < M; j++) {
      for (let i = 0; i < M; i++) {
        const ci = Math.min(N - 1, Math.max(0, i - 1));
        const cj = Math.min(N - 1, Math.max(0, j - 1));
        const edge = i === 0 || j === 0 || i === M - 1 || j === M - 1;
        const v = j * M + i;
        pos[3 * v] = ci * step;
        pos[3 * v + 1] = H(ci, cj) - (edge ? skirt : 0);
        pos[3 * v + 2] = cj * step;
        const dx = (H(ci + 1, cj) - H(ci - 1, cj)) / (2 * step);
        const dz = (H(ci, cj + 1) - H(ci, cj - 1)) / (2 * step);
        const l = Math.hypot(dx, 1, dz);
        nor[3 * v] = -dx / l; nor[3 * v + 1] = 1 / l; nor[3 * v + 2] = -dz / l;
        valid[v] = data[cj * N + ci] ? 1 : 0;
        mat[v] = mats[cj * N + ci];
      }
    }
    const idx = new Uint32Array((M - 1) * (M - 1) * 6);
    let p = 0;
    for (let j = 0; j < M - 1; j++) for (let i = 0; i < M - 1; i++) {
      const a = j * M + i, b = a + 1, c = a + M, d = c + 1;
      idx[p++] = a; idx[p++] = c; idx[p++] = b;
      idx[p++] = b; idx[p++] = c; idx[p++] = d;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setAttribute('valid', new THREE.BufferAttribute(valid, 1));
    g.setAttribute('mat', new THREE.BufferAttribute(mat, 1));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeBoundingSphere();
    const mesh = new THREE.Mesh(g, this.materialFor(n.l));
    mesh.position.set(n.x0, 0, n.z0);
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.visible = false;
    mesh.userData.node = n;
    n.mesh = mesh;
    n.heights = hgt;
    n.state = 'ready';
    this.group.add(mesh);
    this.loaded++;
  }

  dispose(n) {
    if (n.mesh) {
      this.group.remove(n.mesh);
      n.mesh.geometry.dispose();
      n.mesh = null;
      this.loaded--;
    }
    n.heights = null;
    n.state = 'new';
  }

  // ---- Detailauswahl je Frame ----
  nodeBox(n) {
    const e = this.exaggeration;
    this._box.min.set(n.x0, n.minH * e, n.z0);
    this._box.max.set(n.x0 + n.size, n.maxH * e, n.z0 + n.size);
    return this._box;
  }

  select(n, camera) {
    n.used = this.frame;
    if (n.state === 'empty' || !this._frustum.intersectsBox(this.nodeBox(n))) return;
    const d = this._box.distanceToPoint(camera.position);
    if (n.l > 0 && d < this.detail * n.size) {
      const cs = this.children(n);
      let ready = true;
      for (const c of cs) {
        c.used = this.frame;
        if (c.state !== 'ready' && c.state !== 'empty') { this.request(c); ready = false; }
      }
      if (ready) { for (const c of cs) this.select(c, camera); return; }
    }
    if (n.state === 'ready') this.drawn.push(n); else this.request(n);
  }

  update(camera) {
    if (!this.meta) return;
    this.frame++;
    camera.updateMatrixWorld();
    this._m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this._frustum.setFromProjectionMatrix(this._m);
    for (const n of this.drawn) n.mesh.visible = false;
    this.drawn = [];
    this.select(this.node(this.meta.maxLevel, 0, 0), camera);
    for (const n of this.drawn) n.mesh.visible = true;
    this.pump(camera);
    if (this.loaded > MAX_LOADED) {
      const old = [...this.nodes.values()]
        .filter((n) => n.state === 'ready' && n.used < this.frame - 60 && n.l < this.meta.maxLevel)
        .sort((a, b) => a.used - b.used);
      for (const n of old.slice(0, this.loaded - MAX_LOADED * 0.75)) this.dispose(n);
    }
  }

  // Höhe (m, ohne Überhöhung) am Punkt x/z aus dem feinsten geladenen Stück.
  heightAt(x, z) {
    if (!this.meta) return null;
    let n = this.node(this.meta.maxLevel, 0, 0);
    let best = null;
    for (;;) {
      if (n.state === 'ready') best = n;
      if (n.l === 0) break;
      const half = n.size / 2;
      const i = x >= n.x0 + half ? 1 : 0, j = z >= n.z0 + half ? 1 : 0;
      const c = this.nodes.get(`${n.l - 1}/${n.x * 2 + i}/${n.y * 2 + j}`);
      if (!c) break;
      n = c;
    }
    if (!best) return null;
    const N = this.meta.patchQuads + 1;
    const step = best.size / this.meta.patchQuads;
    const fx = Math.min(N - 1.001, Math.max(0, (x - best.x0) / step));
    const fz = Math.min(N - 1.001, Math.max(0, (z - best.z0) / step));
    const i = Math.floor(fx), j = Math.floor(fz), u = fx - i, v = fz - j;
    const h = best.heights;
    const a = h[j * N + i], b = h[j * N + i + 1], c = h[(j + 1) * N + i], d = h[(j + 1) * N + i + 1];
    return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
  }

  // Schnittpunkt eines Strahls mit dem sichtbaren Gelände (Weltkoordinaten) oder null.
  raycast(raycaster) {
    const hits = raycaster.intersectObjects(this.drawn.map((n) => n.mesh), false);
    return hits.length ? hits[0].point : null;
  }
}

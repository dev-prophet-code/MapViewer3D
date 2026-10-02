// 3D-Modelle für Sandsturm und Coriolis-Sturm (Maße in Metern, 1 Einheit = 1 m).
//
// Die Form folgt den Datenassets des Spiels (Content/Dune/Systems/SandStorm/DataAssets):
// ein Sturm besteht aus ineinanderliegenden Ellipsen – Böenfront, Sturmwand, Kern –
// mit Breite, Länge und Höhe je Zone. Für Stufe 3 gelten die Skalen (0,6 | 1 | 0,4)
// aus Level3_Settings. Die Ellipsen liegen mit ihrer Länge in Fahrtrichtung (+Z des
// Modells); der Viewer dreht das Modell mit der Weltrotation des Sturm-Actors.
// Die Darstellung ist ein Abbild dieser Maße, kein Abguss des Spiel-Shaders.
import * as THREE from 'three';
import { dotTexture } from './models.js';

// Grundmaße der Zonen (Meter, aus den Datenassets): Breite × Länge × Höhe
const BASE = { gust: [10000, 12000, 1200], wall: [8300, 7000, 500], core: [7000, 7000, 900] };

// Skalierung je Karte (X = Breite, Y = Länge, Z = Höhe). Das Spiel skaliert die Zonen je
// Sturmstufe (Level3_Settings: 0,6 | 1 | 0,4). Auf der Tiefen Wüste ist der Randabstand der Stürme
// 6000 m, genau die halbe Länge einer Stufe-3-Böenfront (12 000 m); in der Hagga-Becken-Karte
// liegen Start und Ziel der Route 3000 m außerhalb des Randes, daher die halbe Länge 3000 m.
// Abgeleitet, nicht live gemessen: sobald ein Sturm beobachtet wird, hier nachziehen.
export const STORM_SCALE = {
  deepdesert: { x: 0.6, y: 1, z: 0.4 },
  survival: { x: 0.4, y: 0.5, z: 0.4 },
};
export const scaleForMap = (map = '') => (/deep/i.test(map) ? STORM_SCALE.deepdesert : STORM_SCALE.survival);
// Aus der Ferne wirkt ein 500-m-Sturm über 6 × 12 km Grundfläche flach; die Höhe wird zur
// besseren Lesbarkeit überhöht (rein optisch, die Grundfläche bleibt maßstäblich).
const HEIGHT_BOOST = 2.5;
export function stormZones(scale) {
  const z = {};
  for (const [k, [w, l, h]] of Object.entries(BASE)) {
    z[k] = { width: w * scale.x, length: l * scale.y, height: h * scale.z * HEIGHT_BOOST };
  }
  return z;
}

const VERT = `
  varying vec2 vUv;
  varying vec3 vPos;
  void main() {
    vUv = uv;
    vPos = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;

// Wirbelnder Sandschleier: mehrstufiges Rauschen, das mit der Zeit nach oben und um den Sturm zieht.
const FRAG = `
  uniform float uTime;
  uniform vec3 uColor;
  uniform float uOpacity;
  uniform float uScroll;
  varying vec2 vUv;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
  }
  float fbm(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int k = 0; k < 4; k++) { v += a * noise(p); p *= 2.07; a *= 0.5; }
    return v;
  }
  void main() {
    vec2 p = vec2(vUv.x * 14.0 + uTime * uScroll, vUv.y * 3.0 - uTime * 0.18);
    float n = fbm(p) * 0.8 + fbm(p * 2.3 + 7.0 + uTime * 0.05) * 0.4;
    float vert = smoothstep(0.0, 0.12, vUv.y) * (1.0 - smoothstep(0.62, 1.0, vUv.y));
    float a = uOpacity * vert * (0.28 + 0.9 * n);
    gl_FragColor = vec4(uColor * (0.8 + 0.35 * n), clamp(a, 0.0, 1.0));
  }`;

const FLOOR_FRAG = `
  uniform float uTime;
  uniform vec3 uColor;
  uniform float uOpacity;
  varying vec2 vUv;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
  }
  void main() {
    vec2 c = vUv - 0.5;
    float r = length(c) * 2.0;
    float ang = atan(c.y, c.x);
    float n = noise(vec2(ang * 3.0 + uTime * 0.35, r * 6.0 - uTime * 0.6));
    float a = uOpacity * (1.0 - smoothstep(0.55, 1.0, r)) * (0.45 + 0.7 * n);
    gl_FragColor = vec4(uColor, a);
  }`;

function shaderMat(color, opacity, scroll = 0.05) {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Color(color) }, uOpacity: { value: opacity }, uScroll: { value: scroll } },
    vertexShader: VERT, fragmentShader: FRAG,
  });
}

// Ellipsenwand (offener Zylinder) mit Halbachsen a (X, Breite) und b (Z, Länge)
function wall(zone, color, opacity, scroll) {
  const g = new THREE.CylinderGeometry(1, 1, 1, 96, 1, true).translate(0, 0.5, 0);
  const m = new THREE.Mesh(g, shaderMat(color, opacity, scroll));
  m.scale.set(zone.width / 2, zone.height, zone.length / 2);
  m.renderOrder = 4;
  return m;
}

function floor(zone, color, opacity) {
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
    new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Color(color) }, uOpacity: { value: opacity } },
      vertexShader: VERT, fragmentShader: FLOOR_FRAG,
    }),
  );
  m.scale.set(zone.width, 1, zone.length);
  m.position.y = 2;
  m.renderOrder = 3;
  return m;
}

// Fahrtrichtungs-Pfeil am vorderen Rand (liegt flach auf dem Boden)
function chevron(zone, color) {
  const w = zone.width * 0.12, l = zone.length * 0.09;
  const shape = new THREE.Shape();
  shape.moveTo(0, l); shape.lineTo(w, -l * 0.2); shape.lineTo(w * 0.45, -l * 0.2); shape.lineTo(0, l * 0.45);
  shape.lineTo(-w * 0.45, -l * 0.2); shape.lineTo(-w, -l * 0.2); shape.closePath();
  const m = new THREE.Mesh(
    new THREE.ShapeGeometry(shape).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8, depthWrite: false, side: THREE.DoubleSide }),
  );
  m.position.set(0, 6, zone.length / 2 + l * 0.6);
  m.renderOrder = 5;
  return m;
}

// Sandkörner, die im Sturm kreisen
function grains(zone, count) {
  const pos = new Float32Array(count * 3);
  const seed = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random());
    seed.set([a, r, Math.random()], i * 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.PointsMaterial({
    color: 0xe8c98a, size: 3 * Math.min(devicePixelRatio, 2), sizeAttenuation: false, map: dotTexture(),
    alphaTest: 0.2, transparent: true, opacity: 0.55, depthWrite: false,
  });
  const pts = new THREE.Points(g, mat);
  pts.frustumCulled = false;
  pts.renderOrder = 6;
  let t = 0;
  const update = (dt) => {
    t += dt;
    for (let i = 0; i < count; i++) {
      const a = seed[i * 3] + t * (0.12 + seed[i * 3 + 2] * 0.1), r = seed[i * 3 + 1];
      pos[i * 3] = Math.cos(a) * r * zone.width * 0.5;
      pos[i * 3 + 1] = ((seed[i * 3 + 2] + t * 0.05) % 1) * zone.height;
      pos[i * 3 + 2] = Math.sin(a) * r * zone.length * 0.5;
    }
    g.attributes.position.needsUpdate = true;
  };
  update(0);
  return { pts, update };
}

function animate(group, materials, extra = []) {
  let time = 0;
  group.userData.tick = (dt) => {
    time += dt;
    for (const m of materials) m.uniforms.uTime.value = time;
    for (const fn of extra) fn(dt);
  };
}

// Sandsturm: Böenfront, Sturmwand, Kern, Boden-Schleier, Pfeil, Körner (Größe je Karte, siehe STORM_SCALE)
export function stormModel(map) {
  const STORM_ZONES = stormZones(scaleForMap(map));
  const g = new THREE.Group();
  const gust = wall(STORM_ZONES.gust, 0xdcbd84, 0.55, 0.03);
  const outer = wall(STORM_ZONES.wall, 0xb98b4b, 0.8, 0.06);
  const core = wall(STORM_ZONES.core, 0x8d6330, 0.75, 0.09);
  const ground = floor(STORM_ZONES.gust, 0xd9b77a, 0.35);
  const arrow = chevron(STORM_ZONES.gust, 0xffd08a);
  const dust = grains(STORM_ZONES.gust, 320);
  g.add(ground, gust, outer, core, arrow, dust.pts);
  g.userData.height = STORM_ZONES.gust.height;
  animate(g, [gust.material, outer.material, core.material, ground.material], [dust.update]);
  return g;
}

// Coriolis-Sturm: kartenweiter Wirbel (dunkler, höher), nur grob als Ring gezeichnet,
// weil das Spiel dafür keine feste Ellipse vorgibt.
export function coriolisModel() {
  const zone = { width: 40000, length: 40000, height: 3000 };
  const g = new THREE.Group();
  const w = wall(zone, 0xa0472a, 0.5, 0.02);
  const ground = floor(zone, 0xa0472a, 0.25);
  g.add(ground, w);
  g.userData.height = zone.height;
  animate(g, [w.material, ground.material]);
  return g;
}

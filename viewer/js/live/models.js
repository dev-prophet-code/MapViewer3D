// Einfache 3D-Modelle für Live-Objekte (Maße in Metern) und Namensschilder.
// Fahrzeuge und Spielfiguren stehen im Serverbuild nicht als Geometrie zur
// Verfügung, daher sind sie hier aus Grundformen nachgebaut.
import * as THREE from 'three';

const mat = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.3, ...extra });

export const PLAYER_ONLINE = 0xff9d2e;
export const PLAYER_OFFLINE = 0x8a8a8a;

// Spielfigur: Körper, Kopf und eine senkrechte Leuchtsäule, damit sie auch aus
// großer Entfernung auffindbar ist.
export function playerModel(online) {
  const color = online ? PLAYER_ONLINE : PLAYER_OFFLINE;
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.3, 1.0, 4, 10), mat(color, { emissive: color, emissiveIntensity: 0.25 }));
  body.position.y = 0.8;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.2, 12, 10), mat(0xe8c9a8));
  head.position.y = 1.62;
  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(0.25, 0.25, 80, 6, 1, true),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: online ? 0.35 : 0.15, depthWrite: false }),
  );
  beam.position.y = 42;
  g.add(body, head, beam);
  return g;
}

function box(w, h, l, color, y = h / 2) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, l), mat(color));
  m.position.y = y;
  return m;
}

function wheels(g, w, l, r, color = 0x222222) {
  const geo = new THREE.CylinderGeometry(r, r, 0.35, 12).rotateZ(Math.PI / 2);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const m = new THREE.Mesh(geo, mat(color, { metalness: 0 }));
    m.position.set(sx * w / 2, r, sz * l / 3);
    g.add(m);
  }
}

function ornithopter(length, color) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(length * 0.1, length * 0.6, 4, 10).rotateX(Math.PI / 2), mat(color));
  body.position.y = length * 0.15;
  g.add(body);
  const wing = new THREE.BoxGeometry(length * 0.55, 0.12, length * 0.14);
  for (const sx of [-1, 1]) for (const sz of [-0.15, 0.15]) {
    const w = new THREE.Mesh(wing, mat(0xcfc3a8, { metalness: 0.1 }));
    w.position.set(sx * length * 0.33, length * 0.22, sz * length);
    w.rotation.z = sx * 0.08;
    g.add(w);
  }
  return g;
}

// Fahrzeugmodell nach Untertyp der Console (Buggy, LightOrnithopter …).
export function vehicleModel(subtype) {
  switch (subtype) {
    case 'LightOrnithopter': return ornithopter(12, 0x9aa4ad);
    case 'MediumOrnithopter': return ornithopter(17, 0x8d979f);
    case 'TransportOrnithopter': return ornithopter(24, 0x7f8a92);
    case 'Buggy': { const g = new THREE.Group(); g.add(box(2.4, 1.2, 4.4, 0xa8845a, 1.1)); wheels(g, 2.6, 4.4, 0.6); return g; }
    case 'Sandbike': { const g = new THREE.Group(); g.add(box(0.8, 0.9, 2.8, 0xb07a3c, 0.9)); wheels(g, 0.9, 2.8, 0.45); return g; }
    case 'SandCrawler': { const g = new THREE.Group(); g.add(box(8, 5, 14, 0x9c8b6e, 3.2)); g.add(box(8.6, 1.4, 14.5, 0x3a3a3a, 0.7)); return g; }
    case 'TreadWheel': { const g = new THREE.Group(); g.add(box(3, 2.2, 5, 0x8d7b5f, 1.6)); g.add(box(3.4, 1, 5.3, 0x3a3a3a, 0.5)); return g; }
    case 'ContainerVehicle': return box(3, 3, 6, 0x6f7a6a);
    default: return box(2, 2, 4, 0x8a8a8a);
  }
}

// Namensschild als Sprite mit fester Bildschirmgröße.
export function label(text, { color = '#ffffff', bg = 'rgba(20,15,10,0.72)', size = 26 } = {}) {
  const pad = 8;
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  ctx.font = `600 ${size}px -apple-system, "Segoe UI", sans-serif`;
  const w = Math.ceil(ctx.measureText(text).width) + pad * 2;
  const h = size + pad * 2;
  c.width = w; c.height = h;
  ctx.font = `600 ${size}px -apple-system, "Segoe UI", sans-serif`;
  ctx.fillStyle = bg;
  ctx.beginPath(); ctx.roundRect(0, 0, w, h, h / 2); ctx.fill();
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, pad, h / 2 + 1);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: true, depthWrite: false, sizeAttenuation: false, transparent: true }));
  const k = 0.00075; // Bildschirmanteil je Pixel
  s.scale.set(w * k, h * k, 1);
  s.center.set(0.5, 0);
  s.renderOrder = 10;
  return s;
}

// Runde Punkttextur für Markierungswolken
let dot = null;
export function dotTexture() {
  if (dot) return dot;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.beginPath(); ctx.arc(32, 32, 26, 0, Math.PI * 2); ctx.fill();
  ctx.lineWidth = 7;
  ctx.strokeStyle = 'rgba(0,0,0,0.75)';
  ctx.stroke();
  dot = new THREE.CanvasTexture(c);
  return dot;
}

// Basis-Markierung: Fahnenmast mit Wimpel
export function basePin(color = 0x3fa7ff) {
  const g = new THREE.Group();
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 30, 6), new THREE.MeshBasicMaterial({ color: 0xdddddd }));
  pole.position.y = 15;
  const flag = new THREE.Mesh(new THREE.BoxGeometry(0.2, 5, 9), new THREE.MeshBasicMaterial({ color }));
  flag.position.set(0, 27, 4.5);
  g.add(pole, flag);
  return g;
}

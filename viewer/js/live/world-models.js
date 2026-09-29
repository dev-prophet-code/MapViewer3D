// 3D-Modelle für Orte, Gefahren und Ressourcen der Live-Karte (Maße in Metern).
// Jedes Modell ist eine einzige Geometrie mit Vertexfarben, damit viele Exemplare
// als InstancedMesh gezeichnet werden können; die Instanzfarbe tönt zusätzlich
// (z. B. Erzsorten). Die Spielmodelle selbst enthält der Serverbuild nicht.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const WHITE = 0xffffff;

// Ein Bauteil: Geometrie, Farbe, Position, Drehung, Skalierung
function part(geo, color, { p = [0, 0, 0], r = [0, 0, 0], s = [1, 1, 1] } = {}) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  g.deleteAttribute('uv');
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3(...p), new THREE.Quaternion().setFromEuler(new THREE.Euler(...r)), new THREE.Vector3(...s));
  g.applyMatrix4(m);
  const c = new THREE.Color(color);
  const col = new Float32Array(g.attributes.position.count * 3);
  for (let i = 0; i < col.length; i += 3) { col[i] = c.r; col[i + 1] = c.g; col[i + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

const merge = (parts) => {
  const g = mergeGeometries(parts);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
};

// Deterministischer Zufall je Bauteil, damit Modelle nicht zu gleichförmig wirken
function rng(seed) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647);
}

const BUILDERS = {
  cave() {
    return merge([
      part(new THREE.DodecahedronGeometry(9, 0), 0x8a6a4a, { p: [0, 3, 0], s: [1.3, 0.8, 1] }),
      part(new THREE.DodecahedronGeometry(5, 0), 0x7a5c3f, { p: [7, 2, 4], s: [1, 0.8, 1] }),
      part(new THREE.CylinderGeometry(3.2, 3.2, 3, 16, 1, false, 0, Math.PI), 0x1a130d, { p: [0, 2.5, 8.6], r: [Math.PI / 2, 0, 0] }),
    ]);
  },
  ecolab() {
    return merge([
      part(new THREE.CylinderGeometry(9, 10, 3, 20), 0x8f959a, { p: [0, 1.5, 0] }),
      part(new THREE.SphereGeometry(8, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), 0xdfe8ea, { p: [0, 3, 0] }),
      part(new THREE.TorusGeometry(8.2, 0.35, 6, 32), 0x2fb5a8, { p: [0, 3.2, 0], r: [Math.PI / 2, 0, 0] }),
      part(new THREE.CylinderGeometry(0.2, 0.2, 7, 6), 0xcccccc, { p: [4, 13, 0] }),
      part(new THREE.BoxGeometry(3, 2.4, 4), 0x6f777c, { p: [0, 1.2, 10.5] }),
    ]);
  },
  wreck() {
    // liegender Schiffsrumpf, hinten abgebrochen, halb im Sand
    return merge([
      part(new THREE.CylinderGeometry(4.5, 5, 30, 12), 0x7c5b43, { p: [0, 2.5, 0], r: [0.12, 0, Math.PI / 2 + 0.06] }),
      part(new THREE.ConeGeometry(4.6, 9, 12), 0x6f513c, { p: [19.4, 3.4, 0], r: [0.12, 0, -Math.PI / 2 + 0.06] }),
      part(new THREE.CylinderGeometry(4.2, 4.5, 9, 12), 0x5f4633, { p: [-22, 1.6, 2.5], r: [0.35, 0.3, Math.PI / 2 - 0.2] }),
      part(new THREE.CylinderGeometry(1.6, 2, 3, 10), 0x3a3a3a, { p: [-27.5, 2, 3.8], r: [0.3, 0.3, Math.PI / 2 - 0.2] }),
      part(new THREE.BoxGeometry(9, 0.6, 3.5), 0x6a4d39, { p: [2, 7.4, 0], r: [0.12, 0, 0.06] }),
      part(new THREE.BoxGeometry(6, 0.5, 9), 0x5d4433, { p: [-4, 2.2, 6.5], r: [0.25, 0, 0.1] }),
      part(new THREE.DodecahedronGeometry(2, 0), 0x4a3a2c, { p: [-15, 0.8, -5] }),
      part(new THREE.DodecahedronGeometry(1.4, 0), 0x4a3a2c, { p: [8, 0.6, 6] }),
    ]);
  },
  sietch() {
    return merge([
      part(new THREE.DodecahedronGeometry(10, 1), 0x9a7654, { p: [0, 2, 0], s: [1.4, 0.7, 1.1] }),
      part(new THREE.BoxGeometry(3, 4, 2), 0x2a2018, { p: [0, 2, 10.8] }),
      part(new THREE.TorusGeometry(2.4, 0.35, 6, 16, Math.PI), 0x3a8fa0, { p: [0, 4, 11.2] }),
    ]);
  },
  trading() {
    return merge([
      part(new THREE.BoxGeometry(14, 3, 10), 0xb8a07e, { p: [0, 1.5, 0] }),
      part(new THREE.CylinderGeometry(2, 2.6, 16, 10), 0x9c8665, { p: [5, 8, -2] }),
      part(new THREE.ConeGeometry(3, 3, 10), 0x6b5b45, { p: [5, 17.5, -2] }),
      part(new THREE.BoxGeometry(8, 0.3, 6), 0xd6b35a, { p: [-3, 4.5, 1] }),
      part(new THREE.BoxGeometry(1.5, 1.2, 1.5), 0x7a5a3a, { p: [-5, 3.6, 4] }),
      part(new THREE.BoxGeometry(1.5, 1.2, 1.5), 0x7a5a3a, { p: [-3, 3.6, 4] }),
    ]);
  },
  enemy() {
    const r = rng(7);
    const parts = [];
    for (let i = 0; i < 4; i++) {
      const a = i / 4 * Math.PI * 2 + r();
      parts.push(part(new THREE.ConeGeometry(3.2, 3.6, 4), i % 2 ? 0x8c3b2e : 0x6d2f25,
        { p: [Math.cos(a) * 8, 1.8, Math.sin(a) * 8], r: [0, a, 0] }));
    }
    for (let i = 0; i < 14; i++) {
      const a = i / 14 * Math.PI * 2;
      parts.push(part(new THREE.CylinderGeometry(0.2, 0.25, 2.4, 5), 0x4a3a2c, { p: [Math.cos(a) * 14, 1.2, Math.sin(a) * 14] }));
    }
    parts.push(part(new THREE.BoxGeometry(1.4, 1.4, 1.4), 0x7a5a3a, { p: [1, 0.7, 0] }));
    parts.push(part(new THREE.BoxGeometry(1.4, 1.4, 1.4), 0x6b4f34, { p: [2.2, 0.7, 1.1], r: [0, 0.5, 0] }));
    parts.push(part(new THREE.CylinderGeometry(0.15, 0.15, 7, 5), 0x3a3a3a, { p: [-1, 3.5, -1] }));
    parts.push(part(new THREE.BoxGeometry(0.1, 1.6, 2.4), 0xa8322a, { p: [-1, 6.2, 0.2] }));
    return merge(parts);
  },
  spice() {
    const r = rng(11);
    const parts = [part(new THREE.CylinderGeometry(22, 24, 2.4, 32), 0xe07a2a, { p: [0, 0.4, 0] })];
    for (let i = 0; i < 18; i++) {
      const a = r() * Math.PI * 2, d = 4 + r() * 16;
      parts.push(part(new THREE.ConeGeometry(0.6 + r() * 0.8, 1 + r() * 2, 6), 0xff9a3c,
        { p: [Math.cos(a) * d, 0.6, Math.sin(a) * d] }));
    }
    return merge(parts);
  },
  quicksand() {
    return merge([
      part(new THREE.CylinderGeometry(20, 20, 2, 40), 0x8a7152, { p: [0, 0.2, 0] }),
      part(new THREE.TorusGeometry(14, 0.6, 4, 40), 0x6e5a40, { p: [0, 0.3, 0], r: [Math.PI / 2, 0, 0] }),
      part(new THREE.TorusGeometry(8, 0.6, 4, 32), 0x5d4a35, { p: [0, 0.35, 0], r: [Math.PI / 2, 0, 0] }),
      part(new THREE.CylinderGeometry(3, 3, 0.3, 20), 0x3d3024, { p: [0, 0.3, 0] }),
    ]);
  },
  drumsand() {
    return merge([18, 13, 8, 3].map((rad, i) =>
      part(new THREE.TorusGeometry(rad, 0.45, 4, 40), i % 2 ? 0xc9a36d : 0xe3c08a, { p: [0, 0.3, 0], r: [Math.PI / 2, 0, 0] })));
  },
  radiation() {
    return merge([
      part(new THREE.SphereGeometry(30, 28, 14, 0, Math.PI * 2, 0, Math.PI / 2), 0x9dff4a),
      part(new THREE.TorusGeometry(30, 0.5, 4, 48), 0xd8ff5a, { p: [0, 0.4, 0], r: [Math.PI / 2, 0, 0] }),
    ]);
  },
  ore() {
    const r = rng(3);
    const parts = [part(new THREE.DodecahedronGeometry(1.4, 0), 0x6b5a48, { p: [0, 0.5, 0], s: [1.3, 0.6, 1.1] })];
    for (let i = 0; i < 5; i++) {
      const a = r() * Math.PI * 2, d = r() * 0.9;
      parts.push(part(new THREE.OctahedronGeometry(0.45 + r() * 0.5, 0), WHITE,
        { p: [Math.cos(a) * d, 1.1 + r() * 0.6, Math.sin(a) * d], r: [r() * 0.6, r() * 3, r() * 0.6], s: [0.6, 1.6, 0.6] }));
    }
    return merge(parts);
  },
  scrap() {
    const r = rng(5);
    const parts = [];
    for (let i = 0; i < 5; i++) {
      parts.push(part(new THREE.BoxGeometry(0.4 + r() * 1.4, 0.15 + r() * 0.4, 0.3 + r() * 1.1), WHITE,
        { p: [(r() - 0.5) * 2.4, 0.2, (r() - 0.5) * 2.4], r: [r() * 0.5, r() * 3, r() * 0.5] }));
    }
    parts.push(part(new THREE.CylinderGeometry(0.25, 0.25, 1.2, 8), 0x5a5a5a, { p: [0.5, 0.3, 0.2], r: [0, 0, Math.PI / 2] }));
    return merge(parts);
  },
  primrose() {
    const r = rng(9);
    const parts = [];
    for (let i = 0; i < 9; i++) {
      const x = (r() - 0.5) * 3, z = (r() - 0.5) * 3, h = 0.4 + r() * 0.4;
      parts.push(part(new THREE.CylinderGeometry(0.03, 0.03, h, 4), 0x5f7a3a, { p: [x, h / 2, z] }));
      parts.push(part(new THREE.SphereGeometry(0.16, 6, 4), WHITE, { p: [x, h, z] }));
    }
    return merge(parts);
  },
  bush() {
    return merge([
      part(new THREE.IcosahedronGeometry(1, 1), 0x7c8b5a, { p: [0, 0.7, 0], s: [1.2, 0.8, 1.1] }),
      part(new THREE.IcosahedronGeometry(0.7, 0), 0x8e9a64, { p: [0.8, 0.5, 0.3] }),
      part(new THREE.IcosahedronGeometry(0.6, 0), 0x6d7b4d, { p: [-0.7, 0.45, -0.3] }),
    ]);
  },
  cactus() {
    return merge([
      part(new THREE.CapsuleGeometry(0.45, 4, 4, 8), 0x5e7d45, { p: [0, 2.4, 0] }),
      part(new THREE.CapsuleGeometry(0.28, 1.4, 4, 8), 0x587440, { p: [0.8, 2.8, 0] }),
      part(new THREE.CapsuleGeometry(0.28, 0.6, 4, 8), 0x587440, { p: [0.5, 2.1, 0], r: [0, 0, Math.PI / 2] }),
      part(new THREE.CapsuleGeometry(0.25, 1.1, 4, 8), 0x587440, { p: [-0.7, 3.4, 0] }),
      part(new THREE.CapsuleGeometry(0.25, 0.5, 4, 8), 0x587440, { p: [-0.45, 2.8, 0], r: [0, 0, Math.PI / 2] }),
    ]);
  },
  flour() {
    return merge([
      part(new THREE.CylinderGeometry(15, 16, 2, 32), 0xf3e2bd, { p: [0, 0.2, 0] }),
      part(new THREE.TorusGeometry(10, 0.4, 4, 32), 0xfaf0d6, { p: [0, 0.25, 0], r: [Math.PI / 2, 0, 0] }),
    ]);
  },
  storage() {
    return merge([
      part(new THREE.BoxGeometry(1.6, 1.2, 1.2), 0x8a6a48, { p: [0, 0.6, 0] }),
      part(new THREE.BoxGeometry(1.7, 0.12, 1.3), 0x5a4430, { p: [0, 1.2, 0] }),
    ]);
  },
  npc() {
    return merge([
      part(new THREE.CapsuleGeometry(0.32, 1.0, 4, 10), 0x2fa8a0, { p: [0, 0.85, 0] }),
      part(new THREE.SphereGeometry(0.2, 10, 8), 0xe2c5a3, { p: [0, 1.7, 0] }),
      part(new THREE.CylinderGeometry(0.05, 0.05, 6, 5), 0xdddddd, { p: [0.6, 3, 0] }),
      part(new THREE.BoxGeometry(0.05, 0.8, 1.2), 0x2fa8a0, { p: [0.6, 5.6, 0.6] }),
    ]);
  },
  fortress() {
    const parts = [
      part(new THREE.CylinderGeometry(14, 16, 28, 8), 0x8d8272, { p: [0, 14, 0] }),
      part(new THREE.CylinderGeometry(16, 16, 2, 8), 0x7b7163, { p: [0, 29, 0] }),
    ];
    for (let i = 0; i < 8; i++) {
      const a = i / 8 * Math.PI * 2;
      parts.push(part(new THREE.BoxGeometry(3, 3, 3), 0x7b7163, { p: [Math.cos(a) * 15, 31.5, Math.sin(a) * 15], r: [0, -a, 0] }));
    }
    return merge(parts);
  },
};

// Materialeigenschaften je Modell (z. B. durchscheinende Gefahrenzonen)
const MATERIAL = {
  spice: { emissive: 0x7a2c00, emissiveIntensity: 0.6, transparent: true, opacity: 0.85 },
  radiation: { emissive: 0x3a7a00, emissiveIntensity: 0.5, transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide },
  quicksand: { transparent: true, opacity: 0.9 },
  drumsand: { transparent: true, opacity: 0.8 },
  flour: { transparent: true, opacity: 0.85 },
  ore: { metalness: 0.35, roughness: 0.45 },
  scrap: { metalness: 0.6, roughness: 0.5 },
};

const cache = new Map();

// Liefert { geometry, material } für ein Modell (zwischengespeichert).
export function worldModel(key) {
  if (!cache.has(key)) {
    const build = BUILDERS[key] ?? BUILDERS.storage;
    cache.set(key, {
      geometry: build(),
      material: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0.05, flatShading: true, ...MATERIAL[key] }),
    });
  }
  return cache.get(key);
}

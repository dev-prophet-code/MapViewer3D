// Dekodiert Netze im Format "DML1" (backend/mesh.WriteDML) in three.js-Geometrie.
import * as THREE from 'three';

// Ergebnis in Metern mit Y oben. Durch das Vertauschen von Y/Z (Unreal → three.js)
// wird gespiegelt, deshalb wird auch die Dreiecksreihenfolge umgedreht.
export function decodeMesh(buf) {
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== 0x314c4d44) throw new Error('kein DML1-Netz');
  const nv = dv.getUint32(4, true), ni = dv.getUint32(8, true);
  const lo = [0, 1, 2].map((k) => dv.getFloat32(12 + 4 * k, true));
  const hi = [0, 1, 2].map((k) => dv.getFloat32(24 + 4 * k, true));
  const q = new Uint16Array(buf, 36, nv * 3);
  let off = 36 + nv * 6;
  if (off % 4) off += 2;
  const src = nv <= 65535 ? new Uint16Array(buf, off, ni) : new Uint32Array(buf, off, ni);

  const pos = new Float32Array(nv * 3);
  const s = [0, 1, 2].map((k) => (hi[k] - lo[k]) / 65535);
  for (let v = 0; v < nv; v++) {
    const x = lo[0] + q[3 * v] * s[0], y = lo[1] + q[3 * v + 1] * s[1], z = lo[2] + q[3 * v + 2] * s[2];
    pos[3 * v] = x / 100; pos[3 * v + 1] = z / 100; pos[3 * v + 2] = y / 100;
  }
  const idx = new Uint32Array(ni);
  for (let t = 0; t + 2 < ni; t += 3) {
    idx[t] = src[t]; idx[t + 1] = src[t + 2]; idx[t + 2] = src[t + 1];
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeVertexNormals();
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

// Bauteil-Katalog (backend/buildables): Zeilenname → Netz, Gruppe, lokale Verschiebung.
// Baut aus einem Basis-Export der Console instanzierte 3D-Geometrie.
import * as THREE from 'three';
import { api } from '../api.js';
import { ueMatrix, ueToThreeMatrix } from '../coords.js';
import { decodeMesh } from '../meshes.js';

// Farben je Fraktion/Kategorie und Physik-Material
const GROUP_COLORS = {
  Harkonnen: 0x4a4d52, Atreides: 0x7d8a6a, Choam: 0xb9a584, Choam_Level2: 0xc7b391, Choam_Shelter: 0xa8946f,
  Smugglers: 0x8a6a4c, Sardaukar: 0x5b4e45, Watershippers: 0x6f8791, MiniSets: 0x9c8a70, Blockout: 0x9a9a9a,
  Functional: 0x8f8a82, Functional_1510: 0x8f8a82, Functional_PolarCap: 0x8f8a82, Decoration: 0xa38b6d, Vehicle: 0x7c7f86,
};
const PHYS = {
  PM_Metal: { metalness: 0.55, roughness: 0.45 }, PhysMat_Metal: { metalness: 0.55, roughness: 0.45 },
  PM_Concrete: { metalness: 0, roughness: 0.9 }, PM_Stone: { metalness: 0, roughness: 0.95 },
  PM_Glass: { metalness: 0.1, roughness: 0.1, transparent: true, opacity: 0.45 }, PM_Fabric: { metalness: 0, roughness: 1 },
};

export class Buildables {
  constructor() {
    this.index = null;
    this.geometries = new Map();
    this.materials = new Map();
  }

  async load() {
    if (!this.index) this.index = await api.buildables();
    return this.index;
  }

  geometry(id) {
    if (!this.geometries.has(id)) {
      const p = fetch(api.buildableMeshUrl(id)).then((r) => r.arrayBuffer()).then(decodeMesh);
      p.catch(() => this.geometries.delete(id));
      this.geometries.set(id, p);
    }
    return this.geometries.get(id);
  }

  material(row, mesh) {
    const key = `${row.group}|${mesh.physMat ?? ''}`;
    if (!this.materials.has(key)) {
      const phys = PHYS[mesh.physMat] ?? { metalness: 0.15, roughness: 0.8 };
      this.materials.set(key, new THREE.MeshStandardMaterial({
        color: GROUP_COLORS[row.group] ?? 0x9a8f80, flatShading: true, ...phys,
      }));
    }
    return this.materials.get(key);
  }

  // Baut eine Basis aus /api/bases/<id>/export. Bauteile: Ort relativ zur Basis,
  // Drehung um die Hochachse; Platzierbare: rx/ry/rz als Pitch/Yaw/Roll.
  async buildBase(exp) {
    await this.load();
    const group = new THREE.Group();
    const base = [exp.x, exp.y, exp.z];
    const byMesh = new Map(); // Netz-ID → { row, matrices }
    const missing = new Set();
    const add = (type, loc, rot) => {
      const row = this.index.rows[type];
      if (!row || row.mesh < 0) { missing.add(type); return; }
      let m = ueMatrix([base[0] + loc[0], base[1] + loc[1], base[2] + loc[2]], rot);
      if (row.offset || row.rot || row.scale) {
        const s = row.scale && row.scale.some((v) => v) ? row.scale : [1, 1, 1];
        m = m.multiply(ueMatrix(row.offset ?? [0, 0, 0], row.rot ?? [0, 0, 0], s));
      }
      if (!byMesh.has(row.mesh)) byMesh.set(row.mesh, { row, matrices: [] });
      byMesh.get(row.mesh).matrices.push(ueToThreeMatrix(m));
    };
    for (const p of exp.instances ?? []) add(p.building_type, [p.x, p.y, p.z], [0, p.rotation ?? 0, 0]);
    for (const p of exp.placeables ?? []) add(p.building_type, [p.x, p.y, p.z], [p.rx ?? 0, p.ry ?? 0, p.rz ?? 0]);

    await Promise.all([...byMesh].map(async ([meshId, { row, matrices }]) => {
      const geo = await this.geometry(meshId);
      const im = new THREE.InstancedMesh(geo, this.material(row, this.index.meshes[meshId]), matrices.length);
      matrices.forEach((m, i) => im.setMatrixAt(i, m));
      im.computeBoundingSphere();
      group.add(im);
    }));
    if (missing.size) console.info(`Basis ${exp.name}: ohne Geometrie`, [...missing]);
    return group;
  }
}

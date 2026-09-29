// Kartenraster der Deep Desert: 9 × 9 Zellen (A1–I9) à 2,5 km, wie im Spiel und auf der
// Console-Karte. Reihe A liegt im Norden der Karte (größtes Y), Spalte 1 im Westen.
// Die Linien zeichnet der Gelände-Shader (uCells), die Namen sind Sprites über den Zellen.
import * as THREE from 'three';

// Weltausdehnung der Deep Desert in m (wie backend/maps: Bounds, = Kartenbild der Console)
const BOUNDS = { minX: -11776.56, minZ: -11770.66, size: 22500 };
const CELLS = 9;
const CELL = BOUNDS.size / CELLS;

const label = (text) => {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 64;
  const g = c.getContext('2d');
  g.font = '700 46px system-ui, sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.lineWidth = 9; g.strokeStyle = 'rgba(20,12,4,0.85)'; g.strokeText(text, 64, 34);
  g.fillStyle = '#fff4dc'; g.fillText(text, 64, 34);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, fog: false }));
  return s;
};

export class DdGrid {
  constructor(parent, terrain) {
    this.terrain = terrain;
    this.group = new THREE.Group();
    this.group.visible = false;
    parent.add(this.group);
    this.enabled = false; // Karte hat ein Raster
    this.on = true;       // vom Nutzer gewünscht
    this.sprites = [];
    for (let r = 0; r < CELLS; r++) {
      for (let c = 0; c < CELLS; c++) {
        const s = label(`${String.fromCharCode(65 + (CELLS - 1 - r))}${c + 1}`);
        s.userData = { x: BOUNDS.minX + (c + 0.5) * CELL, z: BOUNDS.minZ + (r + 0.5) * CELL, y: 0 };
        s.position.set(s.userData.x, 0, s.userData.z);
        this.group.add(s);
        this.sprites.push(s);
      }
    }
    this.clock = 0;
  }

  // Nur für die Deep Desert (Live-Name DeepDesert)
  setMap(meta) {
    this.enabled = meta?.live === 'DeepDesert';
    this.apply();
  }

  setOn(on) { this.on = on; this.apply(); }

  apply() {
    const show = this.enabled && this.on;
    this.group.visible = show;
    this.terrain.uniforms.uCells.value.set(BOUNDS.minX, BOUNDS.minZ, CELL, show ? 1 : 0);
    if (show) this.clock = 1e9; // Höhen sofort neu bestimmen
  }

  update(camera, dt) {
    if (!this.group.visible) return;
    this.clock += dt;
    const refresh = this.clock > 1.5; // Höhen kommen mit dem Nachladen des Geländes
    if (refresh) this.clock = 0;
    const e = this.terrain.exaggeration;
    for (const s of this.sprites) {
      if (refresh) {
        const h = this.terrain.heightAt(s.userData.x, s.userData.z);
        if (h !== null) s.userData.y = h;
      }
      s.position.y = s.userData.y * e + 25;
      const d = camera.position.distanceTo(s.position);
      const size = THREE.MathUtils.clamp(d * 0.05, 30, 650); // etwa gleich groß auf dem Bildschirm
      s.scale.set(size * 2, size, 1);
      s.material.opacity = THREE.MathUtils.smoothstep(d, 60, 250);
    }
  }
}

// Tastaturflug: W/A/S/D bewegen, Q/E hoch/runter, Shift schneller.
// Bewegt Kamera und Orbit-Ziel gemeinsam; Eingabefelder sind ausgenommen.
import * as THREE from 'three';

export class Fly {
  constructor(camera, controls) {
    this.camera = camera;
    this.controls = controls;
    this.keys = new Set();
    this.enabled = true;
    addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e)) return;
      this.keys.add(e.code);
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
  }

  update(dt) {
    if (!this.enabled || !this.keys.size) return;
    const k = this.keys;
    const fast = k.has('ShiftLeft') || k.has('ShiftRight') ? 3 : 1;
    const speed = Math.max(20, this.camera.position.distanceTo(this.controls.target)) * fast;
    const fwd = new THREE.Vector3();
    this.camera.getWorldDirection(fwd);
    fwd.y = 0; fwd.normalize();
    const right = new THREE.Vector3().crossVectors(fwd, this.camera.up).normalize();
    const mv = new THREE.Vector3();
    if (k.has('KeyW')) mv.add(fwd);
    if (k.has('KeyS')) mv.sub(fwd);
    if (k.has('KeyD')) mv.add(right);
    if (k.has('KeyA')) mv.sub(right);
    if (k.has('KeyE')) mv.y += 1;
    if (k.has('KeyQ')) mv.y -= 1;
    mv.multiplyScalar(speed * dt * 0.6);
    this.camera.position.add(mv);
    this.controls.target.add(mv);
  }
}

export const isTyping = (e) => e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement
  || e.target instanceof HTMLTextAreaElement;

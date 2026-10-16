// Tastaturflug: W/A/S/D bewegen, Q/E hoch/runter, Shift schneller.
// Bewegt Kamera und Orbit-Ziel gemeinsam; Eingabefelder sind ausgenommen.
import * as THREE from 'three';

export class Fly {
  constructor(camera, controls) {
    this.camera = camera;
    this.controls = controls;
    this.keys = new Set();
    this.enabled = true;
    this._fwd = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._mv = new THREE.Vector3();
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
    const fwd = this._fwd;
    this.camera.getWorldDirection(fwd);
    fwd.y = 0; fwd.normalize();
    const right = this._right.crossVectors(fwd, this.camera.up).normalize();
    const mv = this._mv.set(0, 0, 0);
    if (k.has('KeyW') || k.has('ArrowUp')) mv.add(fwd);
    if (k.has('KeyS') || k.has('ArrowDown')) mv.sub(fwd);
    if (k.has('KeyD') || k.has('ArrowRight')) mv.add(right);
    if (k.has('KeyA') || k.has('ArrowLeft')) mv.sub(right);
    if (k.has('KeyE') || k.has('PageUp')) mv.y += 1;
    if (k.has('KeyQ') || k.has('PageDown')) mv.y -= 1;
    if (mv.lengthSq() === 0) return;
    mv.multiplyScalar(speed * dt * 0.6);
    this.camera.position.add(mv);
    this.controls.target.add(mv);
  }
}

export const isTyping = (e) => e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement
  || e.target instanceof HTMLTextAreaElement;

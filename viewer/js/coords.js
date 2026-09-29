// Umrechnung zwischen Unreal (cm, X/Y/Z, Z oben, linkshändig) und three.js
// (m, x/y/z, Y oben, rechtshändig). Das Vertauschen von Y und Z spiegelt dabei
// zugleich die Händigkeit korrekt.
import * as THREE from 'three';
import { lang } from './i18n.js';

export const ueToThree = (x, y, z) => new THREE.Vector3(x / 100, z / 100, y / 100);

// Zahlen im Format der gewählten Sprache (1,234 bzw. 1.234)
export const fmtInt = (v) => Math.round(v).toLocaleString(lang === 'de' ? 'de-DE' : 'en-US');

// Matrix für Unreal-Weltraum (cm) → three.js (m): three = C · ue.
const C = new THREE.Matrix4().set(0.01, 0, 0, 0, 0, 0, 0.01, 0, 0, 0.01, 0, 0, 0, 0, 0, 1);
const CInv = C.clone().invert();

// Rotator (Pitch, Yaw, Roll in Grad) als Unreal-Rotationsmatrix (Spaltenvektoren).
export function ueRotation(pitch, yaw, roll) {
  const d = Math.PI / 180;
  const sp = Math.sin(pitch * d), cp = Math.cos(pitch * d);
  const sy = Math.sin(yaw * d), cy = Math.cos(yaw * d);
  const sr = Math.sin(roll * d), cr = Math.cos(roll * d);
  return new THREE.Matrix4().set(
    cp * cy, sr * sp * cy - cr * sy, -(cr * sp * cy + sr * sy), 0,
    cp * sy, sr * sp * sy + cr * cy, cy * sr - cr * sp * sy, 0,
    sp, -sr * cp, cr * cp, 0,
    0, 0, 0, 1);
}

// Unreal-Transform (Ort cm, Rotator Grad, Skalierung) als Matrix im Unreal-Raum.
export function ueMatrix(loc, rot = [0, 0, 0], scale = [1, 1, 1]) {
  const m = ueRotation(rot[0], rot[1], rot[2]);
  m.scale(new THREE.Vector3(scale[0], scale[1], scale[2]));
  m.setPosition(loc[0], loc[1], loc[2]);
  return m;
}

// Wandelt eine Unreal-Matrix in eine three.js-Matrix für Geometrie, die bereits
// nach three.js-Metern umgerechnet wurde (siehe decodeMesh).
export const ueToThreeMatrix = (mUe) => new THREE.Matrix4().multiplyMatrices(C, mUe).multiply(CInv);

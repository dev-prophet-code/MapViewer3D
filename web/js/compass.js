// Kompass: zeigt, in welche Himmelsrichtung die Kamera blickt. Die Rose dreht
// sich gegen die Blickrichtung, sodass die Richtung vorn oben steht; ein Klick
// dreht die Kamera nach Norden.
import * as THREE from 'three';
import { t } from './i18n.js';

// Norden liegt in Karten-Blickrichtung „oben“ und damit bei –Z (Y in Unreal wächst nach Süden).
const CARDINALS = [['N', 0, 13], ['E', 1, 71], ['S', 2, 71], ['W', 3, 13]];
const NS = 'http://www.w3.org/2000/svg';
const el = (name, attrs = {}, text) => {
  const e = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text) e.textContent = text;
  return e;
};

export function initCompass(host, camera, controls) {
  const svg = el('svg', { viewBox: '0 0 84 84', 'aria-hidden': 'true' });
  svg.append(el('circle', { class: 'compass-disc', cx: 42, cy: 42, r: 40 }));
  const rose = el('g', { class: 'compass-rose' });
  rose.append(
    el('circle', { class: 'compass-ring', cx: 42, cy: 42, r: 21 }),
    el('path', { class: 'compass-ticks', d: 'M42 18v5M66 42h-5M42 66v-5M18 42h5M25 25l3 3M59 25l-3 3M59 59l-3-3M25 59l3-3' }),
  );
  const letters = [];
  for (const [name, i] of CARDINALS) {
    const a = i * 90, r = 29;
    const x = 42 + r * Math.sin(a * Math.PI / 180), y = 42 - r * Math.cos(a * Math.PI / 180);
    const tx = el('text', { class: `compass-card${name === 'N' ? ' north' : ''}`, x: x.toFixed(2), y: y.toFixed(2) }, t(`compass.${name}`));
    letters.push({ tx, x, y });
    rose.append(tx);
  }
  svg.append(rose, el('path', { class: 'compass-pointer', d: 'M42 26 51 52 42 47 33 52Z' }));
  host.replaceChildren(svg);
  host.title = t('compass.tip');
  host.setAttribute('role', 'button');
  host.tabIndex = 0;

  const off = new THREE.Vector3();
  const sph = new THREE.Spherical();
  let shown = NaN;
  let anim = null;

  // Blickrichtung im Uhrzeigersinn von Norden (Grad)
  const bearing = () => {
    const f = camera.getWorldDirection(off);
    return (Math.atan2(f.x, -f.z) * 180 / Math.PI + 360) % 360;
  };

  function faceNorth() {
    off.subVectors(camera.position, controls.target);
    sph.setFromVector3(off);
    // Kamera südlich des Ziels = Blick nach Norden (theta 0)
    anim = { from: sph.theta, to: Math.round(sph.theta / (2 * Math.PI)) * 2 * Math.PI, p: 0 };
  }
  host.addEventListener('click', faceNorth);
  host.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); faceNorth(); } });

  return {
    update(dt) {
      if (anim) {
        anim.p = Math.min(1, anim.p + dt / 0.45);
        const e = 1 - Math.pow(1 - anim.p, 3);
        off.subVectors(camera.position, controls.target);
        sph.setFromVector3(off);
        sph.theta = anim.from + (anim.to - anim.from) * e;
        off.setFromSpherical(sph);
        camera.position.copy(controls.target).add(off);
        camera.lookAt(controls.target);
        if (anim.p >= 1) anim = null;
      }
      const b = bearing();
      if (Math.abs(b - shown) < 0.1) return;
      shown = b;
      rose.setAttribute('transform', `rotate(${(-b).toFixed(1)} 42 42)`);
      for (const l of letters) l.tx.setAttribute('transform', `rotate(${b.toFixed(1)} ${l.x.toFixed(2)} ${l.y.toFixed(2)})`);
      host.setAttribute('aria-label', `${t('compass.facing')} ${Math.round(b)}°`);
    },
  };
}

// Hell/Dunkel: schaltet die Oberfläche (CSS-Variablen über data-theme) und die
// 3D-Szene zwischen Tag und Nacht um. Der Übergang wird weich überblendet.
import * as THREE from 'three';

const STORAGE_KEY = 'mv3d.theme';

const DAY = {
  horizon: new THREE.Color(0xe3c29a), zenith: new THREE.Color(0x6d8fb3),
  hemiSky: new THREE.Color(0xcfd9e6), hemiGround: new THREE.Color(0x8a6a48), hemi: 1.1,
  sun: new THREE.Color(0xfff1dc), sunI: 2.2, disc: new THREE.Color(1.0, 0.85, 0.6),
  tone: new THREE.Color(1, 1, 1), exposure: 1.05,
};
const NIGHT = {
  horizon: new THREE.Color(0x141c38), zenith: new THREE.Color(0x02040b),
  hemiSky: new THREE.Color(0x3a4f88), hemiGround: new THREE.Color(0x15111c), hemi: 0.7,
  sun: new THREE.Color(0x9db2ff), sunI: 0.75, disc: new THREE.Color(0.55, 0.65, 0.95),
  tone: new THREE.Color(0.2, 0.27, 0.48), exposure: 1.05,
};

const mix = (a, b, k) => a + (b - a) * k;

export function initTheme({ scene, renderer, sky, hemi, sun, terrain, horizon }) {
  const root = document.documentElement;
  const buttons = [...document.querySelectorAll('.theme-toggle [data-theme-set]')];
  let stored = null;
  try { stored = localStorage.getItem(STORAGE_KEY); } catch { /* ohne Speicher */ }
  const dark = stored ? stored === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  let target = dark ? 1 : 0;
  let k = target; // aktueller Überblendwert: 0 = Tag, 1 = Nacht

  function applyUi() {
    const name = target ? 'dark' : 'light';
    root.dataset.theme = name;
    for (const b of buttons) {
      const on = b.dataset.themeSet === name;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    }
  }

  function applyScene() {
    horizon.copy(DAY.horizon).lerp(NIGHT.horizon, k);
    sky.material.uniforms.uZenith.value.copy(DAY.zenith).lerp(NIGHT.zenith, k);
    sky.material.uniforms.uSunCol.value.copy(DAY.disc).lerp(NIGHT.disc, k);
    hemi.color.copy(DAY.hemiSky).lerp(NIGHT.hemiSky, k);
    hemi.groundColor.copy(DAY.hemiGround).lerp(NIGHT.hemiGround, k);
    hemi.intensity = mix(DAY.hemi, NIGHT.hemi, k);
    sun.color.copy(DAY.sun).lerp(NIGHT.sun, k);
    sun.intensity = mix(DAY.sunI, NIGHT.sunI, k);
    terrain.uniforms.uTone.value.copy(DAY.tone).lerp(NIGHT.tone, k);
    renderer.toneMappingExposure = mix(DAY.exposure, NIGHT.exposure, k);
  }

  function set(name) {
    target = name === 'dark' ? 1 : 0;
    try { localStorage.setItem(STORAGE_KEY, name); } catch { /* nur für diese Sitzung */ }
    applyUi();
  }

  for (const b of buttons) b.addEventListener('click', () => set(b.dataset.themeSet));
  applyUi();
  applyScene();

  return {
    // pro Bild aufrufen; blendet die Szene weich zum Ziel
    update(dt) {
      if (k === target) return;
      k = Math.abs(target - k) < 0.005 ? target : k + (target - k) * Math.min(1, dt * 5);
      applyScene();
    },
  };
}

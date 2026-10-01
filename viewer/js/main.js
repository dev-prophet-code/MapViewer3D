// Einstieg: baut Szene, Gelände, Live-Ebene und Oberfläche zusammen.
import * as THREE from 'three';
import { api } from './api.js';
import { fmtInt } from './coords.js';
import { Fly } from './fly.js';
import { LiveLayer } from './live/live.js';
import { AGENT_TOGGLES } from './live/agent.js';
import { createScene, SKY } from './scene.js';
import { Terrain } from './terrain.js';
import { bindHud, bindUi, showMapInfo } from './ui.js';
import { initCompass } from './compass.js';
import { initTheme } from './theme.js';
import { askForSetup, editNames, showConnection } from './setup.js';
import { initUpdate } from './update.js';
import { applyStatic, EMBED, START_MAP, t } from './i18n.js';

applyStatic();
initUpdate();
if (EMBED) document.documentElement.classList.add('embed');

const $ = (id) => document.getElementById(id);

const canvas = $('view');
const { renderer, scene, camera, controls, world, sun, sky, hemi } = createScene(canvas);
const terrain = new Terrain(world);
const fly = new Fly(camera, controls);
const live = new LiveLayer({ world, camera, canvas });

// Feste Sonne (Nachmittag), gemeinsam für Gelände, Himmel und Gebäude
const SUN = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(55), THREE.MathUtils.degToRad(-135));
terrain.uniforms.uSun.value.copy(SUN);
sky.material.uniforms.uSun.value.copy(SUN);
sun.position.copy(SUN).multiplyScalar(1000);

// Kamera auf x/z (m) ausrichten; mit dist auch den Abstand setzen
function jumpTo(x, z, dist) {
  const offset = new THREE.Vector3().subVectors(camera.position, controls.target);
  if (dist) offset.setLength(dist);
  const h = (terrain.heightAt(x, z) ?? 0) * terrain.exaggeration;
  controls.target.set(x, h, z);
  camera.position.copy(controls.target).add(offset);
}

const theme = initTheme({ scene, renderer, sky, hemi, sun, terrain, horizon: SKY });
const compass = initCompass($('compass'), camera, controls);
bindHud();
const fillMaps = bindUi({ live, jumpTo, onMap: loadMap });
let entries = [];

// ---------- Mauszeiger → Spielkoordinaten ----------
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
let mouseDirty = false;
canvas.addEventListener('pointermove', (e) => {
  mouse.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  mouseDirty = true;
});
function updateCursor() {
  if (!mouseDirty) return;
  mouseDirty = false;
  raycaster.setFromCamera(mouse, camera);
  const p = terrain.raycast(raycaster);
  $('cursor').textContent = p
    ? `X ${fmtInt(p.x * 100)}  Y ${fmtInt(p.z * 100)}\nZ ${fmtInt(p.y / terrain.exaggeration * 100)} cm`
    : '–';
}

// ---------- Karte laden ----------
let current = null; // aktuell geladene Karte (Gelände)
let currentVersion = 0; // Stand der Geländedaten

// Eintrag = Karte + Serverinstanz; das Gelände wird nur bei Kartenwechsel neu geladen.
// keepView: Aktualisierung derselben Karte (neues Coriolis-Layout) – Kamera bleibt stehen.
function loadMap(entry, keepView = false) {
  const m = entry.map;
  if (current !== m.name || m.version !== currentVersion) {
    const switched = current !== m.name && !keepView;
    current = m.name;
    currentVersion = m.version;
    terrain.setMap(m);
    if (switched) {
      const ext = terrain.extent;
      const [ox, oz] = terrain.origin;
      controls.target.set(ox + ext / 2, 0, oz + ext / 2);
      camera.position.set(ox + ext * 0.35, ext * 0.45, oz + ext * 1.05);
    }
  }
  showMapInfo(m, entry.view);
  if (!EMBED) history.replaceState(null, '', `#${entry.id}`);
  live.setMap(m, entry.view ? entry.view.partition : null);
}

async function init() {
  // Erst die Verbindung zum Dune-Docker-Server sicherstellen
  let status = await api.setupStatus();
  showVersion();
  if (!status.configured && status.admin === false) {
    // öffentlich betriebener Viewer ohne Verbindung: einrichten kann nur der Betreiber
    showConnection(status);
    $('mapinfo').textContent = t('setup.remote');
    return;
  }
  if (!status.configured) status = await askForSetup();
  showConnection(status);
  // Öffentlich gibt es keine Offline-Spieler – der Schalter bliebe immer leer
  const st = await api.liveStatus().catch(() => ({}));
  if (st.public) document.querySelector('#liveToggles [data-key="offline"]')?.remove();
  // Sandwürmer, Gegner und Fahrzeuge live gibt es nur mit Agent (mapviewer -agent …)
  live.agentEnabled = !!st.agent;
  if (!st.agent) for (const k of AGENT_TOGGLES) document.querySelector(`#liveToggles [data-key="${k.key}"]`)?.remove();
  await loadMaps();
  running = true;
  renderer.setAnimationLoop(tick);
}

async function showVersion() {
  try { $('version').textContent = (await api.version()).version; } catch { /* ältere Server */ }
}

async function loadMaps() {
  const maps = await api.maps();
  if (!maps.length) { $('mapinfo').textContent = t('maps.none'); return; }
  const want = decodeURIComponent(location.hash.slice(1));
  entries = fillMaps(maps, want);
  const start = entries.find((e) => e.id === want) ?? (START_MAP && byLive(entries, START_MAP)) ?? entries[0];
  $('map').value = start.id;
  current = null;
  loadMap(start);
}

// Nach einem Coriolis-Sturm wechselt die Deep Desert das Layout: Der Server baut das
// Gelände dazu und meldet das neue Layout. Der Viewer fragt regelmäßig nach und lädt die
// Karte um, ohne dass jemand die Seite neu laden muss (Kamera und Auswahl bleiben).
async function refreshMaps() {
  if (document.hidden || !running || !entries.length) return;
  const cur = entries.find((e) => e.id === $('map').value);
  if (!cur?.map.live) return;
  let maps;
  try { maps = await api.maps(); } catch { return; }
  const fresh = maps.find((m) => m.live === cur.map.live);
  if (!fresh) return;
  const changed = fresh.name !== cur.map.name || fresh.version !== cur.map.version
    || JSON.stringify(fresh.coriolis) !== JSON.stringify(cur.map.coriolis);
  if (!changed) return;
  const partition = cur.view?.partition;
  const id = partition != null ? `${fresh.name}@${partition}` : fresh.name;
  entries = fillMaps(maps, id);
  const next = entries.find((e) => e.id === id) ?? byLive(entries, cur.map.live) ?? entries[0];
  $('map').value = next.id;
  loadMap(next, true);
}
setInterval(refreshMaps, 2 * 60 * 1000);

// Erste Instanz einer Karte, gesucht über den Live-Namen (HaggaBasin, DeepDesert)
const byLive = (list, name) => list.find((e) => e.map.live === name);

// ---------- Steuerung durch die einbettende Seite ----------
// { type: 'dune3d', map: 'HaggaBasin' } wechselt die Karte,
// { type: 'dune3d', paused: true|false } hält Zeichnen und Abrufe an, solange die 3D-Ansicht verborgen ist.
let running = false;
addEventListener('message', (e) => {
  if (!EMBED || e.origin !== location.origin || e.data?.type !== 'dune3d') return;
  const { map, paused } = e.data;
  if (map && entries.length) {
    const entry = byLive(entries, map);
    if (entry && entry.map.name !== current) { $('map').value = entry.id; loadMap(entry); }
  }
  if (paused === true && running) {
    running = false;
    renderer.setAnimationLoop(null);
    live.stop();
  } else if (paused === false && !running && entries.length) {
    running = true;
    clock.getDelta();
    renderer.setAnimationLoop(tick);
    if (live.map) live.start();
  }
});

$('connChange').addEventListener('click', async () => {
  const status = await askForSetup({ cancellable: true });
  if (!status) return;
  showConnection(status);
  await loadMaps();
});
$('connNames').addEventListener('click', async () => {
  if (await editNames()) await loadMaps();
});
$('connDelete').addEventListener('click', async () => {
  if (!confirm(t('conn.delete.confirm'))) return;
  await api.setupDelete();
  location.reload();
});

// ---------- Hauptschleife ----------
const clock = new THREE.Clock();
function tick() {
  const dt = Math.min(clock.getDelta(), 0.1);
  fly.update(dt);
  controls.update();
  const g = terrain.heightAt(camera.position.x, camera.position.z);
  if (g !== null) camera.position.y = Math.max(camera.position.y, g * terrain.exaggeration + 2);
  terrain.update(camera);
  live.update(dt);
  theme.update(dt);
  compass.update(dt);
  scene.fog.density = terrain.uniforms.uFogDensity.value;
  renderer.render(scene, camera);
  updateCursor();
}

// Der einbettenden Seite melden, sobald das Gelände der Startansicht steht –
// erst dann nimmt sie ihren Ladehinweis weg. Per Timer statt in der
// Hauptschleife: In einem Hintergrund-Tab ruht requestAnimationFrame.
if (EMBED) {
  const probe = setInterval(() => {
    if (!terrain.drawn.length || terrain.queue.size || terrain.inflight) return;
    clearInterval(probe);
    parent.postMessage({ type: 'dune3d', ready: true }, location.origin);
  }, 400);
}

init().catch((e) => { $('mapinfo').textContent = `Fehler: ${e.message}`; console.error(e); });

// Für die Fehlersuche in der Browser-Konsole
window.dune = { terrain, live, camera, controls, scene };

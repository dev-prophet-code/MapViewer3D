// Realtime Data (addon): live positions of sandworms, enemies, civilians/traders, vehicles and
// storms, read from the game servers by the MapViewer3D position agent and passed on by the Dune
// Docker Console to API keys with the scope "Realtime Data" (../realtime.js reads the stream).
// Full state first (`snap`), then position changes (`pos`, up to 10 Hz). The browser glides the
// markers between two samples (interpolation); without a stream it polls every 3 s.
// Same layer as the standalone viewer's, except for where the data comes from.
//
// Sandwürmer sind weltweit aktiv und bewegen sich ständig; Gegner und Zivilisten
// stehen meist still (ihre KI schläft ohne Spieler in der Nähe) und kommen als
// Punktwolke, damit auch einige Tausend nichts kosten.
import * as THREE from 'three';
import { ueToThree } from '../coords.js';
import { api } from '../api.js';
import { plainHttp } from '../realtime.js';
import { t } from '../i18n.js';
import { dotTexture, label, vehicleModel } from './models.js';
import { iconFor, iconSprite, spriteScale } from './icons.js';
import { stormModel, coriolisModel } from './storm.js';

// Schalter dieser Ebene (Namen in i18n.js unter toggle.<key>)
export const AGENT_TOGGLES = [
  { key: 'worms', on: true },
  { key: 'storms', on: true },
  { key: 'npcs', on: false },
  { key: 'civilians', on: false },
  { key: 'liveVehicles', on: false },
];

const FOLLOW = 10;            // 1/s: wie schnell Marker ihrem Ziel folgen (≈ 100 ms)
const POLL_MS = 3000;         // Rückfall ohne Strom
const LABEL_RANGE = { worm: 8000, vehicle: 450, storm: 1e6, coriolis: 1e6 };
const CLOUD = {
  npcs: { color: 0xff5a4d, size: 5 },
  civilians: { color: 0x4dd2c6, size: 5 },
};
const KIND_TOGGLE = { worm: 'worms', storm: 'storms', coriolis: 'storms', npc: 'npcs', civilian: 'civilians', vehicle: 'liveVehicles' };

// Blueprint-Name → lesbarer Name ("BP_Npc_SoldierBase_Character_Baked_C" → Soldat)
const NAMES = [
  [/SoldierBase/i, 'agent.name.soldier'],
  [/StrandedTraveler/i, 'agent.name.stranded'],
  [/SpiceMerchant/i, 'agent.name.spicemerchant'],
  [/LandsraadQM_Atreides/i, 'agent.name.qmAtreides'],
  [/LandsraadQM_Harkonnen/i, 'agent.name.qmHarkonnen'],
  [/Civilian/i, 'agent.name.civilian'],
  [/Sandworm/i, 'agent.name.worm'],
];
export function prettyName(cls = '') {
  for (const [re, key] of NAMES) if (re.test(cls)) return t(key);
  return cls.replace(/^BP_/, '').replace(/_C$/, '').replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim() || '?';
}

const row = (o) => ({ ...o, name: prettyName(o.c), class: o.c, partition_id: o.p });

export class AgentLayer {
  constructor({ group, camera, canvas, vehicleType, subtypeName }) {
    Object.assign(this, { group, camera, canvas, vehicleType, subtypeName });
    this.map = null;
    this.partition = null;
    this.show = Object.fromEntries(AGENT_TOGGLES.map((x) => [x.key, x.on]));
    this.items = new Map();   // id → Zeile des Agenten ({i,k,c,p,x,y,z})
    this.movers = new Map();  // id → { obj, label, icon, target, kind } (Würmer, Fahrzeuge)
    this.clouds = {};         // npcs/civilians → { points, index: Map(id → n), ids: [] }
    this.players = null;      // Spieler der Live-Ebene (id → Eintrag), vom LiveLayer gesetzt
    this.livePos = new Map(); // Console-Spieler-ID → { v: Position (three), t: Zeitpunkt }
    this.es = null;
    this.pollTimer = null;
    this.connected = false;
    this.lastEvent = 0;
    this.gen = 0;
    this.weather = null;      // { coriolisStart, coriolisNext } (Unix-ms), aus dem Speicher des Spielservers
  }

  start(map, partition) {
    this.stop();
    this.map = map;
    this.partition = partition;
    this.open();
  }

  stop() {
    this.es?.close();
    this.es = null;
    clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.connected = false;
    this.map = null;
    this.clear();
  }

  open() {
    if (typeof ReadableStream === 'undefined' || !globalThis.fetch) { this.poll(); return; }
    // one shared connection (realtime.js); it reconnects by itself and stops when the key is refused
    this.es = api.agentStream(this.map, this.partition, {
      snap: (v) => this.onSnap(v),
      pos: (p) => this.onPos(p),
      error: () => { this.connected = false; },
    });
  }

  poll() {
    clearInterval(this.pollTimer);
    const map = this.map;
    const tick = async () => {
      try {
        const v = await api.agent(map, this.partition);
        if (map === this.map) this.onSnap(v);
      } catch { this.connected = false; }
    };
    tick();
    this.pollTimer = setInterval(tick, POLL_MS);
  }

  onSnap(v) {
    this.lastEvent = Date.now();
    this.connected = v.connected !== false;
    this.gen = v.gen ?? 0;
    this.weather = v.weather ?? null;
    this.items = new Map((v.objects ?? []).map((o) => [o.i, o]));
    this.livePos.clear();
    for (const o of this.items.values()) if (o.k === 'player') this.applyPlayer(o);
    this.rebuild();
  }

  onPos(p) {
    this.lastEvent = Date.now();
    this.connected = true;
    for (const [id, x, y, z] of p.d ?? []) {
      const o = this.items.get(id);
      if (!o) continue;
      o.x = x; o.y = y; o.z = z;
      if (o.k === 'player') { this.applyPlayer(o); continue; }
      const m = this.movers.get(id);
      if (m) this.aim(m, o); else this.moveDot(o);
    }
    for (const id of p.r ?? []) {
      const o = this.items.get(id);
      if (!o) continue;
      this.items.delete(id);
      const m = this.movers.get(id);
      if (m) { this.group.remove(m.obj); this.movers.delete(id); } else this.removeDot(o);
    }
  }

  // Echtzeitposition eines Spielers, den der Server der Console zugeordnet hat (o.pl)
  applyPlayer(o) {
    if (o.pl === undefined || o.pl === null) return;
    const v = ueToThree(o.x, o.y, o.z);
    this.livePos.set(o.pl, { v, t: performance.now() });
    this.players?.get(o.pl)?.target.copy(v);
  }

  // Aktuelle Echtzeitposition (höchstens 4 s alt) oder null
  livePlayer(id) {
    const e = this.livePos.get(id);
    return e && performance.now() - e.t < 4000 ? e.v : null;
  }

  // ---- Aufbau ----
  clear() {
    for (const m of this.movers.values()) this.group.remove(m.obj);
    this.movers.clear();
    for (const c of Object.values(this.clouds)) { this.group.remove(c.points); c.points.geometry.dispose(); c.points.material.dispose(); }
    this.clouds = {};
    this.items = new Map();
    this.livePos.clear();
  }

  rebuild() {
    // Würmer und Fahrzeuge einzeln, Gegner/Zivilisten als Punktwolke
    const seen = new Set();
    const byCloud = { npcs: [], civilians: [] };
    for (const o of this.items.values()) {
      if (o.k === 'worm' || o.k === 'vehicle' || o.k === 'storm' || o.k === 'coriolis') {
        seen.add(o.i);
        const m = this.movers.get(o.i) ?? this.makeMover(o);
        this.aim(m, o, !m.placed);
      } else if (o.k === 'npc') byCloud.npcs.push(o);
      else if (o.k === 'civilian') byCloud.civilians.push(o);
    }
    for (const [id, m] of this.movers) {
      if (!seen.has(id)) { this.group.remove(m.obj); this.movers.delete(id); }
    }
    for (const [key, list] of Object.entries(byCloud)) this.buildCloud(key, list);
    this.applyVisibility();
  }

  makeMover(o) {
    let obj, lab, icon;
    if (o.k === 'worm') {
      obj = wormModel();
      lab = label(t('agent.name.worm'), { color: '#ffd08a', size: 24 });
      lab.position.y = 60;
      icon = iconSprite(iconFor('worm'));
      icon.position.y = 20;
    } else if (o.k === 'storm' || o.k === 'coriolis') {
      obj = o.k === 'storm' ? stormModel(this.map) : coriolisModel();
      const h = obj.userData.height;
      lab = label(t(o.k === 'storm' ? 'agent.name.storm' : 'agent.name.coriolis'), { color: '#ffd9a0', size: 30 });
      lab.position.y = h + 120;
      icon = iconSprite(iconFor('storm', { coriolis: o.k === 'coriolis' }));
      icon.position.y = h + 40;
      obj.rotation.y = Math.PI / 2 - ((o.yaw ?? 0) * Math.PI) / 180; // Fahrtrichtung aus der Weltrotation (UE: 0° = +X)
    } else {
      const subtype = this.vehicleType(o.c);
      obj = vehicleModel(subtype);
      lab = label(this.subtypeName(subtype), { color: '#cfe3ff', size: 20 });
      lab.position.y = 6;
      icon = iconSprite(iconFor('vehicles', { subtype }));
      icon.position.y = 2;
    }
    obj.add(lab, icon);
    const m = { obj, label: lab, icon, kind: o.k, id: o.i, target: new THREE.Vector3(), placed: false, heading: obj.rotation.y };
    this.movers.set(o.i, m);
    this.group.add(obj);
    return m;
  }

  // Ziel setzen (und beim ersten Mal direkt dorthin); Blickrichtung aus der Bewegung
  aim(m, o, jump = false) {
    const p = ueToThree(o.x, o.y, o.z);
    if (jump || !m.placed) {
      m.obj.position.copy(p);
      m.placed = true;
    } else {
      const dx = p.x - m.target.x, dz = p.z - m.target.z;
      // Stürme ziehen langsam: erst ab einigen Metern Weg die Richtung aus der Bewegung nehmen
      if (dx * dx + dz * dz > (m.kind === 'storm' || m.kind === 'coriolis' ? 25 : 0.25)) m.heading = Math.atan2(dx, dz);
    }
    m.target.copy(p);
  }

  buildCloud(key, list) {
    const old = this.clouds[key];
    if (old) { this.group.remove(old.points); old.points.geometry.dispose(); old.points.material.dispose(); delete this.clouds[key]; }
    if (!list.length) return;
    const pos = new Float32Array(list.length * 3);
    const index = new Map();
    list.forEach((o, n) => {
      const p = ueToThree(o.x, o.y, o.z);
      pos.set([p.x, p.y + 1, p.z], n * 3);
      index.set(o.i, n);
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({
      color: CLOUD[key].color, size: CLOUD[key].size * Math.min(devicePixelRatio, 2), sizeAttenuation: false,
      map: dotTexture(), alphaTest: 0.3, transparent: true, depthWrite: false,
    });
    const points = new THREE.Points(g, mat);
    points.frustumCulled = false;
    points.renderOrder = 6;
    this.clouds[key] = { points, index, ids: list.map((o) => o.i), dirty: false };
    this.group.add(points);
  }

  moveDot(o) {
    const c = this.clouds[KIND_TOGGLE[o.k]];
    const n = c?.index.get(o.i);
    if (n === undefined) return;
    const p = ueToThree(o.x, o.y, o.z);
    c.points.geometry.attributes.position.setXYZ(n, p.x, p.y + 1, p.z);
    c.dirty = true;
  }

  // verschwundener Punkt: weit weg parken (Indizes bleiben stabil bis zum nächsten Stand)
  removeDot(o) {
    const c = this.clouds[KIND_TOGGLE[o.k]];
    const n = c?.index.get(o.i);
    if (n === undefined) return;
    c.points.geometry.attributes.position.setXYZ(n, 0, -1e6, 0);
    c.index.delete(o.i);
    c.dirty = true;
  }

  setShow(key, on) {
    if (!(key in this.show)) return false;
    this.show[key] = on;
    this.applyVisibility();
    return true;
  }

  applyVisibility() {
    for (const m of this.movers.values()) m.obj.visible = this.show[KIND_TOGGLE[m.kind]];
    for (const [key, c] of Object.entries(this.clouds)) c.points.visible = this.show[key];
  }

  // ---- Pro Frame ----
  update(dt) {
    if (!this.map) return;
    const k = 1 - Math.exp(-dt * FOLLOW);
    const h = this.canvas.clientHeight || innerHeight;
    const unit = spriteScale(this.camera, h, 1);
    const cam = this.camera.position;
    for (const m of this.movers.values()) {
      if (!m.obj.visible) continue;
      m.obj.position.lerp(m.target, k);
      m.obj.rotation.y += Math.atan2(Math.sin(m.heading - m.obj.rotation.y), Math.cos(m.heading - m.obj.rotation.y)) * k;
      const px = m.icon.userData.px;
      m.icon.scale.set(px * unit, px * unit, 1);
      const d = Math.hypot(m.obj.position.x - cam.x, m.obj.position.z - cam.z);
      m.label.visible = d < LABEL_RANGE[m.kind];
      // das Symbol nur aus der Ferne; nah stehen Modell und Name
      m.icon.visible = m.kind === 'worm' || m.kind === 'storm' || m.kind === 'coriolis' || d > 60;
      m.obj.userData.tick?.(dt);
    }
    for (const c of Object.values(this.clouds)) {
      if (c.dirty) { c.points.geometry.attributes.position.needsUpdate = true; c.dirty = false; }
    }
  }

  // ---- Auswahl ----
  // test(lokalePosition, Eintrag) für jedes sichtbare Objekt
  pick(test) {
    for (const m of this.movers.values()) {
      if (!m.obj.visible) continue;
      const o = this.items.get(m.id);
      if (o) test(m.obj.position, { kind: m.kind === 'worm' ? 'worm' : 'liveVehicle', row: row(o), obj: m.obj, id: m.id });
    }
    const v = new THREE.Vector3();
    for (const [key, c] of Object.entries(this.clouds)) {
      if (!c.points.visible) continue;
      const attr = c.points.geometry.attributes.position;
      for (const [id, n] of c.index) {
        const o = this.items.get(id);
        if (o) test(v.fromBufferAttribute(attr, n), { kind: key === 'npcs' ? 'npc' : 'civilian', row: row(o), local: v.clone(), id });
      }
    }
  }

  counts() {
    const c = { worm: 0, npc: 0, civilian: 0, vehicle: 0, storm: 0, coriolis: 0 };
    for (const o of this.items.values()) c[o.k] = (c[o.k] ?? 0) + 1;
    return c;
  }

  statusText() {
    if (!this.map) return '';
    if (!this.connected && !this.items.size) return t('agent.off');
    const c = this.counts();
    const age = this.connected && this.lastEvent ? '' : t('agent.stale');
    let s = t('agent.status', { worms: c.worm, npcs: c.npc + c.civilian }) + age;
    if (c.storm) s += ` · ${t('agent.storms', { n: c.storm })}`;
    const w = this.weatherText();
    const plain = plainHttp() ? t('agent.plainhttp') : '';
    return [s, w, plain].filter(Boolean).join('\n');
  }

  // Coriolis-Zeitplan: Countdown bis zum nächsten Zyklus (aus dem Speicher des Spielservers)
  weatherText() {
    const w = this.weather;
    if (!w?.coriolisNext) return '';
    if (this.items && [...this.items.values()].some((o) => o.k === 'coriolis')) return t('agent.coriolis.active');
    const ms = w.coriolisNext - Date.now();
    if (ms <= 0) return t('agent.coriolis.due');
    const d = Math.floor(ms / 864e5), h = Math.floor((ms % 864e5) / 36e5), m = Math.floor((ms % 36e5) / 6e4);
    const when = new Date(w.coriolisNext).toLocaleString(undefined, { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    return t('agent.coriolis.next', { in: d ? `${d} d ${h} h` : `${h} h ${m} min`, when });
  }
}

// Ein auftauchender Wurm: Sandhügel mit dunklem Schlund und einer Warnsäule,
// damit er auch aus großer Entfernung auffällt (Maße in Metern).
function wormModel() {
  const g = new THREE.Group();
  const mound = new THREE.Mesh(
    new THREE.SphereGeometry(1, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2).scale(38, 9, 38),
    new THREE.MeshStandardMaterial({ color: 0xc8a96a, roughness: 0.95, metalness: 0 }),
  );
  const mouth = new THREE.Mesh(
    new THREE.RingGeometry(9, 20, 32).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0x2a1a10, side: THREE.DoubleSide }),
  );
  mouth.position.y = 9.2;
  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(1.2, 1.2, 160, 8, 1, true),
    new THREE.MeshBasicMaterial({ color: 0xe0872a, transparent: true, opacity: 0.28, depthWrite: false }),
  );
  beam.position.y = 80;
  g.add(mound, mouth, beam);
  return g;
}

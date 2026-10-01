// Live-Ebene: holt Spieler, Fahrzeuge, Basen, Orte, Gefahren und Ressourcen über
// den Viewer-Server (Proxy zur Console-API) und zeigt sie in 3D. Basen im
// Sichtfeld der Kamera (und in ihrem Umkreis) werden aus ihren Bauteilen als
// Gebäude aufgebaut, alle anderen nicht geladen. Aus der Ferne steht jedes Objekt
// als Symbol der 2D-Karte auf der Karte, aus der Nähe als 3D-Modell.
import * as THREE from 'three';
import { api } from '../api.js';
import { ueToThree, fmtInt } from '../coords.js';
import { Buildables } from './buildables.js';
import { basePin, label, playerModel, vehicleModel } from './models.js';
import { worldModel } from './world-models.js';
import { iconFor, iconPoints, iconSprite, spriteScale } from './icons.js';
import { AgentLayer, AGENT_TOGGLES } from './agent.js';
import { t } from '../i18n.js';

// Farben für Erz-, Schrott- und Pflanzensorten (Instanzfarbe der Modelle)
const ORE_COLORS = {
  Azurite: 0x3fb7d9, Basalt: 0x4a4a52, Bauxite: 0xc0603a, Dolomite: 0xd8d4c8, Erythrite: 0xe46fa8,
  Jasmium: 0x9b59d6, Magnetite: 0x5a6068, Rhyolite: 0xd08a4c, Stravidium: 0x4d7cff, Titanium: 0xc9d1d8,
};
const tint = (map, key, fallback = 0xffffff) => {
  const k = Object.keys(map).find((m) => key?.startsWith(m));
  return k ? map[k] : fallback;
};

// Kategorien der Live-Karte (Anzeigenamen in i18n.js unter cat.<key>).
// match: Zeile der Console → gehört dazu?
// model: 3D-Modell (Name oder Funktion je Zeile), color: Punktfarbe aus der Ferne.
export const CATEGORIES = [
  { key: 'cave', color: 0xb58a5a, model: 'cave', match: (r) => r.type === 'poi' && r.subtype === 'Cave' },
  { key: 'ecolab', color: 0x2fb5a8, model: 'ecolab', match: (r) => r.type === 'poi' && r.subtype === 'Ecolab' },
  { key: 'wreck', color: 0x9a6b4a, model: 'wreck', match: (r) => r.type === 'poi' && r.subtype === 'Shipwreck' },
  { key: 'sietch', color: 0x3a8fa0, model: 'sietch', match: (r) => r.type === 'poi' && r.subtype === 'Sietch' },
  { key: 'trading', color: 0xd6b35a, model: 'trading', match: (r) => r.type === 'poi' && r.subtype === 'TradingPost' },
  { key: 'enemy', color: 0xff4d4d, model: 'enemy', match: (r) => r.type === 'enemy' },
  { key: 'spice', color: 0xff7b1c, model: 'spice', match: (r) => r.type === 'spice' || r.type === 'spice_active' },
  { key: 'quicksand', color: 0x8a7152, model: 'quicksand', match: (r) => r.type === 'hazard' && r.subtype === 'Hazard_Quicksand' },
  { key: 'drumsand', color: 0xe3c08a, model: 'drumsand', match: (r) => r.type === 'hazard' && r.subtype === 'Hazard_Drumsand' },
  { key: 'radiation', color: 0x9dff4a, model: 'radiation', match: (r) => r.type === 'hazard' && r.subtype === 'Hazard_Radiation' },
  { key: 'ore', color: 0x6ec6ff, model: 'ore', match: (r) => r.type === 'ore', tint: (r) => tint(ORE_COLORS, r.subtype) },
  { key: 'scrap', color: 0xb8b8b8, model: 'scrap', match: (r) => r.type === 'scrap',
    tint: (r) => (r.subtype?.startsWith('FuelCell') ? 0xd9b23a : 0x9aa0a6) },
  { key: 'flora', color: 0x7bd66b, match: (r) => r.type === 'flora',
    model: (r) => (r.subtype === 'SaguaroSeed' ? 'cactus' : r.subtype === 'BrittleBush' ? 'bush' : 'primrose'),
    tint: (r) => (r.subtype === 'PrimroseField' ? 0xf2d34a : 0xffffff) },
  { key: 'flour', color: 0xf2d7a0, model: 'flour', match: (r) => r.type === 'flour_sand' },
  { key: 'storage', color: 0x9c7b5b, model: 'storage', match: (r) => r.type === 'storage' },
  { key: 'npc', color: 0x4dd2c6, model: 'npc', match: (r) => r.type === 'trainer' || r.type === 'house_representative' },
  { key: 'fortress', color: 0xc9b27a, model: 'fortress', match: (r) => r.type === 'fortress' },
];

// Schalter der Live-Karte (Namen in i18n.js unter toggle.<key>);
// Standard: nur Spieler online, Basen (auch in 3D) und Namen.
export const TOGGLES = [
  { key: 'players', on: true },
  { key: 'offline', on: false },
  { key: 'vehicles', on: false },
  { key: 'bases', on: true },
  { key: 'bases3d', on: true },
  { key: 'labels', on: true },
  { key: 'beams', on: false },
  ...AGENT_TOGGLES, // Würmer, Gegner, Zivilisten, Fahrzeuge live (nur mit Agent, siehe agent.js)
];

const FEEDS = { players: 5000, overlays: 20000, poi: 300000, spice: 120000 };
// Basen in 3D: geladen wird nur, was im Sichtfeld liegt (bis BASE_VIEW_RANGE)
// oder direkt um die Kamera (BASE_AROUND, damit beim Umdrehen schon etwas steht).
// Verlässt eine Basis Sichtfeld und Umkreis, wird sie nach BASE_GRACE_MS verworfen;
// ihr Export bleibt kurz im Speicher, damit ein Zurückschwenken nichts neu lädt.
const BASE_VIEW_RANGE = 2500;  // m
const BASE_KEEP_RANGE = 3500;  // m, Abstand, ab dem eine Basis sicher verworfen wird
const BASE_AROUND = 500;       // m
const BASE_RADIUS = 150;       // m, grobe Ausdehnung einer Basis für den Sichtfeldtest
const BASE_GRACE_MS = 4000;
const BASE_EXPORT_CACHE = 60;  // Exporte im Speicher
const BASE_PARALLEL = 3;       // gleichzeitige Ladevorgänge
// Ab welcher Entfernung (m) das Symbol das 3D-Modell ablöst: [ganz aus, ganz an]
const ICON_FADE = { player: [40, 120], vehicle: [60, 170], base: [350, 800] };
const PICK_PX = 12;
const LABEL_RANGE = { player: 4000, offline: 1000, vehicle: 450, base: 1200 };

export class LiveLayer {
  constructor({ world, camera, canvas }) {
    Object.assign(this, { camera, canvas });
    this.group = new THREE.Group();
    world.add(this.group);
    this.buildables = new Buildables();
    // Live-Positionen aus dem Agenten; nur aktiv, wenn der Server einen hat (agentEnabled)
    this.agent = new AgentLayer({ group: this.group, camera, canvas, vehicleType, subtypeName });
    this.agentEnabled = false;
    this.map = null;
    this.data = { players: [], overlays: [], poi: [], spice: [] };
    this.fetchedAt = {};
    this.errors = {};
    this.timers = [];
    this.partition = null;
    this.show = Object.fromEntries([...TOGGLES, ...CATEGORIES.map((c) => ({ key: c.key, on: false }))].map((t) => [t.key, t.on]));
    this.players = new Map();
    this.vehicles = new Map();
    this.bases = new Map();
    this.layers = {};          // Kategorie → { rows, points, meshes[] }
    this.heights = new Map();  // "x,y" → z (cm) für Markierungen ohne Höhe
    this.selected = null;
    this.exports = new Map();  // Basis-ID → Export (zuletzt benutzt am Ende)
    this.frustum = new THREE.Frustum();
    this.onStatus = null;
    this.onSelect = null;
    this.onPlayers = null;
    this.highlight = new THREE.Mesh(
      new THREE.RingGeometry(3, 4.2, 32).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true, opacity: 0.9 }),
    );
    this.highlight.visible = false;
    this.highlight.renderOrder = 11;
    this.group.add(this.highlight);

    let down = null;
    canvas.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
    canvas.addEventListener('pointerup', (e) => {
      if (!this.map || !down || e.button !== 0) return;
      if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;
      this.select(this.pick(e.clientX, e.clientY));
    });
  }

  // Karte bzw. Serverinstanz wechseln; meta.live leer = keine Live-Daten.
  // partition: nur Spieler, Basen, Fahrzeuge und Lager dieser Instanz zeigen.
  setMap(meta, partition = null) {
    this.stop();
    this.clear();
    this.partition = partition;
    this.map = meta.live ? meta.name : null;
    this.select(null);
    if (this.map) this.start();
    else this.onPlayers?.([]);
  }

  start() {
    for (const [feed, every] of Object.entries(FEEDS)) {
      this.refresh(feed);
      this.timers.push(setInterval(() => this.refresh(feed), every));
    }
    this.timers.push(setInterval(() => this.updateBases(), 500));
    if (this.agentEnabled) this.agent.start(this.map, this.partition);
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.agent.stop();
  }

  clear() {
    for (const m of [this.players, this.vehicles]) {
      for (const p of m.values()) this.group.remove(p.obj);
      m.clear();
    }
    for (const b of this.bases.values()) this.removeBase(b);
    this.bases.clear();
    this.exports.clear();
    for (const l of Object.values(this.layers)) this.removeLayer(l);
    this.layers = {};
    this.data = { players: [], overlays: [], poi: [], spice: [] };
    this.fetchedAt = {};
    this.errors = {};
  }

  async refresh(feed) {
    const map = this.map;
    try {
      const res = await api.liveFeed(map, feed);
      if (map !== this.map) return;
      this.data[feed] = res.rows ?? [];
      this.fetchedAt[feed] = Date.now();
      delete this.errors[feed];
      if (feed === 'players') this.syncPlayers();
      if (feed === 'overlays') { this.syncVehicles(); this.syncBases(); this.syncLayers(); }
      if (feed === 'poi' || feed === 'spice') this.syncLayers();
    } catch (e) {
      this.errors[feed] = e.message;
      console.warn('Live', feed, e);
    }
    this.status();
  }

  // Zeile gehört zur gewählten Serverinstanz? Weltobjekte ohne Partition gelten überall.
  inPartition(row) {
    return this.partition === null || row.partition_id === undefined || row.partition_id === null
      || Number(row.partition_id) === this.partition;
  }

  setShow(key, on) {
    this.show[key] = on;
    this.agent.setShow(key, on);
    this.applyVisibility();
    if (key === 'bases3d' || key === 'bases') this.updateBases();
  }

  applyVisibility() {
    for (const p of this.players.values()) {
      p.obj.visible = p.online ? this.show.players : this.show.offline;
      p.beam.visible = this.show.beams;
    }
    for (const v of this.vehicles.values()) v.obj.visible = this.show.vehicles;
    for (const b of this.bases.values()) {
      b.obj.visible = this.show.bases;
      if (b.building) b.building.visible = this.show.bases && this.show.bases3d;
    }
    for (const [k, l] of Object.entries(this.layers)) {
      for (const m of [...l.points, ...l.meshes]) m.visible = !!this.show[k];
    }
    this.cullLabels();
  }

  // ---------- Spieler ----------
  syncPlayers() {
    const seen = new Set();
    for (const row of this.data.players) {
      if (!Number.isFinite(row.x) || !this.inPartition(row)) continue;
      const online = row.online_status === 'Online';
      seen.add(row.id);
      let p = this.players.get(row.id);
      if (p && p.online !== online) { this.group.remove(p.obj); p = null; }
      const pos = ueToThree(row.x, row.y, row.z);
      if (!p) {
        const obj = playerModel(online);
        const lab = label(row.name, { color: online ? '#ffd9a8' : '#cccccc' });
        lab.position.y = 3;
        const icon = iconSprite(iconFor(online ? 'players' : 'offline', row));
        icon.position.y = 1;
        obj.add(lab, icon);
        obj.position.copy(pos);
        p = { obj, label: lab, icon, fade: ICON_FADE.player, beam: obj.children[2], target: pos.clone(), online, row };
        this.players.set(row.id, p);
        this.group.add(obj);
      }
      p.row = row;
      p.target.copy(pos);
    }
    for (const [id, p] of this.players) {
      if (!seen.has(id)) { this.group.remove(p.obj); this.players.delete(id); }
    }
    this.applyVisibility();
    this.onPlayers?.(this.onlinePlayers());
  }

  onlinePlayers() {
    return [...this.players.values()].filter((p) => p.online).map((p) => p.row)
      .sort((a, b) => a.name.localeCompare(b.name, 'de'));
  }

  playerPosition(id) { return this.players.get(id)?.obj.position ?? null; }

  // ---------- Fahrzeuge ----------
  syncVehicles() {
    const seen = new Set();
    for (const row of this.data.overlays) {
      if (row.type !== 'vehicle' || !Number.isFinite(row.x) || !this.inPartition(row)) continue;
      seen.add(row.id);
      let v = this.vehicles.get(row.id);
      if (!v) {
        const subtype = vehicleType(row.class ?? row.name);
        const obj = vehicleModel(subtype);
        const lab = label(`${subtypeName(subtype)}${row.owner_name ? ` · ${row.owner_name}` : ''}`, { color: '#cfe3ff', size: 20 });
        lab.position.y = 6;
        const icon = iconSprite(iconFor('vehicles', { subtype }));
        icon.position.y = 2;
        obj.add(lab, icon);
        v = { obj, label: lab, icon, fade: ICON_FADE.vehicle, row, subtype };
        this.vehicles.set(row.id, v);
        this.group.add(obj);
      }
      v.row = row;
      v.obj.position.copy(ueToThree(row.x, row.y, row.z));
    }
    for (const [id, v] of this.vehicles) {
      if (!seen.has(id)) { this.group.remove(v.obj); this.vehicles.delete(id); }
    }
    this.applyVisibility();
  }

  // ---------- Basen ----------
  syncBases() {
    const seen = new Set();
    for (const row of this.data.overlays) {
      if (row.type !== 'base' || !Number.isFinite(row.x) || !this.inPartition(row)) continue;
      seen.add(row.id);
      if (this.bases.has(row.id)) { this.bases.get(row.id).row = row; continue; }
      const obj = basePin();
      const lab = label(`${row.name}${row.owner_name ? ` (${row.owner_name})` : ''}`, { color: '#bfe1ff' });
      lab.position.y = 31;
      const icon = iconSprite(iconFor('bases', row));
      icon.position.y = 4;
      obj.add(lab, icon);
      obj.position.copy(ueToThree(row.x, row.y, row.z));
      this.bases.set(row.id, { obj, label: lab, icon, fade: ICON_FADE.base, row, building: null, state: 'none', outSince: 0 });
      this.group.add(obj);
    }
    for (const [id, b] of this.bases) {
      if (!seen.has(id)) { this.removeBase(b); this.bases.delete(id); }
    }
    this.applyVisibility();
    this.updateBases();
  }

  removeBase(b) {
    this.group.remove(b.obj);
    this.dropBuilding(b);
  }

  // Gebäude aus der Szene nehmen; die Bauteil-Netze teilen sich alle Basen und
  // bleiben, freigegeben werden nur die Instanzdaten dieser Basis.
  dropBuilding(b) {
    if (b.building) {
      this.group.remove(b.building);
      b.building.traverse((o) => o.isInstancedMesh && o.dispose());
    }
    b.building = null;
    b.state = 'none';
  }

  // Nur Basen im Sichtfeld (bzw. im Umkreis der Kamera) als 3D-Gebäude laden,
  // alle anderen verwerfen. Die nächsten zuerst.
  updateBases() {
    if (!this.map) return;
    if (!this.show.bases || !this.show.bases3d) {
      for (const b of this.bases.values()) if (b.building || b.state === 'loading') this.dropBuilding(b);
      return;
    }
    const cam = this.camera.position;
    this.camera.updateMatrixWorld();
    this.frustum.setFromProjectionMatrix(
      new THREE.Matrix4().multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse));
    const sphere = new THREE.Sphere();
    const now = performance.now();
    let loading = 0;
    const want = [];
    for (const b of this.bases.values()) {
      if (b.state === 'loading') loading++;
      b.obj.getWorldPosition(sphere.center);
      const d = sphere.center.distanceTo(cam);
      sphere.radius = BASE_RADIUS;
      const inView = d < BASE_VIEW_RANGE && this.frustum.intersectsSphere(sphere);
      b.inView = inView;
      if (inView || d < BASE_AROUND) {
        b.outSince = 0;
        if (b.state === 'none') want.push({ b, d });
        continue;
      }
      if (!b.building) continue;
      // knapp außerhalb: kurz behalten, damit Schwenken nicht ständig neu aufbaut
      if (d > BASE_KEEP_RANGE) { this.dropBuilding(b); continue; }
      b.outSince ||= now;
      if (now - b.outSince > BASE_GRACE_MS) this.dropBuilding(b);
    }
    want.sort((x, y) => x.d - y.d);
    for (const { b } of want) {
      if (loading >= BASE_PARALLEL) break;
      loading++;
      this.loadBase(b);
    }
    this.status();
  }

  async loadBase(b) {
    b.state = 'loading';
    const token = (b.loadToken = {});
    try {
      const exp = await this.baseExport(b.row.id);
      b.export = exp;
      const building = await this.buildables.buildBase(exp);
      // inzwischen verworfen, Karte gewechselt oder Basis weg?
      if (b.loadToken !== token || b.state !== 'loading' || this.bases.get(b.row.id) !== b) {
        building.traverse((o) => o.isInstancedMesh && o.dispose());
        return;
      }
      b.building = building;
      b.state = 'ready';
      this.group.add(building);
      this.applyVisibility();
    } catch (e) {
      console.warn('Basis', b.row.id, e);
      if (b.loadToken === token) b.state = 'error';
    }
    this.status();
  }

  // Export einer Basis, die zuletzt benutzten bleiben im Speicher
  async baseExport(id) {
    let exp = this.exports.get(id);
    if (exp) {
      this.exports.delete(id);
    } else {
      exp = await api.liveBase(id);
    }
    this.exports.set(id, exp);
    while (this.exports.size > BASE_EXPORT_CACHE) this.exports.delete(this.exports.keys().next().value);
    return exp;
  }

  // ---------- Orte, Gefahren, Ressourcen ----------
  syncLayers() {
    const rows = [...this.data.poi, ...this.data.spice, ...this.data.overlays.filter((r) => r.type === 'storage')]
      .filter((r) => Number.isFinite(r.x) && this.inPartition(r));
    const missing = [];
    for (const cat of CATEGORIES) {
      // Die Console liefert manche Orte doppelt; gleiche Art an gleicher Stelle nur einmal
      const seen = new Set();
      const list = rows.filter(cat.match).filter((r) => {
        const k = `${r.type}|${r.subtype ?? ''}|${Math.round(r.x / 100)}|${Math.round(r.y / 100)}`;
        return !seen.has(k) && seen.add(k);
      });
      if (this.layers[cat.key]) this.removeLayer(this.layers[cat.key]);
      const positions = list.map((r) => {
        let z = r.z;
        if (!z) {
          z = this.heights.get(`${r.x},${r.y}`);
          if (z === undefined) { missing.push(r); z = 0; }
        }
        return ueToThree(r.x, r.y, z ?? 0);
      });
      const layer = { rows: list, positions, points: iconGroups(cat, list, positions), meshes: instanced(cat, list, positions) };
      this.layers[cat.key] = layer;
      const objs = [...layer.points, ...layer.meshes];
      if (objs.length) this.group.add(...objs); // leere Kategorie: nichts hinzufügen
    }
    if (missing.length) this.sampleHeights(missing);
    this.applyVisibility();
  }

  removeLayer(l) {
    const objs = [...l.points, ...l.meshes];
    if (objs.length) this.group.remove(...objs);
    for (const p of l.points) { p.geometry.dispose(); p.material.dispose(); }
    for (const m of l.meshes) m.dispose();
  }

  // Höhen für Markierungen ohne Z (Spice, Gefahren) vom Gelände holen
  async sampleHeights(rows) {
    const uniq = [...new Map(rows.map((r) => [`${r.x},${r.y}`, r])).values()];
    try {
      const zs = await api.sample(this.map, uniq.map((r) => [r.x, r.y]));
      uniq.forEach((r, i) => this.heights.set(`${r.x},${r.y}`, zs[i] ?? 0));
      this.syncLayers();
    } catch (e) { console.warn('Höhen', e); }
  }

  // ---------- Auswahl ----------
  // Sucht das Objekt nächst am Mauszeiger (Bildschirmabstand).
  pick(clientX, clientY) {
    const r = this.canvas.getBoundingClientRect();
    const v = new THREE.Vector3();
    const w = new THREE.Vector3();
    let best = null, bestD = PICK_PX;
    const test = (local, item) => {
      v.copy(local);
      this.group.localToWorld(v);
      v.project(this.camera);
      if (v.z > 1) return;
      const x = (v.x + 1) / 2 * r.width + r.left, y = (1 - v.y) / 2 * r.height + r.top;
      const d = Math.hypot(x - clientX, y - clientY);
      if (d < bestD) { bestD = d; best = item; }
    };
    for (const p of this.players.values()) if (p.obj.visible) test(w.copy(p.obj.position).setY(p.obj.position.y + 1), { kind: 'player', row: p.row, obj: p.obj });
    for (const x of this.vehicles.values()) if (x.obj.visible) test(x.obj.position, { kind: 'vehicle', row: x.row, obj: x.obj });
    for (const b of this.bases.values()) if (b.obj.visible) test(w.copy(b.obj.position).setY(b.obj.position.y + 20), { kind: 'base', row: b.row, obj: b.obj, base: b });
    for (const cat of CATEGORIES) {
      const l = this.layers[cat.key];
      if (!l || !this.show[cat.key]) continue;
      l.positions.forEach((p, i) => test(p, { kind: cat.key, row: l.rows[i], local: p }));
    }
    this.agent.pick(test);
    return best;
  }

  select(item) {
    this.selected = item;
    this.highlight.visible = !!item;
    if (item) this.highlight.position.copy(item.local ?? item.obj.position);
    this.onSelect?.(item, item ? describe(item) : null);
  }

  // ---------- Pro Frame ----------
  update(dt) {
    if (!this.map) return;
    const k = 1 - Math.exp(-dt * 3); // weiche Bewegung zwischen zwei Abrufen
    for (const p of this.players.values()) p.obj.position.lerp(p.target, k);
    this.agent.update(dt);
    if (this.selected?.obj) this.highlight.position.copy(this.selected.obj.position);
    const s = 1 + 0.15 * Math.sin(performance.now() / 250);
    const d = this.camera.position.distanceTo(this.highlight.getWorldPosition(new THREE.Vector3()));
    this.highlight.scale.setScalar(s * Math.max(1, d / 150));
    this.updateIcons();
    this.cullLabels();
  }

  // Symbole von Spielern, Fahrzeugen und Basen: feste Bildschirmgröße, nah an
  // der Kamera ausgeblendet (dort steht das 3D-Modell). Der Name rückt über das Symbol.
  updateIcons() {
    const h = this.canvas.clientHeight || innerHeight;
    const unit = spriteScale(this.camera, h, 1);
    const cam = this.camera.position;
    const w = new THREE.Vector3();
    for (const m of [this.players, this.vehicles, this.bases]) {
      for (const e of m.values()) {
        if (!e.obj.visible) continue;
        const d = e.obj.getWorldPosition(w).distanceTo(cam);
        const a = THREE.MathUtils.smoothstep(d, e.fade[0], e.fade[1]);
        const shrink = 1 - 0.45 * THREE.MathUtils.smoothstep(d, 2500, 20000); // wie iconPoints
        const px = e.icon.userData.px * shrink;
        e.icon.visible = a > 0.01;
        e.icon.material.opacity = a;
        e.icon.scale.set(px * unit, px * unit, 1);
        if (e.label.visible) {
          const labelPx = e.label.scale.y / unit;
          e.label.center.y = a > 0.01 ? -(px * 0.5 * a + 2) / labelPx : 0;
        }
      }
    }
  }

  // Namen nach Entfernung ein-/ausblenden
  cullLabels() {
    const c = this.camera.position;
    const near = (o, r) => Math.hypot(o.position.x - c.x, o.position.z - c.z) < r;
    const on = this.show.labels;
    for (const p of this.players.values()) p.label.visible = on && near(p.obj, p.online ? LABEL_RANGE.player : LABEL_RANGE.offline);
    for (const v of this.vehicles.values()) v.label.visible = on && near(v.obj, LABEL_RANGE.vehicle);
    for (const b of this.bases.values()) b.label.visible = on && near(b.obj, LABEL_RANGE.base);
  }

  status() {
    const online = [...this.players.values()].filter((p) => p.online).length;
    const age = this.fetchedAt.players ? Math.round((Date.now() - this.fetchedAt.players) / 1000) : null;
    const built = [...this.bases.values()].filter((b) => b.state === 'ready').length;
    const inView = [...this.bases.values()].filter((b) => b.inView).length;
    const err = Object.entries(this.errors).map(([f, m]) => `${f}: ${m}`).join('\n');
    this.onStatus?.(
      t('live.status', { online, bases: this.bases.size, built, inView })
      + (age !== null ? t('live.age', { age }) : t('live.loading'))
      + (this.agentEnabled && this.agent.statusText() ? `\n${this.agent.statusText()}` : '')
      + (err ? `\n⚠ ${err}` : ''),
    );
  }
}

// ---------- Darstellung der Kategorien ----------

// 3D-Modelle je Kategorie als InstancedMesh (eins je Modell), mit Zufallsdrehung
function instanced(cat, rows, positions) {
  const groups = new Map();
  rows.forEach((r, i) => {
    const key = typeof cat.model === 'function' ? cat.model(r) : cat.model;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(i);
  });
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const one = new THREE.Vector3(1, 1, 1);
  const up = new THREE.Vector3(0, 1, 0);
  const c = new THREE.Color();
  return [...groups].map(([key, idx]) => {
    const { geometry, material } = worldModel(key);
    const mesh = new THREE.InstancedMesh(geometry, material, idx.length);
    idx.forEach((i, n) => {
      q.setFromAxisAngle(up, hashAngle(rows[i].id ?? i));
      mesh.setMatrixAt(n, m.compose(positions[i], q, one));
      mesh.setColorAt(n, c.set(cat.tint ? cat.tint(rows[i]) : 0xffffff));
    });
    mesh.computeBoundingSphere();
    return mesh;
  });
}

const hashAngle = (id) => {
  let h = 0;
  for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return (h % 628) / 100;
};

// Symbole für die Fernansicht: je Bild eine Punktwolke (z. B. je Erzsorte)
function iconGroups(cat, rows, positions) {
  const groups = new Map();
  rows.forEach((r, i) => {
    const icon = iconFor(cat.key, r);
    if (!groups.has(icon.id)) groups.set(icon.id, { icon, pos: [], size: [] });
    const g = groups.get(icon.id);
    g.pos.push(positions[i].clone().setY(positions[i].y + 3));
    g.size.push(icon.px);
  });
  return [...groups.values()].map((g) => iconPoints(g.icon, g.pos, g.size));
}

// ---------- Beschreibungen ----------
const VEHICLES = ['TransportOrnithopter', 'MediumOrnithopter', 'LightOrnithopter', 'SandCrawler', 'TreadWheel', 'ContainerVehicle', 'Sandbike', 'Buggy'];
function vehicleType(cls = '') {
  return VEHICLES.find((v) => cls.includes(v)) ?? (/Ornithopter/i.test(cls) ? 'LightOrnithopter' : 'Unbekannt');
}
const subtypeName = (s) => t(`veh.${s}`);

// Titel, Symbol und Zeilen für das Infofeld
function describe({ kind, row, base }) {
  const lines = [];
  const add = (k, v) => { if (v !== undefined && v !== null && v !== '') lines.push([k, String(v)]); };
  let title = row.name ?? row.subtypeLabel ?? kind;
  let icon = kind;
  switch (kind) {
    case 'player':
      icon = row.online_status === 'Online' ? 'players' : 'offline';
      add(t('field.status'), row.online_status);
      add(t('field.funcom'), row.funcom_id);
      break;
    case 'vehicle':
      icon = 'vehicles';
      title = subtypeName(vehicleType(row.class ?? row.name));
      add(t('field.owner'), row.owner_name);
      break;
    case 'base':
      icon = 'bases';
      add(t('field.type'), row.base_type);
      add(t('field.owner'), row.owner_name);
      if (base?.export) {
        add(t('field.pieces'), fmtInt(base.export.piece_count));
        add(t('field.placeables'), fmtInt(base.export.placeable_count));
      } else {
        add(t('field.3d'), base?.state === 'error' ? t('base.unavailable') : base?.state === 'loading' ? t('base.loading') : t('base.closer'));
      }
      break;
    case 'worm': case 'npc': case 'civilian':
      icon = kind;
      title = row.name;
      add(t('field.category'), t(`agent.kind.${kind}`));
      if (kind !== 'worm') add(t('field.kind'), row.class);
      break;
    case 'liveVehicle':
      icon = 'vehicles';
      title = subtypeName(vehicleType(row.class));
      add(t('field.category'), t('toggle.liveVehicles'));
      break;
    default: {
      const cat = CATEGORIES.find((c) => c.key === kind);
      const catLabel = cat ? t(`cat.${cat.key}`) : kind;
      title = row.subtypeLabel ?? row.name ?? catLabel;
      add(t('field.category'), catLabel);
      if (row.subtype && row.subtype !== title) add(t('field.kind'), row.subtype);
      if (row.item_count !== undefined) add(t('field.contents'), t('field.items', { n: row.item_count }));
    }
  }
  add(t('field.partition'), row.partition_id);
  add(t('field.position'), `X ${fmtInt(row.x)} · Y ${fmtInt(row.y)}${row.z ? ` · Z ${fmtInt(row.z)}` : ''}`);
  const spec = kind === 'player' ? iconFor(icon, row) : kind === 'base' ? iconFor('bases', row)
    : kind === 'vehicle' || kind === 'liveVehicle' ? iconFor('vehicles', { subtype: vehicleType(row.class ?? row.name) }) : iconFor(kind, row);
  return { title, icon, spec, lines };
}

// MapViewer 3D v2 - Addon-Seite (läuft in der Console-Sandbox: kein Netzwerk, nur die Addon-Brücke).
(async function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const POLL_MS = 6000; // weit unter dem Limit der Brücke (60 Aufrufe/Minute)
  const SQL_PLAYERS = "select ((a.transform).location).x as x, ((a.transform).location).y as y, ((a.transform).location).z as z, " +
    "coalesce(a.map,'') as map, coalesce(ps.online_status::text,'') as status, coalesce(nullif(ps.character_name,''),'?') as name " +
    "from dune.actors a join dune.player_state ps on ps.player_pawn_id = a.id where a.transform is not null limit 3000";
  const SQL_BASES = "select ((a.transform).location).x as x, ((a.transform).location).y as y, ((a.transform).location).z as z, " +
    "coalesce(a.map,'') as map from dune.buildings b join dune.building_instances bi on bi.building_id = b.id " +
    "join dune.actor_fgl_entities afe on afe.entity_id = bi.owner_entity_id join dune.actors a on a.id = afe.actor_id " +
    "where a.transform is not null group by a.id, a.map, a.transform limit 3000";

  UI.add({
    en: {
      'g.world': 'World', 'l.online': 'Players online', 'l.offline': 'Players offline', 'l.bases': 'Bases',
      'start.title': 'Set up the companion (optional)', 'start.intro': 'In the console this addon reads players and bases through the console bridge (read-only, permission database:read). Realtime Data is built into the console API, but the console bridge offers no realtime action to addons. Sandworms and enemies, the full 1 m terrain and the API-token sign-in therefore run in the companion: it asks for your token on its own start screen. The console sandbox has no network access, so a token cannot be used here and is not requested.',
      'start.companion': 'Companion address (optional)', 'start.continue': 'Save', 'start.bad': 'Only https:// (or http://localhost) without credentials.',
      'conn.console': 'Dune Docker Console', 'conn.console.yes': 'detected', 'conn.console.no': 'not detected (preview outside the console)', 'conn.bridge': 'Console bridge', 'conn.db': 'Game data (database:read)', 'conn.rt': 'Realtime Data', 'conn.rt.off': 'only in the companion (sandbox without network)',
      'conn.ok': 'connected', 'conn.preview': 'preview outside the console', 'conn.companion': 'Companion', 'conn.change': 'Companion address …', 'conn.none': 'not set',
      'live.status': '{0} players, {1} bases', 'terrain': 'Terrain (embedded): {0}×{0} points · {1} m grid', 'hq': 'Finer terrain (slower)', 'models': '3D models for markers (off: icons only)', 'saved': 'Saved. Open this address in a new browser tab.',
    },
    de: {
      'g.world': 'Welt', 'l.online': 'Spieler online', 'l.offline': 'Spieler offline', 'l.bases': 'Basen',
      'start.title': 'Companion einrichten (optional)', 'start.intro': 'In der Console liest dieses Addon Spieler und Basen über die Console-Brücke (nur lesend, Berechtigung database:read). Realtime Data steckt in der Console-API, aber die Console-Brücke bietet Addons keine Realtime-Aktion. Sandwürmer und Gegner, das volle 1-m-Gelände und die Anmeldung mit API-Token laufen deshalb im Companion: Er fragt den Token auf seinem eigenen Startbildschirm ab. Die Console-Sandbox hat kein Netzwerk, ein Token ist hier nicht nutzbar und wird deshalb nicht abgefragt.',
      'start.companion': 'Adresse des Companion (optional)', 'start.continue': 'Speichern', 'start.bad': 'Nur https:// (oder http://localhost) ohne Zugangsdaten.',
      'conn.console': 'Dune Docker Console', 'conn.console.yes': 'erkannt', 'conn.console.no': 'nicht erkannt (Vorschau außerhalb der Console)', 'conn.bridge': 'Console-Brücke', 'conn.db': 'Spieldaten (database:read)', 'conn.rt': 'Realtime Data', 'conn.rt.off': 'nur im Companion (Sandbox ohne Netzwerk)',
      'conn.ok': 'verbunden', 'conn.preview': 'Vorschau außerhalb der Console', 'conn.companion': 'Companion', 'conn.change': 'Companion-Adresse …', 'conn.none': 'nicht gesetzt',
      'live.status': '{0} Spieler, {1} Basen', 'terrain': 'Gelände (eingebettet): {0}×{0} Punkte · {1} m Raster', 'hq': 'Feineres Gelände (langsamer)', 'models': '3D-Modelle für Marker (aus: nur Symbole)', 'saved': 'Gespeichert. Öffne diese Adresse in einem neuen Browser-Tab.',
    },
  });

  const TERRAIN = { hagga: JSON.parse($('t-hagga').textContent), deep: JSON.parse($('t-deep').textContent) };
  const env = MV.createEnv($('view'), document.documentElement);
  (async () => { // eingebettete Körper von Wurm, Figur und Fahrzeugen (aus dem cdn-Branch, siehe tools/embed-creatures.mjs)
    try {
      const d = JSON.parse($('t-creatures').textContent);
      if (d && d.index && d.meshes) await MV.Creatures.load({ index: d.index, bin: async (id) => { const s = atob(String(d.meshes[id] || '')), u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u.buffer; } });
    } catch { /* Platzhalter-Modelle bleiben */ }
  })();
  const pts = { online: MV.Layer(env, 'player', 0x2f9bff, 11, { glyph: 'player', px: 34, overlay: true, lift: 6, fade: [40, 120] }), offline: MV.Layer(env, 'player', 0x3a6a8a, 6, { glyph: 'offline', px: 28, fade: [40, 120] }), bases: MV.Layer(env, 'base', 0xff8a1f, 9, { glyph: 'base', px: 34, fade: [350, 800] }) };
  const labels = MV.Labels(env), beams = MV.Beams(env); // Namen und Leuchtsäulen wie im Dune Map Viewer
  const lay = UI.layers([{ id: 'w', label: 'g.world' }], [
    { key: 'online', label: 'l.online', color: '#2f9bff', group: 'w', cls: 'mv-glyph-player' }, { key: 'offline', label: 'l.offline', color: '#3a6a8a', group: 'w', cls: 'mv-glyph-offline' }, { key: 'bases', label: 'l.bases', color: '#ff8a1f', group: 'w', cls: 'mv-glyph-base' },
    { key: 'labels', label: 'l.labels', color: '#bfe1ff', group: 'w', cls: 'mv-glyph-labels' }, { key: 'beams', label: 'l.beams', color: '#ff9d2e', group: 'w', cls: 'mv-glyph-beams' },
  ], (k, on) => { if (k === 'labels') labels.setOn(on); else if (k === 'beams') beams.setOn(on); else { pts[k].obj.visible = on; labels.setKind(k, on); } });
  // Standard wie im Dune Map Viewer: Spieler online, Basen und Namen an; offline und Leuchtsäulen aus
  { const rows = document.querySelectorAll('#layers input'); const off = ['offline', 'beams']; const keys = ['online', 'offline', 'bases', 'labels', 'beams']; rows.forEach((cb, i) => { if (off.includes(keys[i])) { cb.checked = false; cb.onchange(); } }); }

  let current = 'hagga', showGen = 0, rows = { players: [], bases: [] }, hq = false, companion = '', bridgeState = ['', ''], terrainArgs = null;
  const mapKey = (m) => (/deep/i.test(m) ? 'deep' : /survival|hagga/i.test(m) ? 'hagga' : null);
  const pick = (r) => (Array.isArray(r) ? r : (r && Array.isArray(r.rows) ? r.rows : []));
  const pt = (r) => ({ x: MV.cm2m(r.x), y: MV.cm2m(r.y), z: MV.cm2m(r.z) });

  // Erkannt gilt erst, wenn die Console-Brücke wirklich geantwortet hat (nicht schon bei einem bloßen Rahmen)
  let consoleState = 'wait'; // 'wait' | 'yes' | 'no'
  function renderConn() {
    UI.conn([
      UI.t('conn.console') + ': ' + (consoleState === 'wait' ? '…' : UI.t(consoleState === 'yes' ? 'conn.console.yes' : 'conn.console.no')),
      UI.t('conn.bridge') + ': ' + bridgeState[0], UI.t('conn.db') + ': ' + bridgeState[1],
      UI.t('conn.rt') + ': ' + UI.t('conn.rt.off'),
      UI.t('conn.companion') + ': ' + (companion || UI.t('conn.none')),
    ].concat(storeNote ? [storeNote] : []).join('\n'));
    UI.mapinfo(terrainArgs ? UI.t('terrain', terrainArgs[0], terrainArgs[1]) : '');
  }
  UI.onLang(() => { renderConn(); applyRows(); });

  async function showMap(key, keepCamera) {
    current = key; const gen = ++showGen; env.clear();
    const t = TERRAIN[key];
    if (!keepCamera) env.setMeta({ originX: t.originX, originY: t.originY, minZ: t.minZ, maxZ: t.maxZ, width: t.grid, spacing: t.extent / (t.grid - 1) });
    const terrain = await MV.CoarseTerrain(env, t, hq ? 1 : 2);
    if (gen !== showGen) { terrain.remove(); return; } // überholt von einem neueren Aufruf
    const n = Math.floor((t.grid - 1) / (hq ? 1 : 2)) + 1;
    terrainArgs = [n, Math.round(t.extent / 100 / (n - 1))];
    renderConn(); applyRows();
  }

  function applyRows() {
    const on = [], off = [], bs = [], list = [];
    for (const r of rows.players) {
      if (mapKey(r.map) !== current || !Number.isFinite(+r.x)) continue;
      const isOn = /^online$/i.test(String(r.status).trim());
      (isOn ? on : off).push(pt(r));
      if (isOn) { const p = pt(r); list.push({ label: String(r.name || '?').slice(0, 40), pick: () => env.jump(p.x, p.y, p.z, 120) }); }
    }
    for (const r of rows.bases) if (mapKey(r.map) === current && Number.isFinite(+r.x)) bs.push(pt(r));
    pts.online.set(on); pts.offline.set(off); pts.bases.set(bs); beams.set(on);
    const nm = (r) => String(r.name || '?').slice(0, 40), lb = (arr, f) => arr.map(f);
    labels.set('online', lb(rows.players.filter((r) => mapKey(r.map) === current && Number.isFinite(+r.x) && /^online$/i.test(String(r.status).trim())), (r) => Object.assign(pt(r), { text: nm(r), range: 4000, px: 34, color: '#ffe9c7' })));
    labels.set('offline', lb(rows.players.filter((r) => mapKey(r.map) === current && Number.isFinite(+r.x) && !/^online$/i.test(String(r.status).trim())), (r) => Object.assign(pt(r), { text: nm(r), range: 1000, px: 28, color: '#ffe9c7' })));
    labels.set('bases', bs.map((p) => Object.assign({}, p, { text: UI.t('name.base'), range: 1200, px: 34, color: '#cfe3ff' })));
    lay.count('online', on.length); lay.count('offline', off.length); lay.count('bases', bs.length);
    UI.players(list); UI.status(UI.t('live.status', rows.players.filter((r) => mapKey(r.map) === current).length, bs.length));
  }

  let polling = false;
  async function poll() {
    if (polling) return; polling = true;
    try {
      const [p, b] = await Promise.all([DuneAddon.request('database.query', { query: SQL_PLAYERS }), DuneAddon.request('database.query', { query: SQL_BASES })]);
      rows = { players: pick(p), bases: pick(b) };
      consoleState = 'yes'; bridgeState = [UI.t('conn.ok'), rows.players.length + ' / ' + rows.bases.length];
      applyRows();
    } catch (e) {
      consoleState = window.parent === window ? 'no' : 'wait'; // im Rahmen, aber ohne Antwort: weiter prüfen
      bridgeState = [window.parent === window ? UI.t('conn.preview') : String(e && e.message || e).slice(0, 80), '–'];
    }
    polling = false; renderConn();
  }

  // ---- Einstellung: Adresse des Companion (nur Anzeige; die Sandbox darf dorthin nichts senden)
  const okUrl = (u) => { try { const x = new URL(u); return (x.protocol === 'https:' || (x.protocol === 'http:' && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(x.hostname))) && !x.username && !x.password; } catch (e) { return false; } };
  let storeNote = '';
  async function saveCompanion(u) {
    if (u && !okUrl(u)) return UI.t('start.bad');
    if (u === companion) return null;               // unverändert: nichts schreiben
    companion = u; storeNote = '';
    try {
      let ver = null; try { const e = await DuneAddon.request('addon.storage.get', { key: 'settings' }); ver = e && e.version != null ? e.version : null; } catch (x) { /* neu anlegen */ }
      await DuneAddon.request('addon.storage.put', { key: 'settings', value: { companionUrl: u }, expectedVersion: ver });
    } catch (x) { if (window.parent !== window) storeNote = String(x && x.message || x).slice(0, 80); } // Speichern ist nicht lebenswichtig: Dialog bleibt nicht hängen
    renderConn(); return null;
  }
  const startDialog = () => UI.dialog({
    title: UI.t('start.title'), intro: UI.t('start.intro'), submit: UI.t('start.continue'), cancel: UI.t('cancel'),
    fields: [{ name: 'companion', label: UI.t('start.companion'), placeholder: 'https://…', value: companion }],
    onSubmit: (v) => saveCompanion(v.companion),
  });
  // gespeicherte Adresse nachladen, ohne den Start zu blockieren
  DuneAddon.request('addon.storage.get', { key: 'settings' }).then((e) => {
    const v = e && (e.value || e);
    if (v && typeof v.companionUrl === 'string' && okUrl(v.companionUrl) && !companion) {
      companion = v.companionUrl; renderConn();
      const i = document.querySelector('#setupFields input[name=companion]'); if (i && !i.value) i.value = companion;
    }
  }).catch(() => { /* noch nichts gespeichert oder Vorschau */ });

  $('map').onchange = (e) => showMap(e.target.value);
  const buttons = () => { UI.clearButtons(); UI.button(UI.t('conn.change'), startDialog); };
  buttons(); UI.onLang(buttons);
  UI.toggle('hq', (on) => { hq = on; showMap(current, true); });
  UI.toggle('models', (on) => MV.Layer.setModels(on), true);
  UI.followCursor(env);
  UI.clickPick($('view'), (x, y) => {
    for (const k in pts) { const h = pts[k].nearest(x, y, 12); if (h) return { title: UI.t('l.' + k), lines: [[UI.t('info.pos'), Math.round(h.x) + ' / ' + Math.round(h.y) + ' · ' + Math.round(h.z) + ' m']], pick: () => env.jump(h.x, h.y, h.z, 120) }; }
    return null;
  });

  renderConn();
  // Kein Startdialog: Die Console wird automatisch erkannt. Die Companion-Adresse ist optional (Knopf im Bereich Verbindung).
  await showMap('hagga');
  poll(); setInterval(poll, POLL_MS);
})();

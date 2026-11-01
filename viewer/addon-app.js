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
      'start.title': 'Connect to your Dune Docker server', 'start.intro': 'In the console this addon reads players and bases through the console bridge (read-only, permission database:read). Realtime Data (sandworms, enemies), the full 1 m terrain and the API-token sign-in run in the companion: it asks for your token on its own start screen. The console sandbox has no network access, so a token cannot be used here and is not requested.',
      'start.companion': 'Companion address (optional)', 'start.continue': 'Continue', 'start.bad': 'Only https:// (or http://localhost) without credentials.',
      'conn.bridge': 'Console bridge', 'conn.db': 'Game data (database:read)', 'conn.rt': 'Realtime Data', 'conn.rt.off': 'only in the companion (sandbox without network)',
      'conn.ok': 'connected', 'conn.preview': 'preview outside the console', 'conn.companion': 'Companion', 'conn.change': 'Companion address …', 'conn.none': 'not set',
      'live.status': '{0} players, {1} bases', 'terrain': 'Terrain (embedded): {0}×{0} points · {1} m grid', 'hq': 'Finer terrain (slower)', 'saved': 'Saved. Open this address in a new browser tab.',
    },
    de: {
      'g.world': 'Welt', 'l.online': 'Spieler online', 'l.offline': 'Spieler offline', 'l.bases': 'Basen',
      'start.title': 'Mit deinem Dune-Docker-Server verbinden', 'start.intro': 'In der Console liest dieses Addon Spieler und Basen über die Console-Brücke (nur lesend, Berechtigung database:read). Realtime Data (Sandwürmer, Gegner), das volle 1-m-Gelände und die Anmeldung mit API-Token laufen im Companion: Er fragt den Token auf seinem eigenen Startbildschirm ab. Die Console-Sandbox hat kein Netzwerk, ein Token ist hier nicht nutzbar und wird deshalb nicht abgefragt.',
      'start.companion': 'Adresse des Companion (optional)', 'start.continue': 'Weiter', 'start.bad': 'Nur https:// (oder http://localhost) ohne Zugangsdaten.',
      'conn.bridge': 'Console-Brücke', 'conn.db': 'Spieldaten (database:read)', 'conn.rt': 'Realtime Data', 'conn.rt.off': 'nur im Companion (Sandbox ohne Netzwerk)',
      'conn.ok': 'verbunden', 'conn.preview': 'Vorschau außerhalb der Console', 'conn.companion': 'Companion', 'conn.change': 'Companion-Adresse …', 'conn.none': 'nicht gesetzt',
      'live.status': '{0} Spieler, {1} Basen', 'terrain': 'Gelände (eingebettet): {0}×{0} Punkte · {1} m Raster', 'hq': 'Feineres Gelände (langsamer)', 'saved': 'Gespeichert. Öffne diese Adresse in einem neuen Browser-Tab.',
    },
  });

  const TERRAIN = { hagga: JSON.parse($('t-hagga').textContent), deep: JSON.parse($('t-deep').textContent) };
  const env = MV.createEnv($('view'), document.documentElement);
  const pts = { online: MV.Points(env, 0x2f9bff, 11), offline: MV.Points(env, 0x3a6a8a, 6), bases: MV.Points(env, 0xff8a1f, 9) };
  const lay = UI.layers([{ id: 'w', label: 'g.world' }], [
    { key: 'online', label: 'l.online', color: '#2f9bff', group: 'w' }, { key: 'offline', label: 'l.offline', color: '#3a6a8a', group: 'w' }, { key: 'bases', label: 'l.bases', color: '#ff8a1f', group: 'w' },
  ], (k, on) => { pts[k].obj.visible = on; });

  let current = 'hagga', showGen = 0, rows = { players: [], bases: [] }, hq = false, companion = '', bridgeState = ['', ''], terrainArgs = null;
  const mapKey = (m) => (/deep/i.test(m) ? 'deep' : /survival|hagga/i.test(m) ? 'hagga' : null);
  const pick = (r) => (Array.isArray(r) ? r : (r && Array.isArray(r.rows) ? r.rows : []));
  const pt = (r) => ({ x: MV.cm2m(r.x), y: MV.cm2m(r.y), z: MV.cm2m(r.z) });

  function renderConn() {
    UI.conn([UI.t('conn.bridge') + ': ' + bridgeState[0], UI.t('conn.db') + ': ' + bridgeState[1], UI.t('conn.rt') + ': ' + UI.t('conn.rt.off'), UI.t('conn.companion') + ': ' + (companion || UI.t('conn.none'))].concat(storeNote ? [storeNote] : []).join('\n'));
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
    pts.online.set(on); pts.offline.set(off); pts.bases.set(bs);
    lay.count('online', on.length); lay.count('offline', off.length); lay.count('bases', bs.length);
    UI.players(list); UI.status(UI.t('live.status', rows.players.filter((r) => mapKey(r.map) === current).length, bs.length));
  }

  let polling = false;
  async function poll() {
    if (polling) return; polling = true;
    try {
      const [p, b] = await Promise.all([DuneAddon.request('database.query', { query: SQL_PLAYERS }), DuneAddon.request('database.query', { query: SQL_BASES })]);
      rows = { players: pick(p), bases: pick(b) };
      bridgeState = [UI.t('conn.ok'), rows.players.length + ' / ' + rows.bases.length];
      applyRows();
    } catch (e) {
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
    title: UI.t('start.title'), intro: UI.t('start.intro'), submit: UI.t('start.continue'), cancel: null,
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
  UI.button(UI.t('conn.change'), startDialog);
  UI.onLang(() => { UI.clearButtons(); UI.button(UI.t('conn.change'), startDialog); });
  UI.toggle('hq', (on) => { hq = on; showMap(current, true); });
  UI.followCursor(env);

  renderConn();
  startDialog();           // zuerst die Verbindungsabfrage, die Karte lädt im Hintergrund
  await showMap('hagga');
  poll(); setInterval(poll, POLL_MS);
})();

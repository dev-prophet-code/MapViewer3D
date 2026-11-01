// MapViewer 3D v2 - Companion-Seite: zuerst die Abfrage des API-Tokens, dann Realtime-Prüfung und gestreamtes 1-m-Gelände.
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const HDR = { 'Content-Type': 'application/json', 'X-MV-CSRF': '1' };
  const api = async (path, opt) => {
    const r = await fetch(path, Object.assign({ credentials: 'same-origin', cache: 'no-store' }, opt));
    let j = null; try { j = await r.json(); } catch (e) { /* kein JSON */ }
    if (!r.ok) throw Object.assign(new Error((j && j.error) || 'HTTP ' + r.status), { status: r.status, code: j && j.code });
    return j;
  };

  UI.add({
    en: {
      'g.world': 'Players & bases', 'g.rt': 'Realtime Data', 'l.online': 'Players online', 'l.offline': 'Players offline', 'l.bases': 'Bases', 'l.vehicle': 'Vehicles', 'l.worm': 'Sandworms',
      'l.npc': 'Enemies / NPCs', 'l.civilian': 'Civilians / traders', 'l.storm': 'Sandstorms',
      'setup.title': 'Connect to your Dune Docker server', 'setup.intro': 'Enter an API token from the console (Settings → API Keys: Maps and Bases read; Realtime Data for live data). It stays only in this server’s memory and never returns to the browser.',
      'setup.token': 'API token', 'setup.connect': 'Check and connect',
      'c.mode.rt': 'Realtime active', 'c.mode.fb': 'Fallback (no realtime)', 'c.token': 'Token valid', 'c.rt': 'Realtime Data', 'c.rt.on': '{0} sources ready', 'c.tiles': 'Map data', 'c.tiles.v': 'tiles verified by SHA-256',
      'e.token_invalid': 'Token invalid, disabled or expired', 'e.token_format': 'Token format invalid (expected dak_…)', 'e.console_down': 'Console not reachable', 'e.no_maps': 'The token lacks “Maps: Read”', 'e.too_many': 'Too many failed attempts. Try again later.', 'r.no_scope': 'The token lacks “Realtime Data: Read”', 'r.agent_off': 'The position agent (mvagent) is not running', 'r.unavailable': 'Realtime Data is not available',
      'c.recheck': 'Check again', 'c.logout': 'Sign out', 'live.rt': 'realtime ({0} objects)', 'live.fb': 'fallback: players and bases only', 'live.status': '{0} players, {1} bases', 'tile.errors': '{0} load errors',
      'tiles': '{0} visible · {1} loaded · {2} loading', 'finest': 'finest level {0} ({1} m)',
    },
    de: {
      'g.world': 'Spieler & Basen', 'g.rt': 'Realtime Data', 'l.online': 'Spieler online', 'l.offline': 'Spieler offline', 'l.bases': 'Basen', 'l.vehicle': 'Fahrzeuge', 'l.worm': 'Sandwürmer',
      'l.npc': 'Gegner / NPCs', 'l.civilian': 'Zivilisten / Händler', 'l.storm': 'Sandstürme',
      'setup.title': 'Mit deinem Dune-Docker-Server verbinden', 'setup.intro': 'Gib einen API-Token der Console ein (Settings → API Keys: Maps und Bases lesen; für Live-Daten Realtime Data). Er bleibt nur im Arbeitsspeicher dieses Servers und kommt nie in den Browser zurück.',
      'setup.token': 'API-Token', 'setup.connect': 'Prüfen und verbinden',
      'c.mode.rt': 'Echtzeit aktiv', 'c.mode.fb': 'Fallback (ohne Echtzeit)', 'c.token': 'Token gültig', 'c.rt': 'Realtime Data', 'c.rt.on': '{0} Quellen bereit', 'c.tiles': 'Kartendaten', 'c.tiles.v': 'Kacheln per SHA-256 geprüft',
      'e.token_invalid': 'Token ungültig, deaktiviert oder abgelaufen', 'e.token_format': 'Token-Format ungültig (erwartet dak_…)', 'e.console_down': 'Console nicht erreichbar', 'e.no_maps': 'Dem Token fehlt „Maps: Read“', 'e.too_many': 'Zu viele Fehlversuche. Später erneut versuchen.', 'r.no_scope': 'Dem Token fehlt „Realtime Data: Read“', 'r.agent_off': 'Der Position-Agent (mvagent) läuft nicht', 'r.unavailable': 'Realtime Data ist nicht verfügbar',
      'c.recheck': 'Erneut prüfen', 'c.logout': 'Abmelden', 'live.rt': 'Echtzeit ({0} Objekte)', 'live.fb': 'Fallback: nur Spieler und Basen', 'live.status': '{0} Spieler, {1} Basen', 'tile.errors': '{0} Ladefehler',
      'tiles': '{0} sichtbar · {1} geladen · {2} in Arbeit', 'finest': 'feinste Stufe {0} ({1} m)',
    },
  });

  const DEFS = [
    { key: 'online', label: 'l.online', color: '#2f9bff', group: 'w', size: 11 }, { key: 'offline', label: 'l.offline', color: '#3a6a8a', group: 'w', size: 6 }, { key: 'bases', label: 'l.bases', color: '#ff8a1f', group: 'w', size: 9 },
    { key: 'vehicle', label: 'l.vehicle', color: '#ffffff', group: 'r', size: 7, rt: 1 }, { key: 'worm', label: 'l.worm', color: '#ff3b30', group: 'r', size: 16, rt: 1 }, { key: 'npc', label: 'l.npc', color: '#ffd23f', group: 'r', size: 3, rt: 1 },
    { key: 'civilian', label: 'l.civilian', color: '#9cff6a', group: 'r', size: 4, rt: 1 }, { key: 'storm', label: 'l.storm', color: '#c040ff', group: 'r', size: 14, rt: 1 },
  ];
  const KINDS = ['vehicle', 'worm', 'npc', 'civilian', 'storm'];
  let env, terrain, pts = {}, lay, session = null, mapKey = 'hagga', stream = null, mapGen = 0, dirty = false;
  let live = { objs: new Map(), sources: [] }, rows = { players: [], bases: [] };

  // ---- Zuerst die Token-Abfrage
  function askToken(msg) {
    UI.dialog({
      title: UI.t('setup.title'), intro: UI.t('setup.intro'), submit: UI.t('setup.connect'), cancel: null,
      fields: [{ name: 'token', label: UI.t('setup.token'), type: 'password', placeholder: 'dak_…', max: 170, required: true }],
      onSubmit: async (v) => {
        try { session = await api('/api/login', { method: 'POST', headers: HDR, body: JSON.stringify({ token: v.token }) }); } catch (e) { return (e.code && UI.t('e.' + e.code) !== 'e.' + e.code) ? UI.t('e.' + e.code) : e.message; }
        start(); return null;
      },
    });
    if (msg) { $('setupError').textContent = msg; $('setupError').hidden = false; }
  }
  async function boot() {
    env = MV.createEnv($('view'), document.documentElement);
    try { session = await api('/api/session'); start(); } catch (e) { askToken(); }
  }

  const mapRows = (a) => a.filter((r) => r.m === MV.MAPS[mapKey].live);
  function groupObjs() { // ein Durchlauf für alle Arten
    const m = MV.MAPS[mapKey].source, ok = new Set(live.sources.map((s, i) => (s.map === m ? i : -1)).filter((i) => i >= 0)), out = {};
    for (const k of KINDS) out[k] = [];
    for (const o of live.objs.values()) if (out[o.k] && ok.has(o.s)) out[o.k].push({ x: o.x / 100, y: o.y / 100, z: o.z / 100 });
    return out;
  }
  function applyMarkers() {
    const pl = mapRows(rows.players), cv = (r) => ({ x: MV.cm2m(r.x), y: MV.cm2m(r.y), z: MV.cm2m(r.z) });
    pts.online.set(pl.filter((r) => r.on).map(cv)); pts.offline.set(pl.filter((r) => !r.on).map(cv)); pts.bases.set(mapRows(rows.bases).map(cv));
    const g = groupObjs(); for (const k of KINDS) pts[k].set(g[k]);
    for (const d of DEFS) lay.count(d.key, pts[d.key].count);
    UI.status(session.mode === 'realtime' ? UI.t('live.rt', live.objs.size) : UI.t('live.fb'));
  }
  function renderPlayers() {
    UI.players(mapRows(rows.players).filter((p) => p.on).map((r) => ({ label: r.n || '?', pick: () => env.jump(MV.cm2m(r.x), MV.cm2m(r.y), MV.cm2m(r.z), 120) })));
  }
  function renderConn() {
    const rt = session.mode === 'realtime';
    UI.conn([UI.t(rt ? 'c.mode.rt' : 'c.mode.fb'), '', UI.t('c.token'), UI.t('c.rt') + ': ' + (rt ? UI.t('c.rt.on', session.sources.filter((s) => s.ready).length) : (session.reasonCode ? UI.t('r.' + session.reasonCode) : (session.reason || '–'))), UI.t('c.tiles') + ': ' + UI.t('c.tiles.v')].join('\n'));
    UI.clearButtons();
    if (!rt) UI.button(UI.t('c.recheck'), async () => { try { session = await api('/api/recheck', { method: 'POST', headers: HDR, body: '{}' }); setMode(); openStream(); } catch (e) { if (e.status === 401) location.reload(); } });
    UI.button(UI.t('c.logout'), async () => { try { await api('/api/logout', { method: 'POST', headers: HDR, body: '{}' }); } catch (e) { /* egal */ } location.reload(); }, 'danger');
  }
  function setMode() {
    const rt = session.mode === 'realtime';
    for (const d of DEFS) if (d.rt) lay.disabled(d.key, !rt);
    renderConn(); applyMarkers();
  }

  async function start() {
    for (const d of DEFS) pts[d.key] = MV.Points(env, parseInt(d.color.slice(1), 16), d.size);
    lay = UI.layers([{ id: 'w', label: 'g.world' }, { id: 'r', label: 'g.rt' }], DEFS, (k, on) => { pts[k].obj.visible = on; });
    UI.onLang(renderConn); UI.onLang(renderPlayers);
    $('map').onchange = (e) => loadMap(e.target.value);
    setMode();
    await loadMap('hagga');
    pollStatic(); setInterval(pollStatic, 6000);
    openStream();
    setInterval(() => { if (dirty) { dirty = false; applyMarkers(); } }, 150);
    setInterval(hudTick, 400);
    UI.followCursor(env);
  }

  async function loadMap(key) {
    mapKey = key; const m = MV.MAPS[key], gen = ++mapGen;
    if (terrain) { terrain.dispose(); terrain = null; } env.clear();
    const idx = await api('/cdn/m/' + m.name + '.json');
    if (gen !== mapGen) return; // zwischenzeitlich andere Karte gewählt
    env.setMeta(idx.meta);
    terrain = MV.Terrain(env, idx, async (n, ix, N) => {
      const lv = ix.levels[n.l]; if (!lv || n.x >= lv.nx || n.y >= lv.ny) return null;
      const ci = lv.cells[n.y * lv.nx + n.x]; if (ci < 0 || ci >= ix.ids.length) return null;
      const id = ix.ids[ci], r = await fetch('/cdn/p/' + id.slice(0, 2) + '/' + id.slice(2) + '.z', { credentials: 'same-origin' });
      if (!r.ok) throw new Error('Kachel ' + r.status);
      return MV.decodeTile(new Uint8Array(await new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()), N);
    });
    terrain.detail = 3; applyMarkers(); renderPlayers();
  }
  let polling = false;
  async function pollStatic() {
    if (polling) return; polling = true;
    try { rows = await api('/api/static'); applyMarkers(); renderPlayers(); } catch (e) { if (e.status === 401) location.reload(); }
    polling = false;
  }

  // Echtzeit: erst "snap" (alles ersetzen), danach nur "pos" (geänderte Positionen)
  function openStream() {
    if (stream) { stream.close(); stream = null; }
    live = { objs: new Map(), sources: [] };
    if (session.mode !== 'realtime') { applyMarkers(); return; }
    stream = new EventSource('/api/realtime/stream');
    stream.addEventListener('snap', (ev) => {
      let d; try { d = JSON.parse(ev.data); } catch (e) { return; }
      live.sources = Array.isArray(d.sources) ? d.sources : []; live.objs = new Map();
      for (const o of (Array.isArray(d.objects) ? d.objects : [])) if (o && Number.isFinite(o.i)) live.objs.set(o.i, { k: String(o.k), s: o.s | 0, x: +o.x || 0, y: +o.y || 0, z: +o.z || 0 });
      applyMarkers();
    });
    stream.addEventListener('pos', (ev) => {
      let d; try { d = JSON.parse(ev.data); } catch (e) { return; }
      for (const u of (Array.isArray(d.d) ? d.d : [])) { const o = live.objs.get(u[0]); if (o) { o.x = +u[1] || 0; o.y = +u[2] || 0; o.z = +u[3] || 0; } }
      for (const id of (Array.isArray(d.r) ? d.r : [])) live.objs.delete(id);
      dirty = true;
    });
    stream.onerror = () => { if (stream && stream.readyState === 2) setTimeout(() => api('/api/session').then(openStream).catch(() => location.reload()), 3000); };
  }
  function hudTick() {
    if (!terrain) return;
    const minL = terrain.drawn.reduce((a, n) => Math.min(a, n.l), 99);
    UI.hud(UI.t('tiles', terrain.drawn.length, terrain.loaded, terrain.inflight) + (minL === 99 ? '' : ' · ' + UI.t('finest', minL, 1 << minL)) + (terrain.errors ? ' · ' + UI.t('tile.errors', terrain.errors) : ''));
  }
  boot();
})();

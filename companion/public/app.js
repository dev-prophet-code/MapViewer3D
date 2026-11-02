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
      'l.npc': 'Enemies / NPCs', 'l.civilian': 'Civilians / traders', 'l.storm': 'Sandstorms', 'g.atlas': 'Map atlas', 't.spice': 'Spice fields', 't.spice_active': 'Spice fields (active)', 't.flour_sand': 'Flour sand', 't.ore': 'Ore deposits', 't.scrap': 'Scrap', 't.flora': 'Plants', 't.poi': 'Places', 't.house_representative': 'House representatives', 't.trainer': 'Trainers', 't.fortress': 'Fortresses', 't.hazard': 'Hazards', 't.enemy': 'Enemy camps', 't.storage': 'Storage', 't.vehicle': 'Vehicles (database)',
      'setup.title': 'Connect to your Dune Docker server', 'setup.intro': 'Enter an API token from the console (Settings → API Keys: Maps and Bases read; Realtime Data for live data). It stays only in this server’s memory and never returns to the browser.',
      'setup.token': 'API token', 'setup.connect': 'Check and connect',
      'c.mode.rt': 'Realtime active', 'c.mode.fb': 'Fallback (no realtime)', 'c.token': 'Token valid', 'c.rt': 'Realtime Data', 'c.rt.on': '{0} sources ready', 'c.tiles': 'Map data', 'c.tiles.v': 'tiles verified by SHA-256',
      'e.token_invalid': 'Token invalid, disabled or expired', 'e.token_format': 'Token format invalid (expected dak_…)', 'e.console_down': 'Console not reachable', 'e.no_maps': 'The token lacks “Maps: Read”', 'e.too_many': 'Too many failed attempts. Try again later.', 'r.no_scope': 'The token lacks “Realtime Data: Read”', 'r.agent_off': 'The position agent (mvagent) is not running', 'r.unavailable': 'Realtime Data is not available',
      'c.recheck': 'Check again', 'c.logout': 'Sign out', 'live.rt': 'realtime ({0} objects)', 'live.fb': 'fallback: players and bases only', 'live.status': '{0} players, {1} bases', 'tile.errors': '{0} load errors', 'models': '3D models for markers (off: icons only)', 'c.bases.scope': 'Bases are shown simplified: the token lacks “Bases: Read”',
      'tiles': '{0} visible · {1} loaded · {2} loading', 'finest': 'finest level {0} ({1} m)',
    },
    de: {
      'g.world': 'Spieler & Basen', 'g.rt': 'Realtime Data', 'l.online': 'Spieler online', 'l.offline': 'Spieler offline', 'l.bases': 'Basen', 'l.vehicle': 'Fahrzeuge', 'l.worm': 'Sandwürmer',
      'l.npc': 'Gegner / NPCs', 'l.civilian': 'Zivilisten / Händler', 'l.storm': 'Sandstürme', 'g.atlas': 'Karten-Atlas', 't.spice': 'Gewürzfelder', 't.spice_active': 'Gewürzfelder (aktiv)', 't.flour_sand': 'Mehlsand', 't.ore': 'Erzvorkommen', 't.scrap': 'Schrott', 't.flora': 'Pflanzen', 't.poi': 'Orte', 't.house_representative': 'Hausvertreter', 't.trainer': 'Trainer', 't.fortress': 'Festungen', 't.hazard': 'Gefahren', 't.enemy': 'Gegnerlager', 't.storage': 'Lager', 't.vehicle': 'Fahrzeuge (Datenbank)',
      'setup.title': 'Mit deinem Dune-Docker-Server verbinden', 'setup.intro': 'Gib einen API-Token der Console ein (Settings → API Keys: Maps und Bases lesen; für Live-Daten Realtime Data). Er bleibt nur im Arbeitsspeicher dieses Servers und kommt nie in den Browser zurück.',
      'setup.token': 'API-Token', 'setup.connect': 'Prüfen und verbinden',
      'c.mode.rt': 'Echtzeit aktiv', 'c.mode.fb': 'Fallback (ohne Echtzeit)', 'c.token': 'Token gültig', 'c.rt': 'Realtime Data', 'c.rt.on': '{0} Quellen bereit', 'c.tiles': 'Kartendaten', 'c.tiles.v': 'Kacheln per SHA-256 geprüft',
      'e.token_invalid': 'Token ungültig, deaktiviert oder abgelaufen', 'e.token_format': 'Token-Format ungültig (erwartet dak_…)', 'e.console_down': 'Console nicht erreichbar', 'e.no_maps': 'Dem Token fehlt „Maps: Read“', 'e.too_many': 'Zu viele Fehlversuche. Später erneut versuchen.', 'r.no_scope': 'Dem Token fehlt „Realtime Data: Read“', 'r.agent_off': 'Der Position-Agent (mvagent) läuft nicht', 'r.unavailable': 'Realtime Data ist nicht verfügbar',
      'c.recheck': 'Erneut prüfen', 'c.logout': 'Abmelden', 'live.rt': 'Echtzeit ({0} Objekte)', 'live.fb': 'Fallback: nur Spieler und Basen', 'live.status': '{0} Spieler, {1} Basen', 'tile.errors': '{0} Ladefehler', 'models': '3D-Modelle für Marker (aus: nur Symbole)', 'c.bases.scope': 'Basen vereinfacht: Dem Token fehlt „Bases: Read“',
      'tiles': '{0} sichtbar · {1} geladen · {2} in Arbeit', 'finest': 'feinste Stufe {0} ({1} m)',
    },
  });

  // Symbole: wo die Console ein Symbol hat (Spieler, Basis, Fahrzeug), deren Bild und CSS (marker-*), sonst eigenes Piktogramm (mv-glyph-*, reines CSS).
  // Standard wie im Dune Map Viewer: Spieler online, Basen, Basen in 3D, Namen, Würmer und Stürme an; offline, Leuchtsäulen, Gegner, Zivilisten und Fahrzeuge aus.
  const DEFS = [
    { key: 'online', label: 'l.online', color: '#2f9bff', group: 'w', size: 11, cls: 'marker-player', file: 'Characters.webp', glyph: 'player', px: 34, overlay: true, lift: 6, fade: [40, 120] },
    { key: 'offline', label: 'l.offline', color: '#3a6a8a', group: 'w', size: 6, cls: 'marker-player offline', file: 'Characters.webp', glyph: 'offline', px: 28, tint: 0x8a8a8a, fade: [40, 120], off: true },
    { key: 'bases', label: 'l.bases', color: '#ff8a1f', group: 'w', size: 9, cls: 'marker-base', file: 'Base.webp', glyph: 'base', px: 34, fade: [350, 800] },
    { key: 'worm', label: 'l.worm', color: '#ff3b30', group: 'r', size: 16, rt: 1, cls: 'mv-glyph-worm', glyph: 'worm', px: 40, overlay: true, lift: 28, symOnly: true },
    { key: 'storm', label: 'l.storm', color: '#c040ff', group: 'r', size: 14, rt: 1, cls: 'mv-glyph-storm', glyph: 'storm', px: 46, overlay: true, lift: 450, symOnly: true },
    { key: 'npc', label: 'l.npc', color: '#ff5a4d', group: 'r', size: 3, rt: 1, cls: 'mv-glyph-npc', glyph: 'npc', px: 10, symOnly: true, off: true },
    { key: 'civilian', label: 'l.civilian', color: '#4dd2c6', group: 'r', size: 4, rt: 1, cls: 'mv-glyph-civilian', glyph: 'civilian', px: 10, symOnly: true, off: true },
    { key: 'vehicle', label: 'l.vehicle', color: '#ffffff', group: 'r', size: 7, rt: 1, cls: 'marker-vehicle', file: 'sandbikevehicle.webp', glyph: 'vehicle', px: 28, overlay: true, lift: 8, fade: [60, 170], off: true },
  ];
  // Schalter ohne eigene Punkte-Schicht (Reihenfolge wie im Dune Map Viewer, hinter den Basen)
  const EXTRA = [
    { key: 'bases3d', label: 'l.bases3d', color: '#9aa0a6', group: 'w', cls: 'mv-glyph-bases3d' },
    { key: 'labels', label: 'l.labels', color: '#bfe1ff', group: 'w', cls: 'mv-glyph-labels' },
    { key: 'beams', label: 'l.beams', color: '#ff9d2e', group: 'w', cls: 'mv-glyph-beams', off: true },
  ];

  const KINDS = ['vehicle', 'worm', 'npc', 'civilian', 'storm'];
  const MODEL_OF = { online: 'player', offline: 'player' }; // Art des 3D-Modells je Schicht (Rest: gleicher Name)
  let buildings = null, labels = null, beams = null, atlas = null, atlasOn = {}, want = {}, env, terrain, pts = {}, lay, session = null, mapKey = 'hagga', stream = null, mapGen = 0, dirty = false;
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
    for (const o of live.objs.values()) if (out[o.k] && ok.has(o.s)) out[o.k].push({ id: o.id, x: o.x / 100, y: o.y / 100, z: o.z / 100, v: MV.Creatures && MV.Creatures.variantFor(o.k, o.c) });
    return out;
  }
  function applyMarkers() {
    const pl = mapRows(rows.players), cv = (r) => ({ x: MV.cm2m(r.x), y: MV.cm2m(r.y), z: MV.cm2m(r.z) });
    const on = pl.filter((r) => r.on), off = pl.filter((r) => !r.on); pts.online.set(on.map(cv)); pts.offline.set(off.map(cv)); beams.set(on.map(cv));
    const L = { online: on.map((r) => Object.assign(cv(r), { text: r.n || '?', range: 4000, px: 34, color: '#ffe9c7' })), offline: off.map((r) => Object.assign(cv(r), { text: r.n || '?', range: 1000, px: 28, color: '#ffe9c7' })) };
    { const bs = mapRows(rows.bases); if (buildings) buildings.setBases(bs); const real = buildings ? buildings.realIds() : new Set(); pts.bases.set(bs.filter((r) => !real.has(r.i)).map(cv), bs.map(cv)); L.bases = bs.map((r) => Object.assign(cv(r), { text: (r.n || '?') + (r.o ? ' · ' + r.o : ''), range: 1200, px: 34, color: '#cfe3ff' })); } // Basen mit echten Bauteilen brauchen kein Haus-Symbol
    const g = groupObjs(); for (const k of KINDS) pts[k].set(g[k]);
    L.worm = g.worm.map((o) => Object.assign({}, o, { text: UI.t('name.worm'), range: 8000, px: 40, lift: 28, size: 24, color: '#ffd08a' })); L.storm = g.storm.map((o) => Object.assign({}, o, { text: UI.t('name.storm'), range: 1e6, px: 46, lift: 450, size: 30, color: '#ffd9a0' })); L.vehicle = g.vehicle.map((o) => Object.assign({}, o, { text: UI.t('l.vehicle'), range: 450, px: 28, lift: 8, color: '#cfe3ff' }));
    for (const k in L) labels.set(k, L[k]);
    for (const d of DEFS) lay.count(d.key, d.key === 'bases' ? mapRows(rows.bases).length : pts[d.key].count); // Basen mit echten Bauteilen zählen mit
    UI.status(session.mode === 'realtime' ? UI.t('live.rt', live.objs.size) : UI.t('live.fb'));
  }
  function renderPlayers() {
    UI.players(mapRows(rows.players).filter((p) => p.on).map((r) => ({ label: r.n || '?', pick: () => env.jump(MV.cm2m(r.x), MV.cm2m(r.y), MV.cm2m(r.z), 120) })));
  }
  function renderConn() {
    const rt = session.mode === 'realtime';
    UI.conn([UI.t(rt ? 'c.mode.rt' : 'c.mode.fb'), '', UI.t('c.token'), UI.t('c.rt') + ': ' + (rt ? UI.t('c.rt.on', session.sources.filter((s) => s.ready).length) : (session.reasonCode ? UI.t('r.' + session.reasonCode) : (session.reason || '–'))), UI.t('c.tiles') + ': ' + UI.t('c.tiles.v')].concat(buildings && buildings.disabled === 'scope' ? ['', UI.t('c.bases.scope')] : []).join('\n'));
    UI.clearButtons();
    if (!rt) UI.button(UI.t('c.recheck'), async () => { try { session = await api('/api/recheck', { method: 'POST', headers: HDR, body: '{}' }); setMode(); openStream(); } catch (e) { if (e.status === 401) location.reload(); } });
    UI.button(UI.t('c.logout'), async () => { try { await api('/api/logout', { method: 'POST', headers: HDR, body: '{}' }); } catch (e) { /* egal */ } location.reload(); }, 'danger');
  }
  function setMode() {
    const rt = session.mode === 'realtime';
    for (const d of DEFS) if (d.rt) lay.disabled(d.key, !rt);
    renderConn(); applyMarkers();
  }

  // Ebenenliste: Welt + Echtzeit (wie bisher) und der Karten-Atlas der Console (Typen mit Symbol aus dem Console-CSS)
  function buildLegend() {
    const dict = { en: {}, de: {} };
    for (const g of atlas ? atlas.groups : []) { const k = 't.' + g.type; if (UI.t(k) === k) { const nice = g.type.replace(/_/g, ' '); dict.en[k] = nice; dict.de[k] = nice; } }
    UI.add(dict);
    const dflt = (d) => (want[d.key] === undefined ? !d.off : want[d.key] !== false);
    const defs = DEFS.concat(EXTRA).map((d) => Object.assign({}, d, { on: dflt(d) }));
    const adefs = (atlas ? atlas.groups : []).map((g) => ({ key: 'a:' + g.type, label: 't.' + g.type, color: '#9ca3af', group: 'a', cls: g.cls, on: atlasOn[g.type] === true })); // Orte, Gefahren und Ressourcen sind wie im Dune Map Viewer zunächst aus
    lay = UI.layers([{ id: 'w', label: 'g.world' }, { id: 'r', label: 'g.rt' }].concat(adefs.length ? [{ id: 'a', label: 'g.atlas' }] : []), defs.concat(adefs), (k, on) => {
      if (k.startsWith('a:')) { atlasOn[k.slice(2)] = on; if (atlas) atlas.setVisible(k.slice(2), on); }
      else if (k === 'bases3d') { want[k] = on; if (buildings) buildings.setVisible(on); }
      else if (k === 'labels') { want[k] = on; labels.setOn(on); }
      else if (k === 'beams') { want[k] = on; beams.setOn(on); }
      else { want[k] = on; pts[k].obj.visible = on; labels.setKind(k, on); }
    });
    for (const g of atlas ? atlas.groups : []) { lay.count('a:' + g.type, g.count); atlas.setVisible(g.type, atlasOn[g.type] === true); }
    for (const d of DEFS) { const on = dflt(d); pts[d.key].obj.visible = on; labels.setKind(d.key, on); } labels.setOn(dflt(EXTRA[1])); beams.setOn(dflt(EXTRA[2])); if (buildings) buildings.setVisible(dflt(EXTRA[0]));
    if (session) for (const d of DEFS) if (d.rt) lay.disabled(d.key, session.mode !== 'realtime');
    for (const d of DEFS) lay.count(d.key, d.key === 'bases' ? mapRows(rows.bases).length : pts[d.key].count);
  }
  async function loadAtlas(key, gen) {
    let rowsA = []; try { rowsA = (await api('/api/markers?map=' + key)).rows || []; } catch (e) { if (e.status === 401) location.reload(); }
    if (gen !== mapGen) return;
    if (atlas) atlas.dispose();
    atlas = rowsA.length ? MV.MarkerSet(env, rowsA) : null;
    buildLegend();
  }

  async function loadCreatures() {
    try {
      const index = await api('/cdn/creatures/index.json');
      await MV.Creatures.load({ index, bin: async (id) => { const r = await fetch('/cdn/creatures/mesh/' + id + '.bin', { credentials: 'same-origin' }); if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); } });
    } catch { /* Platzhalter-Modelle bleiben */ }
  }

  async function start() {
    MV.ICON_FILES = true; // Der Companion liefert die Symbole der Console (/icons/<Datei>)
    for (const d of DEFS) pts[d.key] = MV.Layer(env, MODEL_OF[d.key] || d.key, parseInt(d.color.slice(1), 16), d.size, d);
    labels = MV.Labels(env); beams = MV.Beams(env);
    buildings = MV.Buildings(env, { api, bin: async (p) => { const r = await fetch(p, { credentials: 'same-origin' }); if (!r.ok) throw Object.assign(new Error('HTTP ' + r.status), { status: r.status }); return r.arrayBuffer(); } }, { onChange: () => { dirty = true; } });
    loadCreatures();
    buildLegend();
    UI.onLang(renderConn); UI.onLang(renderPlayers);
    $('map').onchange = (e) => loadMap(e.target.value);
    setMode();
    await loadMap('hagga');
    pollStatic(); setInterval(pollStatic, 6000);
    openStream();
    let noted = false;
    setInterval(() => { if (dirty) { dirty = false; applyMarkers(); } if (buildings && buildings.disabled && !noted) { noted = true; renderConn(); } }, 150);
    setInterval(hudTick, 400);
    UI.followCursor(env);
    UI.toggle('models', (on) => MV.Layer.setModels(on), true);
    const hitAt = (x, y) => {
      for (const k in pts) { const h = pts[k].nearest(x, y, 12); if (h) return { n: UI.t(DEFS.find((d) => d.key === k).label), x: h.x, y: h.y, z: h.z }; }
      if (atlas) { const a = atlas.nearest(x, y, 14); if (a) return { n: (a.n || a.s || a.t) + ' · ' + a.t, x: a.x, y: a.y, z: a.z }; }
      return null;
    };
    UI.clickPick($('view'), (x, y) => { const h = hitAt(x, y); return h && { title: h.n, lines: [[UI.t('info.pos'), Math.round(h.x) + ' / ' + Math.round(h.y) + ' · ' + Math.round(h.z) + ' m']], pick: () => env.jump(h.x, h.y, h.z, 120) }; });
    let tipRaf = 0;
    $('view').addEventListener('pointermove', (e) => { // Name des Markers unter der Maus
      if (tipRaf) return; tipRaf = requestAnimationFrame(() => { tipRaf = 0;
        let hit = null; for (const k in pts) { hit = pts[k].nearest(e.clientX, e.clientY, 12); if (hit) { hit = { n: UI.t(DEFS.find((d) => d.key === k).label), x: hit.x, y: hit.y, z: hit.z }; break; } }
        if (!hit && atlas) { const a = atlas.nearest(e.clientX, e.clientY, 14); if (a) hit = { n: (a.n || a.s || a.t) + ' · ' + a.t, x: a.x, y: a.y, z: a.z }; }
        UI.tip(hit ? hit.n + ' · ' + Math.round(hit.x) + ' / ' + Math.round(hit.y) + ' · ' + Math.round(hit.z) + ' m' : '', e.clientX, e.clientY); });
    });
  }

  async function loadMap(key) {
    mapKey = key; const m = MV.MAPS[key], gen = ++mapGen;
    if (terrain) { terrain.dispose(); terrain = null; } env.clear();
    const idx = await api('/cdn/m/' + m.name + '.json');
    if (gen !== mapGen) return; // zwischenzeitlich andere Karte gewählt
    env.setMeta(idx.meta);
    env.setMapImage(null); // Kartenbild der Console als Farbgrundlage; fehlt es, bleibt das Gelände im Sandton
    if (m.image) { const im = new Image(); im.onload = () => { if (gen === mapGen) env.setMapImage(im, m.bounds, false); }; im.src = '/mapimg/' + m.image; }
    terrain = MV.Terrain(env, idx, async (n, ix, N) => {
      const lv = ix.levels[n.l]; if (!lv || n.x >= lv.nx || n.y >= lv.ny) return null;
      const ci = lv.cells[n.y * lv.nx + n.x]; if (ci < 0 || ci >= ix.ids.length) return null;
      const id = ix.ids[ci], r = await fetch('/cdn/p/' + id.slice(0, 2) + '/' + id.slice(2) + '.z', { credentials: 'same-origin' });
      if (!r.ok) throw new Error('Kachel ' + r.status);
      return MV.decodeTile(new Uint8Array(await new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()), N);
    });
    terrain.detail = 3; applyMarkers(); renderPlayers();
    loadAtlas(key, gen);
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
      for (const o of (Array.isArray(d.objects) ? d.objects : [])) if (o && Number.isFinite(o.i)) live.objs.set(o.i, { id: o.i, k: String(o.k), c: typeof o.c === 'string' ? o.c.slice(0, 120) : '', s: o.s | 0, x: +o.x || 0, y: +o.y || 0, z: +o.z || 0 });
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

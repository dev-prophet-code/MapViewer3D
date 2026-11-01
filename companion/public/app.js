// MapViewer 3D v2 - Companion-Seite: Token-Anmeldung, Realtime-Prüfung, gestreamtes 1-m-Gelände.
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const HDR = { 'Content-Type': 'application/json', 'X-MV-CSRF': '1' };
  const api = async (path, opt) => {
    const r = await fetch(path, Object.assign({ credentials: 'same-origin', cache: 'no-store' }, opt));
    let j = null; try { j = await r.json(); } catch (e) { /* kein JSON */ }
    if (!r.ok) throw Object.assign(new Error((j && j.error) || 'Fehler ' + r.status), { status: r.status });
    return j;
  };

  const LAYERS = [
    ['online', 'Spieler online', '#2f9bff', 11, 0], ['offline', 'Spieler offline', '#3a6a8a', 6, 0], ['bases', 'Basen', '#ff8a1f', 9, 0],
    ['vehicle', 'Fahrzeuge', '#ffffff', 7, 1], ['worm', '🐛 Sandwürmer', '#ff3b30', 16, 1], ['npc', 'Gegner / NPCs', '#ffd23f', 3, 1],
    ['civilian', 'Zivilisten / Händler', '#9cff6a', 4, 1], ['storm', 'Sandstürme', '#c040ff', 14, 1],
  ];
  let env, terrain, pts = {}, session = null, mapKey = 'hagga', stream = null, staticTimer = null;
  let live = { objs: new Map(), sources: [] }, rows = { players: [], bases: [] };

  function showGate(msg) { $('gate').classList.remove('hide'); $('viewer').classList.add('hide'); $('err').textContent = msg || ''; }

  async function boot() {
    try { session = await api('/api/session'); } catch (e) { return showGate(); }
    start();
  }

  $('loginForm').addEventListener('submit', async (ev) => {
    ev.preventDefault(); $('err').textContent = ''; $('loginBtn').disabled = true;
    try {
      session = await api('/api/login', { method: 'POST', headers: HDR, body: JSON.stringify({ token: $('tok').value.trim() }) });
      $('tok').value = ''; start();
    } catch (e) { $('err').textContent = e.message; }
    $('loginBtn').disabled = false;
  });
  $('logout').onclick = async () => { try { await api('/api/logout', { method: 'POST', headers: HDR, body: '{}' }); } catch (e) { /* egal */ } location.reload(); };
  $('recheck').onclick = async () => {
    try { session = await api('/api/recheck', { method: 'POST', headers: HDR, body: '{}' }); renderStatus(); openStream(); } catch (e) { if (e.status === 401) location.reload(); }
  };

  function renderStatus() {
    const rt = session.mode === 'realtime';
    const b = $('modeBadge'); b.className = 'badge ' + (rt ? 'ok' : 'warn'); b.textContent = rt ? 'Echtzeit aktiv' : 'Fallback (ohne Echtzeit)';
    const box = $('checks'); box.textContent = '';
    const add = (c, t, s) => { const row = MV.el('div', { class: 'chk' }), d = MV.el('div'); d.append(document.createTextNode(t), MV.el('small', null, s)); row.append(MV.el('span', { class: 'dot ' + c }), d); box.append(row); };
    add('ok', 'Token gültig', 'Verbindung zur Console steht');
    add(rt ? 'ok' : 'warn', 'Realtime Data', rt ? (session.sources.filter((s) => s.ready).length + ' Quellen bereit') : (session.reason || 'nicht verfügbar'));
    add('ok', 'Kartendaten', 'Kacheln über SHA-256 geprüft (Companion)');
    add(rt ? 'ok' : 'warn', 'Würmer, NPCs, Fahrzeuge', rt ? 'live (ca. 10 Hz)' : 'nicht verfügbar, Spieler und Basen aus regulären Quellen');
    $('layers').querySelectorAll('[data-rt="1"]').forEach((cb) => { cb.disabled = !rt; if (!rt) { cb.checked = false; pts[cb.dataset.k].obj.visible = false; } });
    $('recheck').classList.toggle('hide', rt);
  }

  async function start() {
    $('gate').classList.add('hide'); $('viewer').classList.remove('hide');
    env = MV.createEnv($('c'), $('stage'));
    const lay = $('layers');
    for (const [k, name, color, size, rt] of LAYERS) {
      pts[k] = MV.Points(env, parseInt(color.slice(1), 16), size);
      const l = MV.el('label', { class: 'l' }), cb = MV.el('input', { type: 'checkbox', 'data-k': k, 'data-rt': rt }); cb.checked = true;
      cb.onchange = () => { pts[k].obj.visible = cb.checked; };
      const sw = MV.el('span', { class: 'sw' }); sw.style.background = color;
      pts[k].num = MV.el('span', { class: 'note grow' }, '0');
      l.append(cb, sw, document.createTextNode(name), pts[k].num); lay.append(l);
    }
    renderStatus();
    $('map').onchange = (e) => loadMap(e.target.value);
    $('detail').oninput = (e) => { if (terrain) terrain.detail = +e.target.value; };
    $('contours').onchange = (e) => { env.uniforms.uContours.value = e.target.checked ? 1 : 0; };
    $('grid').onchange = (e) => { env.uniforms.uGrid.value = e.target.checked ? 1 : 0; };
    $('tint').onchange = (e) => env.tint(e.target.checked);
    const J = $('jump'), btn = (t, f) => { const b = MV.el('button', { class: 'btn', type: 'button' }, t); b.onclick = f; J.append(b); };
    btn('Übersicht', () => env.home());
    btn('Basis', () => { const b = mapRows(rows.bases); if (b.length) { const r = b[Math.floor(Math.random() * b.length)]; env.jump(MV.cm2m(r.x), MV.cm2m(r.y), MV.cm2m(r.z), 160); } });
    btn('Wurm', () => { const w = objsOf('worm'); if (w.length) { const r = w[Math.floor(Math.random() * w.length)]; env.jump(r.x, r.y, r.z, 500); } });
    await loadMap('hagga');
    pollStatic(); staticTimer = setInterval(pollStatic, 6000);
    openStream();
    setInterval(hudTick, 400);
  }

  let mapGen = 0;
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
      const raw = new Uint8Array(await new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
      return MV.decodeTile(raw, N);
    });
    terrain.detail = +$('detail').value;
    applyMarkers(); plist();
  }

  const mapRows = (a) => a.filter((r) => r.m === MV.MAPS[mapKey].live);
  const srcIndex = () => { const m = MV.MAPS[mapKey].source; return live.sources.map((s, i) => (s.map === m ? i : -1)).filter((i) => i >= 0); };
  const KINDS = ['vehicle', 'worm', 'npc', 'civilian', 'storm'];
  function groupObjs() { // ein Durchlauf für alle Arten
    const ok = new Set(srcIndex()), out = {};
    for (const k of KINDS) out[k] = [];
    for (const o of live.objs.values()) if (out[o.k] && ok.has(o.s)) out[o.k].push({ x: o.x / 100, y: o.y / 100, z: o.z / 100 });
    return out;
  }
  const objsOf = (kind) => groupObjs()[kind];
  function applyMarkers() {
    const pl = mapRows(rows.players), cv = (r) => ({ x: MV.cm2m(r.x), y: MV.cm2m(r.y), z: MV.cm2m(r.z) });
    pts.online.set(pl.filter((r) => r.on).map(cv)); pts.offline.set(pl.filter((r) => !r.on).map(cv)); pts.bases.set(mapRows(rows.bases).map(cv));
    const g = groupObjs(); for (const k of KINDS) pts[k].set(g[k]);
    for (const [k] of LAYERS) pts[k].num.textContent = pts[k].count;
  }
  function plist() {
    const box = $('plist'); box.textContent = '';
    for (const r of mapRows(rows.players).filter((p) => p.on).slice(0, 100)) {
      const d = MV.el('div', null, r.n || 'Unbekannt'); d.onclick = () => env.jump(MV.cm2m(r.x), MV.cm2m(r.y), MV.cm2m(r.z), 120); box.append(d);
    }
  }
  async function pollStatic() {
    try { rows = await api('/api/static'); applyMarkers(); plist(); } catch (e) { if (e.status === 401) location.reload(); }
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
    stream.onerror = () => { if (stream && stream.readyState === 2) { setTimeout(() => api('/api/session').then(openStream).catch(() => location.reload()), 3000); } };
  }
  let dirty = false;
  setInterval(() => { if (dirty) { dirty = false; applyMarkers(); } }, 150);
  function hudTick() { if (terrain) $('hud').textContent = terrain.info() + (terrain.errors ? ' · ' + terrain.errors + ' Ladefehler' : ''); }

  boot();
})();

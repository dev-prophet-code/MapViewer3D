// MapViewer 3D v2 - Addon-Seite (läuft in der Console-Sandbox: kein Netzwerk, nur die Addon-Brücke).
(async function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const hud = $('hud');
  const POLL_MS = 6000; // weit unter dem Limit der Brücke (60 Aufrufe/Minute)
  const SQL_PLAYERS = "select ((a.transform).location).x as x, ((a.transform).location).y as y, ((a.transform).location).z as z, " +
    "coalesce(a.map,'') as map, coalesce(ps.online_status::text,'') as status " +
    "from dune.actors a join dune.player_state ps on ps.player_pawn_id = a.id where a.transform is not null limit 3000";
  const SQL_BASES = "select ((a.transform).location).x as x, ((a.transform).location).y as y, ((a.transform).location).z as z, " +
    "coalesce(a.map,'') as map from dune.buildings b join dune.building_instances bi on bi.building_id = b.id " +
    "join dune.actor_fgl_entities afe on afe.entity_id = bi.owner_entity_id join dune.actors a on a.id = afe.actor_id " +
    "where a.transform is not null group by a.id, a.map, a.transform limit 3000";

  const TERRAIN = { hagga: JSON.parse($('t-hagga').textContent), deep: JSON.parse($('t-deep').textContent) };
  const env = MV.createEnv($('c'), $('stage'));
  const layers = {
    online: { pts: MV.Points(env, 0x2f9bff, 11), name: 'Spieler online', color: '#2f9bff' },
    offline: { pts: MV.Points(env, 0x3a6a8a, 6), name: 'Spieler offline', color: '#3a6a8a' },
    bases: { pts: MV.Points(env, 0xff8a1f, 9), name: 'Basen', color: '#ff8a1f' },
  };
  for (const k in layers) {
    const l = MV.el('label', { class: 'l' }), cb = MV.el('input', { type: 'checkbox', checked: '' });
    cb.onchange = () => { layers[k].pts.obj.visible = cb.checked; };
    const sw = MV.el('span', { class: 'sw' }); sw.style.background = layers[k].color;
    l.append(cb, sw, document.createTextNode(layers[k].name));
    layers[k].count = MV.el('span', { class: 'note grow' }, '0'); l.append(layers[k].count); $('layers').append(l);
  }

  let current = 'hagga', info = null, rows = { players: [], bases: [] };
  const status = { bridge: ['off', 'Console-Brücke', 'wird geprüft …'], db: ['off', 'Spielerdaten (database:read)', 'wird geprüft …'] };
  function renderChecks() {
    const box = $('checks'); box.textContent = '';
    for (const k in status) {
      const [c, t, s] = status[k], row = MV.el('div', { class: 'chk' });
      const d = MV.el('div'); d.append(document.createTextNode(t), MV.el('small', null, s));
      row.append(MV.el('span', { class: 'dot ' + c }), d); box.append(row);
    }
    const rt = MV.el('div', { class: 'chk' }), d2 = MV.el('div');
    d2.append(document.createTextNode('Realtime Data'), MV.el('small', null, 'nur im Companion (Sandbox ohne Netzwerk)'));
    rt.append(MV.el('span', { class: 'dot' }), d2); box.append(rt);
  }

  let showGen = 0;
  async function showMap(key, keepCamera) {
    current = key; const gen = ++showGen; env.clear();
    const t = TERRAIN[key];
    if (!keepCamera) env.setMeta({ originX: t.originX, originY: t.originY, minZ: t.minZ, maxZ: t.maxZ, width: t.grid, spacing: t.extent / (t.grid - 1) });
    const terrain = await MV.CoarseTerrain(env, t, $('hq').checked ? 1 : 2);
    if (gen !== showGen) { terrain.remove(); return; } // überholt von einem neueren Aufruf
    info = terrain; hud.textContent = info.info();
    applyRows();
  }

  const mapKey = (m) => (/deep/i.test(m) ? 'deep' : /survival|hagga/i.test(m) ? 'hagga' : null);
  const pick = (r) => (Array.isArray(r) ? r : (r && Array.isArray(r.rows) ? r.rows : []));
  const pt = (r) => ({ x: MV.cm2m(r.x), y: MV.cm2m(r.y), z: MV.cm2m(r.z) });
  function applyRows() {
    const on = [], off = [], bs = [];
    for (const r of rows.players) { if (mapKey(r.map) !== current || !Number.isFinite(+r.x)) continue; (/online/i.test(r.status) && !/off/i.test(r.status) ? on : off).push(pt(r)); }
    for (const r of rows.bases) if (mapKey(r.map) === current && Number.isFinite(+r.x)) bs.push(pt(r));
    layers.online.pts.set(on); layers.offline.pts.set(off); layers.bases.pts.set(bs);
    layers.online.count.textContent = on.length; layers.offline.count.textContent = off.length; layers.bases.count.textContent = bs.length;
  }

  async function poll() {
    try {
      const [p, b] = await Promise.all([
        DuneAddon.request('database.query', { query: SQL_PLAYERS }),
        DuneAddon.request('database.query', { query: SQL_BASES }),
      ]);
      rows = { players: pick(p), bases: pick(b) };
      status.bridge = ['ok', 'Console-Brücke', 'verbunden'];
      status.db = ['ok', 'Spielerdaten (database:read)', rows.players.length + ' Spieler, ' + rows.bases.length + ' Basen'];
      applyRows();
    } catch (e) {
      const standalone = window.parent === window;
      status.bridge = [standalone ? 'warn' : 'bad', 'Console-Brücke', standalone ? 'Vorschau außerhalb der Console' : 'Fehler'];
      status.db = ['bad', 'Spielerdaten (database:read)', String(e && e.message || e).slice(0, 120)];
    }
    renderChecks();
  }

  // Einstellung: Adresse des Companion (nur Anzeige; die Sandbox darf dorthin nichts senden)
  const okUrl = (u) => { try { const x = new URL(u); return (x.protocol === 'https:' || (x.protocol === 'http:' && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(x.hostname))) && !x.username && !x.password; } catch (e) { return false; } };
  try {
    const e = await DuneAddon.request('addon.storage.get', { key: 'settings' });
    const v = e && (e.value || e);
    if (v && typeof v.companionUrl === 'string' && okUrl(v.companionUrl)) $('cUrl').value = v.companionUrl;
  } catch (e) { /* noch nichts gespeichert oder Vorschau */ }
  $('cSave').onclick = async () => {
    const u = $('cUrl').value.trim();
    if (u && !okUrl(u)) { $('cMsg').textContent = 'Nur https:// (oder http://localhost) ohne Zugangsdaten.'; return; }
    try {
      let ver = null; try { const e = await DuneAddon.request('addon.storage.get', { key: 'settings' }); ver = e && e.version != null ? e.version : null; } catch (x) { /* neu anlegen */ }
      await DuneAddon.request('addon.storage.put', { key: 'settings', value: { companionUrl: u }, expectedVersion: ver }); $('cMsg').textContent = 'Gespeichert. Öffne diese Adresse in einem neuen Browser-Tab.'; }
    catch (e) { $('cMsg').textContent = 'Speichern fehlgeschlagen: ' + String(e && e.message || e).slice(0, 100); }
  };

  $('map').onchange = (e) => showMap(e.target.value);
  $('hq').onchange = () => showMap(current, true);
  $('contours').onchange = (e) => { env.uniforms.uContours.value = e.target.checked ? 1 : 0; };
  $('grid').onchange = (e) => { env.uniforms.uGrid.value = e.target.checked ? 1 : 0; };
  renderChecks();
  await showMap('hagga');
  poll(); setInterval(poll, POLL_MS);
})();

// MapViewer 3D v2 - gemeinsame Oberfläche (Bedienfeld, Ebenenliste, Spielerliste, Dialoge, Sprache, Hell/Dunkel).
// Klassisches Skript, ohne HTML-Einfügen aus Strings: alle Texte (auch Spielernamen) werden als Text eingefügt.
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const UI = (globalThis.UI = {});
  const S = { en: {}, de: {} };
  let lang = /^de/i.test(navigator.language || '') ? 'de' : 'en';
  const hooks = [];

  UI.add = (d) => { Object.assign(S.en, d.en || {}); Object.assign(S.de, d.de || {}); };
  UI.t = (k, ...a) => { let s = S[lang][k] ?? S.en[k] ?? k; a.forEach((v, i) => { s = s.split('{' + i + '}').join(String(v)); }); return s; };
  UI.onLang = (f) => hooks.push(f);
  UI.offLang = (f) => { const i = hooks.indexOf(f); if (i >= 0) hooks.splice(i, 1); };

  UI.add({
    en: {
      language: 'Language', map: 'Map', 'jump.title': 'Jump to', online: 'online', 'live.title': 'Live map', 'layers.all': 'Show all', 'layers.none': 'Hide all',
      'conn.title': 'Connection', 'help.open': 'Camera controls & guide', 'help.title': 'Controls', close: 'Close', cancel: 'Cancel',
      'hud.panel': 'Show or hide the panel', 'hud.fullscreen': 'Fullscreen', 'players.none': 'Nobody online',
      'jump.search': 'Search player, base or place …', 'jump.empty': 'No matches found', 'terrain.title': 'Terrain display', 'terrain.grid': '1 km coordinate grid', 'terrain.contours': 'Contour lines (10 m / 50 m)', 'terrain.wireframe': 'Wireframe mesh',
      'compass.N': 'N', 'compass.E': 'E', 'compass.S': 'S', 'compass.W': 'W', 'compass.tip': 'Compass – click to face north', 'compass.facing': 'Facing', 'info.jump': 'Fly there', 'info.pos': 'Position', 'l.bases3d': 'Bases in 3D', 'l.labels': 'Names', 'l.beams': 'Light beams', 'name.worm': 'Sandworm', 'name.base': 'Base', 'name.storm': 'Sandstorm',
      'help.1': 'Mouse wheel: rotate the camera around the view centre. Shift + wheel: tilt up / down. Ctrl / ⌘ + wheel (trackpad: pinch): zoom. Left drag: move the map. Right drag: rotate and tilt freely. Click: details of a marker. Touch: one finger moves, two fingers zoom and rotate.',
      'help.2': 'Keyboard: W A S D or arrow keys fly forward / left / back / right, Q / E down / up, Shift faster, F fullscreen. The compass shows north; a click faces north.',
      'help.3': 'Everything is read-only: the viewer never changes anything on the server.',
    },
    de: {
      language: 'Sprache', map: 'Karte', 'jump.title': 'Springen zu', online: 'online', 'live.title': 'Live-Karte', 'layers.all': 'Alle zeigen', 'layers.none': 'Alle ausblenden',
      'conn.title': 'Verbindung', 'help.open': 'Kamerasteuerung & Anleitung', 'help.title': 'Steuerung', close: 'Schließen', cancel: 'Abbrechen',
      'hud.panel': 'Bedienfeld ein- oder ausblenden', 'hud.fullscreen': 'Vollbild', 'players.none': 'Niemand online',
      'jump.search': 'Spieler, Basis oder Ort suchen …', 'jump.empty': 'Keine Treffer gefunden', 'terrain.title': 'Geländedarstellung', 'terrain.grid': '1-km-Koordinatenraster', 'terrain.contours': 'Höhenlinien (10 m / 50 m)', 'terrain.wireframe': 'Drahtgitter',
      'compass.N': 'N', 'compass.E': 'O', 'compass.S': 'S', 'compass.W': 'W', 'compass.tip': 'Kompass – Klick richtet nach Norden aus', 'compass.facing': 'Blickrichtung', 'info.jump': 'Hinfliegen', 'info.pos': 'Position', 'l.bases3d': 'Basen in 3D', 'l.labels': 'Namen', 'l.beams': 'Leuchtsäulen', 'name.worm': 'Sandwurm', 'name.base': 'Basis', 'name.storm': 'Sandsturm',
      'help.1': 'Mausrad: Kamera um die Bildmitte drehen. Umschalt + Rad: nach oben / unten neigen. Strg / ⌘ + Rad (Trackpad: Pinch): zoomen. Links ziehen: Karte verschieben. Rechts ziehen: frei drehen und neigen. Klick: Details zu einem Marker. Touch: ein Finger verschiebt, zwei Finger zoomen und drehen.',
      'help.2': 'Tastatur: W A S D oder Pfeile fliegen vorwärts / links / zurück / rechts, Q / E runter / hoch, Umschalt schneller, F Vollbild. Der Kompass zeigt Norden, ein Klick richtet nach Norden aus.',
      'help.3': 'Alles ist nur lesend: Der Viewer verändert nichts auf dem Server.',
    },
  });

  UI.applyI18n = function () {
    document.documentElement.lang = lang;
    document.querySelectorAll('[data-i18n]').forEach((e) => { e.textContent = UI.t(e.dataset.i18n); });
    document.querySelectorAll('[data-i18n-title]').forEach((e) => { e.title = UI.t(e.dataset.i18nTitle); });
    document.querySelectorAll('[data-i18n-ph]').forEach((e) => { e.placeholder = UI.t(e.dataset.i18nPh); });
    const cp = $('compass'); if (cp) cp.title = UI.t('compass.tip');
    const body = $('helpBody'); body.textContent = '';
    for (const k of ['help.1', 'help.2', 'help.3']) { const p = document.createElement('p'); p.textContent = UI.t(k); body.append(p); }
    hooks.forEach((f) => f(lang));
  };

  UI.el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = String(text); return e; };

  // ---- Ebenenliste in Gruppen. defs: [{key,label,color,group}], groups: [{id,label}]
  UI.layers = function (groups, defs, onChange) {
    const box = $('layers'); box.textContent = ''; const rows = {};
    for (const g of groups) {
      const wrap = UI.el('div', 'lgroup'), head = UI.el('div', 'lhead'); head.dataset.g = g.id; head.textContent = UI.t(g.label); wrap.append(head);
      for (const d of defs.filter((x) => x.group === g.id)) {
        const row = UI.el('label', 'toggle'), cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = d.on !== false;
        // d.cls: Symbol aus dem CSS der Console (Klassen live-map-legend-dot marker-… subtype-…); sonst ein Farbfeld
        const sw = d.cls ? UI.el('span', 'live-map-legend-dot ' + d.cls) : UI.el('span', 'sw'); if (!d.cls) sw.style.background = d.color;
        const name = UI.el('span', null, UI.t(d.label)), count = UI.el('span', 'count', '0');
        cb.onchange = () => onChange(d.key, cb.checked);
        row.append(cb, sw, name, count); wrap.append(row); rows[d.key] = { row, cb, name, count, d, group: head, g };
      }
      box.append(wrap);
    }
    const api = {
      count(k, n) { rows[k].count.textContent = n; },
      disabled(k, off) { // merkt sich den Zustand und stellt ihn beim Wieder-Aktivieren her
        const r = rows[k]; if (!!off === r.cb.disabled) return;
        if (off) { r.prev = r.cb.checked; r.cb.checked = false; } else r.cb.checked = r.prev !== false;
        r.cb.disabled = !!off; r.row.classList.toggle('off', !!off); onChange(k, r.cb.checked);
      },
      setAll(on) { for (const k in rows) if (!rows[k].cb.disabled) { rows[k].cb.checked = on; onChange(k, on); } },
    };
    // Die Ebenenliste wird neu aufgebaut (Kartenwechsel, Atlas): den alten Sprach-Hook abmelden, sonst wächst die Liste ohne Ende
    if (UI._layersHook) UI.offLang(UI._layersHook);
    UI._layersHook = () => { for (const k in rows) { rows[k].name.textContent = UI.t(rows[k].d.label); rows[k].group.textContent = UI.t(rows[k].g.label); } };
    UI.onLang(UI._layersHook);
    $('layersAll').onclick = () => api.setAll(true); $('layersNone').onclick = () => api.setAll(false);
    return api;
  };

  // ---- Einzelner Schalter im Live-Abschnitt (z. B. feineres Gelände)
  UI.toggle = function (labelKey, onChange, initial) {
    const row = UI.el('label', 'toggle'), cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !!initial; const txt = UI.el('span');
    row.append(cb, txt); $('live').append(row);
    const set = () => { txt.textContent = UI.t(labelKey); }; set(); UI.onLang(set); cb.onchange = () => onChange(cb.checked);
  };

  // ---- Kleiner Hinweis neben dem Mauszeiger (Text über textContent, nie als HTML)
  UI.tip = function (text, x, y) {
    let t = $('tip'); if (!t) { t = UI.el('div', 'tip'); t.id = 'tip'; document.body.append(t); }
    if (!text) { t.style.display = 'none'; return; }
    t.textContent = text; t.style.left = x + 14 + 'px'; t.style.top = y + 14 + 'px'; t.style.display = 'block';
  };

  // ---- Koordinaten des Kamerazieles; nur schreiben, wenn sich der Text ändert
  UI.followCursor = function (env) {
    UI.terrain(env); UI.compass(env); env.setNight((document.documentElement.dataset.theme || 'dark') === 'dark');
    let last = '';
    env.onFrame(() => { const t = env.ctl.target, s = 'X ' + Math.round(t.x) + '  Y ' + Math.round(t.z) + '  Z ' + Math.round(t.y) + ' m'; if (s !== last) { last = s; UI.cursor(s); } });
  };

  // ---- Sprungliste. items: [{label, sub, pick}]
  UI.players = function (items) {
    UI._items = items; $('playerCount').textContent = items.length; UI.renderPlayers();
  };
  UI.renderPlayers = function () {
    const box = $('playerList'), items = UI._items || [], q = $('searchInput').value.trim().toLowerCase(); box.textContent = '';
    const list = q ? items.filter((it) => it.label.toLowerCase().includes(q)) : items;
    if (!list.length) { box.append(UI.el('div', 'empty', UI.t(items.length ? 'jump.empty' : 'players.none'))); return; }
    for (const it of list.slice(0, 200)) { const b = UI.el('button', null, it.label); b.type = 'button'; b.onclick = it.pick; box.append(b); }
  };

  UI.set = (id, text) => { $(id).textContent = text; };
  UI.status = (t) => UI.set('liveStatus', t); UI.conn = (t) => UI.set('connInfo', t); UI.mapinfo = (t) => UI.set('mapinfo', t); UI.cursor = (t) => UI.set('cursor', t); UI.hud = (t) => UI.set('hudinfo', t);
  UI.button = (text, onClick, cls) => { const b = UI.el('button', cls, text); b.type = 'button'; b.onclick = onClick; $('connButtons').append(b); return b; };
  UI.clearButtons = () => { $('connButtons').textContent = ''; };

  // ---- Dialog (Anmeldung, Einstellungen). opts: {title,intro,fields:[{name,label,type,placeholder}],submit,cancel,onSubmit(values)->Promise<string|null>}
  UI.dialog = function (o) {
    $('setupTitle').textContent = o.title; $('setupIntro').textContent = o.intro || '';
    const f = $('setupFields'); f.textContent = '';
    for (const x of o.fields || []) {
      const l = UI.el('label'); l.append(document.createTextNode(x.label));
      const i = document.createElement('input'); i.type = x.type || 'text'; i.name = x.name; i.placeholder = x.placeholder || ''; i.value = x.value || '';
      i.setAttribute('autocomplete', 'off'); i.spellcheck = false; i.maxLength = x.max || 300; if (x.required) i.required = true;
      l.append(i); f.append(l);
    }
    const cancel = $('setupCancel'); cancel.hidden = !o.cancel; cancel.textContent = o.cancel || '';
    $('setupSubmit').textContent = o.submit;
    const err = $('setupError'); err.hidden = true;
    const close = () => { $('setup').hidden = true; f.textContent = ''; };
    cancel.onclick = () => { close(); if (o.onCancel) o.onCancel(); };
    $('setupForm').onsubmit = async (ev) => {
      ev.preventDefault(); err.hidden = true; $('setupSubmit').disabled = true;
      const values = {}; f.querySelectorAll('input').forEach((i) => { values[i.name] = i.value.trim(); });
      let msg = null; try { msg = await o.onSubmit(values); } catch (e) { msg = String((e && e.message) || e).slice(0, 200); }
      $('setupSubmit').disabled = false;
      if (msg) { err.textContent = msg; err.hidden = false; return; }
      f.querySelectorAll('input[type=password]').forEach((i) => { i.value = ''; });
      close();
    };
    $('setup').hidden = false;
    const first = f.querySelector('input'); if (first) first.focus();
  };

  // ---- Geländedarstellung: Raster, Höhenlinien, Drahtgitter (wirken über die gemeinsamen Shader-Werte)
  UI.terrain = function (env) {
    if (UI._terrainDone) return; UI._terrainDone = true;
    for (const [key, set] of [['terrain.grid', (on) => { env.uniforms.uGrid.value = on ? 1 : 0; }], ['terrain.contours', (on) => { env.uniforms.uContours.value = on ? 1 : 0; }], ['terrain.wireframe', (on) => env.setWire(on)]]) {
      const row = UI.el('label', 'toggle'), cb = document.createElement('input'); cb.type = 'checkbox'; const txt = UI.el('span'); row.append(cb, txt); $('terrainToggles').append(row);
      const upd = () => { txt.textContent = UI.t(key); }; upd(); UI.onLang(upd); cb.onchange = () => set(cb.checked);
    }
  };

  // ---- Kompass: die Rose dreht sich gegen die Blickrichtung, ein Klick dreht die Kamera nach Norden (Norden = -Z)
  UI.compass = function (env) {
    const host = $('compass'); if (!host || UI._compass) return; UI._compass = true;
    const NS = 'http://www.w3.org/2000/svg', mk = (n, a, t) => { const e = document.createElementNS(NS, n); for (const k in a) e.setAttribute(k, a[k]); if (t) e.textContent = t; return e; };
    const svg = mk('svg', { viewBox: '0 0 84 84', 'aria-hidden': 'true' }), rose = mk('g', { class: 'compass-rose' }), letters = [];
    svg.append(mk('circle', { class: 'compass-disc', cx: 42, cy: 42, r: 40 }));
    rose.append(mk('circle', { class: 'compass-ring', cx: 42, cy: 42, r: 21 }), mk('path', { class: 'compass-ticks', d: 'M42 18v5M66 42h-5M42 66v-5M18 42h5M25 25l3 3M59 25l-3 3M59 59l-3-3M25 59l3-3' }));
    ['N', 'E', 'S', 'W'].forEach((c, i) => {
      const a = i * Math.PI / 2, x = 42 + 29 * Math.sin(a), y = 42 - 29 * Math.cos(a), tx = mk('text', { class: 'compass-card' + (c === 'N' ? ' north' : ''), x: x.toFixed(2), y: y.toFixed(2) }, UI.t('compass.' + c));
      letters.push({ tx, x, y, c }); rose.append(tx);
    });
    UI.onLang(() => letters.forEach((l) => { l.tx.textContent = UI.t('compass.' + l.c); }));
    svg.append(rose, mk('path', { class: 'compass-pointer', d: 'M42 26 51 52 42 47 33 52Z' }));
    host.replaceChildren(svg); host.setAttribute('role', 'button'); host.tabIndex = 0;
    const cam = env.cam, ctl = env.ctl, f = new THREE.Vector3(), off = new THREE.Vector3(), sph = new THREE.Spherical(); let shown = NaN, anim = null;
    const faceNorth = () => { off.subVectors(cam.position, ctl.target); sph.setFromVector3(off); anim = { from: sph.theta, to: Math.round(sph.theta / (2 * Math.PI)) * 2 * Math.PI, p: 0 }; };
    host.addEventListener('click', faceNorth); host.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); faceNorth(); } });
    env.onFrame(() => {
      if (anim) {
        anim.p = Math.min(1, anim.p + 1 / 27); const e = 1 - Math.pow(1 - anim.p, 3);
        off.subVectors(cam.position, ctl.target); sph.setFromVector3(off); sph.theta = anim.from + (anim.to - anim.from) * e; off.setFromSpherical(sph); cam.position.copy(ctl.target).add(off); cam.lookAt(ctl.target);
        if (anim.p >= 1) anim = null;
      }
      cam.getWorldDirection(f); const b = (Math.atan2(f.x, -f.z) * 180 / Math.PI + 360) % 360; if (Math.abs(b - shown) < 0.1) return; shown = b;
      rose.setAttribute('transform', 'rotate(' + (-b).toFixed(1) + ' 42 42)');
      for (const l of letters) l.tx.setAttribute('transform', 'rotate(' + b.toFixed(1) + ' ' + l.x.toFixed(2) + ' ' + l.y.toFixed(2) + ')');
      host.setAttribute('aria-label', UI.t('compass.facing') + ' ' + Math.round(b) + '°');
    });
  };

  // ---- Infofeld rechts. o: {title, lines:[[Name, Wert]], pick}; Texte nur über textContent
  UI.info = function (o) {
    const box = $('liveinfo'); if (!o) { box.hidden = true; return; }
    box.querySelector('.li-title').textContent = o.title; const dl = box.querySelector('.li-lines'); dl.textContent = '';
    for (const [k, v] of o.lines || []) { dl.append(UI.el('dt', null, k), UI.el('dd', null, v)); }
    box.querySelector('.li-jump').onclick = o.pick || null; box.querySelector('.li-jump').hidden = !o.pick; box.hidden = false;
  };
  // Klick (ohne Ziehen) auf die Karte: find(x, y) liefert das Infofeld oder null
  UI.clickPick = function (canvas, find) {
    let d = null;
    canvas.addEventListener('pointerdown', (e) => { d = [e.clientX, e.clientY]; });
    canvas.addEventListener('pointerup', (e) => { if (!d || Math.hypot(e.clientX - d[0], e.clientY - d[1]) > 5) { d = null; return; } d = null; UI.info(find(e.clientX, e.clientY) || null); });
  };

  // ---- Bedienelemente rechts, Sprache, Hell/Dunkel
  const modal = (id, open) => { $(id).hidden = !open; };
  $('helpOpen').onclick = $('helpBtn').onclick = () => modal('help', true);
  $('helpClose').onclick = () => modal('help', false);
  $('searchInput').oninput = () => UI.renderPlayers();
  document.querySelector('#liveinfo .li-close').onclick = () => UI.info(null);
  $('help').addEventListener('click', (e) => { if (e.target === $('help')) modal('help', false); });
  $('panelToggle').onclick = () => { const hide = !document.body.classList.contains('panel-hidden'); document.body.classList.toggle('panel-hidden', hide); $('panelToggle').setAttribute('aria-pressed', String(!hide)); };
  $('fsBtn').onclick = () => { try { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen(); } catch (e) { /* in der Sandbox evtl. nicht erlaubt */ } };
  document.querySelectorAll('[data-theme-set]').forEach((b) => { b.onclick = () => { document.documentElement.dataset.theme = b.dataset.themeSet; if (MV.env) MV.env.setNight(b.dataset.themeSet === 'dark'); document.querySelectorAll('[data-theme-set]').forEach((x) => x.classList.toggle('active', x === b)); }; });
  if (!document.documentElement.dataset.theme) document.documentElement.dataset.theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; // wie die Webseite: nach dem System
  document.querySelectorAll('[data-theme-set]').forEach((x) => x.classList.toggle('active', x.dataset.themeSet === (document.documentElement.dataset.theme || 'dark')));
  $('lang').value = lang;
  $('lang').onchange = (e) => { lang = e.target.value === 'de' ? 'de' : 'en'; UI.applyI18n(); };
  UI.lang = () => lang;
  UI.applyI18n();
})();

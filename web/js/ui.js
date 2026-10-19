// Bedienfeld: Kartenauswahl, Spielerliste („Springen zu“), Schalter der
// Live-Karte mit Symbolen und das Infofeld für ausgewählte Objekte.
import { CATEGORIES, TOGGLES } from './live/live.js';
import { AGENT_TOGGLES } from './live/agent.js';
import { iconElement, legendIcon } from './live/icons.js';
import { t } from './i18n.js';
import { isTyping } from './fly.js';

const $ = (id) => document.getElementById(id);
// Schalter und Liste zeigen dieselben Symbole wie die Karte
const icon = legendIcon;

const TOGGLE_KEYS = new Set(TOGGLES.map((x) => x.key));
// Reihenfolge und Gruppen der Ebenenliste (Schlüssel: toggle.<key> bzw. cat.<key> in i18n.js)
const LAYER_GROUPS = [
  { keys: ['players', 'offline', 'vehicles', 'bases', 'bases3d', 'storage'] },
  { title: 'layers.group.resources', keys: ['spice', 'flour', 'ore', 'scrap', 'flora'] },
  { title: 'layers.group.world', keys: ['cave', 'ecolab', 'wreck', 'sietch', 'trading', 'npc', 'fortress', 'enemy', 'quicksand', 'drumsand', 'radiation'] },
  { title: 'layers.group.live', keys: AGENT_TOGGLES.map((x) => x.key) },
  { title: 'layers.group.display', keys: ['labels', 'beams'] },
];
// every category must be in a group (checked by tests/ui-layers.mjs)
export const LAYER_KEYS = LAYER_GROUPS.flatMap((g) => g.keys);
export const KNOWN_LAYER_KEYS = [...TOGGLES.map((x) => x.key), ...CATEGORIES.map((x) => x.key)];

// Entfernt Ebenen, die hier nicht funktionieren können (z. B. ohne Spielerzugriff), samt leerer Gruppen.
export function removeLayers(keys) {
  for (const k of keys) $('layers').querySelector(`.toggle[data-key="${k}"]`)?.remove();
  for (const sec of $('layers').querySelectorAll('.lgroup')) if (!sec.querySelector('.toggle')) sec.remove();
}

export function bindUi({ live, jumpTo, onMap }) {
  // Ebenen in Gruppen, wie die Layers-Liste der Live-Karte der Console: oben die Live-Akteure,
  // dann Ressourcen und Welt, dann die Echtzeitdaten und die Anzeige. Eine Gruppe hat einen
  // Schalter für alle ihre Ebenen (halb gesetzt, wenn nur einige an sind).
  const wrap = $('layers');
  const labelOf = (key) => (TOGGLE_KEYS.has(key) ? t(`toggle.${key}`) : t(`cat.${key}`));
  // like the Console's Layers: spice, flour sand and the points of interest start on
  const CAT_ON = new Set(['spice', 'flour', 'cave', 'ecolab', 'wreck', 'sietch', 'trading', 'npc']);
  const defaultOn = (key) => TOGGLES.find((x) => x.key === key)?.on ?? CAT_ON.has(key);
  const refreshGroup = (box) => {
    const inputs = [...box.closest('.lgroup').querySelectorAll('.toggle input')];
    const n = inputs.filter((i) => i.checked).length;
    box.checked = n === inputs.length && n > 0;
    box.indeterminate = n > 0 && n < inputs.length;
  };
  for (const g of LAYER_GROUPS) {
    const sec = document.createElement('section');
    sec.className = 'lgroup';
    if (g.title) {
      const head = document.createElement('label');
      head.className = 'lhead';
      const all = Object.assign(document.createElement('input'), { type: 'checkbox' });
      const text = document.createElement('span');
      text.dataset.i18nKey = g.title;
      text.textContent = t(g.title);
      head.append(all, text);
      sec.append(head);
      all.addEventListener('change', () => {
        for (const i of sec.querySelectorAll('.toggle input')) {
          if (i.checked !== all.checked) { i.checked = all.checked; i.dispatchEvent(new Event('change')); }
        }
        all.indeterminate = false;
      });
    }
    const list = document.createElement('div');
    list.className = 'toggles';
    for (const key of g.keys) {
      const l = document.createElement('label');
      l.className = 'toggle';
      l.dataset.key = key;
      const input = Object.assign(document.createElement('input'), { type: 'checkbox', checked: defaultOn(key) });
      input.addEventListener('change', () => {
        live.setShow(key, input.checked);
        const head = sec.querySelector('.lhead input');
        if (head) refreshGroup(head);
      });
      const name = Object.assign(document.createElement('span'), { className: 'lname', textContent: labelOf(key) });
      l.append(input, icon(key), name);
      list.append(l);
    }
    sec.append(list);
    wrap.append(sec);
    const head = sec.querySelector('.lhead input');
    if (head) refreshGroup(head);
  }

  // Anzahl je Ebene hinter dem Namen; 0 = die Console liefert für diese Karte nichts (Ebene ausgegraut)
  live.onCounts = (counts) => {
    for (const l of wrap.querySelectorAll('.toggle')) {
      const n = counts[l.dataset.key];
      if (n === undefined) continue;
      let c = l.querySelector('.count');
      if (!c) { c = Object.assign(document.createElement('span'), { className: 'count' }); l.append(c); }
      c.textContent = n;
      l.classList.toggle('empty', n === 0);
      l.title = n === 0 ? t('layers.empty') : '';
    }
  };

  // Sprachwechsel ohne Neuladen: Beschriftung tauschen, Zustand behalten
  window.addEventListener('langchange', () => {
    for (const l of wrap.querySelectorAll('.toggle')) { l.querySelector('.lname').textContent = labelOf(l.dataset.key); if (l.classList.contains('empty')) l.title = t('layers.empty'); }
    for (const h of wrap.querySelectorAll('[data-i18n-key]')) h.textContent = t(h.dataset.i18nKey);
  });

  // Alle Ebenen ein-/ausblenden
  const setAll = (on) => {
    for (const box of document.querySelectorAll('#layers .toggle input')) {
      if (box.checked !== on) { box.checked = on; box.dispatchEvent(new Event('change')); }
    }
  };
  $('layersAll').addEventListener('click', () => setAll(true));
  $('layersNone').addEventListener('click', () => setAll(false));

  // Spielerliste
  live.onPlayers = (rows) => {
    $('playerCount').textContent = rows.length;
    const list = $('playerList');
    if (!rows.length) {
      list.replaceChildren(Object.assign(document.createElement('div'), { className: 'empty', textContent: t('jump.nobody') }));
      return;
    }
    list.replaceChildren(...rows.map((r) => {
      const b = document.createElement('button');
      b.append(icon('players'), document.createTextNode(r.name));
      b.addEventListener('click', () => {
        const p = live.playerPosition(r.id);
        if (p) jumpTo(p.x, p.z, 60);
        live.select({ kind: 'player', row: r, obj: live.players.get(r.id)?.obj });
      });
      return b;
    }));
  };
  live.onStatus = (s) => { $('liveStatus').textContent = s; };

  // Infofeld
  const info = $('liveinfo');
  info.querySelector('.li-close').addEventListener('click', () => live.select(null));
  info.querySelector('.li-jump').addEventListener('click', () => {
    const s = live.selected;
    if (!s) return;
    const p = s.local ?? s.obj.position;
    jumpTo(p.x, p.z, 120);
  });
  live.onSelect = (item, d) => {
    info.hidden = !item;
    if (!item) return;
    info.querySelector('.li-icon').replaceChildren(iconElement(d.spec, d.icon));
    info.querySelector('.li-title').textContent = d.title;
    info.querySelector('.li-lines').replaceChildren(...d.lines.flatMap(([k, v]) => [
      Object.assign(document.createElement('dt'), { textContent: k }),
      Object.assign(document.createElement('dd'), { textContent: v }),
    ]));
  };

  // Kartenauswahl: je Karte eine Gruppe, darin die Serverinstanzen (PvE, PvP …)
  return (maps, current) => {
    const sel = $('map');
    sel.replaceChildren();
    const entries = [];
    for (const m of maps) {
      const views = m.views?.length ? m.views : [null];
      const og = document.createElement('optgroup');
      og.label = m.title || m.name;
      for (const v of views) {
        const id = v ? `${m.name}@${v.partition}` : m.name;
        og.append(new Option(v ? `${m.title} – ${v.label}` : m.title, id));
        entries.push({ id, map: m, view: v });
      }
      sel.append(og);
    }
    sel.value = current;
    sel.onchange = () => onMap(entries.find((e) => e.id === sel.value));
    return entries;
  };
}

// Anzeige je Karte: Kurzinfo und ob es Live-Daten gibt
export function showMapInfo(m, view) {
  const km = (v) => (v / 100000).toFixed(2);
  $('mapinfo').textContent =
    `${km((m.width - 1) * m.spacing)} × ${km((m.height - 1) * m.spacing)} km · ${t('mapinfo.grid')} ${m.spacing / 100} m`
    + `\n${t('mapinfo.height')} ${(m.minZ / 100).toFixed(0)} … ${(m.maxZ / 100).toFixed(0)} m`
    + (view ? `\n${t('mapinfo.instance')}: ${view.label} (Partition ${view.partition}, ${view.internal})` : '')
    + coriolisInfo(m);
  $('live').hidden = !m.live;
  $('jump').hidden = !m.live || $('jump').dataset.shareOff === '1';
  $('nolive').hidden = !!m.live;
}

// Deep Desert: Layout des Servers, nächster Wechsel und ob das Gelände dazu passt
function coriolisInfo(m) {
  const c = m.coriolis;
  if (!c) return '';
  let text = `\n${t('mapinfo.layout', { n: c.layout })}`;
  const next = c.nextCycle ? new Date(c.nextCycle) : null;
  if (next && !Number.isNaN(next.getTime())) {
    const min = Math.max(0, Math.round((next - Date.now()) / 60000));
    const left = `${Math.floor(min / 1440)} ${t('unit.d')} ${Math.floor((min % 1440) / 60)} ${t('unit.h')}`;
    text += ` · ${t('mapinfo.layout.next', { date: next.toLocaleString(), left })}`;
  }
  if (!c.match) {
    text += `\n⚠ ${c.building
      ? t('mapinfo.layout.building', { live: c.layout })
      : m.layout
        ? t('mapinfo.layout.other', { have: m.layout, live: c.layout })
        : t('mapinfo.layout.generic', { live: c.layout })}`;
  }
  return text;
}

// Rechte Anzeige: Seitenleiste, Vollbild und Anleitung
export function bindHud() {
  const panelBtn = $('panelToggle');
  panelBtn.addEventListener('click', () => {
    const hidden = document.body.classList.toggle('panel-hidden');
    panelBtn.setAttribute('aria-pressed', String(!hidden));
  });

  const fsBtn = $('fsBtn');
  const root = document.documentElement;
  const toggleFs = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else root.requestFullscreen?.().catch(() => { /* vom Browser abgelehnt (z. B. eingebettet ohne allowfullscreen) */ });
  };
  const syncFs = () => {
    const on = !!document.fullscreenElement;
    fsBtn.setAttribute('aria-pressed', String(on));
    fsBtn.title = t(on ? 'hud.fullscreen.exit' : 'hud.fullscreen');
    fsBtn.setAttribute('aria-label', fsBtn.title);
  };
  if (!root.requestFullscreen) fsBtn.hidden = true;
  fsBtn.addEventListener('click', toggleFs);
  document.addEventListener('fullscreenchange', syncFs);

  const help = $('help');
  const setHelp = (on) => { help.hidden = !on; };
  for (const id of ['helpBtn', 'helpOpen']) $(id).addEventListener('click', () => setHelp(true));
  $('helpClose').addEventListener('click', () => setHelp(false));
  help.addEventListener('pointerdown', (e) => { if (e.target === help) setHelp(false); });

  addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e)) return;
    if (e.key === 'Escape') setHelp(false);
    else if (e.code === 'KeyF' && !e.repeat) toggleFs();
  });
}

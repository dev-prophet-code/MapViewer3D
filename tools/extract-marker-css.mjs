#!/usr/bin/env node
// Übernimmt die Marker-Regeln der Live-Karte aus dem CSS der Dune Docker Console (MIT, © RedBlink) und erzeugt:
//   viewer/markers.css       die Regeln .live-map-marker / .live-map-legend-dot (Symbole als relative URL icons/<Datei>)
//   viewer/marker-defs.js    Tabelle Typ/Untertyp → Symbol, Größe, Farbe (MV.MARKER_DEFS), für die 3D-Ansicht
// Es werden keine Bilder kopiert: Der Companion holt die Symbole zur Laufzeit von der Console (fester Dateiname, siehe docs).
// Aufruf: node tools/extract-marker-css.mjs <pfad zu dune-awakening-selfhost-docker/console/web/src/styles.css>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = process.argv[2];
if (!src) { console.error('Pfad zur styles.css der Console angeben.'); process.exit(2); }
const css = fs.readFileSync(src, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

// Regeln auf oberster Ebene (verschachtelte @media/@supports werden übersprungen)
const rules = []; let i = 0;
while (i < css.length) {
  const open = css.indexOf('{', i); if (open < 0) break;
  const sel = css.slice(i, open).trim();
  let depth = 1, j = open + 1; while (j < css.length && depth) { if (css[j] === '{') depth++; else if (css[j] === '}') depth--; j++; }
  if (!sel.startsWith('@')) rules.push({ sel, body: css.slice(open + 1, j - 1).trim() });
  i = j;
}
const wanted = rules.filter((r) => r.sel.split(',').every((s) => /\.live-map-(marker|legend-dot)\b/.test(s)) && !/teleport-preview|\.dragging|\.live-map-marker-layer|label|tooltip|popover/.test(r.sel));

const px = (b, p) => { const m = new RegExp('(?:^|[;\\s])' + p + '\\s*:\\s*(\\d+)px').exec(b); return m ? +m[1] : null; };
const icon = (b) => { const m = /url\("\/images\/maps\/([A-Za-z0-9_.-]+)"\)/.exec(b); return m ? m[1] : null; };
const defs = { icon: { type: {}, subtype: {} }, size: { type: {}, subtype: {} }, color: {} };
for (const r of wanted) {
  const parts = r.sel.split(',').map((s) => s.trim());
  for (const s of parts) {
    if (s.includes(':hover') || s.includes('::after') || s.startsWith('.live-map-legend-dot')) { /* nur .live-map-marker liefert Größe; Symbol nehmen wir überall */ }
    const t = /\.marker-([a-z_]+)/.exec(s), st = /\.subtype-([a-z0-9_]+)/.exec(s);
    const ic = icon(r.body), w = px(r.body, 'width'), hover = s.includes(':hover');
    if (ic && !s.includes('::')) { if (st) defs.icon.subtype[st[1]] = ic; else if (t) defs.icon.type[t[1]] = ic; }
    if (w && !hover && s.startsWith('.live-map-marker') && !s.includes('::') && !/\[class\*=/.test(s)) { if (st) defs.size.subtype[st[1]] = w; else if (t && !/\.spice-size/.test(s)) defs.size.type[t[1]] = w; }
    const col = /(?:^|[;\s])color\s*:\s*(#[0-9a-fA-F]{3,8})/.exec(r.body);
    if (col && t && !st && s.startsWith('.live-map-marker')) defs.color[t[1]] = col[1];
  }
}
// Gruppenregeln der Console (hohe Spezifität, in der CSS als Ausnahmen kommentiert)
const GROUP_SIZE = { vehicle: 32, poi: 28, house_representative: 28, trainer: 28 };
defs.groupSize = GROUP_SIZE; defs.defaultSubtypeSize = 20; defs.defaultDot = 12;
defs.spiceTier = { large: 48, medium: 34, small: 24 };
// Hausvertreter und Trainer haben je Untertyp ein Symbol, aber nur einen Typ-Eintrag in der Console: Kategorie aus dem Namen ableiten
const header = `/* Marker der Live-Karte, übernommen aus dem CSS der Dune Docker Console (Red-Blink/dune-awakening-selfhost-docker, MIT, © RedBlink).
   Erzeugt von tools/extract-marker-css.mjs, nicht von Hand ändern. Symbole: relative URL icons/<Datei>; der Companion holt sie
   zur Laufzeit von der Console (keine Bilder im Repository, siehe NOTICE der Console). */\n`;
let out = header;
for (const r of wanted) out += r.sel + ' { ' + r.body.replace(/url\("\/images\/maps\//g, 'url("icons/').replace(/\s+/g, ' ') + ' }\n';
out += `.live-map-legend-dot { display: inline-block; flex: 0 0 18px; width: 18px; height: 18px; border-radius: 50%; border: 0; }\n`;
fs.writeFileSync(path.join(root, 'viewer/markers.css'), out);
const js = `// Marker-Tabelle der Live-Karte (aus dem CSS der Dune Docker Console, MIT, © RedBlink). Erzeugt von tools/extract-marker-css.mjs.
(function () { 'use strict'; globalThis.MV = globalThis.MV || {}; MV.MARKER_DEFS = ${JSON.stringify(defs, null, 1)}; })();\n`;
fs.writeFileSync(path.join(root, 'viewer/marker-defs.js'), js);
console.log(`markers.css: ${wanted.length} Regeln · Symbole: ${Object.keys(defs.icon.type).length} Typen, ${Object.keys(defs.icon.subtype).length} Untertypen · Farben: ${Object.keys(defs.color).join(', ')}`);

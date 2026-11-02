#!/usr/bin/env node
// Erzeugt viewer/marker-extra.css aus den Symbol-Beschreibungen in viewer/marker-extra.js (MV.GLYPHS).
// Die Piktogramme sind reines CSS (Verläufe auf einem Element, ohne Bilder), im Stil der Marker der Console:
// kein Rand, dunkler Schatten, 24-Einheiten-Raster. Reihenfolge wie auf der Leinwand: spätere Teile liegen oben (CSS: erste Ebene oben, daher umgekehrt). Aufruf: node tools/gen-marker-extra.mjs [--check]
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ctx = vm.createContext({}); ctx.globalThis = ctx;
vm.runInContext(fs.readFileSync(path.join(root, 'viewer/marker-extra.js'), 'utf8'), ctx);
const G = ctx.MV.GLYPHS;
const u = (n) => `calc(var(--u) * ${+n.toFixed(2)})`;
const layer = (q) => {
  if (q[0] === 'rect') { const [, x, y, w, h, c] = q; return `linear-gradient(${c}, ${c}) ${u(x)} ${u(y)} / ${u(w)} ${u(h)} no-repeat`; }
  if (q[0] === 'circle') { const [, cx, cy, r, c] = q; return `radial-gradient(circle closest-side, ${c} calc(100% - 1px), transparent 100%) ${u(cx - r)} ${u(cy - r)} / ${u(r * 2)} ${u(r * 2)} no-repeat`; }
  if (q[0] === 'ring') { const [, cx, cy, r, c, w = 2] = q, inner = Math.round(((r - w) / r) * 100); return `radial-gradient(circle closest-side, transparent ${inner}%, ${c} ${inner}%, ${c} calc(100% - 1px), transparent 100%) ${u(cx - r)} ${u(cy - r)} / ${u(r * 2)} ${u(r * 2)} no-repeat`; }
  throw new Error('Primitiv unbekannt: ' + q[0]);
};
let css = `/* Symbole der Marker ohne eigenes Console-Symbol, gezeichnet in reinem CSS (kein Bild).
   Erzeugt von tools/gen-marker-extra.mjs aus viewer/marker-extra.js, nicht von Hand ändern.
   Stil wie die Marker der Console: kein Rand, dunkler Schatten, Raster 24 × 24 (--u = Einheit). */
.live-map-legend-dot[class*="mv-glyph-"], .live-map-marker[class*="mv-glyph-"] { --u: .75px; display: inline-block; flex: 0 0 18px; width: 18px; height: 18px; min-width: 18px; border: none; border-radius: 0; box-shadow: none; filter: drop-shadow(0 1px 1.5px rgba(9, 11, 13, .65)); }
`;
for (const [k, g] of Object.entries(G)) css += `.live-map-legend-dot.mv-glyph-${k}, .live-map-marker.mv-glyph-${k} { background: ${[...g.p].reverse().map(layer).join(', ')}; }\n`;
const out = path.join(root, 'viewer/marker-extra.css');
if (process.argv.includes('--check')) { if (!fs.existsSync(out) || fs.readFileSync(out, 'utf8') !== css) { console.error('viewer/marker-extra.css ist nicht aktuell: node tools/gen-marker-extra.mjs'); process.exit(1); } console.log('marker-extra.css ist aktuell'); }
else { fs.writeFileSync(out, css); console.log(`marker-extra.css: ${Object.keys(G).length} Symbole`); }

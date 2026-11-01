#!/usr/bin/env node
// Baut Addon-Seite (eine HTML-Datei, Sandbox-tauglich) und Companion-Seite (CSP-tauglich, ohne Inline-Skripte).
// Keine Abhängigkeiten. Ausführen: node scripts/build.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rd = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const wr = (p, s) => { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), s); };
const version = rd('VERSION').trim();

// three.js und OrbitControls als klassische Skripte (kein Modul-Import, kein blob:, kein eval)
function classicThree() {
  let s = rd('vendor/three/three.module.js');
  const m = s.match(/export\s*\{([^}]*)\}\s*;?\s*$/);
  if (!m) throw new Error('three.module.js: Exportliste nicht gefunden');
  if (/(^|\n)export\s+(const|let|var|function|class|default)/.test(s)) throw new Error('three.module.js: unerwartetes export');
  const names = m[1].split(',').map((x) => x.trim()).filter(Boolean);
  if (names.some((n) => /\s/.test(n))) throw new Error('three.module.js: "as"-Export nicht unterstützt');
  s = s.slice(0, m.index);
  return `(function(){\n${s}\nglobalThis.THREE={${names.join(',')}};\n})();\n`;
}
function classicOrbit() {
  let s = rd('vendor/three/OrbitControls.js');
  const im = s.match(/import\s*\{([^}]*)\}\s*from\s*['"]three['"]\s*;/);
  if (!im) throw new Error('OrbitControls: import nicht gefunden');
  s = s.replace(im[0], `const {${im[1].replace(/\s+/g, ' ').trim()}} = THREE;`).replace(/export\s*\{\s*OrbitControls\s*\}\s*;?/, 'globalThis.OrbitControls = OrbitControls;');
  if (/\bexport\b\s*\{|^import /m.test(s)) throw new Error('OrbitControls: Rest-Import/Export');
  return `(function(){\n${s}\n})();\n`;
}
const safeInline = (t) => { if (/<\/script/i.test(t)) throw new Error('</script> in eingebettetem Text'); return t; };

const three = classicThree(), orbit = classicOrbit();
const core = rd('viewer/core.js'), css = rd('viewer/style.css'), shell = rd('viewer/shell.js'), body = rd('viewer/shell.html');

// --- Addon: alles in einer Datei
const terrain = { hagga: rd('addon/data/terrain-survival_1.json').trim(), deep: rd('addon/data/terrain-deepdesert_1.json').trim() };
// Ein einziger Durchlauf über die Vorlage: eingesetzter Text wird nie erneut nach Platzhaltern durchsucht.
const fill = (tpl, map) => tpl.replace(/__([A-Z_]+)__/g, (m, k) => (k in map ? map[k] : m));
const bodyHtml = fill(body, { VERSION: version });
const addonHtml = fill(rd('viewer/addon.template.html'), {
  VERSION: version, CSS: css, BODY: bodyHtml, THREE: safeInline(three), ORBIT: safeInline(orbit), CORE: safeInline(core), SHELL: safeInline(shell),
  TERRAIN_HAGGA: safeInline(terrain.hagga), TERRAIN_DEEP: safeInline(terrain.deep), APP: safeInline(rd('viewer/addon-app.js')),
});
wr('addon/web/index.html', addonHtml);

// --- Companion: getrennte Dateien, keine Inline-Skripte/-Styles (strenge CSP)
wr('companion/public/three.js', three);
wr('companion/public/orbit.js', orbit);
wr('companion/public/core.js', core);
wr('companion/public/shell.js', shell);
wr('companion/public/app.js', rd('viewer/companion-app.js'));
wr('companion/public/app.css', css);
wr('companion/public/index.html', fill(rd('viewer/companion.index.html'), { VERSION: version, BODY: bodyHtml }));
console.log(`gebaut: v${version} · Addon ${(addonHtml.length / 1024).toFixed(0)} KiB`);

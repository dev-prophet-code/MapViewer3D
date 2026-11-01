#!/usr/bin/env node
// The source checks of scripts/verify-source.sh must catch what they are for: storage APIs outside
// the files meant to use them, a new unreviewed script, computed access to globals, dynamic code.
// Each case checks a copy of the addon with ONE violation and expects a failure.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mv3d-verify-'));
let n = 0;

function pack(mutate) {
  const dir = path.join(tmp, `c${n++}`);
  fs.mkdirSync(dir);
  for (const f of ['addon.json', 'README.md']) fs.copyFileSync(path.join(root, f), path.join(dir, f));
  fs.cpSync(path.join(root, 'web'), path.join(dir, 'web'), { recursive: true });
  fs.cpSync(path.join(root, 'sandbox'), path.join(dir, 'sandbox'), { recursive: true });
  mutate?.(dir);
  return spawnSync('bash', [path.join(root, 'scripts', 'verify-source.sh'), dir], { encoding: 'utf8' });
}
const append = (file, code) => (dir) => fs.appendFileSync(path.join(dir, 'web', 'js', file), `\n${code}\n`);

import { strip } from '../scripts/strip-comments.mjs';
let failures = 0;
const test = (name, fn) => { try { fn(); console.log(`ok   ${name}`); } catch (e) { failures++; console.error(`FAIL ${name}\n     ${e.stack ?? e}`); } };
const refused = (r, text) => { assert.notEqual(r.status, 0, 'the package must be refused'); assert.match(r.stderr, text); };

test('the unchanged addon passes', () => { const r = pack(); assert.equal(r.status, 0, r.stderr + r.stdout); });
test('localStorage in a file that must not use it', () => refused(pack(append('share.js', "localStorage.setItem('k', key);")), /not allowed in this file|browser storage API/));
test('storage code moved into another existing file', () => refused(pack(append('api.js', "sessionStorage.setItem('k', 1);")), /api\.js uses sessionStorage/));
test('a cookie anywhere', () => refused(pack(append('i18n.js', "document.cookie = 'k=1';")), /i18n\.js uses document\.cookie/));
test('IndexedDB in the file that may use the Cache API', () => refused(pack(append('data.js', "indexedDB.open('k');")), /data\.js uses indexedDB/));
test('a brand-new script is not accepted unreviewed', () => refused(pack((dir) => fs.writeFileSync(path.join(dir, 'web', 'js', 'extra.js'), 'export const x = 1;\n')), /set of scripts in web\/js changed/));
test('computed access to a global (window["local"+"Storage"])', () => refused(pack(append('ui.js', "const s = window['local' + 'Storage'];")), /computed access|dynamic code/));
test('code after a URL on the same line (the old comment stripping hid it)', () => refused(pack(append('share.js', "const u = 'https://x'; localStorage.setItem('k', currentKey());")), /share\.js uses localStorage|browser storage API/));
test('code after a // inside a template string', () => refused(pack(append('api.js', "const u = `//`; sessionStorage.setItem('k', 1);")), /api\.js uses sessionStorage/));
test('eval', () => refused(pack(append('main.js', "eval('1');")), /dynamic code/));
test('dynamic import', () => refused(pack(append('main.js', "const m = import('./x.js');")), /dynamic code/));

test('a new unreviewed script in sandbox/', () => refused(pack((dir) => fs.writeFileSync(path.join(dir, 'sandbox', 'extra.js'), 'export const x = 1;\n')), /set of scripts in sandbox\/ changed/));
test('the network in sandbox/', () => refused(pack((dir) => fs.appendFileSync(path.join(dir, 'sandbox', 'api.js'), "\nfetch('/x');\n")), /must not use storage, dynamic code or the network/));
test('storage in sandbox/', () => refused(pack((dir) => fs.appendFileSync(path.join(dir, 'sandbox', 'live-data.js'), "\nlocalStorage.setItem('a', 1);\n")), /must not use storage/));
test('another permission', () => refused(pack((dir) => { const f = path.join(dir, 'addon.json'); const m = JSON.parse(fs.readFileSync(f, 'utf8')); m.permissions.database = ['read', 'write']; fs.writeFileSync(f, JSON.stringify(m)); }), /permissions must be exactly/));

// ---- the package check (verify-package.sh) on a small stand-in for the built page ----
function page({ extra = '', script = 'export {};', blocks } = {}) {
  const core = { minLevel: 2, catalog: { maps: [{ name: 'M' }] }, indexes: { M: {} }, tiles: { a: 'b' }, icons: {} };
  const b = blocks ?? { 'mv-core': core, 'mv-models': { index: {}, meshes: {} }, 'mv-maps': {} };
  const data = Object.entries(b).map(([id, v]) => `<script type="application/json" id="${id}">${JSON.stringify(v)}</script>`).join('\n');
  return `<!doctype html><html><head><style>body{}</style>${extra}</head><body>${data}<script type="module">${script}</script></body></html>`;
}
function zipPackage(html, { files = {}, mutateManifest } = {}) {
  const dir = path.join(tmp, `p${n++}`);
  fs.mkdirSync(path.join(dir, 'web'), { recursive: true });
  const m = JSON.parse(fs.readFileSync(path.join(root, 'addon.json'), 'utf8'));
  mutateManifest?.(m);
  fs.writeFileSync(path.join(dir, 'addon.json'), JSON.stringify(m));
  fs.writeFileSync(path.join(dir, 'README.md'), '# x\n');
  fs.writeFileSync(path.join(dir, 'web', 'index.html'), html);
  for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), c);
  const zip = path.join(dir, `${m.id}-${m.version}.zip`);
  const z = spawnSync('zip', ['-X', '-r', zip, 'addon.json', 'README.md', 'web', ...Object.keys(files)], { cwd: dir, encoding: 'utf8' });
  assert.equal(z.status, 0, z.stderr);
  return spawnSync('bash', [path.join(root, 'scripts', 'verify-package.sh'), zip], { encoding: 'utf8' });
}
test('a self-contained page passes the package check', () => { const r = zipPackage(page()); assert.equal(r.status, 0, r.stderr + r.stdout); });
test('package: a separate script file', () => refused(zipPackage(page({ extra: '<script src="x.js"></script>' })), /separate script/));
test('package: a separate style file', () => refused(zipPackage(page({ extra: '<link rel="stylesheet" href="x.css">' })), /separate style/));
test('package: an extra file', () => refused(zipPackage(page(), { files: { 'extra.js': 'x' } }), /exactly addon.json/));
test('package: sessionStorage in the page script', () => refused(zipPackage(page({ script: "sessionStorage.setItem('a', 1);" })), /sessionStorage/));
test('package: a data block that is not JSON', () => refused(zipPackage(page().replace('{"minLevel"', '{"minLevel" x')), /not valid JSON/));
test('package: a missing data block', () => refused(zipPackage(page({ blocks: { 'mv-core': { minLevel: 2, catalog: { maps: [] }, tiles: {}, icons: {} } } })), /missing|lacks/));
test('package: a script syntax error', () => refused(zipPackage(page({ script: 'const = ;' })), /node --check/));
test('package: another permission', () => refused(zipPackage(page(), { mutateManifest: (m) => { m.permissions = { files: ['addon-data'] }; } }), /unexpected permissions/));

test('the comment scanner: comments go, markers inside strings and regexes stay', () => {
  assert.equal(strip("a(); // c\nb();").trim(), 'a(); \nb();');
  assert.equal(strip("/* x */ y();").trim(), 'y();');
  assert.equal(strip("const u = 'https://x'; z();"), "const u = 'https://x'; z();");
  assert.equal(strip('const u = "a // b"; z();'), 'const u = "a // b"; z();');
  assert.equal(strip("const t = `//${1}`; z();"), "const t = `//${1}`; z();");
  assert.equal(strip("const r = /'\\/\\/(x)/; z();"), "const r = /'\\/\\/(x)/; z();");
  assert.equal(strip("const d = a / b; // c").trim(), 'const d = a / b;');
});

if (failures) { console.error(`\n${failures} test(s) failed`); process.exit(1); }
console.log('\nall package check tests passed');

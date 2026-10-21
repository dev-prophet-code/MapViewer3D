#!/usr/bin/env node
// The package checks of scripts/verify-package.sh must catch what they are for: storage APIs outside
// the files meant to use them, a new unreviewed script, computed access to globals, dynamic code.
// Each case builds a package from a copy of the addon with ONE violation and expects a failure.
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
  mutate?.(dir);
  const zip = path.join(dir, 'mapviewer3d-0.4.1.zip');
  const z = spawnSync('zip', ['-X', '-r', zip, 'addon.json', 'README.md', 'web', '-x', '*.DS_Store'], { cwd: dir, encoding: 'utf8' });
  assert.equal(z.status, 0, z.stderr);
  const ver = JSON.parse(fs.readFileSync(path.join(dir, 'addon.json'), 'utf8')).version;
  const named = path.join(dir, `mapviewer3d-${ver}.zip`);
  if (named !== zip) fs.renameSync(zip, named);
  return spawnSync('bash', [path.join(root, 'scripts', 'verify-package.sh'), named], { encoding: 'utf8' });
}
const append = (file, code) => (dir) => fs.appendFileSync(path.join(dir, 'web', 'js', file), `\n${code}\n`);

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
test('eval', () => refused(pack(append('main.js', "eval('1');")), /dynamic code/));
test('dynamic import', () => refused(pack(append('main.js', "const m = import('./x.js');")), /dynamic code/));

if (failures) { console.error(`\n${failures} test(s) failed`); process.exit(1); }
console.log('\nall package check tests passed');

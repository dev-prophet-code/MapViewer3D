#!/usr/bin/env node
// tools/pin-data.mjs must really change both pins in web/js/config.js (it once silently left the
// catalog checksum alone because config.js declares it with `let`), and must fail when it cannot.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mv3d-pin-'));
// work on a copy of the addon so the real config.js is never touched
fs.cpSync(path.join(root, 'tools'), path.join(tmp, 'tools'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'web', 'js'), { recursive: true });
fs.copyFileSync(path.join(root, 'web', 'js', 'config.js'), path.join(tmp, 'web', 'js', 'config.js'));
const data = path.join(tmp, 'data');
fs.mkdirSync(data);
fs.writeFileSync(path.join(data, 'catalog.json'), '{"maps":[]}');
const want = crypto.createHash('sha256').update('{"maps":[]}').digest('hex');
const run = (tag) => spawnSync('node', [path.join(tmp, 'tools', 'pin-data.mjs'), data, tag], { encoding: 'utf8' });

let r = run('data-v9');
assert.equal(r.status, 0, r.stderr);
const cfg = fs.readFileSync(path.join(tmp, 'web', 'js', 'config.js'), 'utf8');
assert.match(cfg, /export const DATA_TAG = 'data-v9';/);
assert.ok(cfg.includes(`export let CATALOG_SHA256 = '${want}';`), 'the catalog checksum must be pinned, and stay a `let` (the test override assigns it)');
assert.ok(!cfg.includes('4b0fcaa5'), 'the old checksum must be gone');
console.log('ok   pin-data pins the tag and the catalog checksum');

// a config.js it cannot recognise is an error, not a silent success
fs.writeFileSync(path.join(tmp, 'web', 'js', 'config.js'), "export const DATA_TAG = 'x';\nexport const SOMETHING = 1;\n");
r = run('data-v10');
assert.notEqual(r.status, 0, 'must fail when CATALOG_SHA256 is not declared');
assert.match(r.stderr, /CATALOG_SHA256/);
console.log('ok   pin-data fails loudly when a declaration is missing');


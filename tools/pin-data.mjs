#!/usr/bin/env node
// Pins the addon to a data release: writes the tag and the SHA-256 of catalog.json into
// web/js/config.js.   node tools/pin-data.mjs <dataDir> <tag>
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [dataDir, tag] = process.argv.slice(2);
if (!dataDir || !/^[A-Za-z0-9._-]+$/.test(tag ?? '')) {
  console.error('usage: pin-data.mjs <dataDir> <tag>');
  process.exit(2);
}
const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(dataDir, 'catalog.json'))).digest('hex');
const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'js', 'config.js');
let s = fs.readFileSync(file, 'utf8');
// Each declaration must be found exactly once: a silent no-op would leave a stale pin and break
// the data of every client (config.js declares CATALOG_SHA256 with `let`, the local test override assigns it).
const pin = (re, value, name) => {
  const hits = s.match(new RegExp(re.source, 'g'))?.length ?? 0;
  if (hits !== 1) { console.error(`${name}: expected exactly one declaration in ${file}, found ${hits}`); process.exit(1); }
  s = s.replace(re, value);
};
pin(/export (?:const|let) DATA_TAG = '[^']*';/, `export const DATA_TAG = '${tag}';`, 'DATA_TAG');
pin(/export (?:const|let) CATALOG_SHA256 = '[0-9a-f]*';/, `export let CATALOG_SHA256 = '${sha}';`, 'CATALOG_SHA256');
fs.writeFileSync(file, s);
console.log(`pinned ${tag}, catalog sha256 ${sha}`);

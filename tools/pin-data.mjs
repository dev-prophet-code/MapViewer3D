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
s = s.replace(/export const DATA_TAG = '[^']*';/, `export const DATA_TAG = '${tag}';`)
  .replace(/export const CATALOG_SHA256 = '[0-9a-f]*';/, `export const CATALOG_SHA256 = '${sha}';`);
fs.writeFileSync(file, s);
console.log(`pinned ${tag}, catalog sha256 ${sha}`);

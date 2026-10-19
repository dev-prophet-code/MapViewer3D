#!/usr/bin/env node
// Every layer the viewer can draw must be reachable in the grouped layer list, and no group may name
// a layer that does not exist (a typo would silently hide it). Static check of the sources.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'js');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const keysIn = (src, from, to) => [...src.slice(src.indexOf(from), src.indexOf(to)).matchAll(/\{ key: '([A-Za-z0-9]+)'/g)].map((m) => m[1]);

const live = read('live/live.js');
const categories = keysIn(live, 'export const CATEGORIES', 'export const TOGGLES');
const toggles = keysIn(live, 'export const TOGGLES', 'const FEEDS');
const agent = keysIn(read('live/agent.js'), 'export const AGENT_TOGGLES', 'const FOLLOW');
assert.ok(categories.length >= 15 && toggles.length >= 5 && agent.length === 5, 'sources parsed');

const ui = read('ui.js');
const groups = ui.slice(ui.indexOf('const LAYER_GROUPS'), ui.indexOf('// every category must be'));
const listed = [...groups.matchAll(/'([A-Za-z0-9]+)'/g)].map((m) => m[1]).filter((k) => !k.startsWith('layers.'));
const have = new Set([...categories, ...toggles, ...agent]);
const inGroups = new Set([...listed, ...agent]); // the live group is built from AGENT_TOGGLES
for (const k of have) assert.ok(inGroups.has(k), `layer ${k} is in no group`);
for (const k of listed) assert.ok(have.has(k), `group names unknown layer ${k}`);
assert.equal(new Set(listed).size, listed.length, 'a layer is listed twice');

// every label exists in both languages
const i18n = read('i18n.js');
for (const k of [...categories.map((c) => `cat.${c}`), ...[...toggles, ...agent].map((x) => `toggle.${x}`), 'layers.group.resources', 'layers.group.world', 'layers.group.live', 'layers.group.display']) {
  assert.equal(i18n.split(`'${k}':`).length - 1, 2, `${k} must exist in en and de`);
}
console.log(`ok   ${have.size} layers, all grouped and translated`);

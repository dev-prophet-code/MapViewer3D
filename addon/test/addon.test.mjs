import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const full = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const page = full.replace(/<script>(?:(?!<\/script>)[\s\S])*?globalThis\.(?:THREE|OrbitControls)\s*=[\s\S]*?<\/script>/g, '');
test('Validierung des Pakets läuft durch', () => { execFileSync('node', [fileURLToPath(new URL('../scripts/validate.mjs', import.meta.url))]); });
test('Seite ist in sich geschlossen (keine externen Ressourcen, kein Netzwerkaufruf)', () => {
  assert.ok(!/<(script|link|img|iframe)\b[^>]*\b(src|href)\s*=/i.test(page));
  assert.ok(!/\bfetch\s*\(|XMLHttpRequest|new WebSocket|EventSource/.test(page));
});
test('Nur lesende SQL-Abfragen', () => {
  const sql = [...page.matchAll(/"(select [^"]+)"/g)].map((m) => m[1]);
  assert.ok(sql.length >= 2);
  for (const q of sql) assert.ok(/^select /i.test(q) && !/\b(insert|update|delete|drop|alter|create|truncate|grant)\b/i.test(q), q);
});
test('Manifest verlangt nur database:read und files:addon-data', () => {
  const m = JSON.parse(fs.readFileSync(new URL('../addon.json', import.meta.url)));
  assert.deepEqual(m.permissions, { database: ['read'], files: ['addon-data'] });
});

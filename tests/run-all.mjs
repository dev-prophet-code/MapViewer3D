#!/usr/bin/env node
// Runs every test that needs no browser and no Console checkout (CI runs them one by one, with names).
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tests = ['key-storage', 'realtime', 'share', 'share-visitor', 'console-cache', 'pin-data', 'verify-package', 'ui-layers', 'unit', 'sandbox-sql', 'sandbox-live'];
let failed = 0;
for (const t of tests) {
  const r = spawnSync(process.execPath, [path.join(here, `${t}.mjs`)], { stdio: 'inherit' });
  if (r.status !== 0) { failed++; console.error(`^^^ ${t} failed`); }
}
if (failed) process.exit(1);
console.log(`\nall ${tests.length} test files passed`);

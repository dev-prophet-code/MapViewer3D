#!/usr/bin/env node
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './lib/config.mjs';
import { createApp } from './lib/server.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const version = fs.readFileSync(path.join(here, '..', 'VERSION'), 'utf8').trim();
let cfg;
try { cfg = loadConfig(); } catch (e) { console.error('Konfiguration: ' + e.message); process.exit(2); }
const log = (m) => console.log(new Date().toISOString() + ' ' + m);
const app = createApp(cfg, { log, version, publicDir: path.join(here, 'public') });
app.listen(cfg.port, cfg.bind, () => log(`MapViewer 3D Companion v${version} auf ${cfg.bind}:${cfg.port} (Console: ${cfg.consoleUrl.protocol}//${cfg.consoleUrl.host})`));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => app.close(() => process.exit(0)));

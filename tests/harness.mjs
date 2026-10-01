#!/usr/bin/env node
// Test harness: stands in for the Dune Docker Console so the addon can be exercised in a
// real browser without a server.
//   node tests/harness.mjs <dataDir> [port]      then open  http://127.0.0.1:<port>/
//
// It serves
//   /                                         a host page that frames the addon exactly like the console does
//                                             and answers the addon bridge (addon.storage.*)
//   /api/addons/installed/mapviewer3d/content/<path>   the addon files (../web)
//   /data/*                                   the data branch (CORS open, like raw.githubusercontent.com)
//   /api/map/..., /api/bases/..., /images/..  a mock console API that ONLY accepts the API key
//                                             and records every request that carries a session cookie
//                                             or lacks the key (see /__test/violations)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dataDir = path.resolve(process.argv[2] ?? '.');
const port = Number(process.argv[3] ?? 8099);
const webDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
export const KEY = 'dak_testid_0123456789abcdef0123456789';
const COOKIE = 'console_session=ADMIN-SESSION-MUST-NOT-BE-USED';
const violations = [];
const log = [];
const storage = new Map();

const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp', '.bin': 'application/octet-stream', '.z': 'application/octet-stream' };
const send = (res, code, body, type = 'application/json', extra = {}) => {
  res.writeHead(code, { 'Content-Type': type, ...extra });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};
const serveFile = (res, file, extra = {}) => {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, { error: 'not found' });
  send(res, 200, fs.readFileSync(file), mime[path.extname(file)] ?? 'application/octet-stream', extra);
};
const safeJoin = (root, rel) => {
  const p = path.normalize(path.join(root, rel));
  return p.startsWith(root) ? p : null;
};

const HOST = `<!doctype html><meta charset=utf-8><title>console host</title>
<style>html,body,iframe{margin:0;width:100%;height:100%;border:0;background:#111}</style>
<iframe id=f src="/api/addons/installed/mapviewer3d/content/web/index.html?${'${QUERY}'}"></iframe>
<script>
// the console's addon bridge: addon.storage.* only (permission files:addon-data)
document.cookie = '${COOKIE}; path=/';
const store = JSON.parse(sessionStorage.getItem('store') || '{}');
addEventListener('message', (e) => {
  if (e.origin !== location.origin || e.data?.type !== 'dune-addon-request') return;
  const { requestId, action, payload, addonId } = e.data;
  const reply = (ok, v) => e.source.postMessage({ type: 'dune-addon-response', addonId, requestId, ok, ...(ok ? { result: v } : { error: v }) }, location.origin);
  if (action === 'addon.storage.get') return reply(true, payload.key in store ? { found: true, key: payload.key, version: 1, value: store[payload.key] } : { found: false, key: payload.key, version: 0, value: null });
  if (action === 'addon.storage.put') { store[payload.key] = payload.value; sessionStorage.setItem('store', JSON.stringify(store)); return reply(true, { ok: true, key: payload.key }); }
  if (action === 'addon.storage.delete') { delete store[payload.key]; sessionStorage.setItem('store', JSON.stringify(store)); return reply(true, { ok: true, deleted: true }); }
  reply(false, 'unsupported in test host: ' + action);
});
</script>`;

const players = { rows: [
  { id: 'p1', name: 'Test Fremen', online_status: 'Online', x: 0, y: 0, z: 5000, partition_id: 1 },
  { id: 'p2', name: 'Offline Atreides', online_status: 'Offline', x: 20000, y: -15000, z: 5000, partition_id: 1 },
] };

function api(req, res, url) {
  const auth = req.headers.authorization;
  if (req.headers.cookie) violations.push(`${req.method} ${url.pathname}: request carried a session cookie`);
  if (auth !== `Bearer ${KEY}`) {
    if (!auth) violations.push(`${req.method} ${url.pathname}: request without API key`);
    return send(res, 401, { error: 'unauthorized' });
  }
  if (req.method !== 'GET') violations.push(`${req.method} ${url.pathname}: not a GET`);
  log.push(url.pathname + url.search);
  const p = url.pathname;
  if (p === '/api/map/partitions') return send(res, 200, { rows: [
    { map: 'HaggaBasin', partition_id: 1, name: 'Survival_1_P1', alive: true },
    { map: 'DeepDesert', partition_id: 2, name: 'DeepDesert_1_P2', alive: true },
  ] });
  if (p === '/api/map/status') return send(res, 200, { maps: { stdout: 'Survival_1 Current: x Assigned: 1\nDeepDesert_1 Current: x Assigned: 1\nSH_Arrakeen Current: x Assigned: 0\n' } });
  if (p === '/api/map/markers') return send(res, 200, url.searchParams.get('map') === 'DeepDesert'
    ? { coriolisLayout: Number(process.env.LAYOUT ?? 8), coriolisSeed: 'cor-8', coriolisNextCycleAt: '2026-10-07T00:00:00Z', maps: {} }
    : { maps: {} });
  if (p === '/api/map/players') return send(res, 200, players);
  if (['/api/map/overlays', '/api/map/poi', '/api/map/spice'].includes(p)) return send(res, 200, { rows: [] });
  if (p.startsWith('/api/maps/user-settings/values')) return send(res, 200, { stdout: url.searchParams.get('scope') === 'partition' ? 'partition_pvp_enabled\tfalse\n' : '' });
  if (p.startsWith('/api/bases/')) return send(res, 404, { error: 'unknown base' });
  send(res, 404, { error: 'not found' });
}

http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  const p = url.pathname;
  if (p === '/') return send(res, 200, HOST.replace('${QUERY}', `data=${encodeURIComponent(`http://127.0.0.1:${port}/data/`)}`), 'text/html');
  if (p === '/__test/violations') return send(res, 200, { violations, requests: log.length });
  if (p === '/__test/log') return send(res, 200, log);
  if (p.startsWith('/api/addons/installed/mapviewer3d/content/web/')) {
    const f = safeJoin(webDir, decodeURIComponent(p.slice('/api/addons/installed/mapviewer3d/content/web/'.length)));
    return f ? serveFile(res, f) : send(res, 400, {});
  }
  if (p.startsWith('/data/')) {
    const f = safeJoin(dataDir, decodeURIComponent(p.slice(6)));
    return f ? serveFile(res, f, { 'Access-Control-Allow-Origin': '*' }) : send(res, 400, {});
  }
  if (p.startsWith('/images/maps/')) return send(res, 404, 'no icon in the test host', 'text/plain');
  if (p.startsWith('/api/')) return api(req, res, url);
  send(res, 404, { error: 'not found' });
}).listen(port, '127.0.0.1', () => console.log(`test console on http://127.0.0.1:${port}/  (key ${KEY})`));

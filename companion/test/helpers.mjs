// Gemeinsame Testhilfen: gefälschte Console und gefälschtes CDN auf Loopback, Companion mit Testkonfiguration.
import http from 'node:http';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../lib/config.mjs';
import { createApp } from '../lib/server.mjs';

export const GOOD = 'dak_' + 'a'.repeat(40);       // gültiger Test-Token (nur im Test)
export const NOREALTIME = 'dak_' + 'b'.repeat(40);   // gültig, aber ohne Realtime-Scope
export const NOMAPS = 'dak_' + 'c'.repeat(40);       // gültig, aber ohne Maps-Scope
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

export async function fakeConsole() {
  const seen = [];
  const srv = http.createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization });
    const tok = String(req.headers.authorization || '').replace(/^Bearer /, '');
    const j = (c, o) => { res.writeHead(c, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (![GOOD, NOREALTIME, NOMAPS].includes(tok)) return j(401, { error: 'unauthorized' });
    if (req.url.startsWith('/api/realtime/healthz')) return tok === GOOD ? j(200, { available: true, ok: true, sources: [{ map: 'Survival_1', partition: 1, ready: true, n: 3 }] }) : j(403, { error: 'scope' });
    if (req.url.startsWith('/api/realtime/stream')) {
      if (tok !== GOOD) return j(403, { error: 'scope' });
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('event: snap\ndata: ' + JSON.stringify({ gen: 1, t: 1, sources: [{ map: 'Survival_1', partition: 1, ready: true, n: 1 }], objects: [{ i: 1, k: 'worm', c: 'BP_X_C', s: 0, x: 100, y: 200, z: 300 }] }) + '\n\n');
      const t = setInterval(() => res.write(': keepalive\n\n'), 200); res.on('close', () => clearInterval(t)); return;
    }
    if (req.url.startsWith('/api/map/partitions')) return tok === NOMAPS ? j(403, {}) : j(200, { rows: [{ map: 'HaggaBasin', partition_id: 1 }] });
    if (req.url.startsWith('/api/map/players')) return j(200, { rows: [{ name: '<img src=x onerror=alert(1)>', online_status: 'Online', map: 'HaggaBasin', partition_id: 1, x: 1, y: 2, z: 3 }] });
    if (req.url.startsWith('/api/map/bases')) return j(200, { rows: [{ name: 'B', owner_name: 'O', base_type: 'Fief', map: 'HaggaBasin', partition_id: 1, x: 4, y: 5, z: 6 }] });
    j(404, {});
  });
  const port = await listen(srv);
  return { srv, port, seen, close: () => srv.close() };
}

// Kleines, aber gültiges CDN: Katalog + Index + eine Kachel (alles mit stimmenden Hashes)
export function buildCdn() {
  const raw = Buffer.alloc(3 * 129 * 129, 7);
  const id = sha(raw).slice(0, 16);
  const tile = zlib.gzipSync(raw);
  const index = Buffer.from(JSON.stringify({ format: 1, patchQuads: 128, maxLevel: 0, meta: { name: 'testmap' }, ids: [id], levels: [{ nx: 1, ny: 1, cells: [0] }] }));
  const catalog = Buffer.from(JSON.stringify({ format: 1, maps: [{ file: 'm/testmap.json', sha256: sha(index) }] }));
  const files = { '/catalog.json': catalog, '/m/testmap.json': index, [`/p/${id.slice(0, 2)}/${id.slice(2)}.z`]: tile };
  return { files, id, catalogSha: sha(catalog), tilePath: `p/${id.slice(0, 2)}/${id.slice(2)}.z` };
}
export async function fakeCdn(cdn = buildCdn(), tamper = {}) {
  const srv = http.createServer((req, res) => {
    let body = tamper[req.url] || cdn.files[req.url];
    if (!body) { res.writeHead(404); return res.end(); }
    res.writeHead(200); res.end(body);
  });
  const port = await listen(srv);
  return { srv, port, cdn, close: () => srv.close() };
}

export async function startApp(over = {}) {
  const con = over.console || await fakeConsole();
  const cdn = over.cdn || await fakeCdn();
  const env = { CONSOLE_URL: `http://127.0.0.1:${con.port}`, CDN_BASE: `http://127.0.0.1:${cdn.port}/`, PORT: '1', BIND: '127.0.0.1', LOGIN_FAIL_LIMIT: '5', ...over.env };
  const cfg = loadConfig(env);
  const app = createApp(cfg, { version: '9.9.9', publicDir: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public') });
  const port = await listen(app);
  const base = `http://127.0.0.1:${port}`;
  const H = { 'Content-Type': 'application/json', 'X-MV-CSRF': '1' };
  const login = async (token = GOOD) => {
    const r = await fetch(base + '/api/login', { method: 'POST', headers: H, body: JSON.stringify({ token }) });
    const c = (r.headers.get('set-cookie') || '').split(';')[0];
    return { r, cookie: c, json: await r.json().catch(() => null) };
  };
  return { app, con, cdn, base, H, login, close: () => { app.close(); app.closeAllConnections?.(); con.close(); cdn.close(); } };
}

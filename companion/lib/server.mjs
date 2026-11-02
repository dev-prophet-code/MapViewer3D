import http from 'node:http';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { makeConsole, TOKEN_RE, MAP_LIVE, ICON_RE } from './console.mjs';
import { makeCdn } from './cdn.mjs';
import { makeSessions, makeLimiter, makeLoginGuard, parseCookies } from './session.mjs';

const COOKIE = 'mv_sid';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const LIVE_MAPS = new Set(['HaggaBasin', 'DeepDesert']);
const HEADERS = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
};
const str = (v, n = 64) => (typeof v === 'string' ? v.slice(0, n) : '');
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

export function createApp(cfg, { log = () => {}, version = '0.0.0', publicDir } = {}) {
  const consoleApi = makeConsole(cfg), cdn = makeCdn(cfg, log), sessions = makeSessions(cfg);
  const guard = makeLoginGuard(cfg.loginFailLimit), ipLimit = makeLimiter(240, 60000), apiLimit = makeLimiter(240, 60000), cdnLimit = makeLimiter(3000, 60000);
  let streamsTotal = 0;
  const allowedHosts = cfg.allowedHosts;

  // Statische Dateien: feste Liste aus dem Verzeichnis beim Start, nie ein Dateipfad aus der Anfrage.
  const files = new Map();
  for (const f of fs.readdirSync(publicDir)) { const t = TYPES[path.extname(f)]; if (t) files.set('/' + f, { buf: fs.readFileSync(path.join(publicDir, f)), type: t }); }
  files.set('/', files.get('/index.html'));

  const clientIp = (req) => {
    if (cfg.trustProxy) { const x = String(req.headers['x-forwarded-for'] || '').split(',').pop().trim(); if (net.isIP(x)) return x; }
    return req.socket.remoteAddress || 'unknown';
  };
  const isTls = (req) => req.socket.encrypted || (cfg.trustProxy && req.headers['x-forwarded-proto'] === 'https');

  function send(res, status, body, type = 'application/json', extra = {}) {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    res.writeHead(status, { 'Content-Type': type, 'Content-Length': buf.length, 'Cache-Control': 'no-store', ...HEADERS, ...extra });
    res.end(buf);
  }
  const fail = (res, status, msg, code) => send(res, status, code ? { error: msg, code } : { error: msg });

  function hostOk(req) {
    const h = String(req.headers.host || '').toLowerCase();
    if (!h || h.length > 255) return false;
    const name = h.startsWith('[') ? h.slice(0, h.indexOf(']') + 1) : h.replace(/:\d+$/, '');
    if (allowedHosts.length) return allowedHosts.includes(h) || allowedHosts.includes(name);
    return name === 'localhost' || net.isIP(name.replace(/^\[|\]$/g, '')) !== 0;
  }
  function csrfOk(req) {
    if (req.headers['x-mv-csrf'] !== '1') return false;
    if (!/^application\/json(\s*;|$)/i.test(String(req.headers['content-type'] || ''))) return false;
    const o = req.headers.origin;
    if (o !== undefined) { try { if (new URL(o).host.toLowerCase() !== String(req.headers.host).toLowerCase()) return false; } catch { return false; } }
    return true;
  }
  function readJson(req, max = 1024) {
    return new Promise((resolve, reject) => {
      const ch = []; let n = 0, over = false;
      if (Number(req.headers['content-length']) > max) return reject(Object.assign(new Error('zu groß'), { status: 413 }));
      req.on('data', (c) => { if (over) return; n += c.length; if (n > max) { over = true; reject(Object.assign(new Error('zu groß'), { status: 413 })); } else ch.push(c); });
      req.on('end', () => { if (over) return; try { const v = JSON.parse(Buffer.concat(ch).toString('utf8')); resolve(v && typeof v === 'object' && !Array.isArray(v) ? v : null); } catch { resolve(null); } });
      req.on('error', reject);
    });
  }

  // Prüft Token und Realtime: Realtime verfügbar -> "realtime", sonst "fallback" über die regulären Karten-Routen.
  async function probe(token) {
    let h; try { h = await consoleApi.get(token, '/api/realtime/healthz'); } catch { return { error: 502, msg: 'Console nicht erreichbar', code: 'console_down' }; }
    if (h.status === 401) return { error: 401, msg: 'Token ungültig, deaktiviert oder abgelaufen', code: 'token_invalid' };
    if (h.status === 200 && h.json && h.json.available) return { mode: 'realtime', sources: (h.json.sources || []).slice(0, 20).map((s) => ({ map: str(s.map), ready: !!s.ready, n: num(s.n) })) };
    const reasonCode = h.status === 403 ? 'no_scope' : h.status === 503 ? 'agent_off' : 'unavailable';
    const reason = { no_scope: 'Dem Token fehlt „Realtime Data: Read“', agent_off: 'Der Position-Agent (mvagent) läuft nicht', unavailable: 'Realtime Data ist nicht verfügbar' }[reasonCode];
    let p; try { p = await consoleApi.get(token, '/api/map/partitions'); } catch { return { error: 502, msg: 'Console nicht erreichbar', code: 'console_down' }; }
    if (p.status === 401) return { error: 401, msg: 'Token ungültig, deaktiviert oder abgelaufen', code: 'token_invalid' };
    if (p.status === 200) return { mode: 'fallback', reason, reasonCode, sources: [] };
    return { error: 403, msg: 'Dem Token fehlt „Maps: Read“', code: 'no_maps' };
  }
  const sessionView = (s) => ({ mode: s.mode, reason: s.reason || '', reasonCode: s.reasonCode || '', sources: s.sources || [] });

  const icons = new Map(); // Dateiname -> {status,type,buf}, höchstens 400 Einträge
  // Marker-Atlas (Erze, Orte, Fahrzeuge, Lager …). Die Console aktualisiert ihn einmal pro Minute.
  async function markersData(s, live) {
    const key = 'markers:' + live, hit = s.cache.get(key); if (hit && hit.t > Date.now() - 30000) return hit.v;
    const r = await consoleApi.get(s.token, '/api/map/markers?map=' + live);
    if (r.status !== 200 || !r.json || !Array.isArray(r.json.rows)) { const e = new Error('markers'); e.status = r.status; throw e; }
    const rows = r.json.rows.filter((m) => m && m.type !== 'player' && m.type !== 'base').slice(0, 20000)
      .map((m) => ({ t: str(m.type, 32), s: str(m.subtype, 48), n: str(m.name || m.subtypeLabel || '', 60), id: str(String(m.id == null ? '' : m.id), 40), x: num(m.x), y: num(m.y), z: num(m.z) }));
    const v = { rows }; s.cache.set(key, { t: Date.now(), v }); return v;
  }
  // Eine Basis mit ihren Bauteilen (Console: GET /api/bases/<id>/export). Nur Typ und Lage, Längen und Mengen begrenzt.
  async function baseData(s, id) {
    const key = 'base:' + id, hit = s.cache.get(key); if (hit && hit.t > Date.now() - 120000) return hit.v;
    if (s.cache.size > 24) s.cache.delete(s.cache.keys().next().value); // je Basis bis ~0,4 MB: Speicher je Sitzung begrenzen
    const r = await consoleApi.get(s.token, '/api/bases/' + id + '/export');
    if (r.status !== 200 || !r.json || typeof r.json !== 'object') { const e = new Error('base'); e.status = r.status; throw e; }
    const j = r.json, arr = (a, n) => (Array.isArray(a) ? a.slice(0, n) : []);
    const v = { x: num(j.x), y: num(j.y), z: num(j.z),
      i: arr(j.instances, 6000).map((p) => [str(p && p.building_type, 80), num(p && p.x), num(p && p.y), num(p && p.z), num(p && p.rotation)]),
      p: arr(j.placeables, 3000).map((p) => [str(p && p.building_type, 80), num(p && p.x), num(p && p.y), num(p && p.z), num(p && p.rx), num(p && p.ry), num(p && p.rz)]) };
    s.cache.set(key, { t: Date.now(), v }); return v;
  }
  async function staticData(s) {
    const hit = s.cache.get('static'); if (hit && hit.t > Date.now() - 4000) return hit.v;
    const [pl, ba] = await Promise.all([consoleApi.get(s.token, '/api/map/players').catch(() => null), consoleApi.get(s.token, '/api/map/bases').catch(() => null)]);
    const rows = (r) => (r && r.status === 200 && r.json && Array.isArray(r.json.rows) ? r.json.rows.slice(0, 5000) : []);
    const v = {
      players: rows(pl).map((r) => ({ n: str(r.name), on: r.online_status === 'Online', m: str(r.map, 32), p: num(r.partition_id), x: num(r.x), y: num(r.y), z: num(r.z) })),
      bases: rows(ba).map((r) => ({ i: str(String(r.base_id == null ? '' : r.base_id), 14).replace(/\D/g, ''), n: str(r.name), o: str(r.owner_name), t: str(r.base_type), m: str(r.map, 32), p: num(r.partition_id), x: num(r.x), y: num(r.y), z: num(r.z) })),
      notes: { players: pl && pl.status === 200 ? 'ok' : 'nicht verfügbar', bases: ba && ba.status === 200 ? 'ok' : 'nicht verfügbar' },
    };
    s.cache.set('static', { t: Date.now(), v }); return v;
  }

  async function handle(req, res) {
    if (req.url.length > 2048) return fail(res, 414, 'URL zu lang');
    if (!hostOk(req)) return fail(res, 421, 'Host nicht erlaubt');
    const ip = clientIp(req);
    if (!['GET', 'HEAD', 'POST'].includes(req.method)) return fail(res, 405, 'Methode nicht erlaubt');
    let url; try { url = new URL(req.url, 'http://x'); } catch { return fail(res, 400, 'Anfrage ungültig'); }
    const p = url.pathname;

    const file = files.get(p);
    if (file && req.method !== 'POST') { if (!ipLimit(ip)) return fail(res, 429, 'Zu viele Anfragen'); return send(res, 200, req.method === 'HEAD' ? '' : file.buf, file.type, { 'Cache-Control': 'no-cache' }); }
    if (p === '/healthz') return send(res, 200, { ok: true, version });
    if (!p.startsWith('/api/') && !p.startsWith('/cdn/') && !p.startsWith('/icons/')) return fail(res, 404, 'nicht gefunden');

    if (p === '/api/login') {
      if (req.method !== 'POST') return fail(res, 405, 'POST erforderlich');
      if (!csrfOk(req)) return fail(res, 403, 'Anfrage abgelehnt');
      if (guard.isBlocked(ip)) return fail(res, 429, 'Zu viele Fehlversuche. Später erneut versuchen.', 'too_many');
      const body = await readJson(req);
      const token = body && typeof body.token === 'string' ? body.token.trim() : '';
      if (!TOKEN_RE.test(token)) { guard.fail(ip); return fail(res, 400, 'Token-Format ungültig (erwartet dak_…)', 'token_format'); }
      const r = await probe(token);
      if (r.error) { if (r.error === 401) guard.fail(ip); return fail(res, r.error, r.msg, r.code); }
      guard.ok(ip);
      const sid = sessions.create(token, r.mode, ip); if (!sid) return fail(res, 503, 'Zu viele aktive Sitzungen');
      const s = sessions.get(sid); s.reason = r.reason; s.reasonCode = r.reasonCode; s.sources = r.sources;
      const cookie = `${COOKIE}=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(cfg.sessionTtlMs / 1000)}${isTls(req) ? '; Secure' : ''}`;
      return send(res, 200, sessionView(s), 'application/json', { 'Set-Cookie': cookie });
    }

    const sid = parseCookies(req.headers.cookie)[COOKIE];
    const s = sessions.get(sid);
    if (!s) return fail(res, 401, 'Nicht angemeldet');
    if (!(p.startsWith('/cdn/') ? cdnLimit : apiLimit)(sid)) return fail(res, 429, 'Zu viele Anfragen');

    if (p === '/api/logout') {
      if (req.method !== 'POST') return fail(res, 405, 'POST erforderlich');
      if (!csrfOk(req)) return fail(res, 403, 'Anfrage abgelehnt');
      sessions.end(sid);
      return send(res, 200, { ok: true }, 'application/json', { 'Set-Cookie': `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` });
    }
    if (p === '/api/recheck') {
      if (req.method !== 'POST') return fail(res, 405, 'POST erforderlich');
      if (!csrfOk(req)) return fail(res, 403, 'Anfrage abgelehnt');
      const r = await probe(s.token);
      if (r.error) { if (r.error === 401) sessions.end(sid); return fail(res, r.error, r.msg, r.code); }
      s.mode = r.mode; s.reason = r.reason; s.reasonCode = r.reasonCode; s.sources = r.sources;
      return send(res, 200, sessionView(s));
    }
    if (req.method === 'POST') return fail(res, 405, 'Methode nicht erlaubt');
    if (p === '/api/session') return send(res, 200, sessionView(s));
    if (p === '/api/static') {
      try { return send(res, 200, await staticData(s)); } catch { return fail(res, 502, 'Console nicht erreichbar'); }
    }
    if (p === '/api/markers') { // alle Marker-Arten der Live-Karte außer Spielern und Basen (die kommen aus /api/static)
      const live = MAP_LIVE[url.searchParams.get('map')]; if (!live) return fail(res, 400, 'Karte ungültig');
      try { return send(res, 200, await markersData(s, live)); } catch (e) { return fail(res, e && e.status === 403 ? 403 : 502, e && e.status === 403 ? 'Dem Token fehlt „Maps: Read“' : 'Console nicht erreichbar'); }
    }
    if (p === '/api/base') { // Bauteile einer Basis (für die 3D-Basis aus echten Modellen)
      const id = url.searchParams.get('id'); if (!/^\d{1,12}$/.test(id || '')) return fail(res, 400, 'Basis ungültig');
      try { return send(res, 200, await baseData(s, id)); } catch (e) { return fail(res, e && e.status === 403 ? 403 : e && e.status === 404 ? 404 : 502, e && e.status === 403 ? 'Dem Token fehlt „Bases: Read“' : e && e.status === 404 ? 'Basis nicht gefunden' : 'Console nicht erreichbar'); }
    }
    if (p.startsWith('/icons/')) { // Symbole der Live-Karte, von der Console geholt und zwischengespeichert
      let name; try { name = decodeURIComponent(p.slice(7)); } catch { return fail(res, 400, 'Name ungültig'); }
      if (!ICON_RE.test(name)) return fail(res, 400, 'Name ungültig');
      let hit = icons.get(name);
      if (!hit) { try { hit = await consoleApi.icon(name); } catch { return fail(res, 502, 'Console nicht erreichbar'); } if (hit.status !== 200) return fail(res, hit.status === 404 ? 404 : 502, 'Symbol nicht verfügbar'); if (icons.size >= 400) icons.delete(icons.keys().next().value); icons.set(name, hit); }
      return send(res, 200, req.method === 'HEAD' ? '' : hit.buf, hit.type, { 'Cache-Control': 'private, max-age=86400' });
    }
    if (p === '/api/realtime/stream') {
      if (s.mode !== 'realtime') return fail(res, 409, 'Realtime ist für diese Sitzung nicht aktiv');
      if (s.streams >= 2 || streamsTotal >= 16) return fail(res, 429, 'Zu viele offene Streams');
      let up; try { up = await consoleApi.stream(s.token, '/api/realtime/stream'); } catch { return fail(res, 502, 'Console nicht erreichbar'); }
      if (up.status !== 200) { up.res.resume(); if (up.status === 401) sessions.end(sid); return fail(res, up.status === 401 ? 401 : 502, 'Stream nicht verfügbar'); }
      s.streams++; streamsTotal++;
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', ...HEADERS });
      let done = false;
      const close = () => { if (done) return; done = true; s.streams--; streamsTotal--; s.closers.delete(close); up.req.destroy(); res.end(); };
      s.closers.add(close);
      up.res.pipe(res); up.res.on('end', close); up.res.on('error', close); res.on('close', close);
      return;
    }
    if (p.startsWith('/cdn/')) {
      let rel; try { rel = decodeURIComponent(p.slice(5)); } catch { return fail(res, 400, 'Pfad ungültig'); }
      try { const buf = await cdn.get(rel); return send(res, 200, req.method === 'HEAD' ? '' : buf, buf.type || 'application/octet-stream', { 'Cache-Control': 'private, max-age=86400' }); }
      catch (e) { return fail(res, e.status || 502, e.status === 404 ? 'nicht gefunden' : 'Kartendaten nicht verfügbar'); }
    }
    return fail(res, 404, 'nicht gefunden');
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      log('Fehler: ' + (e && e.message));
      if (res.headersSent) return res.end();
      if (e && e.status === 413) { res.once('finish', () => req.destroy()); return send(res, 413, { error: 'zu groß' }, 'application/json', { Connection: 'close' }); }
      fail(res, 500, 'interner Fehler');
    });
  });
  server.requestTimeout = 30000; server.headersTimeout = 10000; server.maxConnections = 256; server.keepAliveTimeout = 5000;
  server.on('clientError', (_e, sock) => sock.end('HTTP/1.1 400 Bad Request\r\n\r\n'));
  server.sessions = sessions;
  return server;
}

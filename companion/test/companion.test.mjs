import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startApp, GOOD, NOREALTIME, NOMAPS, fakeCdn, buildCdn } from './helpers.mjs';
import { loadConfig } from '../lib/config.mjs';
import { blockedAddress } from '../lib/console.mjs';

test('Version in VERSION, package.json und addon.json stimmt überein', () => {
  const v = fs.readFileSync(new URL('../../VERSION', import.meta.url), 'utf8').trim();
  assert.equal(JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url))).version, v);
  assert.equal(JSON.parse(fs.readFileSync(new URL('../../addon/addon.json', import.meta.url))).version, v);
  assert.match(v, /^2\.\d+\.\d+$/);
});

test('Anmeldung: Realtime aktiv -> Modus realtime, Cookie HttpOnly + SameSite=Strict, Token nie in der Antwort', async () => {
  const t = await startApp();
  const { r, json } = await t.login(GOOD);
  assert.equal(r.status, 200); assert.equal(json.mode, 'realtime');
  const sc = r.headers.get('set-cookie'); assert.match(sc, /HttpOnly/); assert.match(sc, /SameSite=Strict/);
  assert.ok(!JSON.stringify(json).includes(GOOD) && !sc.includes(GOOD));
  t.close();
});

test('Anmeldung ohne Realtime-Scope -> Fallback mit Grund', async () => {
  const t = await startApp(); const { r, json } = await t.login(NOREALTIME);
  assert.equal(r.status, 200); assert.equal(json.mode, 'fallback'); assert.match(json.reason, /Realtime/); t.close();
});

test('Anmeldung: ungültiger Token, falsches Format, fehlendes Maps-Recht', async () => {
  const t = await startApp();
  assert.equal((await t.login('dak_' + 'z'.repeat(40))).r.status, 401);
  assert.equal((await t.login('nope')).r.status, 400);
  assert.equal((await t.login(NOMAPS)).r.status, 403);
  t.close();
});

test('Nach fünf Fehlversuchen wird gesperrt (429), auch mit gültigem Token', async () => {
  const t = await startApp();
  for (let i = 0; i < 5; i++) await t.login('dak_' + 'z'.repeat(40));
  assert.equal((await t.login(GOOD)).r.status, 429); t.close();
});

test('CSRF: ohne Header oder mit fremdem Origin abgelehnt', async () => {
  const t = await startApp();
  const body = JSON.stringify({ token: GOOD });
  assert.equal((await fetch(t.base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).status, 403);
  assert.equal((await fetch(t.base + '/api/login', { method: 'POST', headers: { ...t.H, Origin: 'http://evil.example' }, body })).status, 403);
  assert.equal((await fetch(t.base + '/api/login', { method: 'POST', headers: { 'X-MV-CSRF': '1', 'Content-Type': 'text/plain' }, body })).status, 403);
  t.close();
});

test('API und CDN ohne Sitzung -> 401', async () => {
  const t = await startApp();
  for (const p of ['/api/session', '/api/static', '/api/realtime/stream', '/cdn/catalog.json']) assert.equal((await fetch(t.base + p)).status, 401, p);
  t.close();
});

test('Daten: Spieler/Basen bereinigt, Namen bleiben Text (kein HTML-Escaping nötig im JSON)', async () => {
  const t = await startApp(); const { cookie } = await t.login(GOOD);
  const j = await (await fetch(t.base + '/api/static', { headers: { cookie } })).json();
  assert.equal(j.players.length, 1); assert.equal(j.bases[0].t, 'Fief');
  assert.ok(!('fls_id' in j.players[0]) && !('funcom_id' in j.players[0]));
  t.close();
});

test('Der Token geht nur an die Console und nur im Authorization-Header', async () => {
  const t = await startApp(); const { cookie } = await t.login(GOOD);
  await fetch(t.base + '/api/static', { headers: { cookie } });
  assert.ok(t.con.seen.length > 0 && t.con.seen.every((s) => s.auth === 'Bearer ' + GOOD && !s.url.includes('dak_')));
  t.close();
});

test('Realtime-Stream wird durchgereicht; im Fallback 409', async () => {
  const t = await startApp(); const a = await t.login(GOOD);
  const ac = new AbortController(); const r = await fetch(t.base + '/api/realtime/stream', { headers: { cookie: a.cookie }, signal: ac.signal });
  assert.equal(r.status, 200); const rd = r.body.getReader(); const { value } = await rd.read();
  assert.match(new TextDecoder().decode(value), /event: snap/); ac.abort();
  const b = await t.login(NOREALTIME);
  assert.equal((await fetch(t.base + '/api/realtime/stream', { headers: { cookie: b.cookie } })).status, 409);
  t.close();
});

test('Logout beendet die Sitzung', async () => {
  const t = await startApp(); const { cookie } = await t.login(GOOD);
  assert.equal((await fetch(t.base + '/api/logout', { method: 'POST', headers: { ...t.H, cookie }, body: '{}' })).status, 200);
  assert.equal((await fetch(t.base + '/api/session', { headers: { cookie } })).status, 401); t.close();
});

test('CDN: gültige Dateien kommen durch, manipulierte werden abgelehnt', async () => {
  const cdn = buildCdn(); const tampered = Buffer.from(cdn.files['/m/testmap.json']); tampered[5] ^= 1;
  const t = await startApp({ cdn: await fakeCdn(cdn, { '/m/testmap.json': tampered }) }); const { cookie } = await t.login(GOOD);
  const get = (p) => fetch(t.base + '/cdn/' + p, { headers: { cookie } });
  assert.equal((await get('catalog.json')).status, 200);
  assert.equal((await get(cdn.tilePath)).status, 200);
  assert.equal((await get('m/testmap.json')).status, 502);   // Hash passt nicht zum Katalog
  assert.equal((await get('p/00/' + '0'.repeat(14) + '.z')).status, 404);
  t.close();
});

test('CDN: falsche Kachel (Hash) wird verworfen', async () => {
  const cdn = buildCdn(); const bad = (await import('node:zlib')).gzipSync(Buffer.alloc(3 * 129 * 129, 9));
  const t = await startApp({ cdn: await fakeCdn(cdn, { ['/' + cdn.tilePath]: bad }) }); const { cookie } = await t.login(GOOD);
  assert.equal((await fetch(t.base + '/cdn/' + cdn.tilePath, { headers: { cookie } })).status, 502); t.close();
});

test('CDN-Katalog-Pin: falscher Pin -> Katalog abgelehnt', async () => {
  const t = await startApp({ env: { CDN_CATALOG_SHA256: '0'.repeat(64) } }); const { cookie } = await t.login(GOOD);
  assert.equal((await fetch(t.base + '/cdn/catalog.json', { headers: { cookie } })).status, 502); t.close();
});

test('Konfiguration: unverschlüsselte Remote-Console braucht ausdrückliche Freigabe', () => {
  assert.throws(() => loadConfig({ CONSOLE_URL: 'http://203.0.113.5:8088' }), /CONSOLE_ALLOW_HTTP/);
  assert.doesNotThrow(() => loadConfig({ CONSOLE_URL: 'http://203.0.113.5:8088', CONSOLE_ALLOW_HTTP: '1' }));
  assert.doesNotThrow(() => loadConfig({ CONSOLE_URL: 'https://example.org' }));
  assert.throws(() => loadConfig({ CONSOLE_URL: 'http://u:p@127.0.0.1' }), /Zugangsdaten/);
  assert.throws(() => loadConfig({ CONSOLE_URL: 'ftp://x' }), /http/);
});

test('SSRF-Filter sperrt Metadaten- und Link-Local-Adressen', () => {
  for (const a of ['169.254.169.254', '0.0.0.0', '224.0.0.1', 'fe80::1', '::', '::ffff:169.254.1.1']) assert.ok(blockedAddress(a), a);
  for (const a of ['127.0.0.1', '10.0.0.5', '8.8.8.8']) assert.ok(!blockedAddress(a), a);
});

test('Statische Seite: strenge Sicherheitsheader, keine Inline-Skripte', async () => {
  const t = await startApp(); const r = await fetch(t.base + '/');
  assert.match(r.headers.get('content-security-policy'), /script-src 'self'/); assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  const html = await r.text(); assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html)); assert.ok(!/\sstyle=|\sonclick=/i.test(html)); t.close();
});

// --- Regressionstests aus dem Code-Review (v2.0.0)
import https from 'node:https';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeConsole } from '../lib/console.mjs';

function selfSigned() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mvcert-'));
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', path.join(d, 'k.pem'), '-out', path.join(d, 'c.pem'), '-days', '2', '-subj', '/CN=localhost'], { stdio: 'ignore' });
  } catch { return null; }
  const cert = fs.readFileSync(path.join(d, 'c.pem')), key = fs.readFileSync(path.join(d, 'k.pem'));
  fs.rmSync(d, { recursive: true });
  const pin = 'sha256/' + crypto.createHash('sha256').update(new crypto.X509Certificate(cert).publicKey.export({ type: 'spki', format: 'der' })).digest('base64url');
  return { cert, key, pin };
}

test('CONSOLE_PIN: richtiger Fingerabdruck verbindet, falscher wird abgelehnt', async (t) => {
  const c = selfSigned(); if (!c) return t.skip('openssl nicht verfügbar');
  const srv = https.createServer({ cert: c.cert, key: c.key }, (req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"available":true}'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const mk = (pin) => makeConsole(loadConfig({ CONSOLE_URL: `https://127.0.0.1:${srv.address().port}`, CONSOLE_PIN: pin }));
  const ok = await mk(c.pin).get(GOOD, '/api/realtime/healthz');
  assert.equal(ok.status, 200);
  await assert.rejects(mk('sha256/' + 'A'.repeat(43)).get(GOOD, '/api/realtime/healthz'), /Fingerabdruck/);
  srv.closeAllConnections(); srv.close();
});

test('Fehlendes Maps-Recht (403) zählt nicht als Fehlversuch, ungültige Tokens schon', async () => {
  const t = await startApp({ env: { LOGIN_FAIL_LIMIT: '3' } });
  for (let i = 0; i < 6; i++) assert.equal((await t.login(NOMAPS)).r.status, 403);
  assert.equal((await t.login(GOOD)).r.status, 200); t.close();
});

test('Sitzungen: je Adresse begrenzt, volle Instanz verdrängt keine fremden Nutzer', async () => {
  const t = await startApp({ env: { MAX_SESSIONS_PER_IP: '2', MAX_SESSIONS: '3' } });
  const a = await t.login(GOOD), b = await t.login(GOOD), c = await t.login(GOOD);
  assert.equal((await fetch(t.base + '/api/session', { headers: { cookie: a.cookie } })).status, 401); // älteste ersetzt
  assert.equal((await fetch(t.base + '/api/session', { headers: { cookie: c.cookie } })).status, 200);
  assert.equal(t.app.sessions.size(), 2); t.close();
});

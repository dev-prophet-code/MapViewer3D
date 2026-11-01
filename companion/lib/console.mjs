// Aufrufe an die Dune-Docker-Console. Feste Zielliste, keine Umleitungen, Zeit- und Größenlimits.
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import crypto from 'node:crypto';
import tlsMod from 'node:tls';

const MAX_BODY = 16 * 1048576;
export const ALLOWED = new Set(['/api/realtime/healthz', '/api/realtime/objects', '/api/realtime/stream', '/api/map/partitions', '/api/map/players', '/api/map/bases']);
export const TOKEN_RE = /^dak_[A-Za-z0-9_-]{16,160}$/;

// Link-lokal, Cloud-Metadaten, Multicast und "unspecified" sind nie ein gültiges Ziel (SSRF / DNS-Rebinding).
export function blockedAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || (a === 169 && b === 254) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return blockedAddress(v.slice(7));
  return v === '::' || v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb') || v.startsWith('ff');
}
const safeLookup = (host, opts, cb) => dns.lookup(host, opts, (err, addr, fam) => {
  if (err) return cb(err);
  const list = Array.isArray(addr) ? addr : [{ address: addr, family: fam }];
  if (list.some((a) => blockedAddress(a.address))) return cb(new Error('Zieladresse nicht erlaubt'));
  cb(null, addr, fam);
});


export function makeConsole(cfg) {
  const u = cfg.consoleUrl, tls = u.protocol === 'https:';
  const mod = tls ? https : http;
  const base = { host: u.hostname.replace(/^\[|\]$/g, ''), port: u.port || (tls ? 443 : 80), lookup: safeLookup, timeout: 15000, agent: false };
  // Selbstsignierte Zertifikate: Node ruft checkServerIdentity bei einem Zertifikatsfehler gar nicht auf. Darum wird der
  // Fingerabdruck VOR der Anfrage geprüft: erst Handshake, dann (nur bei Treffer) wird dieser Socket für die Anfrage benutzt.
  const pin = tls && cfg.consolePin ? cfg.consolePin.replace(/=$/, '') : '';
  const spki = (raw) => 'sha256/' + crypto.createHash('sha256').update(new crypto.X509Certificate(raw).publicKey.export({ type: 'spki', format: 'der' })).digest('base64url');
  function pinnedSocket() {
    return new Promise((resolve, reject) => {
      const s = tlsMod.connect({ host: base.host, port: Number(base.port), servername: net.isIP(base.host) ? undefined : base.host, rejectUnauthorized: false, lookup: safeLookup, timeout: 15000 });
      s.once('error', reject); s.once('timeout', () => s.destroy(new Error('Zeitüberschreitung')));
      s.once('secureConnect', () => {
        let got = ''; try { got = spki(s.getPeerCertificate(true).raw); } catch { /* bleibt leer */ }
        if (got !== pin) { s.destroy(); return reject(new Error('Fingerabdruck der Console stimmt nicht (möglicher Angriff)')); }
        s.removeAllListeners('error'); s.setTimeout(0); resolve(s);
      });
    });
  }
  function open(token, path, stream) {
    if (!ALLOWED.has(path)) throw new Error('Pfad nicht erlaubt');
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) throw new Error('Token-Format');
    return (pin ? pinnedSocket() : Promise.resolve(null)).then((sock) => new Promise((resolve, reject) => {
      const agent = sock ? Object.assign(new https.Agent(), { createConnection: () => sock }) : false;
      const req = mod.request({ ...base, agent, method: 'GET', path, timeout: stream ? 75000 : 15000, headers: { Authorization: 'Bearer ' + token, Accept: stream ? 'text/event-stream' : 'application/json', 'User-Agent': 'mapviewer3d-companion' } }, (res) => {
        if (stream) return resolve({ status: res.statusCode, res, req });
        const chunks = []; let n = 0;
        res.on('data', (c) => { n += c.length; if (n > MAX_BODY) { req.destroy(new Error('Antwort zu groß')); } else chunks.push(c); });
        res.on('end', () => { const body = Buffer.concat(chunks).toString('utf8'); let json = null; try { json = JSON.parse(body); } catch { /* kein JSON */ } resolve({ status: res.statusCode, json }); });
        res.on('error', reject);
      });
      req.on('timeout', () => req.destroy(new Error('Zeitüberschreitung')));
      req.on('error', reject);
      req.end();
    }));
  }
  return { get: (token, path) => open(token, path, false), stream: (token, path) => open(token, path, true) };
}

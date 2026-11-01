// Kartendaten vom CDN-Branch (festes Tag, z. B. data-v2). Nur erlaubte Pfade, jede Datei wird geprüft:
//  catalog.json  -> optional gegen CDN_CATALOG_SHA256 gepinnt
//  m/<karte>.json -> SHA-256 steht im Katalog
//  p/xx/yyyy.z    -> Dateiname = erste 16 Hex-Stellen des SHA-256 des entpackten Inhalts
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { blockedAddress } from './console.mjs';
import dns from 'node:dns';

const RE_CATALOG = /^catalog\.json$/;
const RE_INDEX = /^m\/([a-z0-9_]{1,40})\.json$/;
const RE_TILE = /^p\/([0-9a-f]{2})\/([0-9a-f]{14})\.z$/;
const TILE_RAW = 3 * 129 * 129;
const MAX_BYTES = 16 * 1048576;
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

export function cdnPathOk(p) { return typeof p === 'string' && p.length < 80 && (RE_CATALOG.test(p) || RE_INDEX.test(p) || RE_TILE.test(p)); }

export function makeCdn(cfg, log = () => {}) {
  const cache = new Map(); let bytes = 0; const inflight = new Map(); let catalog = null;
  const mod = cfg.cdnBase.protocol === 'https:' ? https : http;
  const lookup = (h, o, cb) => dns.lookup(h, o, (e, a, f) => {
    if (e) return cb(e);
    const l = Array.isArray(a) ? a : [{ address: a }];
    if (l.some((x) => blockedAddress(x.address))) return cb(new Error('Zieladresse nicht erlaubt'));
    cb(null, a, f);
  });
  function fetchRaw(rel) {
    const url = new URL(rel, cfg.cdnBase);
    if (!url.href.startsWith(cfg.cdnBase.href)) throw new Error('Pfad außerhalb des CDN');
    return new Promise((resolve, reject) => {
      const req = mod.get(url, { lookup, timeout: 20000, agent: false, headers: { 'User-Agent': 'mapviewer3d-companion' } }, (res) => {
        if (res.statusCode !== 200) { res.resume(); return reject(Object.assign(new Error('CDN ' + res.statusCode), { status: res.statusCode === 404 ? 404 : 502 })); }
        const ch = []; let n = 0;
        res.on('data', (c) => { n += c.length; if (n > MAX_BYTES) req.destroy(new Error('Datei zu groß')); else ch.push(c); });
        res.on('end', () => resolve(Buffer.concat(ch)));
        res.on('error', reject);
      });
      req.on('timeout', () => req.destroy(new Error('Zeitüberschreitung')));
      req.on('error', reject);
    });
  }
  async function getCatalog() {
    if (catalog) return catalog;
    const buf = await fetchRaw('catalog.json');
    const h = sha(buf);
    if (cfg.catalogPin) { if (h !== cfg.catalogPin) throw Object.assign(new Error('catalog.json passt nicht zum gepinnten SHA-256'), { status: 502 }); }
    else log(`catalog.json sha256=${h} (nicht gepinnt: setze CDN_CATALOG_SHA256, um ihn festzuhalten)`);
    catalog = { buf, json: JSON.parse(buf.toString('utf8')) };
    return catalog;
  }
  function remember(key, val) {
    cache.set(key, val); bytes += val.length;
    while (bytes > cfg.cacheBytes && cache.size > 1) { const k = cache.keys().next().value; bytes -= cache.get(k).length; cache.delete(k); }
  }
  async function load(p) {
    let m;
    if (RE_CATALOG.test(p)) return { buf: (await getCatalog()).buf, type: 'application/json' };
    if ((m = RE_INDEX.exec(p))) {
      const cat = (await getCatalog()).json;
      const e = (cat.maps || []).find((x) => x.file === p);
      if (!e || !/^[0-9a-f]{64}$/.test(e.sha256 || '')) throw Object.assign(new Error('Karte unbekannt'), { status: 404 });
      const buf = await fetchRaw(p);
      if (sha(buf) !== e.sha256) throw Object.assign(new Error('Karten-Index passt nicht zum Katalog'), { status: 502 });
      return { buf, type: 'application/json' };
    }
    if ((m = RE_TILE.exec(p))) {
      const buf = await fetchRaw(p);
      let raw; try { raw = zlib.gunzipSync(buf, { maxOutputLength: TILE_RAW + 1 }); } catch { throw Object.assign(new Error('Kachel nicht entpackbar'), { status: 502 }); }
      if (raw.length !== TILE_RAW || sha(raw).slice(0, 16) !== m[1] + m[2]) throw Object.assign(new Error('Kachel-Hash falsch'), { status: 502 });
      return { buf, type: 'application/octet-stream' };
    }
    throw Object.assign(new Error('Pfad nicht erlaubt'), { status: 404 });
  }
  return {
    async get(p) {
      if (!cdnPathOk(p)) throw Object.assign(new Error('Pfad nicht erlaubt'), { status: 404 });
      const hit = cache.get(p); if (hit) { cache.delete(p); cache.set(p, hit); return hit; }
      if (inflight.has(p)) return inflight.get(p);
      const pr = load(p).then((v) => { remember(p, v.buf && Object.assign(v.buf, { type: v.type })); return v.buf; }).finally(() => inflight.delete(p));
      inflight.set(p, pr);
      const buf = await pr; return buf;
    },
  };
}

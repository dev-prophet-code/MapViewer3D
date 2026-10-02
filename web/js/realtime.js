// Realtime Data of the Dune Docker Console: live sandworms, enemies, civilians, vehicles and
// sandstorms read from the game servers by the optional MapViewer3D position agent and passed on
// by the console at /api/realtime/* to API keys that hold the scope "Realtime Data".
//
// The standalone viewer gets these through its Go server; the addon has none, so this module does
// what that server does, in the browser: it reads the stream with the key (EventSource cannot send
// a header, so the body is read with fetch), keeps the state and hands each map layer only the
// objects of its map and instance.
//
// Rules (same as console.js): GET only, the key as Authorization: Bearer, credentials omitted.
// Nothing is stored. No suitable answer from the console (older Dune Docker, no agent, a key without
// "Realtime Data") means the feature is simply off and the switches are not shown.
import { consoleGet, consoleStream } from './console.js';

const SHOWN = new Set(['worm', 'vehicle', 'npc', 'civilian', 'storm', 'coriolis']); // never 'player': see README
const RECHECK_MS = 10 * 60 * 1000;
const WATCHDOG_MS = 65 * 1000;
const MAX_BACKOFF = 30 * 1000;
const MAX_BUFFER = 32 * 1024 * 1024;

let availableAt = 0;
let available = false;

// Whether the console offers Realtime Data for this key. Asked once, again after 10 minutes.
export async function isAvailable(force = false) {
  if (!force && Date.now() - availableAt < RECHECK_MS) return available;
  availableAt = Date.now();
  try {
    const doc = await consoleGet('/api/realtime/healthz', 0);
    available = Boolean(doc?.available);
  } catch {
    available = false;
  }
  return available;
}

export function reset() {
  availableAt = 0;
  available = false;
  feed.close();
}

// Plain HTTP (not on this machine): keys and positions are not encrypted, like everything else of
// this page. The addon can only tell the admin; a browser cannot pin certificates.
export const plainHttp = () => location.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);

class Feed {
  constructor() {
    this.sources = [];
    this.objs = new Map(); // id -> { i, k, c, s, x, y, z, yaw }
    this.gen = 0;
    this.lastEvent = 0;
    this.connected = false;
    this.subs = new Set();
    this.abort = null;
    this.retry = null;
    this.backoff = 1000;
  }

  // The state for one map instance, in the shape the layer expects.
  view(mapName, part) {
    const rows = [];
    let weather = null;
    for (const o of this.objs.values()) {
      const src = this.sources[o.s];
      if (!src || src.map !== mapName || !SHOWN.has(o.k) || (part != null && src.partition !== part)) continue;
      rows.push({ i: o.i, k: o.k, c: o.c, p: src.partition, x: Math.round(o.x), y: Math.round(o.y), z: Math.round(o.z), ...(o.yaw ? { yaw: o.yaw } : {}) });
    }
    for (const src of this.sources) {
      if (src.map === mapName && src.weather && (part == null || src.partition === part)) { weather = src.weather; break; }
    }
    const age = this.lastEvent ? Date.now() - this.lastEvent : 0;
    const fresh = this.connected && age < 30000;
    return { enabled: true, connected: fresh, ageMs: age, gen: this.gen, t: Date.now(), objects: fresh ? rows : [], ...(weather ? { weather } : {}) };
  }

  applySnap(snap) {
    this.sources = Array.isArray(snap.sources) ? snap.sources : [];
    this.objs = new Map((Array.isArray(snap.objects) ? snap.objects : []).map((o) => [o.i, o]));
    this.gen = snap.gen ?? 0;
    this.lastEvent = Date.now();
    this.connected = true;
  }

  applyPos(p) {
    for (const [id, x, y, z] of p.d ?? []) {
      const o = this.objs.get(id);
      if (o) { o.x = x; o.y = y; o.z = z; }
    }
    for (const id of p.r ?? []) this.objs.delete(id);
    this.lastEvent = Date.now();
    this.connected = true;
  }

  // handlers: { snap(view), pos({gen, t, d, r}), error() }. Returns { close }.
  attach(mapName, part, handlers) {
    const sub = { mapName, part, handlers, known: new Set() };
    this.subs.add(sub);
    if (this.objs.size && this.connected) this.emitSnap(sub);
    this.open();
    return {
      close: () => {
        this.subs.delete(sub);
        if (!this.subs.size) this.close();
      },
    };
  }

  emitSnap(sub) {
    const v = this.view(sub.mapName, sub.part);
    sub.known = new Set(v.objects.map((o) => o.i));
    sub.handlers.snap(v);
  }

  dispatch(name, data) {
    if (name === 'snap') {
      this.applySnap(data);
      for (const sub of this.subs) this.emitSnap(sub);
    } else if (name === 'pos') {
      this.applyPos(data);
      for (const sub of this.subs) {
        const d = (data.d ?? []).filter((e) => sub.known.has(e[0]));
        const r = (data.r ?? []).filter((id) => sub.known.has(id));
        for (const id of r) sub.known.delete(id);
        if (d.length || r.length) sub.handlers.pos({ gen: data.gen, t: data.t, d, r });
      }
    }
  }

  open() {
    if (this.abort || this.retry) return;
    const ctrl = new AbortController();
    this.abort = ctrl;
    this.read(ctrl).catch(() => {}).finally(() => {
      if (this.abort === ctrl) this.abort = null;
      this.connected = false;
      for (const sub of this.subs) sub.handlers.error?.();
      if (this.subs.size && !ctrl.signal.aborted && !this.denied) {
        this.retry = setTimeout(() => { this.retry = null; this.open(); }, this.backoff);
        this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF);
      }
    });
  }

  async read(ctrl) {
    const res = await consoleStream('/api/realtime/stream', ctrl.signal).catch((e) => {
      // key disabled, expired or revoked, or the scope removed: stop for good, switches go away on reload
      if (e?.code === 'token_rejected' || (e?.code === 'http_status' && ['404', '403'].includes(e.detail))) {
        this.denied = true;
        available = false;
        availableAt = Date.now();
      }
      throw e;
    });
    this.backoff = 1000;
    const dog = () => { clearTimeout(this.dog); this.dog = setTimeout(() => ctrl.abort(), WATCHDOG_MS); };
    dog();
    const reader = res.body.getReader();
    const text = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        dog();
        buf += text.decode(value, { stream: true });
        if (buf.length > MAX_BUFFER) throw new Error('stream too large');
        let at;
        while ((at = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, at).replace(/\r/g, '');
          buf = buf.slice(at + 2);
          this.parse(block);
        }
      }
    } finally {
      clearTimeout(this.dog);
      reader.cancel().catch(() => {});
    }
  }

  parse(block) {
    if (!block || block.startsWith(':')) return; // keep-alive comment
    let name = '';
    let data = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) name = line.slice(6).trim();
      else if (line.startsWith('data:')) data += line.slice(5).trim();
    }
    if (!name || !data) return;
    let obj;
    try { obj = JSON.parse(data); } catch { return; }
    this.dispatch(name, obj);
  }

  close() {
    clearTimeout(this.retry);
    clearTimeout(this.dog);
    this.retry = null;
    this.abort?.abort();
    this.abort = null;
    this.connected = false;
    this.denied = false;
  }
}

const feed = new Feed();

// One shared connection for all layers; the console allows a few per key.
export const attach = (mapName, part, handlers) => feed.attach(mapName, part, handlers);

// One-shot snapshot for the polling fallback (no streaming support in the browser).
export async function snapshot(mapName, part) {
  const doc = await consoleGet('/api/realtime/objects', 2000);
  feed.applySnap(doc);
  return feed.view(mapName, part);
}

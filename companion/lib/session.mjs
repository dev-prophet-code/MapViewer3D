// Sitzungen nur im Arbeitsspeicher. Der Token verlässt den Server nie Richtung Browser und wird nie geschrieben.
import crypto from 'node:crypto';

export function makeSessions(cfg) {
  const map = new Map();
  const timer = setInterval(() => { const now = Date.now(); for (const [id, s] of map) if (s.expires < now) end(id); }, 30000);
  timer.unref();
  function end(id) { const s = map.get(id); if (!s) return; s.token = null; for (const c of s.closers) { try { c(); } catch { /* egal */ } } map.delete(id); }
  return {
    create(token, mode, ip) {
      // Je Adresse nur wenige Sitzungen (die älteste wird ersetzt); ist der Server insgesamt voll, wird abgelehnt statt fremde Nutzer zu verdrängen.
      const mine = [...map.entries()].filter(([, v]) => v.ip === ip).sort((a, b) => a[1].created - b[1].created);
      if (mine.length >= cfg.maxSessionsPerIp) end(mine[0][0]);
      if (map.size >= cfg.maxSessions) return null;
      const id = crypto.randomBytes(32).toString('base64url');
      map.set(id, { token, mode, ip, created: Date.now(), expires: Date.now() + cfg.sessionTtlMs, closers: new Set(), streams: 0, hits: [], cache: new Map() });
      return id;
    },
    get(id) { if (typeof id !== 'string' || id.length !== 43) return null; const s = map.get(id); if (!s) return null; if (s.expires < Date.now()) { end(id); return null; } return s; },
    end, size: () => map.size,
  };
}

export function parseCookies(h) {
  const out = {};
  if (typeof h !== 'string' || h.length > 4096) return out;
  for (const part of h.split(';')) { const i = part.indexOf('='); if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim(); }
  return out;
}

// Gleitendes Fenster je Schlüssel
export function makeLimiter(max, windowMs) {
  const m = new Map();
  const t = setInterval(() => { const now = Date.now(); for (const [k, v] of m) if (v.every((x) => x < now - windowMs)) m.delete(k); }, 60000); t.unref();
  return (key) => { const now = Date.now(); const a = (m.get(key) || []).filter((x) => x > now - windowMs); if (a.length >= max) { m.set(key, a); return false; } a.push(now); m.set(key, a); return true; };
}

// Fehlversuche beim Anmelden: N pro Minute, danach 10 Minuten Sperre
export function makeLoginGuard(limit) {
  const fails = new Map(), blocked = new Map();
  const t = setInterval(() => { const now = Date.now(); for (const [k, v] of blocked) if (v < now) blocked.delete(k); for (const [k, v] of fails) if (v.every((x) => x < now - 60000)) fails.delete(k); }, 60000); t.unref();
  return {
    isBlocked(ip) { const b = blocked.get(ip); if (b && b > Date.now()) return true; blocked.delete(ip); return false; },
    fail(ip) { const now = Date.now(); const a = (fails.get(ip) || []).filter((x) => x > now - 60000); a.push(now); fails.set(ip, a); if (a.length >= limit) { blocked.set(ip, now + 600000); fails.delete(ip); } },
    ok(ip) { fails.delete(ip); },
  };
}

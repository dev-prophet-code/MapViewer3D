// Konfiguration nur aus Umgebungsvariablen. Nichts davon wird geloggt oder ins Repo geschrieben.
import net from 'node:net';

const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|\[?::1\]?)$/i;
export const isLoopbackHost = (h) => LOOPBACK.test(h);

export function loadConfig(env = process.env) {
  const need = (k) => { if (!env[k]) throw new Error(`${k} ist nicht gesetzt (siehe .env.example)`); return env[k]; };
  const flag = (k) => env[k] === '1' || env[k] === 'true';
  const int = (k, d, min, max) => { const v = env[k] === undefined ? d : Number(env[k]); if (!Number.isInteger(v) || v < min || v > max) throw new Error(`${k} ungültig`); return v; };

  let consoleUrl;
  try { consoleUrl = new URL(need('CONSOLE_URL')); } catch { throw new Error('CONSOLE_URL ist keine gültige Adresse'); }
  if (!['http:', 'https:'].includes(consoleUrl.protocol)) throw new Error('CONSOLE_URL muss http:// oder https:// sein');
  if (consoleUrl.username || consoleUrl.password) throw new Error('CONSOLE_URL darf keine Zugangsdaten enthalten');
  if (consoleUrl.pathname !== '/' || consoleUrl.search || consoleUrl.hash) throw new Error('CONSOLE_URL darf keinen Pfad haben');
  const consoleAllowHttp = flag('CONSOLE_ALLOW_HTTP');
  if (consoleUrl.protocol === 'http:' && !isLoopbackHost(consoleUrl.hostname) && !consoleAllowHttp) {
    throw new Error('CONSOLE_URL ist unverschlüsselt (http) und nicht lokal. Nutze https oder setze CONSOLE_ALLOW_HTTP=1 (Token läuft dann im Klartext über das Netz).');
  }
  const consolePin = env.CONSOLE_PIN || '';
  if (consolePin && !/^sha256\/[A-Za-z0-9_-]{43}=?$/.test(consolePin)) throw new Error('CONSOLE_PIN muss die Form sha256/<base64url> haben');

  let cdnBase = new URL(env.CDN_BASE || 'https://raw.githubusercontent.com/dev-prophet-code/MapViewer3D/data-v2/');
  if (!cdnBase.pathname.endsWith('/')) cdnBase = new URL(cdnBase.href + '/');
  if (cdnBase.protocol !== 'https:' && !(cdnBase.protocol === 'http:' && isLoopbackHost(cdnBase.hostname))) throw new Error('CDN_BASE muss https sein');
  if (cdnBase.username || cdnBase.password || cdnBase.search || cdnBase.hash) throw new Error('CDN_BASE ungültig');
  const catalogPin = (env.CDN_CATALOG_SHA256 || '').toLowerCase();
  if (catalogPin && !/^[0-9a-f]{64}$/.test(catalogPin)) throw new Error('CDN_CATALOG_SHA256 ungültig');

  const bind = env.BIND || '127.0.0.1';
  if (net.isIP(bind) === 0 && bind !== 'localhost') throw new Error('BIND muss eine IP-Adresse sein');
  return {
    port: int('PORT', 8799, 1, 65535), bind, consoleUrl, consoleAllowHttp, consolePin,
    cdnBase, catalogPin, trustProxy: flag('TRUST_PROXY'),
    allowedHosts: (env.ALLOWED_HOSTS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    sessionTtlMs: int('SESSION_TTL_MIN', 480, 5, 1440) * 60000,
    maxSessions: int('MAX_SESSIONS', 50, 1, 1000),
    cacheBytes: int('CACHE_MB', 128, 8, 2048) * 1048576,
    loginFailLimit: int('LOGIN_FAIL_LIMIT', 10, 1, 1000),
    maxSessionsPerIp: int('MAX_SESSIONS_PER_IP', 5, 1, 100),
  };
}

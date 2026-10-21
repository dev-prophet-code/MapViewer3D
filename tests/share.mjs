// Tests of the pure parts of the share dialog: gateway address, link address, duration.
import assert from 'node:assert/strict';
import { durationSeconds, findGateway, linkUrl, normalizeGateway, SECRET_PATTERN, TOKEN_PATTERN } from '../web/js/share-core.js';

const own = 'https://console.example.org';
assert.equal(normalizeGateway('', own), own, 'empty = own origin');
assert.equal(normalizeGateway('  ', own), own);
assert.equal(normalizeGateway('https://share.example.org', own), 'https://share.example.org');
assert.equal(normalizeGateway('share.example.org:8798/anything?x=1', own), 'https://share.example.org:8798', 'bare host gets https, path is dropped');
assert.equal(normalizeGateway('http://127.0.0.1:8798', own), 'http://127.0.0.1:8798', 'plain http only for this machine');
assert.equal(normalizeGateway('http://localhost:8798/', own), 'http://localhost:8798');
assert.equal(normalizeGateway('http://share.example.org', own), null, 'plain http to another host is refused');
assert.equal(normalizeGateway('http://console.example.org:8798', 'http://console.example.org:8089'), 'http://console.example.org:8798', 'plain http on the host of a plain-http console');
assert.equal(normalizeGateway('http://console.example.org:8798', own), null, 'but never next to an https console');
assert.equal(normalizeGateway('http://other.example.org:8798', 'http://console.example.org:8089'), null);
assert.equal(normalizeGateway('ftp://share.example.org', own), null);
assert.equal(normalizeGateway('javascript:alert(1)', own), null);
assert.equal(normalizeGateway('https://user:pw@share.example.org', own), null, 'credentials in the address are refused');
assert.equal(normalizeGateway('https://', own), null);

const token = `mvs_${'A'.repeat(43)}`;
assert.ok(TOKEN_PATTERN.test(token));
assert.ok(!TOKEN_PATTERN.test(`${token}x`) && !TOKEN_PATTERN.test('mvs_short') && !TOKEN_PATTERN.test(token.replace('mvs_', 'dak_')));
assert.ok(SECRET_PATTERN.test(`mva_${'b'.repeat(43)}`) && !SECRET_PATTERN.test(token));
assert.equal(linkUrl('https://share.example.org', token), `https://share.example.org/s/${token}/`);

assert.equal(durationSeconds('3600'), 3600);
assert.equal(durationSeconds('custom', 3, 86400), 3 * 86400);
assert.equal(durationSeconds('custom', 2, 3600), 7200);
assert.equal(durationSeconds('custom', 0, 3600), null);
assert.equal(durationSeconds('custom', -1, 3600), null);
assert.equal(durationSeconds('custom', 'abc', 3600), null);
assert.equal(durationSeconds('custom', 2000, 86400), null, 'more than 5 years');
assert.equal(durationSeconds('30'), null, 'less than a minute');
console.log('ok   share dialog helpers');

// ---- the key goes only to an address that has identified itself as the share gateway
{
  const KEY = 'dak_secretkey_0123456789';
  const seen = [];
  const web = (map) => async (url, init = {}) => {
    seen.push({ url, init });
    if (init.headers?.Authorization) assert.ok(map[new URL(url).origin]?.gateway, `the key was sent to ${url}`);
    const m = map[new URL(url).origin];
    if (!m) throw new Error('unreachable');
    if (url.endsWith('/mvshare')) return { ok: m.status !== 404, json: async () => m.who };
    return { ok: true, json: async () => ({ maps: true }) };
  };
  const status = (fetchFn) => async (origin) => (await fetchFn(`${origin}/share-admin/status`, { headers: { Authorization: `Bearer ${KEY}` } })).json();

  let fetchFn = web({
    'https://console.example.org': { who: '<html>', status: 404 },
    'https://console.example.org:8798': { who: { other: 1 } }, // answers, but is not the gateway
    'http://console.example.org:8798': { who: { 'mapviewer-share': 1 }, gateway: true },
  });
  const r = await findGateway(['https://console.example.org', 'https://console.example.org:8798', 'http://console.example.org:8798'], { fetchFn, status: status(fetchFn) });
  assert.equal(r.origin, 'http://console.example.org:8798');
  assert.ok(!seen.some((s) => s.init.headers?.Authorization && !s.url.startsWith('http://console.example.org:8798')), 'only the gateway saw the key');
  for (const s of seen.filter((x) => x.url.endsWith('/mvshare'))) {
    assert.ok(!s.init.headers && s.init.credentials === 'omit' && s.init.redirect === 'error', 'the identification carries no credential');
  }

  seen.length = 0;
  fetchFn = web({ 'https://console.example.org:8798': { who: { other: 1 } } });
  const none = await findGateway(['https://console.example.org:8798'], { fetchFn, status: status(fetchFn) });
  assert.equal(none.origin, undefined);
  assert.ok(!seen.some((s) => s.init.headers?.Authorization), 'an address that is not the gateway never sees the key');
  console.log('ok   the key is sent only to an address that identified itself as the gateway');
}

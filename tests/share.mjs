// Tests of the pure parts of the share dialog: gateway address, link address, duration.
import assert from 'node:assert/strict';
import { durationSeconds, linkUrl, normalizeGateway, SECRET_PATTERN, TOKEN_PATTERN } from '../web/js/share-core.js';

const own = 'https://console.example.org';
assert.equal(normalizeGateway('', own), own, 'empty = own origin');
assert.equal(normalizeGateway('  ', own), own);
assert.equal(normalizeGateway('https://share.example.org', own), 'https://share.example.org');
assert.equal(normalizeGateway('share.example.org:8798/anything?x=1', own), 'https://share.example.org:8798', 'bare host gets https, path is dropped');
assert.equal(normalizeGateway('http://127.0.0.1:8798', own), 'http://127.0.0.1:8798', 'plain http only for this machine');
assert.equal(normalizeGateway('http://localhost:8798/', own), 'http://localhost:8798');
assert.equal(normalizeGateway('http://share.example.org', own), null, 'plain http to another host is refused');
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

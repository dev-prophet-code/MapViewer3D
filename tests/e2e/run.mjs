// End-to-end test of the sandbox edition inside the REAL Dune Docker Console: the console's own server
// (Red-Blink/dune-awakening-selfhost-docker, mock mode, auth on) serves the built addon package through its
// protected content route and the iframe sandbox with the console's CSP; the game database is a
// PostgreSQL-compatible fixture (PGlite) reached through the console's own database.query bridge action.
//
//   node tests/e2e/run.mjs --pkg dist/sandbox-pkg --console <checkout of dune-awakening-selfhost-docker>
//   (--chrome <path to a Chrome/Chromium binary>, default: Playwright's Chromium)
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { chromium } from 'playwright';
import { createFixtureDb } from '../fixtures/dune-fixture.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : null; };
const PKG = path.resolve(arg('pkg') ?? 'dist/sandbox-pkg');
const CONSOLE = path.resolve(arg('console') ?? process.env.DUNE_CONSOLE_DIR ?? '');
const CHROME = arg('chrome') ?? process.env.E2E_CHROME ?? null;
const PASSWORD = 'Test-Password-For-E2E-1234';
const ID = 'mapviewer3d';

if (!fs.existsSync(path.join(PKG, 'web/index.html'))) throw new Error(`no built package at ${PKG} (node scripts/build-sandbox.mjs ...)`);
if (!fs.existsSync(path.join(CONSOLE, 'console/api/src/server.js'))) throw new Error('--console must point at a checkout of dune-awakening-selfhost-docker');

const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, what, extra = '') => { console.log(`${ok ? 'ok:  ' : 'FAIL:'} ${what}${ok || !extra ? '' : ` (${extra})`}`); if (!ok) failures++; };

// ---- the console (built once, API dependencies installed once) ----
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: 'inherit' });
if (!fs.existsSync(path.join(CONSOLE, 'console/api/node_modules'))) run('npm', ['ci', '--no-audit', '--no-fund'], path.join(CONSOLE, 'console/api'));
if (!fs.existsSync(path.join(CONSOLE, 'console/web/dist/index.html'))) {
  if (!fs.existsSync(path.join(CONSOLE, 'console/web/node_modules'))) run('npm', ['ci', '--no-audit', '--no-fund'], path.join(CONSOLE, 'console/web'));
  run('npm', ['run', 'build'], path.join(CONSOLE, 'console/web'));
}

// ---- a throw-away repository root with the addon installed and approved ----
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mv3d-e2e-'));
const port = await freePort();
const pgPort = await freePort();
fs.mkdirSync(path.join(root, 'runtime/secrets'), { recursive: true });
fs.mkdirSync(path.join(root, 'runtime/generated'), { recursive: true });
fs.mkdirSync(path.join(root, 'runtime/addons/installed'), { recursive: true });
fs.writeFileSync(path.join(root, '.env'), `ADMIN_BIND_PORT=${port}\n`);
fs.writeFileSync(path.join(root, 'runtime/secrets/funcom-token.txt'), 'e2e-test-token\n');
fs.writeFileSync(path.join(root, 'runtime/generated/battlegroup.env'), 'X=1\n');
fs.cpSync(PKG, path.join(root, 'runtime/addons/installed', ID), { recursive: true });
const manifest = JSON.parse(fs.readFileSync(path.join(PKG, 'addon.json'), 'utf8'));
const wanted = Object.entries(manifest.permissions).flatMap(([k, v]) => v.map((a) => `${k}:${a}`));
fs.writeFileSync(path.join(root, 'runtime/addons/state.json'), JSON.stringify({
  [ID]: { enabled: true, approvedPermissions: wanted, lifecycle: 'active', installedAt: '2026-11-01T00:00:00.000Z', sha256: 'e2e', provenance: {}, lifecycleMessage: '', lifecycleUrl: '' },
}));

// ---- the game database ----
const db = await createFixtureDb();
const pg = new PGLiteSocketServer({ db, port: pgPort, host: '127.0.0.1' });
await pg.start();

const logs = [];
const child = spawn(process.execPath, ['--import', path.join(here, 'offline-preload.mjs'), 'src/server.js'], {
  cwd: path.join(CONSOLE, 'console/api'),
  env: {
    ...process.env, DUNE_DOCKER_DIR: root, ADMIN_MOCK_MODE: '1', ADMIN_PASSWORD: PASSWORD, ADMIN_BIND_HOST: '127.0.0.1', ADMIN_BIND_PORT: String(port),
    ADMIN_STATIC_DIR: path.join(CONSOLE, 'console/web/dist'), DUNE_DB_HOST: '127.0.0.1', DUNE_DB_PORT: String(pgPort), DUNE_DB_NAME: 'postgres', DUNE_DB_USER: 'postgres', DUNE_DB_PASSWORD: 'postgres', ADMIN_DB_POOL_SIZE: '1', E2E_ADDON_JSON: path.join(PKG, 'addon.json'),
  },
});
child.stdout.on('data', (d) => logs.push(String(d)));
child.stderr.on('data', (d) => logs.push(String(d)));
const BASE = `http://127.0.0.1:${port}`;
for (let i = 0; ; i++) {
  try { if ((await fetch(`${BASE}/`)).ok) break; } catch { /* starting */ }
  if (i > 100) throw new Error(`console did not start:\n${logs.join('')}`);
  await sleep(200);
}

let browser;
let page;
const problems = [];
try {
  // ---- protected asset routes ----
  const content = `${BASE}/api/addons/installed/${ID}/content/web/index.html`;
  const anon = await fetch(content, { redirect: 'manual' });
  check(anon.status === 401 || anon.status === 403, 'the addon page is not served without a console session', String(anon.status));

  browser = await chromium.launch({ executablePath: CHROME || undefined, args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  page = await ctx.newPage();
  page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) problems.push(`${m.type()}: ${m.text().slice(0, 300)}`); });
  page.on('response', (r) => { if (r.status() >= 400) problems.push(`http ${r.status()} ${r.url().replace(BASE, '')}`); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  const bridgeCalls = [];
  await page.exposeFunction('__bridgeSeen', (a) => bridgeCalls.push(a));
  await page.addInitScript(() => {
    window.addEventListener('message', (e) => { if (e.data?.type === 'dune-addon-request') window.__bridgeSeen(e.data.action); });
  });

  await page.goto(`${BASE}/`);
  await page.getByRole('textbox').first().fill(PASSWORD);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.getByText('Addons', { exact: true }).first().click({ timeout: 30000 });

  const ownCookies = await ctx.cookies(BASE);
  const authed = await fetch(content, { headers: { Cookie: ownCookies.map((c) => `${c.name}=${c.value}`).join('; ') } });
  const csp = authed.headers.get('content-security-policy') ?? '';
  check(authed.status === 200, 'the addon page is served to the signed-in session', String(authed.status));
  check(/connect-src 'none'/.test(csp) && /sandbox allow-scripts/.test(csp) && /default-src 'self'/.test(csp), 'the console sends its sandbox CSP (connect-src none)', csp);
  const html = await authed.text();
  check(!/<script[^>]+\bsrc=/i.test(html) && !/<link[^>]+href=/i.test(html), 'the page loads no separate script or style file');
  const sibling = await fetch(`${BASE}/api/addons/installed/${ID}/content/addon.json`, { headers: { Cookie: ownCookies.map((c) => `${c.name}=${c.value}`).join('; ') } });
  check(sibling.status !== 500, 'a second file of the package answers without a server error', String(sibling.status));
  const escape = await fetch(`${BASE}/api/addons/installed/${ID}/content/..%2F..%2Fstate.json`, { headers: { Cookie: ownCookies.map((c) => `${c.name}=${c.value}`).join('; ') } });
  check(escape.status >= 400 && !(await escape.text()).includes('approvedPermissions'), 'the content route does not leave the addon folder', String(escape.status));

  await page.getByRole('button', { name: 'Open', exact: true }).first().click({ timeout: 30000 });
  const frameEl = page.locator('iframe.addon-frame');
  await frameEl.waitFor({ timeout: 30000 });
  check((await frameEl.getAttribute('sandbox')) === 'allow-scripts', 'the console runs the addon with sandbox="allow-scripts" only');
  let frame;
  for (let i = 0; i < 60 && !frame; i++) { frame = page.frames().find((f) => f.url().includes('/addons/installed/')); if (!frame) await sleep(250); }

  // ---- initial rendering ----
  await frame.waitForFunction(() => document.querySelector('#map')?.options.length > 0, null, { timeout: 120000 });
  const maps = await frame.$$eval('#map option', (o) => o.map((x) => x.textContent));
  check(maps.length >= 2 && maps.some((m) => /Hagga/i.test(m)) && maps.some((m) => /Deep/i.test(m)), 'both maps are offered (from the embedded catalog)', maps.join(' | '));
  check(!(await frame.evaluate(() => document.querySelector('#mapinfo').textContent.startsWith('Fehler'))), 'no start-up error is shown');
  check((await frame.locator('#version').textContent()).trim().length > 0, 'the addon version is shown');
  const opaque = await frame.evaluate(() => ({ origin: location.origin, win: window.origin }));
  check(opaque.win === 'null', 'the page really runs in an opaque origin', JSON.stringify(opaque));

  // ---- terrain ----
  await frame.waitForFunction(() => window.dune?.terrain?.drawn?.length > 0 && !window.dune.terrain.inflight && !window.dune.terrain.queue.size, null, { timeout: 120000 });
  const terrain = await frame.evaluate(() => ({ drawn: window.dune.terrain.drawn.length, minLevel: window.dune.terrain.minLevel, h: window.dune.terrain.heightAt(0, 0) }));
  check(terrain.drawn > 0 && terrain.minLevel >= 1, 'terrain tiles are drawn from the embedded data', JSON.stringify(terrain));
  // a flat picture compresses to a few KB; terrain, sky and fog do not
  const shot = await frameEl.screenshot();
  check(shot.length > 40000, 'the 3D view is not blank', `${shot.length} bytes of PNG`);

  // ---- authenticated live data through the bridge ----
  await frame.waitForFunction(() => document.querySelectorAll('#playerList > *').length > 0, null, { timeout: 60000 }).catch(() => {});
  const names = await frame.$$eval('#playerList > *', (el) => el.map((e) => e.textContent));
  check(names.some((n) => n.includes('Anna Atreides')), 'players from the game database are listed', names.join(' | '));
  const status = await frame.locator('#liveStatus').textContent();
  check(!/error|fehler/i.test(status), 'the live status shows no error', status);
  check(bridgeCalls.includes('database.query') && bridgeCalls.every((a) => /^(database\.query|addon\.storage\.(get|put))$/.test(a)), 'the page uses only database.query and addon storage', [...new Set(bridgeCalls)].join(','));
  const perMinute = bridgeCalls.filter((a) => a === 'database.query').length;
  check(perMinute <= 40, 'the bridge budget (60 calls a minute) is respected during start-up', String(perMinute));

  // the console, not the page, enforces read-only: a write through the same bridge is refused
  const refused = await frame.evaluate(() => window.DuneAddon.request('database.query', { query: 'delete from dune.actors' }).then(() => 'accepted', (e) => e.message));
  check(refused !== 'accepted', 'a write statement is refused by the console', refused);
  const rows = await db.query('select count(*)::int as n from dune.actors');
  check(rows.rows[0].n > 0, 'the fixture data was not changed');

  // ---- share dialog ----
  await frame.waitForSelector('#connShare:not([hidden])');
  await frame.locator('#connShare').click();
  await frame.waitForSelector('#share:not([hidden])');
  const shareText = await frame.locator('#shareSandbox').textContent();
  check(/admin/.test(shareText) && /mvshare/.test(shareText), 'the share dialog points to the gateway admin page', shareText);
  await frame.locator('#shareClose').click();

  // ---- no policy violations anywhere ----
  const violations = problems.filter((p) => /Content Security Policy|Refused to|blocked by CORS|ERR_BLOCKED/i.test(p));
  check(violations.length === 0, 'no CSP or blocked-request errors in the console', violations.join(' || '));
  const others = problems.filter((p) => !violations.includes(p) && !/GPU stall|WebGL|swiftshader|GroupMarker/i.test(p)
    // the console's own header polling (players online, performance) has no real server behind it in this test;
    // the 400 is the write statement the test sends on purpose
    && !/Failed to load resource|http \d+ \/api\/(players\/online|server\/performance)|http 400 \/api\/addons\/installed\/[^/]+\/bridge/.test(p));
  check(others.length === 0, 'no other console errors or warnings', others.join(' || '));
  fs.mkdirSync('dist', { recursive: true });
  await page.screenshot({ path: path.resolve('dist', 'e2e-console.png') });
} catch (e) {
  failures++;
  console.error('FAIL: unexpected error', e);
  await page?.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {});
  console.error(`console messages:\n${problems.slice(-12).join('\n')}`);
  console.error(`page text: ${(await page?.locator('body').innerText().catch(() => ''))?.slice(0, 600).replace(/\n+/g, ' | ')}`);
} finally {
  await browser?.close().catch(() => {});
  child.kill();
  await pg.stop().catch(() => {});
  await db.close().catch(() => {});
}
if (failures) { console.error(`\n${failures} check(s) failed. Console log:\n${logs.join('').slice(-3000)}\nTemp dir kept: ${root}`); process.exit(1); }
fs.rmSync(root, { recursive: true, force: true });
console.log('\nall end-to-end checks passed');

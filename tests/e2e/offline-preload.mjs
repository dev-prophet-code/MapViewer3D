// Loaded into the console process (node --import): the console never reaches the internet in this test.
// Its community catalog is a one-entry stand-in for the addon under test (so the console lists the
// installed package like a catalog addon); every other outside host is unreachable. Local addresses work.
import fs from 'node:fs';

const real = globalThis.fetch;
const addon = JSON.parse(fs.readFileSync(process.env.E2E_ADDON_JSON, 'utf8'));
const RAW = 'https://raw.githubusercontent.com/Red-Blink/dune-docker-addons';
const manifestUrl = `${RAW}/main/addons/${addon.id}/addon.json`;
const json = (doc) => new Response(JSON.stringify(doc), { status: 200, headers: { 'content-type': 'application/json' } });

globalThis.fetch = async (input, init) => {
  const url = String(input?.url ?? input);
  if (url === `${RAW}/main/index.json`) {
    return json({ schemaVersion: 1, updatedAt: '2026-11-01T00:00:00Z', addons: [{ id: addon.id, name: addon.name, description: addon.description, author: addon.author, version: addon.version, manifestUrl }] });
  }
  if (url === manifestUrl) {
    return json({ ...addon, sourceUrl: 'https://github.com/dev-prophet-code/MapViewer3D/tree/DD-Addon', downloadUrl: `https://github.com/dev-prophet-code/MapViewer3D/releases/download/e2e/${addon.id}.zip`, sha256: 'a'.repeat(64) });
  }
  if (/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(url)) return real(input, init);
  throw new TypeError(`offline test: ${url}`);
};

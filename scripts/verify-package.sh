#!/usr/bin/env bash
# Verifies the PACKAGE (the ZIP, or the published release asset by URL), not the source checkout:
#
#   bash scripts/verify-package.sh dist/mapviewer3d-X.Y.Z.zip
#   bash scripts/verify-package.sh https://github.com/.../mapviewer3d-X.Y.Z.zip
#
# The package is addon.json, README.md and ONE page, web/index.html, because the Console runs an addon in a
# sandbox that can load nothing else (see scripts/build-sandbox.mjs). The checks:
#   - exactly those three files, below the Console's 50 MiB limit for addon archives,
#   - no CR (CRLF) byte in the text files,
#   - the page loads no separate script, style or outside address; its script passes `node --check`,
#   - the script uses no cookie, sessionStorage, IndexedDB or Cache API (the page has no key to keep),
#   - the embedded data blocks are valid JSON with the expected maps,
#   - the permission list is exactly files:addon-data and database:read,
#   - addon.json id/version match the file name.
set -euo pipefail
SRC="${1:?usage: verify-package.sh <addon zip or URL>}"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

case "$SRC" in
  http*://*) curl --fail --location --silent --show-error -o "$T/pkg.zip" "$SRC"; ZIP="$T/pkg.zip" ;;
  *) ZIP="$SRC" ;;
esac
[ -f "$ZIP" ] || fail "no such file: $ZIP"
mkdir "$T/x"; unzip -q "$ZIP" -d "$T/x"

SIZE="$(wc -c < "$ZIP" | tr -d ' ')"
[ "$SIZE" -lt $((50 * 1024 * 1024)) ] || fail "package is $SIZE bytes; the Console accepts less than 50 MiB"
echo "ok:   package size $SIZE bytes"

FILES="$(cd "$T/x" && find . -type f | sed 's|^\./||' | LC_ALL=C sort | tr '\n' ' ' | sed 's/ $//')"
[ "$FILES" = "README.md addon.json web/index.html" ] || fail "the package must hold exactly addon.json, README.md and web/index.html (found: $FILES)"
echo "ok:   exactly addon.json, README.md, web/index.html"

for f in addon.json README.md web/index.html; do
  if LC_ALL=C grep -q "$(printf '\r')" "$T/x/$f"; then fail "CRLF line endings in $f"; fi
done
echo "ok:   no CR in the text files"

# everything below is done by one script, so the page is read once
node --input-type=module - "$T/x" <<'JS' || exit 1
import fs from 'node:fs';
import path from 'node:path';
const dir = process.argv[2];
const die = (m) => { console.error(`FAIL: ${m}`); process.exit(1); };
const html = fs.readFileSync(path.join(dir, 'web/index.html'), 'utf8');

if (/<script\b[^>]*\bsrc\s*=/i.test(html)) die('web/index.html loads a separate script (the Console sandbox blocks it)');
if (/<link\b[^>]*\bhref\s*=/i.test(html) || /@import\b/.test(html)) die('web/index.html loads a separate style or file');
if (/<(img|iframe|object|embed|video|audio|source)\b[^>]*\bsrc\s*=\s*["']?https?:/i.test(html)) die('web/index.html references an outside address');
if (/<base\b/i.test(html) || /<meta[^>]+http-equiv/i.test(html)) die('web/index.html sets a base address or meta policy');
console.log('ok:   one self-contained page (no separate script, style or outside address)');

const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].map((m) => ({ attrs: m[1], body: m[2] }));
const code = scripts.filter((s) => /type="module"/.test(s.attrs));
if (code.length !== 1) die(`expected exactly one module script, found ${code.length}`);
fs.writeFileSync(path.join(dir, 'page-script.mjs'), code[0].body);
const { spawnSync } = await import('node:child_process');
const chk = spawnSync(process.execPath, ['--check', path.join(dir, 'page-script.mjs')], { encoding: 'utf8' });
if (chk.status !== 0) die(`node --check on the page script: ${chk.stderr}`);
fs.rmSync(path.join(dir, 'page-script.mjs'));
console.log('ok:   node --check on the page script');

const bad = code[0].body.match(/document\.cookie|sessionStorage|indexedDB|caches\.(open|match)|new\s+WebSocket|new\s+EventSource|new\s+XMLHttpRequest/);
if (bad) die(`the page script uses ${bad[0]}, which the addon must not use`);
console.log('ok:   no cookie, sessionStorage, IndexedDB, Cache API or network object in the page script');

const blocks = Object.fromEntries(scripts.filter((s) => /type="application\/json"/.test(s.attrs)).map((s) => [/id="([^"]+)"/.exec(s.attrs)?.[1], s.body]));
for (const id of ['mv-core', 'mv-models', 'mv-maps']) {
  if (!blocks[id]) die(`the data block ${id} is missing`);
  try { blocks[id] = JSON.parse(blocks[id]); } catch (e) { die(`the data block ${id} is not valid JSON: ${e.message}`); }
}
const core = blocks['mv-core'];
if (!core.catalog?.maps?.length || !core.tiles || !Object.keys(core.tiles).length || !core.icons) die('mv-core lacks the catalog, tiles or icons');
if (!Number.isInteger(core.minLevel)) die('mv-core lacks minLevel');
for (const m of core.catalog.maps) if (!core.indexes[m.name]) die(`map ${m.name} has no index`);
console.log(`ok:   embedded data: ${core.catalog.maps.length} map(s), ${Object.keys(core.tiles).length} tiles, ${Object.keys(blocks['mv-models'].meshes).length} models`);

const m = JSON.parse(fs.readFileSync(path.join(dir, 'addon.json'), 'utf8'));
if (JSON.stringify(m.permissions) !== JSON.stringify({ files: ['addon-data'], database: ['read'] })) die(`unexpected permissions ${JSON.stringify(m.permissions)}`);
if (m.entry?.path !== 'web/index.html') die('entry.path must be web/index.html');
console.log('ok:   permissions are exactly files:addon-data and database:read');
console.log(`${m.id} ${m.version}`);
JS
IDVER="$(node -e "const m=require('$T/x/addon.json');process.stdout.write(m.id+'-'+m.version)")"
case "$(basename "$SRC")" in "$IDVER.zip"|pkg.zip) ;; *) fail "file name does not match addon.json ($IDVER.zip)" ;; esac
echo "PACKAGE OK: $(basename "$SRC")"

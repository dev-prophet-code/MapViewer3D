#!/usr/bin/env bash
# Verify a PACKAGE (the ZIP, or the published release asset by URL), not the source checkout:
#
#   bash scripts/verify-package.sh dist/mapviewer3d-X.Y.Z.zip
#   bash scripts/verify-package.sh https://github.com/.../mapviewer3d-X.Y.Z.zip
#
# Unpacks the ZIP into a temp folder and checks the files from there:
#   - no CR (CRLF) byte in any text file,
#   - `node --check` on every JavaScript file,
#   - the package is small (Console limit for addon archives is 50 MiB; we stay far below),
#     and contains no terrain/mesh data (that is streamed, see README),
#   - web/js/config.js pins a data tag and a catalog checksum,
#   - console.js / store.js use no browser storage API (the API key stays in memory),
#   - the permission list is exactly files:addon-data (instance names, removal of a legacy key),
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
[ "$SIZE" -lt $((10 * 1024 * 1024)) ] || fail "package is $SIZE bytes; expected well below 10 MiB (data is streamed, not shipped)"
echo "ok:   package size $SIZE bytes"
if find "$T/x" -type f \( -name '*.u16' -o -name '*.u8' -o -name '*.z' -o -name '*.bin' \) | grep -q .; then
  fail "package contains terrain/mesh data files"
fi
echo "ok:   no terrain/mesh data in the package"

n=0
while IFS= read -r f; do
  n=$((n + 1))
  if LC_ALL=C grep -q "$(printf '\r')" "$f"; then fail "CRLF line endings in ${f#"$T/x/"}"; fi
done < <(find "$T/x" -type f \( -name '*.sh' -o -name '*.js' -o -name '*.json' -o -name '*.md' -o -name '*.yml' -o -name '*.html' -o -name '*.css' \))
[ "$n" -gt 0 ] || fail "package contains no text files?"
echo "ok:   no CR in $n text files"

for f in $(find "$T/x/web" -name '*.js' -not -path '*/vendor/*'); do
  cp "$f" "$f.mjs"; node --check "$f.mjs" || fail "node --check ${f#"$T/x/"}"; rm "$f.mjs"
done
echo "ok:   node --check on the addon's JavaScript"

# The API key must never be persisted (the console shares addon storage between users).
for f in console.js store.js; do
  if sed 's://.*$::' "$T/x/web/js/$f" | grep -Eq 'getItem\(|setItem\(|sessionStorage|indexedDB|caches\.open|document\.cookie'; then
    fail "web/js/$f uses a browser storage API; the API key must stay in memory only"
  fi
done
if sed 's://.*$::' "$T/x/web/js/console.js" | grep -Eq "store\.put\([^)]*(KEY|token|key)"; then
  fail "console.js writes the key to the addon storage"
fi
echo "ok:   API key is memory-only (no browser storage API in console.js / store.js)"

grep -Eq "DATA_TAG = 'data-v[0-9]+'" "$T/x/web/js/config.js" || fail "config.js does not pin a data tag"
grep -Eq "CATALOG_SHA256 = '[0-9a-f]{64}'" "$T/x/web/js/config.js" || fail "config.js does not pin the catalog checksum"
grep -q "CATALOG_SHA256 = '0\{64\}'" "$T/x/web/js/config.js" && fail "catalog checksum is still the placeholder"
echo "ok:   data tag and catalog checksum pinned"

node -e "
const m=require('$T/x/addon.json');
const p=JSON.stringify(m.permissions);
if(p!==JSON.stringify({files:['addon-data']})){console.error('unexpected permissions',p);process.exit(1)}
" || fail "permissions must be exactly files:addon-data"
ID="$(node -e "process.stdout.write(require('$T/x/addon.json').id)")"
VER="$(node -e "process.stdout.write(require('$T/x/addon.json').version)")"
case "$(basename "$SRC")" in "$ID-$VER.zip"|pkg.zip) ;; *) fail "file name does not match addon.json ($ID-$VER.zip)" ;; esac
echo "ok:   addon.json $ID $VER"
echo "PACKAGE OK: $(basename "$SRC")"

#!/usr/bin/env bash
# Rules the viewer's SOURCE must keep (the packaged page is checked by verify-package.sh):
#
#   bash scripts/verify-source.sh [dir]        dir = the addon checkout (default: this repository)
#
#   - no CR (CRLF) byte in any text file,
#   - `node --check` on every JavaScript file,
#   - console.js / store.js use no browser storage API (the API key stays in memory),
#   - the set of scripts is the reviewed one, and browser storage / dynamic code appear only where meant,
#   - web/js/config.js pins a data tag and a catalog checksum,
#   - the permission list is exactly files:addon-data + database:read (instance names, game database).
set -euo pipefail
# comments are removed by a real scanner (a '//' inside a string, e.g. a URL, is not a comment)
STRIP_JS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/strip-comments.mjs"
strip() { node "$STRIP_JS" "$@"; }
SRC="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

[ -f "$SRC/addon.json" ] && [ -d "$SRC/web/js" ] || fail "not an addon checkout: $SRC"
mkdir "$T/x"; cp -R "$SRC/addon.json" "$SRC/README.md" "$SRC/web" "$SRC/sandbox" "$T/x/"
find "$T/x" -name '.DS_Store' -delete

# the scanner must really produce code: an empty answer would make every search below pass
[ -n "$(strip "$T/x/web/js/config.js")" ] || fail "scripts/strip-comments.mjs produced no output"

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
  CODE="$(strip "$T/x/web/js/$f")"

  if echo "$CODE" | grep -Eq 'getItem\(|setItem\(|sessionStorage|indexedDB|caches\.open|document\.cookie'; then
    fail "web/js/$f uses a browser storage API; the API key must stay in memory only"
  fi
done
CODE="$(strip "$T/x/web/js/console.js")"

if echo "$CODE" | grep -Eq "store\.put\([^)]*(KEY|token|key)"; then
  fail "console.js writes the key to the addon storage"
fi
echo "ok:   API key is memory-only (no browser storage API in console.js / store.js)"

# The share dialog never stores the key either; only the gateway's (public) address may be stored.
CODE="$(strip "$T/x/web/js/share.js")"

if echo "$CODE" | grep -Eq 'getItem\(|setItem\(|sessionStorage|indexedDB|caches\.open|document\.cookie'; then
  fail "web/js/share.js uses a browser storage API; the API key must stay in memory only"
fi
CODE="$(strip "$T/x/web/js/share.js")"
if echo "$CODE" | grep -E 'store\.put\(' | grep -Eiq 'secret|token'; then
  fail "share.js writes the API key or a link token to the addon storage"
fi
echo "ok:   share dialog keeps the admin secret and link tokens in memory only"

# ---- the same rules for EVERY script, so moving code into another file cannot get around them -------
# 1. The set of scripts is fixed. A new file has to be reviewed against the rules below and added here.
EXPECTED="api.js compass.js config.js console.js coords.js data.js errors.js fly.js i18n.js iconsrc.js labels.js live/agent.js live/buildables.js live/icons.js live/live.js live/models.js live/storm.js live/world-models.js main.js meshes.js realtime.js scene.js setup.js share-core.js share.js store.js terrain.js theme.js tiles.js ui.js"
ACTUAL="$(cd "$T/x/web/js" && find . -name '*.js' | sed 's|^\./||' | sort | tr '\n' ' ' | sed 's/ $//')"
[ "$ACTUAL" = "$(echo "$EXPECTED" | tr ' ' '\n' | sort | tr '\n' ' ' | sed 's/ $//')" ] || fail "the set of scripts in web/js changed (review the new file, then add it to EXPECTED): $ACTUAL"
echo "ok:   the set of scripts is the reviewed one"

# 2. Browser storage APIs only where they are meant to be, and only the intended ones:
#    data.js: Cache API (public terrain data); i18n.js, theme.js: localStorage for language/theme;
#    store.js: localStorage.removeItem (purge of a legacy development copy). Nowhere else, and never cookies,
#    sessionStorage or IndexedDB anywhere.
STORAGE='localStorage|sessionStorage|indexedDB|caches\.|document\.cookie|getItem\(|setItem\(|removeItem\('
allowed_for() {
  case "$1" in
    data.js) echo 'caches\.' ;;
    i18n.js|theme.js) echo 'localStorage|getItem\(|setItem\(' ;;
    store.js) echo 'localStorage|removeItem\(' ;;
    *) echo '' ;;
  esac
}
while IFS= read -r f; do
  rel="${f#"$T/x/web/js/"}"
  found="$(strip "$f" | grep -oE "$STORAGE" | sort -u || true)"
  [ -z "$found" ] && continue
  ok="$(allowed_for "$rel")"
  for tok in $found; do
    if [ -z "$ok" ] || ! echo "$tok" | grep -Eq "^($ok)$"; then fail "web/js/$rel uses $tok, which is not allowed in this file"; fi
  done
done < <(find "$T/x/web/js" -name '*.js')
echo "ok:   browser storage is used only by the files meant to, in the intended way"

# 3. No dynamic code and no computed access to the global object (it would get around any text search).
# (collected first: with pipefail, `grep -q` would end the pipeline early and hide the match)
DYN="$(find "$T/x/web/js" -name '*.js' -print0 | xargs -0 node "$STRIP_JS" | grep -E '(window|globalThis|self|top|parent)[[:space:]]*\[|(^|[^A-Za-z0-9_.$])eval[[:space:]]*\(|new[[:space:]]+Function|(^|[^A-Za-z0-9_.$])Function[[:space:]]*\(|(^|[^A-Za-z0-9_.$])import[[:space:]]*\(' || true)"
[ -z "$DYN" ] || fail "dynamic code or computed access to a global object in web/js: $(echo "$DYN" | head -1)"
echo "ok:   no dynamic code, no computed access to globals"

grep -Eq "DATA_TAG = 'data-v[0-9]+'" "$T/x/web/js/config.js" || fail "config.js does not pin a data tag"
grep -Eq "CATALOG_SHA256 = '[0-9a-f]{64}'" "$T/x/web/js/config.js" || fail "config.js does not pin the catalog checksum"
grep -q "CATALOG_SHA256 = '0\{64\}'" "$T/x/web/js/config.js" && fail "catalog checksum is still the placeholder"
echo "ok:   data tag and catalog checksum pinned"

node -e "
const m=require('$T/x/addon.json');
const p=JSON.stringify(m.permissions);
if(p!==JSON.stringify({files:['addon-data'],database:['read']})){console.error('unexpected permissions',p);process.exit(1)}
" || fail "permissions must be exactly files:addon-data and database:read"

# ---- the sandbox edition: its own scripts follow the same rules ----------------------------------------
SB_EXPECTED="api.js bridge.js data-embedded.js embedded.js entry.js iconsrc.js live-data.js realtime-off.js share-panel.js sql.js"
SB_ACTUAL="$(cd "$T/x/sandbox" && find . -name '*.js' | sed 's|^\./||' | sort | tr '\n' ' ' | sed 's/ $//')"
[ "$SB_ACTUAL" = "$(echo "$SB_EXPECTED" | tr ' ' '\n' | sort | tr '\n' ' ' | sed 's/ $//')" ] || fail "the set of scripts in sandbox/ changed (review the new file, then add it to SB_EXPECTED): $SB_ACTUAL"
for f in $T/x/sandbox/*.js; do
  cp "$f" "$f.mjs"; node --check "$f.mjs" || fail "node --check sandbox/$(basename "$f")"; rm "$f.mjs"
done
SB_BAD="$(find "$T/x/sandbox" -name '*.js' -print0 | xargs -0 node "$STRIP_JS" | grep -E 'localStorage|sessionStorage|indexedDB|caches\.|document\.cookie|(^|[^A-Za-z0-9_.$])eval[[:space:]]*\(|new[[:space:]]+Function|XMLHttpRequest|WebSocket|EventSource|(^|[^A-Za-z0-9_.$])fetch[[:space:]]*\(' || true)"
[ -z "$SB_BAD" ] || fail "sandbox/ must not use storage, dynamic code or the network: $(echo "$SB_BAD" | head -1)"
echo "ok:   sandbox scripts: reviewed set, no storage, no network, no dynamic code"
echo "SOURCE OK"

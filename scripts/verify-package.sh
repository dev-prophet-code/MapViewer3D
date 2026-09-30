#!/usr/bin/env bash
# Verify a PUBLISHED addon package, not the source checkout:
#
#   bash scripts/verify-package.sh dist/mapviewer3d-X.Y.Z.zip          (static checks)
#   WITH_UPGRADE_TEST=1 bash scripts/verify-package.sh <zip>            (plus the upgrade regression, Linux only)
#
# Unpacks the ZIP into a temp folder and checks the files from there:
#   - no CR (CRLF) byte in any text file,
#   - `sh -n` on every shell script, `node --check` on the JavaScript,
#   - addon.json id/version match the file name,
#   - with WITH_UPGRADE_TEST=1: scripts/test-upgrade.sh against the unpacked docker/ folder.
# Also accepts a URL (https://...zip): it is downloaded first, so the asset on GitHub can be checked.
set -euo pipefail
SRC="${1:?usage: verify-package.sh <addon zip or URL>}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

case "$SRC" in
  http*://*) curl --fail --location --silent --show-error -o "$T/pkg.zip" "$SRC"; ZIP="$T/pkg.zip" ;;
  *) ZIP="$SRC" ;;
esac
[ -f "$ZIP" ] || fail "no such file: $ZIP"
mkdir "$T/x"; unzip -q "$ZIP" -d "$T/x"

n=0
while IFS= read -r f; do
  n=$((n + 1))
  if LC_ALL=C grep -q "$(printf '\r')" "$f"; then fail "CRLF line endings in ${f#"$T/x/"}"; fi
done < <(find "$T/x" -type f \( -name '*.sh' -o -name '*.js' -o -name '*.json' -o -name '*.md' -o -name '*.yml' -o -name '*.html' -o -name '*.css' \))
[ "$n" -gt 0 ] || fail "package contains no text files?"
echo "ok:   no CR in $n text files"

for s in "$T"/x/docker/*.sh; do sh -n "$s" || fail "sh -n ${s#"$T/x/"}"; echo "ok:   sh -n ${s#"$T/x/"}"; done
node --check "$T/x/web/addon.js" && echo "ok:   node --check web/addon.js"

ID="$(node -e "process.stdout.write(require('$T/x/addon.json').id)")"
VER="$(node -e "process.stdout.write(require('$T/x/addon.json').version)")"
case "$(basename "$SRC")" in "$ID-$VER.zip"|pkg.zip) ;; *) fail "file name does not match addon.json ($ID-$VER.zip)" ;; esac
echo "ok:   addon.json $ID $VER"

if [ "${WITH_UPGRADE_TEST:-}" = 1 ]; then
  echo "== upgrade regression against the unpacked package"
  ADDON_DIR="$T/x" sh "$HERE/test-upgrade.sh"
fi
echo "PACKAGE OK: $(basename "$SRC")"

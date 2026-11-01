#!/usr/bin/env bash
# Builds the addon package dist/mapviewer3d-<version>.zip and verifies it.
#
#   bash scripts/package.sh <data-v2 checkout> <console checkout>
#
#   <data-v2 checkout>   the pinned data release: git clone --depth 1 --branch data-v2 <this repository>
#   <console checkout>   Red-Blink/dune-awakening-selfhost-docker (MIT): the marker images of its Live Map
#                        and the two map backgrounds are embedded (console/web/public/images/maps)
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$ROOT_DIR"
DATA="${1:?usage: package.sh <data checkout> <console checkout>}"
CONSOLE="${2:?usage: package.sh <data checkout> <console checkout>}"
IMAGES="$CONSOLE/console/web/public/images/maps"

command -v node >/dev/null 2>&1 || { echo "node is required." >&2; exit 1; }
command -v zip >/dev/null 2>&1 || { echo "zip is required to package the addon." >&2; exit 1; }
[ -d node_modules/esbuild ] || npm ci --no-audit --no-fund
[ -d "$IMAGES" ] || { echo "no marker images at $IMAGES" >&2; exit 1; }

node scripts/validate.js
bash scripts/verify-source.sh

ADDON_ID="$(node -e "process.stdout.write(require('./addon.json').id)")"
ADDON_VERSION="$(node -e "process.stdout.write(require('./addon.json').version)")"
PACKAGE_NAME="${ADDON_ID}-${ADDON_VERSION}.zip"

# The package goes to Linux: CRLF in any shipped text file is a build error (Windows checkouts: see .gitattributes).
if grep -rIl $'\r' addon.json README.md; then
  echo "CRLF line endings in the files above. Re-checkout with LF (git add --renormalize .) and run again." >&2
  exit 1
fi

rm -rf dist
mkdir -p dist
node tools/embed-data.mjs "$DATA" "$IMAGES" "$IMAGES" dist/embedded.json
node scripts/build-sandbox.mjs dist/embedded.json dist/package
(cd dist/package && zip -X -r "../${PACKAGE_NAME}" addon.json README.md web -x "*.DS_Store" >/dev/null)
bash scripts/verify-package.sh "dist/${PACKAGE_NAME}"

echo "Created: dist/${PACKAGE_NAME}"

if command -v sha256sum >/dev/null 2>&1; then
  (cd dist && sha256sum "${PACKAGE_NAME}" | tee "${PACKAGE_NAME}.sha256")
elif command -v shasum >/dev/null 2>&1; then
  (cd dist && shasum -a 256 "${PACKAGE_NAME}" | tee "${PACKAGE_NAME}.sha256")
else
  echo "Install sha256sum or shasum to calculate the release hash." >&2
  exit 1
fi

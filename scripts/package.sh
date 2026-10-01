#!/usr/bin/env bash
# Builds the addon package (dist/mapviewer3d-<version>.zip) and checks it.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$ROOT_DIR"

command -v node >/dev/null 2>&1 || { echo "node is required." >&2; exit 1; }
command -v zip >/dev/null 2>&1 || { echo "zip is required to package the addon." >&2; exit 1; }

node scripts/validate.js

ADDON_ID="$(node -e "process.stdout.write(require('./addon.json').id)")"
ADDON_VERSION="$(node -e "process.stdout.write(require('./addon.json').version)")"
PACKAGE_NAME="${ADDON_ID}-${ADDON_VERSION}.zip"

# The package goes to Linux: CRLF in any shipped file is a build error (Windows checkouts: see .gitattributes).
if grep -rIl $'\r' addon.json README.md web; then
  echo "CRLF line endings in the files above. Re-checkout with LF (git add --renormalize .) and run again." >&2
  exit 1
fi

rm -rf dist
mkdir -p dist

zip -X -r "dist/${PACKAGE_NAME}" addon.json README.md web -x "*.DS_Store" >/dev/null
bash scripts/verify-package.sh "dist/${PACKAGE_NAME}"

echo "Created: dist/${PACKAGE_NAME}"

if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "dist/${PACKAGE_NAME}" | tee "dist/${PACKAGE_NAME}.sha256"
elif command -v shasum >/dev/null 2>&1; then
  shasum -a 256 "dist/${PACKAGE_NAME}" | tee "dist/${PACKAGE_NAME}.sha256"
else
  echo "Install sha256sum or shasum to calculate the release hash." >&2
  exit 1
fi

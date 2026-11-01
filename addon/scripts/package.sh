#!/usr/bin/env bash
# Baut das Addon-ZIP (addon.json + web/) und die SHA-256-Prüfsumme nach dist/.
set -euo pipefail
cd "$(dirname "$0")/.."
node scripts/validate.mjs
version="$(tr -d '[:space:]' < ../VERSION)"
mkdir -p ../dist
out="../dist/mapviewer3d-v2-${version}.zip"
rm -f "$out"
zip -X -r "$out" addon.json web >/dev/null
( cd ../dist && shasum -a 256 "mapviewer3d-v2-${version}.zip" > "mapviewer3d-v2-${version}.zip.sha256" )
echo "$out"; cat "../dist/mapviewer3d-v2-${version}.zip.sha256"

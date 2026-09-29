#!/usr/bin/env bash
# Baut den Viewer-Server für alle Systeme vor (linux/arm mit GOARM=6 läuft auf
# jedem 32-Bit-Raspberry-Pi) (nur für Entwickler, braucht Go).
# Anwender brauchen danach kein Go: start.sh / start.command / start.bat wählen
# das passende Programm aus bin/.
#
#   ./build-release.sh          # Programme nach bin/
#   ./build-release.sh --zip    # zusätzlich ../MapViewer3D.zip zum Weitergeben
#                               # (nur nach bestandenem ./check-clean.sh)
set -euo pipefail
cd "$(dirname "$0")"
VERSION=$(sed -n 's/^var Version = "\(.*\)"$/\1/p' backend/server/server.go)
TARGETS="darwin/arm64 darwin/amd64 linux/amd64 linux/arm64 linux/arm windows/amd64 windows/arm64"

mkdir -p bin
for t in $TARGETS; do
  os=${t%/*}; arch=${t#*/}
  out="bin/mapviewer-$os-$arch"; [ "$os" = windows ] && out="$out.exe"
  echo "→ $out"
  (cd backend && CGO_ENABLED=0 GOOS=$os GOARCH=$arch GOARM=6 go build -trimpath \
    -ldflags "-s -w -X mapviewer3d/server.Version=$VERSION" -o "../$out" ./cmd/mapviewer)
done
rm -f bin/mapviewer # alter Einzelbuild

if [ "${1:-}" = "--zip" ]; then
  # Nie ein Paket mit Zugangsdaten bauen
  ./check-clean.sh || { echo "Abbruch: Projektordner nicht sauber, kein Paket gebaut." >&2; exit 1; }
  zip="../MapViewer3D.zip"
  rm -f "$zip"
  # Nur Auslieferungsdateien; state/, paks/ und die Entwicklerskripte
  # (build-release.sh, check-clean.sh) bleiben draußen
  (cd .. && zip -qr "MapViewer3D.zip" \
    MapViewer3D/bin MapViewer3D/data MapViewer3D/viewer MapViewer3D/backend \
    MapViewer3D/start.sh MapViewer3D/start.command MapViewer3D/start.bat \
    MapViewer3D/LICENSE MapViewer3D/README.md MapViewer3D/README.de.md "MapViewer3D/CHANGELOG - DE.md" "MapViewer3D/CHANGELOG - EN.md" MapViewer3D/Description-EN.md \
    -x '*.DS_Store' -x '*/state/*' -x '*/paks/*' -x '*.enc' -x '*/mapimage.png')
  echo "→ $zip ($(du -h "$zip" | cut -f1), Version $VERSION)"
fi

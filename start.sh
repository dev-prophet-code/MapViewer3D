#!/bin/sh
# Dune MapViewer3D Beta.14 - Start fuer macOS und Linux (Windows: start.bat) - ohne Go.
# Das passende Programm liegt vorgebaut in bin/ (fehlt es, wird es von GitHub geladen). Die Karten kommen per Streaming von GitHub. Weitere Argumente gehen an das
# Programm, z. B.:  ./start.sh -addr 0.0.0.0:8795
# ./start.sh --build baut das Programm vorher selbst (braucht Go ≥ 1.26).
# Fehlen nach dem Entpacken die Ausführrechte:  sh start.sh
set -eu
cd "$(dirname "$0")"

fail() { echo "✗ $*" >&2; exit 1; }

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux)  os=linux ;;
  *) fail "Nicht unterstütztes System: $(uname -s) – unter Windows start.bat verwenden." ;;
esac
case "$(uname -m)" in
  x86_64|amd64)          arch=amd64 ;;
  arm64|aarch64)         arch=arm64 ;;
  armv6l|armv7l|armv8l)  arch=arm ;;   # z. B. Raspberry Pi mit 32-Bit-System
  *) fail "Nicht unterstützte CPU: $(uname -m) (vorgebaut: x86_64, arm64, armv6/7). Mit Go selbst bauen: sh start.sh --build" ;;
esac
bin="bin/mapviewer-$os-$arch"

if [ "$os" = darwin ]; then
  # Die vorgebauten Programme brauchen macOS 13 (Ventura) oder neuer
  major=$(sw_vers -productVersion 2>/dev/null | cut -d. -f1)
  if [ -n "$major" ] && [ "$major" -lt 13 ] && [ "${1:-}" != "--build" ]; then
    fail "macOS $(sw_vers -productVersion) ist zu alt – nötig ist macOS 13 oder neuer (oder mit Go selbst bauen: sh start.sh --build)."
  fi
  # Aus dem Internet geladene Dateien sperrt macOS (Gatekeeper), bis die
  # Markierung weg ist – für den ganzen Ordner, damit auch start.command läuft.
  xattr -dr com.apple.quarantine . 2>/dev/null || true
fi

if [ "${1:-}" = "--build" ]; then
  shift
  command -v go >/dev/null || fail "--build braucht Go (https://go.dev/dl/)."
  (cd backend && CGO_ENABLED=0 go build -trimpath -o "../$bin" ./cmd/mapviewer)
fi
# Fehlt das Programm (z. B. weil nur der Quelltext von GitHub entpackt wurde), wird es vom neuesten Release geladen
download_program() {
  REPO="dev-prophet-code/MapViewer3D"
  command -v curl >/dev/null 2>&1 && command -v unzip >/dev/null 2>&1 || return 1
  echo "→ Programm fehlt: lade die neueste Version von GitHub …"
  api=$(curl -fsSL "https://api.github.com/repos/$REPO/releases?per_page=30") || return 1
  url=$(printf '%s' "$api" | grep -o "https://github.com/$REPO/releases/download/[^\"]*/MapViewer3D-update-Beta\.[0-9]*\.zip" \
        | sed 's/.*update-Beta\.\([0-9]*\)\.zip$/\1 &/' | sort -n | tail -1 | cut -d' ' -f2)
  [ -n "$url" ] || return 1
  tmp=$(mktemp -d) || return 1
  curl -fsSL -o "$tmp/u.zip" "$url" && curl -fsSL -o "$tmp/u.sha" "$url.sha256" || { rm -rf "$tmp"; return 1; }
  want=$(cut -d' ' -f1 "$tmp/u.sha")
  if command -v sha256sum >/dev/null 2>&1; then got=$(sha256sum "$tmp/u.zip" | cut -d' ' -f1); else got=$(shasum -a 256 "$tmp/u.zip" | cut -d' ' -f1); fi
  if [ "$want" != "$got" ]; then echo "✗ Prüfsumme des Downloads stimmt nicht – abgebrochen." >&2; rm -rf "$tmp"; return 1; fi
  unzip -q "$tmp/u.zip" -d "$tmp/x" || { rm -rf "$tmp"; return 1; }
  src=$(dirname "$(find "$tmp/x" -path '*/bin/mapviewer-*' | head -1)")
  [ -d "$src" ] || { rm -rf "$tmp"; return 1; }
  mkdir -p bin && cp -R "$src/." bin/ && rm -rf "$tmp"
}
if [ ! -f "$bin" ]; then
  download_program || fail "Programm fehlt: $bin – und der Download von GitHub ging nicht (Internet? curl und unzip nötig). Alternativ das Release-Paket MapViewer3D-Beta.N.zip entpacken oder mit Go bauen: sh start.sh --build"
  [ -f "$bin" ] || fail "Programm fehlt: $bin – das Release enthält es nicht für dieses System."
fi
# Die Karten (data/) braucht es nicht mehr: Der Viewer streamt sie aus dem Branch cdn auf GitHub.

# Ausführrechte gehen beim Entpacken mit manchen Programmen verloren – auch
# für die Skripte, damit start.command danach wieder per Doppelklick geht
chmod +x "$bin" start.sh start.command 2>/dev/null || true

NOEXEC="Der Ordner liegt vermutlich auf einem Laufwerk ohne Ausführrecht (noexec, z. B. /tmp, USB-Stick, Netzlaufwerk) – MapViewer3D z. B. ins Benutzerverzeichnis kopieren und dort starten."
if [ ! -x "$bin" ]; then
  if ls -l "$bin" | cut -c4 | grep -q x; then fail "$bin lässt sich nicht ausführen. $NOEXEC"; fi
  fail "$bin ist nicht ausführbar und die Rechte lassen sich nicht setzen (chmod +x $bin)."
fi

set +e
"./$bin" -open "$@"
code=$?
set -e
[ $code = 126 ] && fail "$bin ließ sich nicht starten. $NOEXEC"
exit $code

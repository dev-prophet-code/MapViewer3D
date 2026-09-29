#!/bin/sh
# Installs the MapViewer3D companion container next to Dune Docker Console.
#
#   sh install.sh
#
# Everything is detected automatically: the console stack folder, the console
# port (ADMIN_BIND_PORT from the stack's .env) and its address. The only thing
# that cannot be automated is the API key, and MapViewer3D does not work without
# it: only a console admin can create keys (Settings -> API Keys). Create one
# with scope maps = Read and bases = Read, all other scopes None.
# You are asked for it once; re-running the script reuses the stored one.
#
# Optional environment variables:
#   STACK_DIR   folder of dune-awakening-selfhost-docker (auto-detected)
#   DATA_DIR    where files live (default: <stack>/runtime/mapviewer3d)
#   API_BASE    console API address (default: http://127.0.0.1:<console port>)
#   API_TOKEN   console API token (asked for if not stored yet)
#   MV_URL / MV_SHA256   release ZIP and checksum (default: pinned release below)
#   MV_ZIP      use an already downloaded ZIP instead of downloading
#   MV_ADDR     address the viewer listens on (default 0.0.0.0:8795; use e.g.
#               192.168.1.5:8795 to expose it on one interface only)
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"

MV_URL="${MV_URL:-https://github.com/dev-prophet-code/MapViewer3D/releases/download/beta.5/MapViewer3D-Beta.5.zip}"
MV_SHA256="${MV_SHA256:-b91f64343ef13fc3dfbdf215d26e9dda41e63033a3989829b39dacc1685d01e8}"

fail() { echo "✗ $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || fail "'$1' is required."; }

need docker
docker compose version >/dev/null 2>&1 || fail "'docker compose' (v2) is required."
need unzip
need curl

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  else fail "sha256sum or shasum is required."; fi
}

# 1. Find the console stack (this addon usually sits inside it) ---------------
is_stack() { [ -f "$1/docker-compose.yml" ] && [ -d "$1/console" ] && [ -d "$1/runtime" ]; }
if [ -z "${STACK_DIR:-}" ]; then
  d="$HERE"
  while [ "$d" != "/" ]; do
    if is_stack "$d"; then STACK_DIR="$d"; break; fi
    d="$(dirname "$d")"
  done
fi
if [ -z "${STACK_DIR:-}" ] && is_stack "$HOME/dune-awakening-selfhost-docker"; then
  STACK_DIR="$HOME/dune-awakening-selfhost-docker"
fi
if [ -n "${STACK_DIR:-}" ]; then
  echo "→ Console stack: $STACK_DIR"
else
  echo "→ Console stack not found; using defaults (set STACK_DIR to override)"
fi

# 2. Console address: port comes from the stack's .env -------------------------
port=8088
if [ -n "${STACK_DIR:-}" ] && [ -f "$STACK_DIR/.env" ]; then
  p="$(sed -n 's/^ADMIN_BIND_PORT=\([0-9][0-9]*\).*/\1/p' "$STACK_DIR/.env" | tail -n 1)"
  [ -n "$p" ] && port="$p"
fi
API_BASE="${API_BASE:-http://127.0.0.1:$port}"
echo "→ Console API: $API_BASE"

# 3. Data folder (outside the addon folder: addon updates replace that one) ----
if [ -z "${DATA_DIR:-}" ]; then
  if [ -n "${STACK_DIR:-}" ]; then DATA_DIR="$STACK_DIR/runtime/mapviewer3d"
  else DATA_DIR="$HOME/.local/share/mapviewer3d"; fi
fi
mkdir -p "$DATA_DIR"
cd "$DATA_DIR"
cp "$HERE/docker-compose.yml" "$HERE/entrypoint.sh" .

# 4. Token: reuse the stored one, otherwise ask once ---------------------------
stored_token=""
if [ -z "${API_TOKEN:-}" ] && [ -f config.json ]; then
  stored_token="$(sed -n 's/.*"token": *"\([^"]*\)".*/\1/p' config.json | head -n 1)"
  [ -n "$stored_token" ] && echo "→ Reusing the API token from $DATA_DIR/config.json"
fi
API_TOKEN="${API_TOKEN:-$stored_token}"
if [ -z "$API_TOKEN" ]; then
  echo
  echo "An API key is REQUIRED - MapViewer3D cannot work without it."
  echo "In Dune Docker Console open Settings -> API Keys and create a key:"
  echo "  name:  MapViewer3D"
  echo "  scope: maps  = Read"
  echo "  scope: bases = Read"
  echo "  all other scopes: None (never Read+write)"
  echo "The key is shown only once - paste it here."
  printf 'API key (dak_...): '
  stty -echo 2>/dev/null || true
  read -r API_TOKEN
  stty echo 2>/dev/null || true
  echo
fi
case "$API_TOKEN" in
  dak_?*) ;;
  *) fail "That does not look like a console API key (expected dak_...)." ;;
esac
case "$API_TOKEN$API_BASE" in
  *\"*|*\\*) fail "Key and address must not contain quotes or backslashes." ;;
esac

# Check the key before starting anything
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
  -H "Authorization: Bearer $API_TOKEN" "$API_BASE/api/map/partitions" || true)"
case "$code" in
  200) echo "✓ Console accepted the key" ;;
  401|403) fail "The console rejected the key (HTTP $code). Check the key and that it has maps = Read and bases = Read." ;;
  000) fail "Console not reachable at $API_BASE. Is it running? Set API_BASE if it uses another address." ;;
  *) fail "Unexpected answer from the console (HTTP $code) at $API_BASE/api/map/partitions." ;;
esac

# 5. Program and terrain data --------------------------------------------------
if [ -d app/bin ] && [ -d app/data ]; then
  echo "→ MapViewer3D files already present in $DATA_DIR/app (delete it to reinstall)"
else
  zip="${MV_ZIP:-}"
  if [ -z "$zip" ]; then
    zip="$(mktemp -t mapviewer3d.XXXXXX)"
    trap 'rm -f "$zip"' EXIT
    echo "→ Downloading MapViewer3D (about 170 MB)…"
    curl --fail --location --progress-bar --output "$zip" "$MV_URL"
  fi
  actual="$(sha256_of "$zip")"
  [ "$actual" = "$MV_SHA256" ] || fail "Checksum mismatch for the MapViewer3D ZIP (got $actual)."
  echo "→ Unpacking…"
  rm -rf app.tmp && mkdir app.tmp
  unzip -q "$zip" -d app.tmp
  # The package has either a single top-level folder (MapViewer3D/) or is flat
  src=app.tmp
  if [ ! -d "$src/bin" ] && [ "$(ls -A app.tmp | wc -l | tr -d ' ')" = 1 ] && [ -d "app.tmp/$(ls -A app.tmp)" ]; then
    src="app.tmp/$(ls -A app.tmp)"
  fi
  [ -d "$src/bin" ] && [ -d "$src/data" ] && [ -d "$src/viewer" ] || fail "The ZIP does not look like a MapViewer3D package."
  mv "$src" app
  rm -rf app.tmp
fi

# 6. Config (private: contains the key) and start ------------------------------
umask 077
printf '{\n  "apiBase": "%s",\n  "token": "%s"\n}\n' "$API_BASE" "$API_TOKEN" > config.json
printf 'MV_UID=%s\nMV_GID=%s\nMV_ADDR=%s\n' "$(id -u)" "$(id -g)" "${MV_ADDR:-0.0.0.0:8795}" > .env
docker compose up -d
echo
echo "✓ MapViewer3D is running on ${MV_ADDR:-0.0.0.0:8795}."
echo "  Anyone who can reach that port sees player names and positions: restrict it"
echo "  with a firewall or MV_ADDR (see README, section Security)."
echo "  Open the '3D Map' entry in Dune Docker Console (or http://<server>:8795)."

#!/bin/sh
# Installs the MapViewer3D companion container next to Dune Docker Console.
#
#   sh install.sh
#
# Everything is detected automatically: the console stack folder and the
# console address (ADMIN_BIND_HOST / ADMIN_BIND_PORT / ADMIN_WEB_PORT from the
# stack's .env, including ADMIN_BIND_HOST=auto). The only thing
# that cannot be automated is the API key, and MapViewer3D does not work without
# it: only a console admin can create keys (Settings -> API Keys). Create one
# with scope maps = Read and bases = Read, all other scopes None.
# You are asked for it once; re-running the script reuses the stored one.
#
# Optional environment variables:
#   STACK_DIR   folder of dune-awakening-selfhost-docker (auto-detected)
#   DATA_DIR    where files live (default: <stack>/runtime/mapviewer3d)
#   API_BASE    console API address (default: detected, see step 2)
#   API_TOKEN   console API token (asked for if not stored yet)
#   MV_URL / MV_SHA256   release ZIP and checksum (default: pinned release below).
#               Viewer files that are not exactly this release (an older viewer
#               from an earlier addon version, or unknown files) are replaced;
#               config.json (key, password) and extra terrain under data/ stay.
#   MV_ZIP      use an already downloaded ZIP instead of downloading
#   MV_ADDR     address the viewer listens on. Default 127.0.0.1:8795 (private:
#               only browsers on this machine). A network address such as
#               0.0.0.0:8795 or 192.168.1.5:8795 is an explicit opt-in; the
#               installer then sets a viewer password (login in the browser).
#   MV_PASSWORD viewer password for network operation (default: generated,
#               stored in config.json, shown once)
#   MV_ALLOW_OPEN=1  network address WITHOUT any password (not recommended)
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"

MV_VERSION="Beta.8"
MV_URL="${MV_URL:-https://github.com/dev-prophet-code/MapViewer3D/releases/download/beta.8/MapViewer3D-Beta.8.zip}"
MV_SHA256="${MV_SHA256:-16a7db212130aaa149790703dd1646f0a2678ffcc0afb17d9b47d8eb70657400}"

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

# 2. Console address ------------------------------------------------------------
# The stack's .env decides where the console listens: ADMIN_BIND_HOST is an
# address, 0.0.0.0, or "auto" (= the machine's LAN address, NOT 127.0.0.1);
# ADMIN_WEB_PORT, if set, overrides ADMIN_BIND_PORT. Environment wins over .env.
env_get() { # env_get NAME -> value from the environment, else the stack's .env
  eval "v=\${$1:-}"
  if [ -z "$v" ] && [ -n "${STACK_DIR:-}" ] && [ -f "$STACK_DIR/.env" ]; then
    v="$(sed -n "s/^$1=[\"']*\([^\"' #]*\).*/\1/p" "$STACK_DIR/.env" | tail -n 1)"
  fi
  printf '%s' "$v"
}
lan_addrs() { # this machine's IPv4 addresses, most likely first
  {
    ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p'
    hostname -I 2>/dev/null | tr ' ' '\n'
    ifconfig 2>/dev/null | sed -n 's/.*inet \([0-9.]*\) .*/\1/p'
  } | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | grep -v '^127\.' | awk '!seen[$0]++'
}
# http code of an unauthenticated request: any answer (401 too) means "console is there"
probe() { curl -s -o /dev/null -w '%{http_code}' --max-time 4 "$1/api/map/partitions" 2>/dev/null || true; }

if [ -z "${API_BASE:-}" ]; then
  bind_host="$(env_get ADMIN_BIND_HOST)"
  port="$(env_get ADMIN_WEB_PORT)"
  [ -n "$port" ] || port="$(env_get ADMIN_BIND_PORT)"
  case "$port" in ''|*[!0-9]*) port=8088 ;; esac
  case "$bind_host" in
    ''|auto|0.0.0.0|::|'[::]') candidates="127.0.0.1 $(lan_addrs | tr "\n" " ")" ;;
    localhost) candidates="127.0.0.1" ;;
    *) candidates="$bind_host" ;;
  esac
  echo "→ Looking for the console (ADMIN_BIND_HOST=${bind_host:-unset}, port $port)"
  for h in $candidates; do
    c="$(probe "http://$h:$port")"
    if [ -n "$c" ] && [ "$c" != 000 ]; then API_BASE="http://$h:$port"; break; fi
  done
  if [ -z "${API_BASE:-}" ]; then
    fail "Console not reachable on port $port (tried: $candidates). Is it running? Set API_BASE=http://<address>:<port> to use another address."
  fi
fi
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

# The key never goes into a command line (visible to other users in `ps`):
# curl reads the header from a config on stdin.
api_code() { # api_code PATH -> HTTP status with the key
  printf 'header = "Authorization: Bearer %s"\n' "$API_TOKEN" |
    curl -s -o /dev/null -w '%{http_code}' --max-time 10 -K - "$API_BASE$1" 2>/dev/null || true
}

# Check the key and BOTH scopes before starting anything
code="$(api_code /api/map/partitions)"
case "$code" in
  200) echo "✓ Console accepted the key (maps: Read)" ;;
  401) fail "The console rejected the key (HTTP 401). Check that you pasted the whole dak_... key." ;;
  403) fail "The key lacks the scope maps = Read (HTTP 403). Edit it under Settings -> API Keys." ;;
  000|'') fail "Console not reachable at $API_BASE. Is it running? Set API_BASE if it uses another address." ;;
  *) fail "Unexpected answer from the console (HTTP $code) at $API_BASE/api/map/partitions." ;;
esac
# bases: Read needed for the 3D buildings. An unknown base id answers 404/400
# when the scope is present and 403 when it is missing.
code="$(api_code /api/bases/0/export)"
case "$code" in
  403) fail "The key lacks the scope bases = Read (HTTP 403). Edit it under Settings -> API Keys (maps = Read AND bases = Read)." ;;
  401) fail "The console rejected the key for /api/bases (HTTP 401)." ;;
  000|'') fail "Console did not answer the bases check at $API_BASE." ;;
  *) echo "✓ Key has bases: Read" ;;
esac

# Viewer address and password ---------------------------------------------------
# Default is private: only browsers on this machine can open the viewer.
# A network address is an explicit opt-in and needs a viewer password.
MV_ADDR="${MV_ADDR:-127.0.0.1:8795}"
case "${MV_ADDR%:*}" in
  127.*|localhost|'[::1]'|::1) private=1 ;;
  *) private=0 ;;
esac
stored_pw=""
[ -f config.json ] && stored_pw="$(sed -n 's/.*"viewerPassword": *"\([^"]*\)".*/\1/p' config.json | head -n 1)"
VIEWER_PW=""; new_pw=0
if [ "$private" = 0 ]; then
  if [ "${MV_ALLOW_OPEN:-}" = 1 ]; then
    echo "! MV_ALLOW_OPEN=1: the viewer will be open WITHOUT a password on $MV_ADDR."
  else
    VIEWER_PW="${MV_PASSWORD:-$stored_pw}"
    if [ -z "$VIEWER_PW" ]; then
      VIEWER_PW="$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 20)"
      new_pw=1
    fi
    case "$VIEWER_PW" in *[!A-Za-z0-9._@%+=-]*|'') fail "MV_PASSWORD may only contain letters, digits and . _ @ % + = -" ;; esac
  fi
fi

# 5. Program and terrain data --------------------------------------------------
# The viewer files must be exactly the pinned release. A viewer from before
# Beta.7 ignores the password setting, so an old install must never be reused:
# an upgrade would look protected while the viewer stayed open. The release that
# was unpacked is recorded in app/.mapviewer3d-release; anything else (older
# release, no record, half-finished install) is replaced.
release_id="$MV_VERSION $MV_SHA256"
if [ -f app/.mapviewer3d-release ] && [ "$(cat app/.mapviewer3d-release)" = "$release_id" ] \
   && [ -d app/bin ] && [ -d app/data ] && [ -d app/viewer ]; then
  echo "→ MapViewer3D $MV_VERSION already installed in $DATA_DIR/app"
else
  if [ -d app ]; then
    echo "→ Viewer files in $DATA_DIR/app are not $MV_VERSION: upgrading (config.json is kept)"
  fi
  zip="${MV_ZIP:-}"
  if [ -z "$zip" ]; then
    zip="$(mktemp -t mapviewer3d.XXXXXX)"
    trap 'rm -f "$zip"' EXIT
    echo "→ Downloading MapViewer3D $MV_VERSION (about 250 MB)…"
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
  # Stop a running (possibly old) viewer before its files are swapped
  docker compose down >/dev/null 2>&1 || true
  rm -rf app.old
  if [ -d app ]; then mv app app.old; fi
  mv "$src" app
  printf '%s\n' "$release_id" > app/.mapviewer3d-release
  # Keep terrain folders of the old install that the new package does not have
  if [ -d app.old/data ]; then
    for d in app.old/data/*/; do
      [ -d "$d" ] || continue
      n="$(basename "$d")"
      [ -e "app/data/$n" ] || mv "$d" "app/data/$n"
    done
  fi
  rm -rf app.old app.tmp
fi

# 6. Config (private: contains the key and password) and start ----------------
umask 077
{
  printf '{\n  "apiBase": "%s",\n  "token": "%s"' "$API_BASE" "$API_TOKEN"
  [ -n "$VIEWER_PW" ] && printf ',\n  "viewerPassword": "%s"' "$VIEWER_PW"
  printf '\n}\n'
} > config.json
printf 'MV_UID=%s\nMV_GID=%s\nMV_ADDR=%s\nMV_ALLOW_OPEN=%s\n' "$(id -u)" "$(id -g)" "$MV_ADDR" "${MV_ALLOW_OPEN:-}" > .env
docker compose up -d

# Before reporting success (and leaving a network address open), check that the
# running viewer really enforces the password: no login -> 401, password -> 200.
# On any other answer the container is stopped again.
if [ -n "$VIEWER_PW" ]; then
  vhost="${MV_ADDR%:*}"
  case "$vhost" in 0.0.0.0|::|'[::]'|'') vhost=127.0.0.1 ;; esac
  vurl="http://$vhost:${MV_ADDR##*:}/"
  no_login=000; tries=0
  while [ "$tries" -lt "${MV_VERIFY_WAIT:-30}" ]; do
    no_login="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$vurl" 2>/dev/null || true)"
    case "$no_login" in 000|'') tries=$((tries + 1)); sleep 1 ;; *) break ;; esac
  done
  with_login="$(printf 'user = "mapviewer:%s"\n' "$VIEWER_PW" |
    curl -s -o /dev/null -w '%{http_code}' --max-time 5 -K - "$vurl" 2>/dev/null || true)"
  if [ "$no_login" != 401 ] || [ "$with_login" != 200 ]; then
    docker compose down >/dev/null 2>&1 || true
    fail "The viewer did not enforce its password (no login: HTTP $no_login, with password: HTTP $with_login; expected 401 and 200). It was stopped, nothing is exposed. Delete $DATA_DIR/app and run the installer again."
  fi
  echo "✓ Viewer password verified (no login: 401, with password: 200)"
fi
echo
echo "✓ MapViewer3D is running on $MV_ADDR."
if [ "$private" = 1 ]; then
  echo "  Private: only browsers on this machine can open it. To let other computers use it,"
  echo "  re-run with MV_ADDR=0.0.0.0:8795 (a viewer password is then set)."
elif [ -n "$VIEWER_PW" ]; then
  echo "  Login: any user name, password stored in $DATA_DIR/config.json"
  [ "$new_pw" = 1 ] && echo "  New password: $VIEWER_PW  (shown once; keep it safe)"
  echo "  Browsers ask for it when they open http://<server>:${MV_ADDR##*:}."
fi

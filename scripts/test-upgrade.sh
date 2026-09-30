#!/bin/sh
# Upgrade regression test for docker/install.sh (Linux, needs curl, unzip, node).
#
#   sh scripts/test-upgrade.sh
#
# Scenario: the machine has a viewer from an OLDER addon (viewer Beta.6, which
# ignores the password setting). The installer is run with a network address.
# It must replace the old viewer, keep config.json, and afterwards
#   - a request without login must get 401,
#   - a request with the password must succeed (200).
# This is checked independently of the installer's own check, and a second run
# with a lying install (Beta.8 marker, Beta.6 program) must fail closed.
#
# docker is replaced by a shim that runs docker/entrypoint.sh on the host, so the
# REAL viewer programs of both releases are started.
#
# Optional: ADDON_DIR (test an unpacked release package instead of this checkout), OLD_URL / OLD_SHA256 (the old viewer), CACHE_DIR (keeps downloads).
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
ADDON="${ADDON_DIR:-$(dirname "$HERE")}"   # ADDON_DIR: an unpacked release ZIP (see verify-package.sh)

OLD_URL="${OLD_URL:-https://github.com/dev-prophet-code/MapViewer3D/releases/download/beta.6/MapViewer3D-Beta.6.zip}"
OLD_SHA256="${OLD_SHA256:-529ee65cbeae0e972deb21e9c5985a971700df032b4c9232b7b7416e6c6aa89e}"
# The new viewer is the one the installer pins
pinned() { sed -n "s/^$1=\"\${$1:-\(.*\)}\"\$/\1/p" "$ADDON/docker/install.sh" | head -n 1; }
NEW_URL="$(pinned MV_URL)"; NEW_SHA256="$(pinned MV_SHA256)"
NEW_VERSION="$(sed -n 's/^MV_VERSION="\(.*\)"$/\1/p' "$ADDON/docker/install.sh" | head -n 1)"
[ -n "$NEW_URL" ] && [ -n "$NEW_SHA256" ] && [ -n "$NEW_VERSION" ] || { echo "cannot read the pinned release from install.sh" >&2; exit 1; }

case "$(uname -m)" in x86_64|amd64) ;; *) echo "test needs an amd64 Linux host" >&2; exit 1 ;; esac
[ "$(uname -s)" = Linux ] || { echo "test needs Linux" >&2; exit 1; }

T="$(mktemp -d)"
CACHE="${CACHE_DIR:-$T/cache}"; mkdir -p "$CACHE"
PIDS=""
cleanup() {
  [ -f "$T/data/pidfile" ] && kill "$(cat "$T/data/pidfile")" 2>/dev/null || true
  for p in $PIDS; do kill "$p" 2>/dev/null || true; done
  rm -rf "$T"
}
trap cleanup EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "ok:   $*"; }
sha256_of() { sha256sum "$1" | cut -d' ' -f1; }
code() { curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$@" 2>/dev/null || true; }
wait_http() { # wait_http URL  (any HTTP answer)
  i=0
  while [ "$i" -lt 40 ]; do
    c="$(code "$1")"; [ -n "$c" ] && [ "$c" != 000 ] && return 0
    i=$((i + 1)); sleep 1
  done
  return 1
}
fetch() { # fetch URL SHA256 -> path
  f="$CACHE/$2.zip"
  if [ ! -f "$f" ] || [ "$(sha256_of "$f")" != "$2" ]; then
    curl --fail --location --silent --show-error --output "$f" "$1"
  fi
  [ "$(sha256_of "$f")" = "$2" ] || fail "checksum of $1"
  printf '%s' "$f"
}

echo "== fetching viewers (old: Beta.6, new: $NEW_VERSION)"
OLD_ZIP="$(fetch "$OLD_URL" "$OLD_SHA256")"
NEW_ZIP="$(fetch "$NEW_URL" "$NEW_SHA256")"

PORT_MOCK=18088; PORT_VIEWER=18795; PORT_CONTROL=18796
PW="ci-test-password"; TOKEN="dak_ci_test_key"
DATA="$T/data"; mkdir -p "$DATA" "$T/bin"

node "$HERE/mock-console.js" "$PORT_MOCK" >"$T/mock.log" 2>&1 &
PIDS="$PIDS $!"

# docker shim: `compose up -d` runs entrypoint.sh on the host, `compose down` stops it
cat >"$T/bin/docker" <<'SHIM'
#!/bin/sh
[ "${1:-}" = compose ] || exit 1
shift
case "${1:-}" in
  version) echo "Docker Compose version v2.0.0-test-shim" ;;
  down) if [ -f pidfile ]; then kill "$(cat pidfile)" 2>/dev/null || true; rm -f pidfile; sleep 1; fi ;;
  up)
    . ./.env
    mkdir -p run
    MV_APP_DIR="$PWD/app" MV_CONFIG="$PWD/config.json" MV_TMP_DIR="$PWD/run" \
      MV_ADDR="$MV_ADDR" MV_ALLOW_OPEN="${MV_ALLOW_OPEN:-}" \
      sh ./entrypoint.sh >viewer.log 2>&1 &
    echo $! >pidfile ;;
  *) exit 1 ;;
esac
SHIM
chmod +x "$T/bin/docker"

echo "== state of an older installation: viewer Beta.6, private, no password"
unzip -q "$OLD_ZIP" -d "$T/old"
mv "$T/old/MapViewer3D" "$DATA/app"
mkdir -p "$DATA/app/data/my_own_terrain" && echo keep >"$DATA/app/data/my_own_terrain/marker"
printf '{\n  "apiBase": "http://127.0.0.1:%s",\n  "token": "%s"\n}\n' "$PORT_MOCK" "$TOKEN" >"$DATA/config.json"
"$DATA/app/bin/mapviewer-linux-amd64" -version | grep -q 'Beta.6' || fail "old viewer is not Beta.6"

echo "== sanity: the old viewer really ignores a password (this is the reported hole)"
printf '{\n  "apiBase": "http://127.0.0.1:%s",\n  "token": "%s",\n  "viewerPassword": "%s"\n}\n' "$PORT_MOCK" "$TOKEN" "$PW" >"$T/old-with-pw.json"
mkdir -p "$T/ctl"
"$DATA/app/bin/mapviewer-linux-amd64" -addr "127.0.0.1:$PORT_CONTROL" -data "$DATA/app/data" -web "$DATA/app/viewer" \
  -config "$T/old-with-pw.json" -no-local-admin -state "$T/ctl/state" -keydir "$T/ctl/key" -open=false >"$T/ctl.log" 2>&1 &
CTL=$!; PIDS="$PIDS $CTL"
wait_http "http://127.0.0.1:$PORT_CONTROL/" || fail "old viewer did not start"
[ "$(code "http://127.0.0.1:$PORT_CONTROL/")" = 200 ] || fail "expected the old viewer to serve without login (test premise)"
pass "Beta.6 serves without login although a password is configured"
kill "$CTL" 2>/dev/null || true

echo "== upgrade: run the installer with a network address"
run_install() {
  ( cd "$T" && PATH="$T/bin:$PATH" DATA_DIR="$DATA" API_BASE="http://127.0.0.1:$PORT_MOCK" API_TOKEN="$TOKEN" \
    MV_ADDR="0.0.0.0:$PORT_VIEWER" MV_PASSWORD="$PW" MV_ZIP="$NEW_ZIP" MV_SHA256="$NEW_SHA256" \
    MV_VERIFY_WAIT="${MV_VERIFY_WAIT:-30}" HOME="$T/home" sh "$ADDON/docker/install.sh" )
}
mkdir -p "$T/home"
run_install >"$T/install.log" 2>&1 || { cat "$T/install.log"; [ -f "$DATA/viewer.log" ] && cat "$DATA/viewer.log"; fail "installer failed on upgrade"; }
pass "installer finished"

URL="http://127.0.0.1:$PORT_VIEWER/"
[ "$(code "$URL")" = 401 ] || fail "unauthenticated request: expected 401, got $(code "$URL")"
pass "unauthenticated request -> 401"
[ "$(code -u "any:$PW" "$URL")" = 200 ] || fail "authenticated request: expected 200, got $(code -u "any:$PW" "$URL")"
pass "authenticated request -> 200"
[ "$(code -u "any:wrong" "$URL")" = 401 ] || fail "wrong password should get 401"
pass "wrong password -> 401"
[ "$(code "${URL}api/maps")" = 401 ] || fail "API without login should get 401"
pass "API without login -> 401"

"$DATA/app/bin/mapviewer-linux-amd64" -version | grep -q "$NEW_VERSION" || fail "program is not $NEW_VERSION after the upgrade"
[ "$(cat "$DATA/app/.mapviewer3d-release")" = "$NEW_VERSION $NEW_SHA256" ] || fail "release marker not written"
[ ! -e "$DATA/app.old" ] && [ ! -e "$DATA/app.tmp" ] || fail "leftover app.old/app.tmp"
[ -f "$DATA/app/data/my_own_terrain/marker" ] || fail "extra terrain folder was lost"
grep -q "\"token\": \"$TOKEN\"" "$DATA/config.json" || fail "API key lost from config.json"
grep -q "\"apiBase\": \"http://127.0.0.1:$PORT_MOCK\"" "$DATA/config.json" || fail "console address lost from config.json"
grep -q "\"viewerPassword\": \"$PW\"" "$DATA/config.json" || fail "viewer password missing from config.json"
pass "program is $NEW_VERSION; config.json, API key and extra terrain kept"

echo "== fail closed: a lying install (release marker $NEW_VERSION, program Beta.6) must not stay up"
kill "$(cat "$DATA/pidfile")" 2>/dev/null || true; rm -f "$DATA/pidfile"; sleep 1
unzip -q -o -j "$OLD_ZIP" 'MapViewer3D/bin/mapviewer-linux-amd64' -d "$T/oldbin"
cp "$T/oldbin/mapviewer-linux-amd64" "$DATA/app/bin/mapviewer-linux-amd64"; chmod +x "$DATA/app/bin/mapviewer-linux-amd64"
if MV_VERIFY_WAIT=4 run_install >"$T/install2.log" 2>&1; then
  cat "$T/install2.log"; fail "installer reported success with an old program behind a new marker"
fi
[ ! -f "$DATA/pidfile" ] || fail "container was left running"
[ "$(code "$URL")" != 200 ] || fail "viewer is reachable without login"
pass "installer failed and nothing answers on the network address"

echo "All upgrade checks passed."

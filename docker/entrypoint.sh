#!/bin/sh
# Starts the pre-built MapViewer3D program that matches this CPU.
# Paths default to the container layout; scripts/test-upgrade.sh overrides them.
set -eu

APP="${MV_APP_DIR:-/app}"
CONFIG="${MV_CONFIG:-/config/config.json}"
TMP="${MV_TMP_DIR:-/tmp}"
ADDR="${MV_ADDR:-127.0.0.1:8795}"

case "$(uname -m)" in
  x86_64|amd64)         arch=amd64 ;;
  aarch64|arm64)        arch=arm64 ;;
  armv6l|armv7l|armv8l) arch=arm ;;
  *) echo "Unsupported CPU: $(uname -m)" >&2; exit 1 ;;
esac

bin="$APP/bin/mapviewer-linux-$arch"
[ -x "$bin" ] || { echo "Missing or not executable: $bin" >&2; exit 1; }

# Password comes from config.json (viewerPassword). Without one the viewer only
# starts on a network address when MV_ALLOW_OPEN=1.
allow=""
[ "${MV_ALLOW_OPEN:-}" = 1 ] && allow="-allow-open"

# A network address must never run with a viewer that predates the password
# (Beta.6 and older ignore it and would serve everything without a login).
case "${ADDR%:*}" in
  127.*|localhost|'[::1]'|::1) ;;
  *)
    if [ -z "$allow" ]; then
      grep -q '"viewerPassword"' "$CONFIG" 2>/dev/null ||
        { echo "Network address $ADDR needs viewerPassword in config.json (or MV_ALLOW_OPEN=1)." >&2; exit 1; }
      ver="$("$bin" -version 2>/dev/null | sed -n 's/.*Beta\.\([0-9][0-9]*\).*/\1/p' | head -n 1)"
      case "$ver" in ''|*[!0-9]*) ver=0 ;; esac
      [ "$ver" -ge 7 ] ||
        { echo "The installed viewer is older than Beta.7 and ignores the password. Re-run install.sh to upgrade it." >&2; exit 1; }
    fi ;;
esac

# shellcheck disable=SC2086
exec "$bin" $allow \
  -addr "$ADDR" \
  -data "$APP/data" \
  -web "$APP/viewer" \
  -config "$CONFIG" \
  -no-local-admin \
  -state "$TMP/state" \
  -keydir "$TMP/key" \
  -open=false

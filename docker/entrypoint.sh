#!/bin/sh
# Starts the pre-built MapViewer3D program that matches this CPU.
set -eu

case "$(uname -m)" in
  x86_64|amd64)         arch=amd64 ;;
  aarch64|arm64)        arch=arm64 ;;
  armv6l|armv7l|armv8l) arch=arm ;;
  *) echo "Unsupported CPU: $(uname -m)" >&2; exit 1 ;;
esac

bin="/app/bin/mapviewer-linux-$arch"
[ -x "$bin" ] || { echo "Missing or not executable: $bin" >&2; exit 1; }

# Password comes from config.json (viewerPassword). Without one the viewer only
# starts on a network address when MV_ALLOW_OPEN=1.
allow=""
[ "${MV_ALLOW_OPEN:-}" = 1 ] && allow="-allow-open"

# shellcheck disable=SC2086
exec "$bin" $allow \
  -addr "${MV_ADDR:-127.0.0.1:8795}" \
  -data /app/data \
  -web /app/viewer \
  -config /config/config.json \
  -no-local-admin \
  -state /tmp/state \
  -keydir /tmp/key \
  -open=false

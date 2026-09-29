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

exec "$bin" \
  -addr "${MV_ADDR:-0.0.0.0:8795}" \
  -data /app/data \
  -web /app/viewer \
  -config /config/config.json \
  -no-local-admin \
  -state /tmp/state \
  -keydir /tmp/key \
  -open=false

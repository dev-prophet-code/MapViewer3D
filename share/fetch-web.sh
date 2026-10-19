#!/bin/sh
# Downloads the MapViewer3D addon release and unpacks its viewer files (web/) into ./share-web for the
# share gateway. The zip is verified against a SHA-256 before anything is unpacked.
#
#   share/fetch-web.sh                        the version and checksum pinned below
#   share/fetch-web.sh <version> <sha256>     another release (checksum from its release page)
#
# Re-run it after an addon update; no restart of the gateway is needed.
set -eu
VERSION="${1:-0.4.0}"
SHA256="${2:-REPLACE_WITH_RELEASE_SHA256}"
OUT="${MV_SHARE_WEB:-./share-web}"
URL="https://github.com/dev-prophet-code/MapViewer3D/releases/download/addon-v${VERSION}/mapviewer3d-${VERSION}.zip"

case "$SHA256" in *[!0-9a-f]*|"") echo "give the release's SHA-256 (64 hex characters)" >&2; exit 1 ;; esac
[ "${#SHA256}" -eq 64 ] || { echo "give the release's SHA-256 (64 hex characters)" >&2; exit 1; }
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
curl -fsSL -o "$tmp/addon.zip" "$URL"
got="$( (sha256sum "$tmp/addon.zip" 2>/dev/null || shasum -a 256 "$tmp/addon.zip") | cut -d' ' -f1)"
[ "$got" = "$SHA256" ] || { echo "checksum mismatch: got $got" >&2; exit 1; }
unzip -q "$tmp/addon.zip" -d "$tmp/x"
[ -f "$tmp/x/web/index.html" ] || { echo "the zip has no web/index.html" >&2; exit 1; }
rm -rf "$OUT.new"
mv "$tmp/x/web" "$OUT.new"
rm -rf "$OUT"
mv "$OUT.new" "$OUT"
echo "viewer files for addon $VERSION are in $OUT"

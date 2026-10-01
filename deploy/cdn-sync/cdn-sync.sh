#!/usr/bin/env bash
# Hält den Branch `cdn` (Kartendaten, die der Viewer streamt) aktuell.
# Keeps the `cdn` branch (map data the viewer streams) up to date.
#
# Läuft zeitgesteuert (mapviewer-cdn-sync.timer) als root auf dem Server, der den Dune-Docker-Stack betreibt:
#   1. Karten des laufenden Viewers (z. B. selbst gebaute Coriolis-Layouts) in Kacheln schneiden und neue pushen.
#   2. Hat sich der Build des Spiels geändert (Pak-Dateien im Spielserver-Container), alle Karten, Layouts und
#      Bauteile neu aus den Spieldateien extrahieren, schneiden und pushen.
# Kacheln heißen nach ihrem Inhalts-Hash und werden nie gelöscht: Was gleich bleibt, kostet keinen Platz,
# ohne Änderung entsteht kein Commit. Einrichtung: docs/CDN-Sync-DE.md
set -euo pipefail

# Einstellungen aus /etc/mapviewer-cdn.env (siehe cdn-sync.env.example)
[ -f /etc/mapviewer-cdn.env ] && . /etc/mapviewer-cdn.env
BIN="${BIN:-/opt/mapviewer-cdn}"                 # cdnsync und extract
WORK="${WORK:-/var/lib/mapviewer-cdn}"           # Arbeitsordner (Klon, Zustand, extrahierte Karten)
REPO="${REPO:-$WORK/repo}"                       # Arbeitskopie des Branches cdn
DATA_LIVE="${DATA_LIVE:-}"                       # data/ des laufenden Viewers (leer = überspringen)
CLONE_URL="${CLONE_URL:-git@github.com:dev-prophet-code/MapViewer3D.git}"
export GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh -i $BIN/deploy_key -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new}"
PUSH_FLAG="-push"; [ "${DRY_RUN:-0}" = 1 ] && PUSH_FLAG=""

mkdir -p "$WORK"
exec 9>"$WORK/lock"
flock -n 9 || { echo "läuft schon"; exit 0; }

log() { echo "$(date '+%F %T') $*"; }

# 1. Karten des laufenden Viewers
if [ -n "$DATA_LIVE" ] && [ -d "$DATA_LIVE" ]; then
  log "Viewer-Daten packen ($DATA_LIVE)"
  "$BIN/cdnsync" -data "$DATA_LIVE" -repo "$REPO" -clone "$CLONE_URL" -state "$WORK/state-live.json" $PUSH_FLAG -message "Data update (viewer data)"
fi

[ "${SKIP_EXTRACT:-0}" = 1 ] && exit 0

# 2. Neuer Spielbuild? Die Pak-Dateien liegen im Spielserver-Container, erreichbar über /proc/<pid>/root.
pid=$(pgrep -f '^[^ ]*DuneSandboxServer-Linux-Shipping DuneSandbox' | head -1 || true)
if [ -z "$pid" ]; then log "kein Spielserver-Prozess gefunden, überspringe die Extraktion"; exit 0; fi
PAKS="/proc/$pid/root/home/dune/server/DuneSandbox/Content/Paks"
[ -d "$PAKS" ] || { log "keine Paks unter $PAKS"; exit 0; }
sig=$(cd "$PAKS" && stat -L -c '%n %s %Y' *.utoc *.ucas *.pak 2>/dev/null | sort | sha256sum | cut -c1-16)
old=$(cat "$WORK/paks.sig" 2>/dev/null || true)
if [ "$sig" = "$old" ] && [ ! -e "$WORK/force" ]; then
  log "Spielbuild unverändert ($sig)"
  exit 0
fi
log "Spielbuild $old -> $sig: extrahiere Karten, Layouts und Bauteile (dauert ca. 20-30 Minuten)"
mkdir -p "$WORK/data"
nice -n 15 ionice -c3 "$BIN/extract" -paks "$PAKS" -out "$WORK/data" -state /nonexistent -layout all
"$BIN/cdnsync" -data "$WORK/data" -repo "$REPO" -clone "$CLONE_URL" -state "$WORK/state-extract.json" $PUSH_FLAG -message "Data update (game build $sig)"
echo "$sig" > "$WORK/paks.sig"
rm -f "$WORK/force"
log "fertig"

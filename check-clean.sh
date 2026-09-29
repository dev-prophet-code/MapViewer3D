#!/bin/sh
# Prüft, ob der Projektordner im Auslieferungszustand ist: keine Zugangsdaten,
# keine Instanznamen, keine Zwischenspeicher vom eigenen (Test-)Server.
# Läuft automatisch in build-release.sh; Rückgabe 1 = nicht weitergeben.
cd "$(dirname "$0")"
found=0
report() { echo "✗ $1"; found=1; }

[ -e state ] && report "state/ (Zugangsdaten/Einstellungen einer älteren Version)"
for f in $(find . -path ./paks -prune -o \( -name 'credentials.enc' -o -name 'master.key' -o -name 'config.json' \
    -o -name 'instance-names.json' -o -name 'mapimage.png' -o -name '*.enc' -o -name '*.tmp' \) -print); do
  report "$f"
done
# API-Token der Console im Klartext (dak_…) in Text- oder Programmdateien
for f in $(grep -rlE 'dak_[A-Za-z0-9]{10,}' --exclude-dir=paks --exclude-dir=.git . 2>/dev/null); do
  report "$f enthält einen API-Token"
done

if [ $found = 0 ]; then
  echo "✓ Projektordner sauber – keine Zugangsdaten enthalten"
else
  echo "Diese Dateien vor dem Weitergeben entfernen (der Viewer speichert Zugangsdaten im Benutzerordner)."
  exit 1
fi

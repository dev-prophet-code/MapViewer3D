# Den Branch `cdn` aktuell halten (`deploy/cdn-sync`)

Der Viewer streamt Gelände-Kacheln und Bauteil-Modelle aus dem **Branch `cdn`** dieses Repositorys (siehe [README](../README.de.md)).
Der Branch entsteht aus den Spieldateien und muss dem Spiel folgen: nach einem Spiel-Update und für jedes neue Coriolis-Layout der Deep Desert.
Ein Server, der die Spieldateien hat, erledigt das selbst.

## Was im Branch liegt

| Pfad | Inhalt |
|---|---|
| `catalog.json` | alle Karten (Name, Größe, Kalibrierung) mit dem SHA-256 jedes Karten-Index; Prüfsummen der Bauteil-Modelle |
| `m/<karte>.json` | Kachel-Index einer Karte (welche Kachel an welcher Ebene / Spalte / Zeile liegt) |
| `p/<xx>/<id>.z` | Gelände-Kacheln, gzip. `<id>` = die ersten 16 Hex-Stellen des SHA-256 des Inhalts; gleiche Kacheln liegen so nur einmal, über alle Karten und Layouts hinweg |
| `buildables/` | Bauteil-Modelle |

Kacheln werden **nie gelöscht**: Der ältere Daten-Tag `data-v1` (vom Dune-Console-Addon genutzt) und ältere Viewer laufen weiter. Ein neuer Spielbuild fügt nur die Kacheln hinzu,
die sich wirklich geändert haben.

## Wie der Sync arbeitet

`cdn-sync.sh` läuft auf dem Spiel-Host als root (systemd-Timer, alle 30 Minuten, niedrige Priorität):

1. **Viewer-Daten**: Die Karten des laufenden Viewers (`DATA_LIVE`, z. B. selbst gebaute Coriolis-Layouts) werden in Kacheln geschnitten (`cmd/cdnsync`).
2. **Neuer Spielbuild?** Die Signatur der `.pak/.ucas/.utoc`-Dateien im laufenden Spielserver (`/proc/<pid>/root/home/dune/server/DuneSandbox/Content/Paks`)
   wird mit der letzten verglichen. Weicht sie ab, baut `extract` (`cmd/extract`, mit `-tags paks` gebaut) Hagga Basin, die Deep Desert **mit allen Coriolis-Layouts** und den
   Bauteil-Katalog aus den Spieldateien neu (ca. 20–30 Minuten); danach wird wie in Schritt 1 gepackt.
3. Neue Dateien werden in Paketen von höchstens 12 MB committet und übertragen; `catalog.json` kommt immer zuletzt, damit er nie auf Fehlendes zeigt.
   Ohne Änderung entsteht kein Commit.

Da jeder Viewer den Stand des Branches liest, steht ein neues Layout allen kurz nach dem Server zur Verfügung, und die Viewer brauchen keinen eigenen `-paks`-Build.

## Einrichtung (auf dem Spiel-Host)

```bash
# 1. Programme (Go ≥ 1.26 und ein C++-Compiler; aus dem Repository oder dem Ordner backend/ des Update-Pakets bauen)
cd backend
sudo mkdir -p /opt/mapviewer-cdn
sudo go build -trimpath -o /opt/mapviewer-cdn/cdnsync ./cmd/cdnsync
sudo CGO_ENABLED=1 go build -tags paks -trimpath -o /opt/mapviewer-cdn/extract ./cmd/extract
sudo install -m755 ../deploy/cdn-sync/cdn-sync.sh /opt/mapviewer-cdn/

# 2. Deploy-Key (damit pusht der Sync; in GitHub anlegen: Repository → Settings → Deploy keys → „Allow write access“)
sudo ssh-keygen -t ed25519 -N "" -f /opt/mapviewer-cdn/deploy_key
sudo cat /opt/mapviewer-cdn/deploy_key.pub        # in den Deploy-Key einfügen

# 3. Einstellungen und Timer
sudo cp ../deploy/cdn-sync/cdn-sync.env.example /etc/mapviewer-cdn.env     # DATA_LIVE usw. anpassen
sudo cp ../deploy/cdn-sync/mapviewer-cdn-sync.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now mapviewer-cdn-sync.timer

# Ausprobieren ohne Push:          sudo DRY_RUN=1 /opt/mapviewer-cdn/cdn-sync.sh
# Neu extrahieren erzwingen:       sudo touch /var/lib/mapviewer-cdn/force
# Verfolgen:                       journalctl -u mapviewer-cdn-sync -f
```

**Sicherheit.** Der Deploy-Key darf im ganzen Repository schreiben (GitHub kennt keine Deploy-Keys je Branch): Den Host gut absichern. Der Schlüssel liegt nur in
`/opt/mapviewer-cdn/deploy_key` (Modus 600). Ein Viewer, der aus dem Branch streamt, prüft jede Datei gegen den Katalog, der Katalog selbst ist aber nur so
vertrauenswürdig wie das Repository (siehe [SECURITY.md](../SECURITY.md)). Der Branch wächst nur um neue Kacheln (gleiche werden geteilt); ein neues Coriolis-Layout
bringt einige MB.

Nur auf eigenen Servern betreiben. Die Extraktion liest die Spieldateien, am Spiel wird nichts verändert.

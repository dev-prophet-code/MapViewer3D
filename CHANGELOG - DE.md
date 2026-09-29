# Patchnotes – Dune MapViewer3D

Jede Änderung am Viewer steht hier, die neueste Version oben.

**Regeln für diese Datei**

- Jede Änderung kommt sofort in die laufende Version, nicht erst beim Veröffentlichen.
- Wird eine Änderung verworfen, bleibt ihr Eintrag stehen. Er wird ~~durchgestrichen~~,
  mit **Verworfen** und dem Grund markiert und zusätzlich unter *Verworfen* aufgeführt.
  So bleibt nachvollziehbar, was probiert wurde.
- Die Versionsnummer steht auch in `backend/server/server.go` (`Version`) und oben im
  Bedienfeld.

---

## Beta.4 – 29.09.2026

### Sicherheit

Korrekturen aus einer externen Sicherheitsprüfung (danke!).

- **Die Einrichtungssperre versagt hinter einem Reverse-Proxy nicht mehr.** Als lokaler Administrator gilt eine Anfrage nur noch, wenn sie von einer Loopback-Adresse kommt, keine Proxy-Kopfzeile trägt **und** an einen Loopback-Namen gerichtet ist (`localhost`, `127.0.0.1`, `[::1]`). Ein Proxy auf demselben Rechner, der den öffentlichen Host-Namen durchreicht (auch ohne `X-Forwarded-*`), gilt damit als Besucher; das blockiert auch DNS-Rebinding. Die neue Option **`-no-local-admin`** schaltet die Einrichtung im Browser ganz ab (stattdessen `-config` verwenden).
- **Console-Prüfung gegen SSRF gehärtet.** Link-Local-Ziele (auch die Cloud-Metadaten `169.254.169.254`), Multicast und `0.0.0.0` werden schon beim Verbindungsaufbau abgelehnt (auch nach der DNS-Auflösung), Weiterleitungen werden nicht verfolgt und ein Proxy aus der Umgebung wird nicht benutzt. Genaue Fehlermeldungen bekommt nur der Browser auf dem Rechner selbst; mit `-remote-setup` läuft jeder Fehlschlag in ein einziges „nicht erreichbar“, damit die Prüfung nicht als Portscanner taugt.
- **Konten-Kennungen gehen nicht mehr an Besucher.** `account_id`, `action_player_id`, `funcom_id` und `fls_id` werden aus den Live-Daten entfernt – für alle außer dem lokalen Administrator, auch ohne `-public`. Beim Start auf einer im Netz erreichbaren Adresse ohne `-public` erscheint eine deutliche Warnung.
- **Kein CDN mehr.** three.js 0.170.0 liegt unverändert (MIT) in `viewer/vendor/`. Der Server sendet eine `Content-Security-Policy` (nur die eigene Herkunft; die Import-Map ist per Hash erlaubt), `X-Content-Type-Options: nosniff` und `Referrer-Policy: no-referrer`. Die Seite lässt sich weiter in einen iframe einbetten.
- **Sicherheitsprüfung in der CI:** `gitleaks` und `govulncheck` laufen bei jedem Push und Pull-Request.

### Behoben

- Die Extraktionswerkzeuge stürzen bei abgeschnittenen oder unerwarteten Paketdaten nicht mehr ab (`zen.Properties`, `zen.StructArray`, Container-Header), sondern melden den Abschneidefehler. Regressionstests decken jede Kürzung ab.
- Die Kartenliste wird pro Laden einmal statt zweimal aufgebaut.

---

## Beta.3 – 29.09.2026

### Neu

- **Mausrad = freie Kamera:** Das Rad dreht die Kamera um die Bildmitte, Shift + Rad neigt sie, Strg/⌘ + Rad (oder Trackpad-Pinch) zoomt. Ziehen mit der Maus bleibt wie gehabt.
- **Kompass** (unten rechts): zeigt Norden, Süden, Osten und Westen und dreht sich mit der Kamera. Ein Klick richtet nach Norden aus.
- **Hell-/Dunkel-Schalter:** Sonne/Mond unter dem Kompass. Er schaltet Oberfläche und 3D-Szene um (Tageshimmel und -licht bzw. Nachthimmel und Mondlicht). Die Wahl wird gemerkt; ohne Wahl gilt die Systemeinstellung.
- **Vollbild-Schalter** (oder Taste `F`) zeigt den ganzen Viewer im Vollbild.
- **Seitenleiste ein-/ausblenden**; **Alle an / Alle aus** schaltet alle Ebenen auf einmal.
- **Anleitung:** Die neue `?`-Taste (und der Link im Bedienfeld) öffnet eine Anleitung zu Kamera, Tastatur und Schaltflächen.

### Behoben

- Namen, Symbole und Markierungen verschwinden jetzt hinter Bergen, statt durchs Gelände zu scheinen.

---

## Beta.2 – 26.09.2026

### Neu

- **Läuft ohne Go auf Windows, Linux und macOS.** Das Programm liegt für sechs
  Systeme vorgebaut in `bin/`: Windows, Linux und macOS, jeweils x64 und ARM.
  Gestartet wird mit `start.bat` (Windows), `start.command` (macOS, Doppelklick) oder
  `./start.sh` (macOS/Linux). Der Browser öffnet sich von selbst.
- **Betrieb auf einem Server:** `-addr 0.0.0.0:8795` macht den Viewer im Netz
  erreichbar. Zugangsdaten und Instanznamen lassen sich dann nur im Browser auf
  dem Server selbst ändern. Besucher sehen weder Server-Adresse noch Fingerabdruck;
  Anfragen über einen Reverse-Proxy gelten immer als Besucher. Mit `-remote-setup`
  wird die Einrichtung für alle freigegeben (nur hinter eigenem Zugangsschutz).
- **Symbole der 2D-Karte:** Aus der Ferne erscheint jedes Objekt mit dem Symbol der
  2D-Live-Karte (Console bzw. lafamilia-gaming.eu): Spieler, Basen, Fahrzeuge nach
  Typ, Höhlen, Ecolabs, Wracks, Sietches, Handelsposten, Gegnerlager, Festungen, NPCs,
  Erze nach Sorte, Schrott, Pflanzen, Mehlsand, Lager und Spice. Spice-Felder
  zeigen wie in der Console „LIVE“ oder „?“ und sind nach Feldgröße gestaffelt.
  Aus der Nähe übernehmen die 3D-Modelle.
- **Gefahren-Symbole:** Treibsand, Trommelsand und Strahlung haben in der Console
  kein Bild. Sie bekommen eigene Symbole im gleichen Stil: dunkle Scheibe, farbiger
  Ring, Zeichen.
- **Legende = Karte:** Die Schalter im Bedienfeld, die Spielerliste und das Infofeld
  zeigen dieselben Symbole wie die Karte.
- **Version im Bedienfeld** neben dem Titel; `mapviewer -version` zeigt sie ebenfalls.
- **Projektordner ohne Zugangsdaten:** Zugangsdaten, Instanznamen und alle
  Zwischenspeicher (Kartenbilder, Symbole) liegen jetzt im Benutzerordner:
  - Windows: `%AppData%\MapViewer3D\state`
  - macOS: `~/Library/Application Support/MapViewer3D/state`
  - Linux: `~/.config/MapViewer3D/state`

  Der Projektordner bleibt so immer im Auslieferungszustand: Wer ihn bekommt, muss
  Server und Token selbst eintragen. Beim ersten Start einer neuen Version zieht der
  Viewer alte Zugangsdaten aus `state/` im Projektordner in den Benutzerordner um und
  löscht `state/` sowie `data/*/mapimage.png`.
- **`check-clean.sh`** prüft, dass im Projektordner keine Zugangsdaten,
  Instanznamen, Zwischenspeicher oder Klartext-Tokens liegen.
  `build-release.sh --zip` baut das Paket nur, wenn die Prüfung besteht.
- `-config <datei>` enthält den Token im Klartext. Liegt die Datei im Projektordner,
  warnt das Programm beim Start.

### Behoben

- **Windows startete nicht.** Das verteilte `MapViewer3D.zip` war noch Beta.1: kein
  Windows-Programm, nur `start.sh`, das Go braucht. Das Paket wird jetzt mit
  `build-release.sh --zip` gebaut und enthält alle Programme und Startskripte.
- `start.bat` ist robuster geworden:
  - Die Download-Sperre (SmartScreen/Mark-of-the-Web) wird für `bin/` aufgehoben.
  - Pfade mit Umlauten funktionieren (UTF-8-Codepage).
  - Das Programm wird über den vollständigen Pfad gestartet.
  - Bei einem Fehler bleibt das Fenster mit der Meldung offen.
- **macOS und Linux auf dieselben Startprobleme geprüft** (getestet unter Alpine
  ARM64, Debian x64, Debian 32-Bit-ARM, macOS ARM und Intel per Rosetta; der Stand
  vorher hätte auf macOS und Linux genauso nicht gestartet, weil das alte Paket kein
  Programm enthielt):
  - `start.sh` entfernt die macOS-Quarantäne für den ganzen Ordner (nicht nur für
    das Programm), damit auch `start.command` danach läuft.
  - Verlorene Ausführrechte (manche Entpacker) setzt `start.sh` für Programm und
    Skripte neu; `sh start.sh` geht immer.
  - Neu: Programm für 32-Bit-ARM-Linux (`linux-arm`, z. B. Raspberry Pi); vorher
    brach `start.sh` dort mit „Nicht unterstützte Architektur“ ab.
  - Laufwerke ohne Ausführrecht (`noexec`) werden erkannt und klar gemeldet statt
    „Permission denied“.
  - Zu alte Systeme werden vor dem Start gemeldet: macOS unter 13 (`start.sh`) und
    Windows unter 10 (`start.bat`). Vorher gab es eine unverständliche Meldung
    oder einen stillen Abbruch.
  - Ohne Benutzerordner (`$HOME` fehlt, z. B. in manchen Diensten) nennt das
    Programm die Lösung (`-state`/`-keydir`).
  - README: Gatekeeper-Hinweise für macOS 13–15+ (Programm ist nicht notarisiert).
- Die `.exe` startet auch per Doppelklick: Der Browser öffnet sich, und bei einem
  Fehler wartet das Fenster auf Enter, statt sofort zu verschwinden. Ohne Argumente
  gestartet, öffnet das Programm auf allen Systemen den Browser.

### Geändert

- **Basen in 3D nur noch im Sichtfeld.** Bisher wurden alle Basen im Umkreis von
  2,5 km um die Kamera geladen, auch hinter ihr. Jetzt lädt der Viewer nur Basen
  im Blickfeld (bis 2,5 km) und direkt um die Kamera (500 m), die nächsten zuerst,
  höchstens drei gleichzeitig. Was Sichtfeld und Umkreis verlässt, wird nach 4 s
  verworfen und sein Speicher freigegeben. Die letzten 60 Basisdaten bleiben im
  Speicher, damit Zurückschwenken nichts neu lädt. Die Statuszeile zeigt, wie viele
  Basen im Sichtfeld liegen.
- **Bessere Sichtbarkeit:** Die farbigen Punkte der Fernansicht sind durch die
  Symbole ersetzt, die sich mit ihrem dunklen Rand vom Sand abheben. Aus großer
  Entfernung werden die Symbole kleiner, damit die Übersicht lesbar bleibt.
- Namen stehen über dem Symbol, statt es zu verdecken.
- Das Programm findet `data/` und `viewer/` neben `bin/` selbst. Pfade
  müssen nicht mehr angegeben werden.

- **Öffentlicher Betrieb mit PvE-Filter:** `-public <datei>` (JSON mit `partitions`
  und `modeSource`) lässt nur Partitionen durch, die auf der Liste stehen **und** von
  `modeSource` als PvE gemeldet werden. Gefiltert wird auf dem Server: Spieler nur
  online und ohne Kennungen, Basis-Exporte nur für freigegebene Basen, die
  Instanzauswahl nur mit freigegebenen Partitionen. Ist die Quelle länger als 10 min
  nicht erreichbar, gilt keine Partition.
- **Einbettung (`?embed=1`):** Sprache (`?lang=`) und Startkarte (`?map=HaggaBasin`)
  kommen von der Seite; Titel, Sprachwahl und Verbindung sind ausgeblendet. Die Seite
  steuert per `postMessage` (`{type: 'dune3d', map, paused}`) und bekommt
  `{type: 'dune3d', ready: true}`, sobald das Gelände steht.

### Technik

- Neuer Endpunkt `GET /api/icons/<datei>`: holt das Markerbild von der eingetragenen
  Console (`/images/maps/…`) und speichert es im Einstellungsordner unter `icons/`
  zwischen (~~`state/icons/` im Projektordner~~, **Verworfen**: gehört nicht ins
  weitergegebene Projekt). Die
  Bilder werden nicht mitgeliefert. Beim Wechsel des Servers wird der Zwischenspeicher
  geleert. Fehlt ein Bild, erscheint ein farbiger Punkt.
- Neuer Endpunkt `GET /api/version`.
- Der Viewer-Server ist reines Go ohne cgo. `build-release.sh` baut alle Systeme,
  `build-release.sh --zip` zusätzlich `../MapViewer3D.zip` zum Weitergeben, mit
  Quellcode und ohne Paks (~~`dist/MapViewer3D-<Version>.zip` ohne Quellcode~~,
  **Verworfen**: Das Paket ersetzt das bisherige `MapViewer3D.zip`, und ohne
  `backend/` ging `start.sh --build` nicht).
- Das Kartenbild der Console liegt jetzt im Einstellungsordner (`mapimages/`) statt
  in `data/<karte>/mapimage.png`.
- Das alte Einzelprogramm `bin/mapviewer` ist durch `bin/mapviewer-<system>-<cpu>` ersetzt.

### Aufgeräumt

- Projektordner auf die Dateien reduziert, die Viewer, Startskripte und Kartenbau
  wirklich brauchen:
  - `data/*/preview.png` (9,6 MB) entfernt, dazu der Endpunkt
    `/api/map/<name>/preview.png` und ihre Erzeugung in `cmd/extract`. Die
    Minikarte, für die sie gedacht waren, gibt es seit dem Entfernen des Editors
    nicht mehr.
  - Von der Header-Bibliothek `simde` (Oodle-Entpacker für den Kartenbau) bleiben
    die 15 Header, die tatsächlich eingebunden werden; 457 ungenutzte sind weg
    (10 MB → 0,9 MB). Geprüft mit cgo-Builds von `cmd/extract` auf macOS (ARM, x64)
    und Linux (GCC).
  - `.gitignore` entfernt (das Projekt ist kein Git-Repository; der Schutz vor
    Zugangsdaten liegt in `check-clean.sh`).
  - Unbenutzte Konstanten `FilePreview` und `FileMapImage` entfernt.
- Die Entwicklerskripte `build-release.sh` und `check-clean.sh` sind nicht mehr im
  Verteilpaket; sie bleiben nur im Projektordner.
- Verteilpaket: 1277 Dateien.

### Verworfen

- Zugangsdaten und Zwischenspeicher unter `state/` im Projektordner: Sie wären beim
  Weitergeben mitgewandert. Ersetzt durch den Benutzerordner.


---

## Beta.1 – 25.09.2026

- Erste verteilbare Fassung: Hagga Basin und Deep Desert je Serverinstanz,
  Live-Daten der Console, Basen in 3D, verschlüsselte Zugangsdaten, Oberfläche
  Englisch/Deutsch. Start mit `./start.sh`; Go und ein C-Compiler waren nötig.

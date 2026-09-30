# Patchnotes – Dune MapViewer3D

Jede Änderung am Viewer steht hier, die neueste Version oben.

**Regeln für diese Datei**

- Jede Änderung kommt sofort in die laufende Version, nicht erst beim Veröffentlichen.
- Wird eine Änderung verworfen, bleibt ihr Eintrag stehen. Er wird ~~durchgestrichen~~,
  mit **Verworfen** und dem Grund markiert und zusätzlich unter *Verworfen* aufgeführt.
  So bleibt nachvollziehbar, was probiert wurde.
- Die Versionsnummer steht auch in `backend/server/server.go` (`Version`), oben im
  Bedienfeld und im Kopfkommentar von `start.bat`, `start.command`, `start.sh` und
  `SECURITY.md`. Bei jedem Release überall mitziehen.

---

## Beta.8 – 30.09.2026

### Entfernt

- **Kartenraster A1–I9 (Deep Desert) entfernt.** Das Console-Kartenbild im Viewer zeigt dieses Raster bereits, die zusätzlichen Linien und schwebenden Zellnamen waren überflüssig. Der Schalter unter der Kartenauswahl, grid.js und die Zell-Überlagerung im Gelände-Shader sind weg. (Der Eintrag unter Beta.5 bleibt als Nachweis stehen.)

### Sicherheit

- **Das Upgrade des Dune-Docker-Addons (0.1.6) übernimmt keinen alten Viewer mehr.** Viewer vor Beta.7 ignorieren die Passwort-Einstellung; ein Upgrade, das die alten Dateien behielt, konnte daher geschützt aussehen, während der Viewer offen blieb. Der Addon-Installer merkt sich jetzt, welchen Viewer-Release er entpackt hat, ersetzt jede Installation, die nicht zum festgelegten Release (Beta.8) passt (deine config.json mit API-Key und Passwort bleibt unberührt, zusätzliche Geländeordner unter data/ bleiben erhalten) und prüft vor der Erfolgsmeldung den laufenden Viewer: ohne Login muss er 401 antworten, mit Passwort 200; sonst stoppt er den Container. Ein Regressionstest (scripts/test-upgrade.sh im Addon) fährt das Upgrade von einer echten Beta.6-Installation und prüft genau das.

---
## Beta.7 – 29.09.2026

### Sicherheit

- **Passwort für den Netzbetrieb.** Ein Viewer auf einer Adresse außerhalb von Loopback (z. B. `0.0.0.0:8795`) braucht jetzt ein Passwort (`-password`, `MV_PASSWORD` oder `viewerPassword` in der `-config`-Datei); der Browser fragt per HTTP-Login (Benutzername egal). Der Vergleich läuft in konstanter Zeit. Ohne Passwort verweigert das Programm den Start auf einer Netzadresse; ungeschützter Netzbetrieb geht nur mit bewusstem `-allow-open`. Der lokale Betrieb (Standard) ist unverändert. Anlass: Das Review des Dune-Docker-Addons bemängelte, dass der Viewer Spielernamen und Positionen ohne Login zeigte.

---

## Beta.6 – 29.09.2026

### Neu

- **Deep Desert: Felsen, Ecolabs und Wracks des Layouts.** Beta.5 baute nur die Geländekacheln des wöchentlichen Layouts. Jetzt werden auch die *Content-Blöcke* gelesen, die die 162 Cluster des Layouts in die Wüste setzen (Felsformationen, Ecolab-Plätze, Schiffswracks, Sandfliegen-Lager: rund 720 Blöcke), gedreht und wie die festen Blöcke der Reihe A auf die Karte gesetzt und ins Gelände gerastert. Die Wüste hinter Reihe A zeigt damit die Objekte des aktuellen Kartenstands deines Servers, nicht nur den Boden.
- Die Zahl der Blöcke und ihrer Netze steht im Protokoll von `extract` (z. B. *162 Cluster, 727 Content-Blöcke*).

- **Folgt jedem Coriolis-Sturm von selbst.** Mit den Spieldateien (`mapviewer -paks <Ordner>`) fragt der Server die Console alle 5 Minuten nach dem aktuellen Layout; bringt ein Sturm ein neues, baut er das passende Deep-Desert-Gelände im Hintergrund (etwa 15 s), behält die neuesten drei Layouts und löscht ältere. Die Kartenliste wechselt selbständig auf das neue Gelände, und der offene Browser-Tab lädt die Deep Desert ohne Neuladen der Seite um (Kamera und Auswahl bleiben). Bis es fertig ist, meldet das Bedienfeld, dass das Gelände gebaut wird. Dafür braucht es ein Programm, das mit `go build -tags paks` gebaut wurde (der Leser der Spieldateien braucht einen C++-Compiler); die fertigen Programme bleiben reines Go und geben mit `-paks` diesen Hinweis aus. Ohne Spieldateien zeigt der Viewer weiter das passende Gelände, falls vorhanden, sonst die Dünenvorlage, und warnt.
- Live-Objekte (Spieler, Basen, Fahrzeuge, Spice, Erz, Schrott) kamen schon bisher laufend aus der Console; zusammen mit dem Layout-Gelände zeigt die Karte damit immer den aktuellen Stand des Servers.

### Hinweise

- Die Blöcke liegen innerhalb der Kachelfelder ihrer Cluster; das bestätigt auch die Lage des Kachelrasters.
- Die Blöcke bleiben Teil der Höhenkarte (2,5D, keine Überhänge), wie die Felsen in Reihe A.

---

## Beta.5 – 29.09.2026

### Neu

- **Deep Desert mit dem wöchentlichen Coriolis-Layout.** Hinter Reihe A baut das Spiel die Welt aus einem Layout, das der Server je Coriolis-Zyklus wählt (`DA_DeepDesert_1_Layout_NN`, die Nummer ist `coriolisLayout` in der Console). Der Viewer liest dieses Layout jetzt aus den Spieldateien und baut das Gelände aus dessen 24 × 24-Kachelplan (Kacheln zu 1016 m: Krater, Rampen, Ecolab- und Wrack-Plätze, Spice-Gebiete) statt aus einer einzigen wiederholten Dünenvorlage. Zellen ohne Überschreibung bleiben Düne. Damit siehst du in 3D den aktuellen Kartenstand deines Servers.
- **Der Viewer wählt das passende Gelände.** Der Server meldet sein Layout über die Console (`coriolisLayout`, `coriolisNextCycleAt`); der Viewer lädt das Gelände, das für dieses Layout gebaut wurde, und zeigt unter der Karte *Coriolis-Layout N · wechselt … (in x T y Std)*. Fehlt das Gelände für das aktuelle Layout, nennt eine Warnung den Befehl, der es baut.
- **Kartenraster A1–I9.** Neuer Schalter unter der Kartenauswahl (nur Deep Desert): die 9 × 9 Zellen zu 2,5 km wie im Spiel und auf der Console-Karte (Reihe A im Norden, Spalte 1 im Westen), als Linien auf dem Gelände, dazu die Zellnamen darüber.
- **`extract -layout`** baut das Deep-Desert-Gelände je Layout nach `data/deepdesert_1_lNN/`: `auto` (Standard: aktuelles Layout laut Console), eine Liste wie `8,9`, `all` (alle Layouts der Spieldateien) oder `none` (alte Dünenvorlage). Ein Layout dauert etwa 10 s und belegt 170 MB; fertige Pakete enthalten deshalb nur das aktuelle Layout.

### Hinweise

- Das Kachelraster ist aus der Kartenmitte und dem 63,5-m-Raster der generischen Actors des Layouts auf die Karte gelegt (Genauigkeit etwa 16 m).
- Felsen, Ecolab- und Wrack-Gebäude, die das Layout als *Content-Blöcke* setzt, werden noch nicht gezeigt; das Gelände darunter schon.

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

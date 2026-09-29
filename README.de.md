# Dune MapViewer3D

3D-Kartenviewer für einen selbst gehosteten Dune-Awakening-Server mit dem
Docker-Stack von Red-Blink (*dune-awakening-selfhost-docker*). Er zeigt Hagga Basin
und Deep Desert je Serverinstanz (z. B. PvE, PvP, Creative) mit Spielern, Basen in 3D,
Fahrzeugen, Orten, Gefahren und Ressourcen.

> **Voraussetzung:** Der MapViewer3D funktioniert **nur mit dem Docker-Stack von
> [Red-Blink](https://github.com/Red-Blink)** (*dune-awakening-selfhost-docker*).
> Andere Server-Setups werden nicht unterstützt.
>
> **Lizenz:** [MIT](LICENSE) – frei nutzbar und anpassbar.

## Starten

Go muss nicht installiert sein: Das Programm liegt für Windows, Linux und macOS
(je x64 und ARM, Linux zusätzlich 32-Bit-ARM, z. B. Raspberry Pi) vorgebaut in `bin/`.
Mindestens nötig: Windows 10, macOS 13 (Ventura), Linux-Kernel 3.2; die Startskripte
prüfen das und melden zu alte Systeme.

| System | Start |
|---|---|
| Windows | Doppelklick auf `start.bat` |
| macOS | Doppelklick auf `start.command` oder im Terminal `./start.sh` |
| Linux | `./start.sh` (fehlen nach dem Entpacken die Rechte: `sh start.sh`) |

Der Browser öffnet http://127.0.0.1:8795 von selbst. Weitere Argumente reichen die
Skripte an das Programm weiter, z. B. `./start.sh -addr 127.0.0.1:9000`.

Windows (10/11): Das ZIP erst entpacken, dann `start.bat` doppelklicken. Meldet
SmartScreen „Der Computer wurde durch Windows geschützt“, auf *Weitere Informationen →
Trotzdem ausführen* klicken; `start.bat` hebt danach die Download-Sperre des
Programms selbst auf. Das Fenster bleibt offen, solange der Viewer läuft, und zeigt
bei einem Fehler die Ursache an. Die `.exe` in `bin/` startet auch per Doppelklick.

macOS: Das Programm ist nicht bei Apple beglaubigt (keine Notarisierung). Beim
ersten Doppelklick auf `start.command` meldet macOS deshalb, dass es nicht geöffnet
werden kann:
- **macOS 15 (Sequoia) und neuer:** *Systemeinstellungen → Datenschutz & Sicherheit*,
  ganz unten bei `start.command` auf *Trotzdem öffnen* klicken.
- **macOS 13/14:** Rechtsklick auf `start.command` → *Öffnen* → *Öffnen*.
- **Immer möglich:** Terminal öffnen, in den Ordner wechseln, `sh start.sh`.

Danach entfernt `start.sh` die Download-Sperre für den ganzen Ordner, und weitere
Starts gehen ohne Rückfrage. Das Programm in `bin/` nicht direkt im Finder
doppelklicken, das blockiert macOS.

Linux: Liegt der Ordner auf einem Laufwerk ohne Ausführrecht (`noexec`, z. B. `/tmp`,
manche USB-Sticks), meldet `start.sh` das; dann den Ordner ins Benutzerverzeichnis
kopieren.

### Auf einem Server betreiben

```bash
./start.sh -addr 0.0.0.0:8795          # Linux/macOS
start.bat -addr 0.0.0.0:8795           # Windows
```

- Zugangsdaten und Instanznamen lassen sich dann **nur im Browser auf dem Server
  selbst** ändern (z. B. per SSH-Tunnel: `ssh -L 8795:127.0.0.1:8795 <server>`).
  Besucher sehen die Karte, aber weder Server-Adresse noch Token-Fingerabdruck.
- Hinter einem Reverse-Proxy (nginx, Caddy …) gelten alle weitergeleiteten Anfragen
  als Besucher.
- `-remote-setup` erlaubt die Einrichtung von überall. Das nur hinter eigenem
  Zugangsschutz verwenden.
- Auf Servern ohne Benutzerordner Einstellungen und Schlüssel selbst ablegen,
  **außerhalb** des Projektordners: `-state /var/lib/mapviewer3d -keydir /var/lib/mapviewer3d/key`.

Beispiel für einen systemd-Dienst (Linux):

```ini
[Unit]
Description=Dune MapViewer3D
After=network-online.target

[Service]
User=mapviewer
WorkingDirectory=/opt/MapViewer3D
ExecStart=/opt/MapViewer3D/bin/mapviewer-linux-amd64 -addr 127.0.0.1:8795 -state /var/lib/mapviewer3d -keydir /var/lib/mapviewer3d/key
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

### Selbst bauen (nur für Entwickler)

```bash
cd backend
go build -trimpath -o ../bin/mapviewer ./cmd/mapviewer   # eigenes System
GOOS=windows GOARCH=amd64 go build -o ../bin/mapviewer-windows-amd64.exe ./cmd/mapviewer   # Cross-Compile
./start.sh --build                                       # bauen und starten
```

Zum Neubauen der Karten (`cmd/extract`, siehe unten) braucht es weiterhin Go mit
C-Compiler, weil das Entpacken der Spieldateien Oodle per cgo nutzt.

Änderungen stehen in [CHANGELOG - DE.md](<CHANGELOG - DE.md>) bzw. [CHANGELOG - EN.md](<CHANGELOG - EN.md>).

Die Oberfläche ist standardmäßig **englisch**. Über die Sprachauswahl oben rechts im
Panel lässt sie sich auf **Deutsch** umstellen; die Wahl merkt sich der Browser.
Übersetzungen stehen in `viewer/js/i18n.js`.

## Einrichtung beim ersten Start

Der Browser fragt nach:

| Feld | Beispiel |
|---|---|
| Server (Host, IP oder URL) | `mein-server.de` oder `203.0.113.10` |
| Port der Console | `8088` (Standard des Stacks) |
| API-Token | ein API-Schlüssel der Console mit Lesezugriff auf die Kartendaten (`dak_…`) |

Der Viewer prüft die Verbindung sofort. Ein falscher Token wird abgelehnt und nicht
gespeichert.

Im Bereich **Verbindung** lassen sich später Server und Token ändern, die
Zugangsdaten löschen und die Serverinstanzen benennen.

## Wie die Zugangsdaten geschützt sind

- **Doppelte Verschlüsselung:** innen **AES-256-GCM**, außen **XChaCha20-Poly1305**,
  je Schicht mit eigenem Schlüssel.
- **Schlüssel:** Sie werden per **HKDF-SHA512** aus einem zufälligen Hauptschlüssel
  und einem Zufallssalz abgeleitet und an **Rechner und Benutzerkonto** gebunden.
- **Integrität:** **HMAC-SHA512** über den gesamten Datensatz; jede Veränderung wird
  erkannt.
- **Fingerabdruck:** Vom Token wird ein gesalzener Hash gespeichert (PBKDF2-SHA512,
  210 000 Runden). Nur dieser gekürzte Fingerabdruck wird angezeigt.
- **Getrennte Ablage:**
  - Hauptschlüssel: Benutzer-Konfigordner, Rechte 0600 (macOS:
    `~/Library/Application Support/MapViewer3D/master.key`).
  - Verschlüsselte Daten, Instanznamen und Zwischenspeicher (Kartenbilder, Symbole):
    `state/` im selben Benutzer-Konfigordner (Windows `%AppData%\MapViewer3D\state`,
    Linux `~/.config/MapViewer3D/state`).
  - **Der Projektordner enthält nie Zugangsdaten** und bleibt im Auslieferungszustand:
    Wer ihn bekommt, muss Server und Token selbst eintragen. Ältere Versionen legten
    `state/` im Projektordner an; der Viewer verschiebt die Zugangsdaten beim Start
    in den Benutzerordner und löscht den alten Ordner.
- **In der Datei steht nichts im Klartext**, auch nicht die Server-Adresse.
- **Im Browser:** Der Token erreicht den Browser nie. Alle Anfragen an den Server
  laufen über den lokalen Viewer-Server, der nur auf `127.0.0.1` lauscht und
  ändernde Aufrufe gegen fremde Webseiten (CSRF) absichert.

Grenze: Wer das Benutzerkonto samt Hauptschlüssel auf diesem Rechner hat, kann die
Daten entschlüsseln. Das ist bei jeder Anwendung so, die sich die Zugangsdaten ohne
erneute Passworteingabe merkt.

## Was vom eingetragenen Server kommt

- **Karten:** welche Karten aktiv sind.
- **Serverinstanzen:** Liste und Namen. Ist auf dem Server kein Name gesetzt,
  erscheint „PvE“ oder „PvP“ laut PvP-Schalter der Instanz; unter
  *Instanzen benennen* lässt sich der Name anpassen.
- **Kartenbilder:** die Oberflächenfarbe der Karte.
- **Live-Daten:** Spieler, Basen (samt Bauteilen für die 3D-Ansicht), Fahrzeuge,
  Lager, Orte, Gefahren, Ressourcen, Spice.

## Was mitgeliefert wird

Gelände und Bauteil-Geometrie (`data/`) stammen aus den Spieldateien. Sie sind für
alle Server mit derselben Spielversion gleich und deshalb vorgebaut. Nach einem
Spielupdate lassen sie sich neu erzeugen:

```bash
# Spieldateien aus dem Spielserver-Container kopieren (ca. 4,3 GB)
ssh <BENUTZER>@<SERVER> 'docker cp <SPIELSERVER_CONTAINER>:/home/dune/server/DuneSandbox/Content/Paks /tmp/dunepaks'
scp '<BENUTZER>@<SERVER>:/tmp/dunepaks/*.u*' paks/

# Karten neu bauen (liest die aktiven Karten über die gespeicherte Verbindung)
cd backend && go run ./cmd/extract
```

## Ordner

| Pfad | Inhalt |
|---|---|
| `bin/` | vorgebautes Programm je System (`mapviewer-<system>-<cpu>`) |
| `backend/` | Go-Modul `mapviewer3d`: Paks lesen, Karten bauen, Server, verschlüsselter Speicher (`secure/`) |
| `viewer/` | Weboberfläche (three.js) |
| `data/` | vorgebaute Karten und Bauteil-Katalog |
| *(Benutzerordner)* `MapViewer3D/` | Hauptschlüssel und `state/`: verschlüsselte Zugangsdaten, Instanznamen, Zwischenspeicher – bewusst außerhalb des Projekts |

Eine ausführliche Bauanleitung liegt in den Ordnern „MapViewer3D - DE“ und
„MapViewer3D - Eng“.

## Grenzen

- **Keine Originaltexturen:** Der Server-Build enthält keine Bilddaten. Die Farben
  kommen aus dem Kartenbild der Console und prozeduralen Details.
- **2,5D-Gelände:** Das Gelände hat keine Überhänge. Fahrzeuge, Figuren und Orte
  sind nachgebaute Modelle, Gebäude entstehen aus Kollisionsformen.
- **Deep Desert:** Das Gelände wird zur Laufzeit erzeugt (Coriolis). Der Viewer
  zeigt eine wiederholte Dünen-Vorlage samt den festen Felsblöcken.
- **Live-Positionen:** Sie kommen aus der Datenbank der Console und können einige
  Sekunden bis Minuten hinterherhinken.

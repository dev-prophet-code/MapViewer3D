# MapViewer3D-Echtzeitdaten für Dune Docker

[English](README.md) · [Sicherheit](SECURITY.md)

Echtzeit-**Sandwürmer, Gegner, Zivilisten, Fahrzeuge, Sandstürme** (und auf Wunsch **Spieler**) von einem [Dune-Docker](https://github.com/Red-Blink/dune-awakening-selfhost-docker)-Server in einem **MapViewer3D, der auf deinem eigenen PC läuft** – immer verschlüsselt, gegen Man-in-the-Middle-Angriffe geschützt und nur für Geräte, die der Server-Admin gekoppelt hat.

> Branch `ddp` von MapViewer3D: in Arbeit, noch nicht Teil eines Releases.

## Warum ein eigener Container?

Die Live-Map von Dune Docker liest Postgres. Spieler und Fahrzeuge stehen in der Datenbank (alle paar Sekunden gespeichert), **Sandwürmer, NPCs und Stürme aber nicht**: Es gibt sie nur im Speicher des laufenden Spielserver-Prozesses. Der Positions-Agent `mvagent` von MapViewer3D liest sie dort, nur lesend, etwa 10-mal pro Sekunde ([docs/Agent-DE.md](https://github.com/dev-prophet-code/MapViewer3D/blob/main/docs/Agent-DE.md)).

Ein *Community-Addon* von Dune Docker kann das nicht: Addons sind Browser-Seiten in der Console mit wenigen freigegebenen API-Rechten, sie können keine Container starten und keine Prozesse sehen. Darum ist das hier ein kleines **eigenes Compose-Projekt**, das neben Dune Docker läuft und daran nichts verändert.

```
 Dune-Docker-Host                                                     dein PC
┌───────────────────────────────────────────────┐
│ dune-server-*-Container (Spielprozesse)       │
│        ▲ nur lesend /proc/<pid>/mem           │
│ ┌──────┴──────┐ internes  ┌────────────────┐  │ securelink ┌──────────────────┐
│ │  mvagent    │──Netz─────│    mvgate      │◄─┼────────────│ MapViewer3D      │
│ │ root, kein  │  (kein    │ TLS 1.3, fester│  │ TLS 1.3    │ ab Beta.16:      │
│ │ Port, kein  │ Internet) │ Schlüssel, ge- │  │ :8797      │  -agent-pair     │
│ │ Internet    │           │ genseit. Nachw.│  │            │ älter: mvlink    │
│ └─────────────┘           └────────────────┘  │            └──────────────────┘
└───────────────────────────────────────────────┘
```

- **mvagent** – aus den MapViewer3D-Quellen gebaut (Release-Tag `MV_REF`, geprüft gegen `MV_COMMIT`). `pid: host` lässt ihn die Spielserver-Prozesse der Dune-Docker-Container sehen; zum Lesen ihres Speichers braucht er `SYS_PTRACE` + `DAC_OVERRIDE` (und AppArmor `unconfined`, wie die Dune-Container). Alle anderen Rechte sind entzogen, das Dateisystem ist schreibgeschützt, er hat **keinen veröffentlichten Port und kein Internet** (internes Netz).
- **mvgate** – der einzige veröffentlichte Port (8797/TCP). Es spricht **securelink**: nur TLS 1.3, ein eigener Schlüssel, den der Client fest erwartet, und ein gegenseitiger Token-Nachweis, der an die TLS-Sitzung gebunden ist – das Token selbst geht nie über das Netz. Nur angemeldete Clients erreichen die drei lesenden Agent-Adressen. Läuft ohne root. Einzelheiten: [SECURITY.md](SECURITY.md).
- **mvlink** – optionales Hilfsprogramm auf deinem PC für MapViewer3D-Versionen vor Beta.16 (siehe unten).

## Voraussetzungen

- Ein laufender Dune-Docker-Host (Linux, Docker mit Compose v2 und BuildKit). Unter Docker Desktop/WSL2 genauso: `pid: host` meint dort die Docker-VM, in der auch die Spiel-Container laufen.
- MapViewer3D auf deinem PC, mit API-Key an die Console angebunden (`apiBase` + `token`, siehe Haupt-README). **Ab Beta.16** verbindet er sich direkt; ältere Versionen (ab Beta.9) nutzen `mvlink`.
- Geprüft mit Spiel-Build `2134304`; nach einem Spiel-Update ermittelt der Agent seine Offsets selbst neu (siehe Agent-Doku).

## 1. Installation (auf dem Dune-Docker-Host)

```bash
git clone --branch ddp --depth 1 https://github.com/dev-prophet-code/MapViewer3D.git mapviewer-live
cd mapviewer-live
cp .env.example .env
docker compose -f docker-compose.mapviewer-live.yml up -d --build
docker compose -f docker-compose.mapviewer-live.yml logs -f
```

Beim ersten Start erzeugt mvgate einen eigenen Schlüssel und ein starkes Token in seinem Volume `mvgate-data` und schreibt den Fingerabdruck des Schlüssels (`sha256/…`) ins Log. Das Agent-Log nennt jeden gefundenen Spielserver-Prozess und wie viele Objekte er liest (Hagga-Becken ≈ 2500, Tiefe Wüste ≈ 250). Die Overmap ist absichtlich „nicht bereit“.

Port **8797/TCP** in der Firewall öffnen – am besten nur für die IPs, die ihn brauchen (`MV_GATE_ALLOW`).

## 2. Koppeln (= freischalten)

Solange der Server-Admin kein Gerät koppelt, kann niemand etwas lesen.

**In der Dune-Docker-Console** (sobald die Einbindung aus [dune-docker-integration/](dune-docker-integration/README.md) Teil von Dune Docker ist): **Settings → MapViewer3D Live Data** → öffentliche Adresse eintragen → **Create Pairing Code**. Der Code wird einmal angezeigt; **Revoke All Pairings** macht alle Codes ungültig. Die Oberfläche ist, wie die ganze Console, auf Englisch.

**Auf der Host-Shell** – Kopplungscode mit dem **öffentlichen** Namen oder der IP des Servers erzeugen:

```bash
docker compose -f docker-compose.mapviewer-live.yml exec mvgate mvgate -pair dune.example.org
```

Ausgegeben wird eine Zeile `mvlive1:…`. Sie enthält Adresse, Fingerabdruck und Token: **wie ein Passwort behandeln** und nur über einen vertrauenswürdigen Weg weitergeben (nicht in öffentlichen Chats, nicht über unverschlüsseltes HTTP). Alle Codes auf einmal widerrufen:

```bash
docker compose -f docker-compose.mapviewer-live.yml exec mvgate mvgate -rotate-token
docker compose -f docker-compose.mapviewer-live.yml restart mvgate
```

## 3. Lokalen MapViewer3D verbinden

**Ab Beta.16** – den Code in eine Datei (z. B. `pairing.txt`) außerhalb des Programmordners speichern und starten mit

```bash
./start.sh -agent-pair /pfad/zu/pairing.txt
```

oder in die Konfigurationsdatei (`-config`) als `"agentPairing": "mvlive1:…"` schreiben, oder `MV_AGENT_PAIR` setzen. Der Viewer fragt das Gate kurz an (höchstens 5 s):

- Antwort und alles stimmt → die Schalter **Sandwürmer (live)**, **Gegner**, **Zivilisten & Händler**, **Fahrzeuge (live)** und die Stürme erscheinen;
- keine Antwort, falscher Schlüssel oder falsches Token → die Schalter bleiben ausgeblendet, das Log sagt warum (ein falscher Schlüssel wird als möglicher Angriff gemeldet). Alle 10 Minuten fragt er erneut; neue Schalter erscheinen nach dem Neuladen der Seite.

Ohne Kopplungscode fragt der Viewer nur die Dune-Docker-Console, ob sie diese Funktion anbietet (heute nicht), und lässt die Schalter ausgeblendet.

**Ältere Versionen (Beta.9 – Beta.15)** – `mvlink` auf demselben PC starten; es hält den Code und bietet die Daten nur auf `127.0.0.1` an:

```bash
cd gate && go build -o mvlink ./cmd/mvlink          # Go ab 1.24; oder für andere Systeme bauen, siehe unten
./mvlink -pair-file /pfad/zu/pairing.txt
./start.sh -agent http://127.0.0.1:8798
```

## Sicherheit in Kürze

- Nur TLS 1.3, keine Klartext-Variante; der Client nimmt genau den festgelegten Schlüssel an, keine Zertifizierungsstelle beteiligt.
- Das Token verlässt den PC nie: Beide Seiten weisen mit einem HMAC nach, dass sie es kennen, gebunden an die TLS-Sitzung – ein mitgeschnittener oder weitergereichter Nachweis ist wertlos.
- Nicht angemeldete Verbindungen erreichen HTTP nie; 10 Fehlversuche pro Minute sperren die IP für 10 Minuten.
- `mvagent` hat keinen Port und kein Internet; `mvgate` leitet nur `GET` auf `/stream`, `/healthz`, `/api/objects` weiter.
- `MV_AGENT_PLAYERS=false` lassen, solange keine Live-Spieler gebraucht werden. Im PvP folgen Würmer und Gegner den Spielern: keine Spieler koppeln.
- Das Volume `mvgate-data` sichern; geht es verloren, bekommt mvgate einen neuen Schlüssel und alle Geräte müssen neu gekoppelt werden.

Bedrohungsmodell, Protokoll und der Vorschlag für eine Einbindung in Dune Docker: [SECURITY.md](SECURITY.md).

## Einstellungen (`.env`)

| Variable | Standard | Bedeutung |
|---|---|---|
| `MV_REF` / `MV_COMMIT` | `beta.15` / dessen Commit | MapViewer3D-Release, aus dem der Agent gebaut wird; zeigt das Tag woanders hin, bricht der Bau ab |
| `MV_AGENT_PLAYERS` | `false` | auch Spieler lesen |
| `MV_AGENT_HZ` | `10` | Abtastrate bewegter Objekte |
| `MV_AGENT_CPUS` | `1.0` | CPU-Grenze des Agenten (die Suche liest den ganzen Prozessspeicher) |
| `MV_AGENT_APPARMOR` | `unconfined` | Dune Docker startet die Spiel-Container privilegiert und AppArmor-`unconfined`; das Profil `docker-default` darf solche Prozesse nicht lesen (`permission denied`, Kernel-Log `apparmor="DENIED" … peer="unconfined"`), darum braucht der Agent ebenfalls `unconfined`. Seine übrigen Grenzen bleiben. |
| `MV_GATE_ALLOW` | leer = alle | IPs / CIDRs, die verbinden dürfen |
| `MV_GATE_BIND` / `MV_GATE_PORT` | `0.0.0.0` / `8797` | wo das Gate auf dem Host lauscht (der Port steht auch im Kopplungscode) |
| `MV_GATE_MAX_STREAMS` | `8` | gleichzeitige Viewer |
| `MV_GATE_TOKEN` | leer | leer lassen: mvgate erzeugt selbst ein 256-Bit-Token |

## Aktualisieren, stoppen, entfernen

```bash
git pull                                                     # neue Compose-Datei/Gate
# neues MapViewer3D-Release: MV_REF und MV_COMMIT in .env setzen, dann
docker compose -f docker-compose.mapviewer-live.yml up -d --build
docker compose -f docker-compose.mapviewer-live.yml down     # stoppen (Schlüssel und Token bleiben)
docker compose -f docker-compose.mapviewer-live.yml down -v  # entfernen samt Schlüssel und Token
```

Im Container aktualisiert sich der Agent nie selbst; ein neues Release heißt neu bauen.

## Fehlersuche

| Symptom | Ursache / Lösung |
|---|---|
| Agent-Log: keine Spielserver-Prozesse | Dune Docker läuft nicht, oder der Container hat kein `pid: host` (Podman/rootless Docker werden nicht unterstützt) |
| `permission denied` bei `/proc/<pid>/mem` | AppArmor: `MV_AGENT_APPARMOR=unconfined` lassen (Standard; `DENIED` in `sudo dmesg` suchen). SELinux: `label=disable` in `security_opt` von `mvagent` ergänzen. `kernel.yama.ptrace_scope=3` verhindert es ganz. |
| Viewer-Log: „keine Antwort“ | Port 8797 zu/falsch weitergeleitet, falscher Host im Kopplungscode, IP nicht in `MV_GATE_ALLOW` oder nach Fehlversuchen gesperrt (10 Minuten warten) |
| Viewer-Log: „anderer Schlüssel“ | mvgate wurde neu aufgesetzt (Volume weg) → neu koppeln; sonst **sitzt jemand dazwischen**: nicht weitermachen |
| Viewer-Log: „lehnt den Kopplungscode ab“ | Token wurde gewechselt → neuen Kopplungscode holen |
| nach einem Spiel-Update alles „nicht bereit“ | im Agent-Log nach „neu bestimmt“ schauen; klappt es nicht, `-blocks/-root/-pos` setzen (Agent-Doku) |

Der Container-Healthcheck von mvgate verbindet sich selbst über securelink (`docker compose ps` zeigt `healthy`).

## Entwicklung

```bash
cd gate && go vet ./... && go test ./...           # securelink, mvgate, mvlink
docker compose -f docker-compose.mapviewer-live.yml build
# mvlink für andere Systeme, z. B. Windows:
cd gate && GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -o mvlink.exe ./cmd/mvlink
```

`gate/securelink` und `backend/securelink` im MapViewer3D-Hauptcode müssen identisch bleiben.

## Lizenz

MIT, wie MapViewer3D. Inoffizielles Community-Projekt, nicht verbunden mit Funcom oder Red-Blink.

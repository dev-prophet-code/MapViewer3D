# MapViewer3D-Echtzeitdaten für Dune Docker

[English](README.md)

Echtzeit-**Sandwürmer, Gegner, Zivilisten, Fahrzeuge, Sandstürme** (und auf Wunsch **Spieler**) von einem [Dune-Docker](https://github.com/Red-Blink/dune-awakening-selfhost-docker)-Server in einem **MapViewer3D, der auf deinem eigenen PC läuft**.

> Branch `ddp` von MapViewer3D: in Arbeit, noch nicht Teil eines Releases.

## Warum ein eigener Container?

Die Live-Map von Dune Docker liest Postgres. Spieler und Fahrzeuge stehen in der Datenbank (alle paar Sekunden gespeichert), **Sandwürmer, NPCs und Stürme aber nicht**: Es gibt sie nur im Speicher des laufenden Spielserver-Prozesses. Der Positions-Agent `mvagent` von MapViewer3D liest sie dort, nur lesend, etwa 10-mal pro Sekunde ([docs/Agent-DE.md](https://github.com/dev-prophet-code/MapViewer3D/blob/main/docs/Agent-DE.md)).

Ein *Community-Addon* von Dune Docker kann das nicht: Addons sind Browser-Seiten in der Console mit wenigen freigegebenen API-Rechten, sie können keine Container starten und keine Prozesse sehen. Darum ist das hier ein kleines **eigenes Compose-Projekt**, das neben Dune Docker läuft und daran nichts verändert.

```
 Dune-Docker-Host                                              dein PC
┌──────────────────────────────────────────────┐
│ dune-server-*-Container (Spielprozesse)      │
│        ▲ nur lesend /proc/<pid>/mem          │
│ ┌──────┴──────┐ internes  ┌───────────────┐  │  Token   ┌────────────────────┐
│ │  mvagent    │──Netz─────│    mvgate     │◄─┼──────────│ MapViewer3D        │
│ │ root, kein  │  (kein    │ Token, IP-    │  │  :8797   │ start -agent …     │
│ │ Port, kein  │ Internet) │ Liste, TLS,   │  │          │ + Console-API-Key  │
│ │ Internet    │           │ nur GET       │  │          └────────────────────┘
│ └─────────────┘           └───────────────┘  │
└──────────────────────────────────────────────┘
```

- **mvagent** – aus den MapViewer3D-Quellen gebaut (Release-Tag `MV_REF`). `pid: host` lässt ihn die Spielserver-Prozesse der Dune-Docker-Container sehen; zum Lesen ihres Speichers braucht er `SYS_PTRACE` + `DAC_OVERRIDE`. Alle anderen Rechte sind entzogen, das Dateisystem ist schreibgeschützt, er hat **keinen veröffentlichten Port und kein Internet** (internes Netz).
- **mvgate** – der einzige veröffentlichte Port. Prüft ein Token (Basic oder Bearer), optional eine IP-Liste, sperrt eine IP nach 10 Fehlversuchen für 10 Minuten, leitet nur `GET /stream`, `/healthz`, `/api/objects` weiter, gibt das Token nie weiter, TLS optional. Läuft ohne root.

## Voraussetzungen

- Ein laufender Dune-Docker-Host (Linux, Docker mit Compose v2). Unter Docker Desktop/WSL2 genauso: `pid: host` meint dort die Docker-VM, in der auch die Spiel-Container laufen.
- MapViewer3D **ab Beta.9** auf deinem PC (empfohlen Beta.15), schon mit API-Key an die Console angebunden (`apiBase` + `token`, siehe Haupt-README).
- Geprüft mit Spiel-Build `2134304`; nach einem Spiel-Update ermittelt der Agent seine Offsets selbst neu (siehe Agent-Doku).

## Installation (auf dem Dune-Docker-Host)

```bash
git clone --branch ddp --depth 1 https://github.com/dev-prophet-code/MapViewer3D.git mapviewer-live
cd mapviewer-live
cp .env.example .env
sed -i "s/^MV_GATE_TOKEN=.*/MV_GATE_TOKEN=$(openssl rand -hex 24)/" .env
docker compose -f docker-compose.mapviewer-live.yml up -d --build
docker compose -f docker-compose.mapviewer-live.yml logs -f mvagent
```

Das Agent-Log nennt jeden gefundenen Spielserver-Prozess und wie viele Objekte er liest (Hagga-Becken ≈ 2500, Tiefe Wüste ≈ 250). Die Overmap ist absichtlich „nicht bereit“.

Port **8797/TCP** in der Firewall öffnen – am besten nur für die eigene IP (`MV_GATE_ALLOW`), siehe *Sicherheit*.

## Lokalen MapViewer3D verbinden

Die Agent-Adresse in die Konfigurationsdatei des Viewers (`-config config.json`) schreiben statt auf die Kommandozeile, damit das Token nicht in der Prozessliste steht:

```json
{
  "apiBase": "http://DEIN-SERVER:8088",
  "token": "dak_…",
  "agentUrl": "https://mv:DEIN_GATE_TOKEN@DEIN-SERVER:8797"
}
```

oder für einen schnellen Test:

```bash
./start.sh -agent "http://mv:DEIN_GATE_TOKEN@DEIN-SERVER:8797"
```

Der Benutzername (`mv`) ist egal; das Passwort ist das Gate-Token. Der Viewer zeigt dann die Schalter **Sandwürmer (live)**, **Gegner**, **Zivilisten & Händler**, **Fahrzeuge (live)** und die Stürme. Mit `MV_AGENT_PLAYERS=true` bewegen sich Online-Spieler in Echtzeit; der Viewer zeigt nur Spieler, die er den Online-Spielern der Console zuordnen kann.

## Sicherheit

Der Agent sieht Positionen, mit `MV_AGENT_PLAYERS=true` auch die von Spielern. Das Gate-Token ist so schützenswert wie ein Admin-Key der Console.

Eine Variante wählen, von am besten bis am einfachsten:

1. **SSH-Tunnel / VPN (kein offener Port).** `MV_GATE_BIND=127.0.0.1` setzen und vom PC aus `ssh -N -L 8797:127.0.0.1:8797 du@server`, dann `agentUrl: "http://mv:TOKEN@127.0.0.1:8797"`.
2. **TLS im Gate.** `fullchain.pem`/`privkey.pem` für den Servernamen (z. B. Let's Encrypt) nach `./certs`, `MV_GATE_TLS_CERT=/certs/fullchain.pem` und `MV_GATE_TLS_KEY=/certs/privkey.pem` setzen, in `agentUrl` `https://…` verwenden. Ein selbst signiertes Zertifikat geht nicht (der Viewer prüft es).
3. **Reverse Proxy** (nginx, Caddy, …) mit TLS vor `127.0.0.1:8797` (`MV_GATE_BIND=127.0.0.1`). Achtung: Das Gate sieht dann den Proxy als Absender, IP-Liste und Sperre gelten also für den Proxy – IPs dann im Proxy filtern.
4. **Einfaches HTTP + IP-Liste** (`MV_GATE_ALLOW=<deine IP>`): Token und Positionen gehen unverschlüsselt durchs Netz. Nur fürs LAN oder zum Testen.

Außerdem:

- `MV_AGENT_PLAYERS=false` lassen, solange keine Live-Spieler gebraucht werden.
- PvP: Würmer und Gegner folgen Spielern, ihre Bewegung kann also verraten, wo Spieler sind. Das Token nicht an Spieler geben.
- Den Agenten selbst (Port 8796) nie veröffentlichen; die Compose-Datei tut das nicht.
- Bekannte Lücke: Nach 30 s fehlgeschlagener Verbindung schreibt der Viewer die Agent-Adresse samt Token in sein eigenes lokales Log. Das Log privat halten (Korrektur in MapViewer3D geplant).
- Token wechseln: `.env` ändern, dann `docker compose -f docker-compose.mapviewer-live.yml up -d`.

## Einstellungen (`.env`)

| Variable | Standard | Bedeutung |
|---|---|---|
| `MV_GATE_TOKEN` | – (Pflicht) | ≥ 24 Zeichen, kein `:` `@` `/` (steht in einer URL) |
| `MV_REF` | `beta.15` | MapViewer3D-Release-Tag, aus dem der Agent gebaut wird |
| `MV_AGENT_PLAYERS` | `false` | auch Spieler lesen |
| `MV_AGENT_HZ` | `10` | Abtastrate bewegter Objekte |
| `MV_AGENT_CPUS` | `1.0` | CPU-Grenze des Agenten (die Suche liest den ganzen Prozessspeicher) |
| `MV_AGENT_APPARMOR` | `docker-default` | `unconfined` nur, wenn das Log `permission denied` bei `/proc/<pid>/mem` zeigt |
| `MV_GATE_ALLOW` | leer = alle | IPs / CIDRs, die verbinden dürfen |
| `MV_GATE_BIND` / `MV_GATE_PORT` | `0.0.0.0` / `8797` | wo das Gate auf dem Host lauscht |
| `MV_GATE_MAX_STREAMS` | `8` | gleichzeitige Viewer |
| `MV_GATE_TLS_CERT` / `MV_GATE_TLS_KEY` | leer | TLS-Dateien im Container (`/certs/…`) |
| `MV_GATE_CERT_DIR` | `./certs` | Host-Ordner, der unter `/certs` eingehängt wird |

## Aktualisieren, stoppen, entfernen

```bash
git pull                                                     # neue Compose-Datei/Gate
# neues MapViewer3D-Release: MV_REF in .env setzen, dann
docker compose -f docker-compose.mapviewer-live.yml up -d --build
docker compose -f docker-compose.mapviewer-live.yml down     # stoppen und entfernen
```

Im Container aktualisiert sich der Agent nie selbst (`-auto-update` wird nicht benutzt); ein neues Release heißt neu bauen mit neuem `MV_REF`.

## Fehlersuche

| Symptom | Ursache / Lösung |
|---|---|
| Agent-Log: keine Spielserver-Prozesse | Dune Docker läuft nicht, oder der Container hat kein `pid: host` (Podman/rootless Docker werden nicht unterstützt) |
| `permission denied` bei `/proc/<pid>/mem` | AppArmor/SELinux: `MV_AGENT_APPARMOR=unconfined` (AppArmor). Bei SELinux `label=disable` in `security_opt` von `mvagent` ergänzen. `kernel.yama.ptrace_scope=3` verhindert es ganz. |
| Viewer: `HTTP 401` | falsches Token in `agentUrl` |
| Viewer: `HTTP 403` | deine IP steht nicht in `MV_GATE_ALLOW` |
| Viewer: `HTTP 429` | 10 Fehlversuche: 10 Minuten warten |
| Viewer: TLS-Fehler | Zertifikat passt nicht zum Hostnamen in `agentUrl` oder ist selbst signiert |
| nach einem Spiel-Update alles „nicht bereit“ | im Agent-Log nach „neu bestimmt“ schauen; klappt es nicht, `-blocks/-root/-pos` setzen (Agent-Doku) |

Gate vom PC aus testen: `curl -u mv:TOKEN http://DEIN-SERVER:8797/healthz`.

## Entwicklung

```bash
cd gate && go test ./...                         # Gate-Tests
docker compose -f docker-compose.mapviewer-live.yml build
```

## Lizenz

MIT, wie MapViewer3D. Inoffizielles Community-Projekt, nicht verbunden mit Funcom oder Red-Blink.

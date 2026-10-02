# MapViewer3D-Echtzeitdaten für Dune Docker

[English](README.md) · [Sicherheit](SECURITY.md) · [Einbindung in Dune Docker](dune-docker-integration/README.md)

Echtzeit-**Sandwürmer, Gegner, Zivilisten, Fahrzeuge, Sandstürme** (und auf Wunsch **Spieler**) von einem [Dune-Docker](https://github.com/Red-Blink/dune-awakening-selfhost-docker)-Server in einem **MapViewer3D, der auf deinem eigenen PC läuft**. Der Zugang ist ein normaler **API-Key** der Console mit dem Recht **Realtime Data**.

> Branch `ddp` von MapViewer3D: in Arbeit, noch nicht Teil eines Releases.

## So funktioniert es

Die Live-Map von Dune Docker liest Postgres. Spieler und Fahrzeuge stehen in der Datenbank, **Sandwürmer, NPCs und Stürme aber nicht**: Es gibt sie nur im Speicher des laufenden Spielserver-Prozesses. Der Positions-Agent `mvagent` von MapViewer3D liest sie dort, nur lesend, etwa 10-mal pro Sekunde ([docs/Agent-DE.md](https://github.com/dev-prophet-code/MapViewer3D/blob/main/docs/Agent-DE.md)).

```
 Dune-Docker-Host                                                    dein PC
┌──────────────────────────────────────────────────────┐
│ dune-server-*-Container (Spielprozesse)              │
│        ▲ nur lesend /proc/<pid>/mem                  │
│ ┌──────┴───────┐ 127.0.0.1:8796 ┌─────────────────┐  │ HTTPS     ┌─────────────────┐
│ │   mvagent    │◄───────────────│ Dune-Docker-    │◄─┼───────────│ MapViewer3D     │
│ │ kein Port,   │   (loopback)   │ Console         │  │ API-Key   │ ab Beta.16      │
│ │ kein Login   │                │ /api/realtime/* │  │ „Realtime │                 │
│ └──────────────┘                └─────────────────┘  │  Data“    └─────────────────┘
└──────────────────────────────────────────────────────┘
```

- **mvagent** (dieses Repository) – ein Container neben Dune Docker. `pid: host`, um die Spielprozesse zu sehen, nur `SYS_PTRACE` + `DAC_OVERRIDE`, AppArmor `unconfined` wie die Dune-Container, schreibgeschütztes Dateisystem. Er lauscht **nur auf 127.0.0.1:8796 des Hosts**; nach außen ist nichts offen.
- **Dune-Docker-Console** – die einzige Tür. Ihre Routen `/api/realtime/*` prüfen den API-Key wie jeden anderen API-Aufruf. Dafür braucht es die Änderung aus [dune-docker-integration/](dune-docker-integration/README.md), die noch nicht Teil von Dune Docker ist.
- **MapViewer3D** (ab Beta.16) – fragt die Console kurz, ob Realtime Data für seinen Key verfügbar ist. Wenn nicht (ältere Dune-Docker-Version, kein Agent, Key ohne das Recht, kein HTTPS), werden die Live-Schalter einfach nicht angezeigt.

## Voraussetzungen

- Ein Dune-Docker-Host (Linux, Docker mit Compose v2 und BuildKit) mit der Console-Änderung aus [dune-docker-integration/](dune-docker-integration/README.md).
- Die Console ist von deinem PC aus per **HTTPS** erreichbar (z. B. Caddy oder nginx vor Port 8088). MapViewer3D nutzt Realtime Data nicht über unverschlüsseltes HTTP, außer auf demselben Rechner.
- MapViewer3D **ab Beta.16**, mit einem API-Key an die Console angebunden.
- Geprüft mit Spiel-Build `2134304`; nach einem Spiel-Update ermittelt der Agent seine Offsets selbst neu.

## 1. Agent installieren (auf dem Dune-Docker-Host)

```bash
git clone --branch ddp --depth 1 https://github.com/dev-prophet-code/MapViewer3D.git mapviewer-live
cd mapviewer-live
cp .env.example .env
docker compose -f docker-compose.mapviewer-live.yml up -d --build
docker compose -f docker-compose.mapviewer-live.yml logs -f
```

Das Log nennt jeden Spielserver-Prozess und wie viele Objekte er liest (Hagga-Becken ≈ 2500, Tiefe Wüste ≈ 250). Die Overmap ist absichtlich „nicht bereit“. An der Firewall muss nichts geändert werden.

## 2. „Realtime Data“ für einen API-Key freischalten

In der Console: **Settings → API Keys → Create Key**. Neben Maps, Players und den anderen gibt es eine Zeile **Realtime Data** mit **None / Read**:

- **Read** – Sandwürmer, Gegner, Zivilisten, Fahrzeuge und Stürme.
- Für Live-**Spieler**positionen zusätzlich **Players → Read** und `MV_AGENT_PLAYERS=true` in `.env`.
- Key deaktivieren, ablaufen lassen oder widerrufen sperrt den Zugang; ein offener Strom endet innerhalb von 10 Sekunden.

Die Console-Oberfläche ist, wie die ganze Console, auf Englisch.

## 3. MapViewer3D verbinden

Den Key als Console-Token des Viewers verwenden (`apiBase` = HTTPS-Adresse der Console, `token` = der Key). Beim Start fragt der Viewer `/api/realtime/healthz` (höchstens 5 s):

- verfügbar und erlaubt → die Schalter **Sandwürmer (live)**, **Gegner**, **Zivilisten & Händler**, **Fahrzeuge (live)** und die Stürme erscheinen;
- sonst bleiben sie ausgeblendet und das Log sagt warum (Dune Docker ohne die Funktion, Agent läuft nicht, Key ohne „Realtime Data“, Console nicht per HTTPS, Zertifikat passt nicht). Alle 10 Minuten fragt er erneut.

**Selbst signiertes oder internes Zertifikat** (z. B. Caddy `tls internal`): Der Viewer lehnt es ab und schreibt seinen Fingerabdruck ins Log. Auf dem Server vergleichen und festlegen:

```bash
./start.sh -api-pin sha256/…        # oder "apiPin" in der Konfigurationsdatei, oder MV_API_PIN
```

## Sicherheit in Kürze

- Ein einziger Zugang: der API-Key der Console. Rechte, Ablaufdatum, Rate-Limit, Audit-Log und Widerruf gelten; kein zusätzlicher Port, kein zusätzliches Geheimnis.
- Der Agent ist nur über das Loopback des Hosts erreichbar; er hat keinen Login und keinen veröffentlichten Port.
- Spielerpositionen brauchen „Realtime Data“ und „Players → Read“ (und `MV_AGENT_PLAYERS=true`).
- Der Viewer schickt den Key nur über HTTPS (oder an denselben Rechner) und prüft das Zertifikat – über die Zertifikatsstellen des Systems oder einen festgelegten Fingerabdruck.
- Im PvP folgen Würmer und Gegner den Spielern: solche Keys nicht an Spieler geben.

Einzelheiten: [SECURITY.md](SECURITY.md).

## Einstellungen (`.env`)

| Variable | Standard | Bedeutung |
|---|---|---|
| `MV_REF` / `MV_COMMIT` | `beta.15` / dessen Commit | MapViewer3D-Release, aus dem der Agent gebaut wird; zeigt das Tag woanders hin, bricht der Bau ab |
| `MV_AGENT_PLAYERS` | `false` | auch Spieler lesen |
| `MV_AGENT_HZ` | `10` | Abtastrate bewegter Objekte |
| `MV_AGENT_CPUS` | `1.0` | CPU-Grenze (die Suche liest den ganzen Prozessspeicher) |
| `MV_AGENT_PORT` | `8796` | Loopback-Port; die Console liest `DUNE_REALTIME_AGENT_URL` (Standard `http://127.0.0.1:8796`) |
| `MV_AGENT_APPARMOR` | `unconfined` | Dune Docker startet die Spiel-Container privilegiert und AppArmor-`unconfined`; `docker-default` darf solche Prozesse nicht lesen (`permission denied`, Kernel-Log `apparmor="DENIED" … peer="unconfined"`) |

## Aktualisieren, stoppen, entfernen

```bash
git pull
# neues MapViewer3D-Release: MV_REF und MV_COMMIT in .env setzen, dann
docker compose -f docker-compose.mapviewer-live.yml up -d --build
docker compose -f docker-compose.mapviewer-live.yml down
```

## Fehlersuche

| Symptom | Ursache / Lösung |
|---|---|
| Agent-Log: keine Spielserver-Prozesse | Dune Docker läuft nicht, oder kein `pid: host` (Podman/rootless Docker werden nicht unterstützt) |
| `permission denied` bei `/proc/<pid>/mem` | `MV_AGENT_APPARMOR=unconfined` lassen; `DENIED` in `sudo dmesg` suchen; `kernel.yama.ptrace_scope=3` verhindert es ganz |
| Viewer: „Dune Docker hat Realtime Data nicht“ | Console ohne die Einbindung |
| Viewer: „Key hat kein Realtime Data“ | dem Key **Realtime Data → Read** geben |
| Viewer: „Agent läuft nicht“ (503) | diesen Stack starten; sein Log prüfen |
| Viewer: „nicht per HTTPS“ | Console per HTTPS öffnen (Reverse Proxy) oder den Viewer auf dem Host selbst starten |
| Viewer: Zertifikatsfehler mit Fingerabdruck | internes Zertifikat: Fingerabdruck auf dem Server vergleichen, dann `-api-pin` |
| nach einem Spiel-Update alles „nicht bereit“ | im Agent-Log nach „neu bestimmt“ schauen |

## Lizenz

MIT, wie MapViewer3D. Inoffizielles Community-Projekt, nicht verbunden mit Funcom oder Red-Blink.

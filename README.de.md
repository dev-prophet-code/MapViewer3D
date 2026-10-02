# MapViewer3D-Echtzeitdaten für Dune Docker

[English](README.md) · [Sicherheit](SECURITY.md) · [Einbindung in Dune Docker](dune-docker-integration/README.md)

Echtzeit-**Sandwürmer, Gegner, Zivilisten, Fahrzeuge, Sandstürme** (und auf Wunsch **Spieler**) von einem [Dune-Docker](https://github.com/Red-Blink/dune-awakening-selfhost-docker)-Server in einem **MapViewer3D, der auf deinem eigenen PC läuft**. Der Zugang ist ein normaler **API-Key** der Console mit dem Recht **Realtime Data**.

> Branch `ddp` von MapViewer3D: in Arbeit, noch nicht Teil eines Releases.

## So funktioniert es

Die Live-Map von Dune Docker liest Postgres. Spieler und Fahrzeuge stehen in der Datenbank, **Sandwürmer, NPCs und Stürme aber nicht**: Es gibt sie nur im Speicher des laufenden Spielserver-Prozesses. Der Positions-Agent `mvagent` von MapViewer3D liest sie dort, nur lesend, etwa 10-mal pro Sekunde ([docs/Agent-DE.md](https://github.com/dev-prophet-code/MapViewer3D/blob/main/docs/Agent-DE.md)).

```
 Dune-Docker-Host                                                          dein PC
┌─────────────────────────────────────────────────────────────┐
│ dune-server-*-Container (Spielprozesse)                     │
│        ▲ nur lesend /proc/<pid>/mem                         │
│ ┌──────┴───────┐ 127.0.0.1:8796 ┌─────────────────┐        │
│ │   mvagent    │◄───────────────│ Dune-Docker-    │◄─ 8088 │ einfaches HTTP (wie bisher,
│ │ kein Port,   │   (loopback)   │ Console         │        │  für alle anderen)
│ │ kein Login   │                │ /api/realtime/* │◄───┐   │
│ └──────────────┘                └─────────────────┘    │   │
│                                  ┌─────────────────┐   │   │ HTTPS ┌────────────────┐
│                                  │ mvtls (optional)│───┘   │◄──────│ MapViewer3D    │
│                                  │ eigener Schlüss.│ :8797 │ API-Key│ ab Beta.16     │
│                                  └─────────────────┘       │       └────────────────┘
└─────────────────────────────────────────────────────────────┘
```

- **mvagent** (dieses Repository) – ein Container neben Dune Docker. `pid: host`, um die Spielprozesse zu sehen, nur `SYS_PTRACE` + `DAC_OVERRIDE`, AppArmor `unconfined` wie die Dune-Container, schreibgeschütztes Dateisystem. Er lauscht **nur auf 127.0.0.1:8796 des Hosts**; nach außen ist nichts offen.
- **Dune-Docker-Console** – die einzige Tür. Ihre Routen `/api/realtime/*` prüfen den API-Key wie jeden anderen API-Aufruf. Dafür braucht es die Änderung aus [dune-docker-integration/](dune-docker-integration/README.md), die noch nicht Teil von Dune Docker ist.
- **mvtls** (dieses Repository, optional) – der **verschlüsselte Eingang**: HTTPS mit eigenem, langlebigem Schlüssel, den der Viewer festlegt, und Weiterleitung an die unveränderte Console auf `127.0.0.1:8088`. Für die Verschlüsselung muss an Dune Docker nichts geändert werden, und alle anderen nutzen `http://…:8088` genau wie bisher. Siehe [Verschlüsselte Verbindung](#verschlüsselte-verbindung).
- **MapViewer3D** (ab Beta.16) – fragt die Console kurz, ob Realtime Data für seinen Key verfügbar ist. Wenn nicht (ältere Dune-Docker-Version, kein Agent, Key ohne das Recht, keine verschlüsselte Verbindung), werden die Live-Schalter einfach nicht angezeigt. `mvtls` erkennt er selbst und bietet an, es zu nutzen.

## Voraussetzungen

- Ein Dune-Docker-Host (Linux, Docker mit Compose v2 und BuildKit) mit der Console-Änderung aus [dune-docker-integration/](dune-docker-integration/README.md).
- Eine **verschlüsselte Verbindung** von deinem PC zur Console: der Eingang `mvtls` dieses Stacks (empfohlen, [unten](#verschlüsselte-verbindung)), oder ein eigener Reverse Proxy mit Zertifikat, oder ein SSH-Tunnel/VPN. MapViewer3D nutzt Realtime Data nur über HTTPS (oder auf demselben Rechner).
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

## Verschlüsselte Verbindung

Die Console spricht einfaches HTTP (`http://host:8088`): API-Key und alle Antworten gehen im Klartext übers Netz. Der optionale Container **`mvtls`** behebt das für den Viewer, ohne Dune Docker oder die Einrichtung anderer anzufassen:

```bash
docker compose -f docker-compose.mapviewer-live.yml --profile tls up -d --build
docker compose -f docker-compose.mapviewer-live.yml exec mvtls mvtls -pin     # Fingerabdruck des Schlüssels (nicht geheim)
```

Port **8797/TCP** öffnen (am besten nur für die eigene IP: `MV_TLS_ALLOW`). Beim ersten Start erzeugt `mvtls` seinen **eigenen Schlüssel** (ECDSA P-256, im Volume `mvtls-data`) mit einem 20 Jahre gültigen Zertifikat. Der Viewer legt den **Schlüssel** fest, der Fingerabdruck ändert sich also nie von selbst – nicht nach einem Neustart und nicht, wenn das Zertifikat neu ausgestellt wird (z. B. nach Änderung von `MV_TLS_NAMES`). Das Volume sichern; geht es verloren, ändert sich der Fingerabdruck und Viewer müssen den neuen bestätigen.

- **API-Tür (Standard):** nur `GET`/`HEAD` auf `/api/*` und `/images/maps/*`, nur mit `Authorization: Bearer dak_…` (die öffentlichen Marker-Bilder ausgenommen). Sitzungen und Cookies kommen nie durch, die Routen `auth`, `settings` und `setup` der Console sind nicht erreichbar, und die Weboberfläche der Console wird auf diesem Port **nicht** angeboten. Es entsteht also kein neuer Weg in die Admin-Console.
- **Brute Force:** abgelehnte API-Keys zählt `mvtls` pro Absenderadresse (die Console sieht hinter einem Proxy nur `127.0.0.1` und würde alle zusammenwerfen); 10 Ablehnungen pro Minute sperren die Adresse für 10 Minuten.
- **`MV_TLS_FULL=true`** leitet zusätzlich die Weboberfläche und den Login der Console weiter, damit sich die ganze Console verschlüsselt öffnen lässt (nötig für das Console-Addon über HTTPS). Damit liegt der Admin-Login auf diesem Port – nur mit `MV_TLS_ALLOW` und gut überlegt, wenn die Console bewusst nicht öffentlich ist.
- Eine Console, die schon hinter einem eigenen Reverse Proxy mit echtem Zertifikat steht (Caddy/nginx + Let's Encrypt), braucht kein `mvtls`.

**Fest in Dune Docker (Patch 2 in [dune-docker-integration/](dune-docker-integration/README.md)):** Der Dune-Docker-Installer startet diesen Eingang dann selbst und zeigt Adresse und **Fingerabdruck des Schlüssels** unter dem ersten Admin-Passwort an; derselbe Wert steht in **Settings → Encrypted API Access** (mit Ein/Aus-Schalter) und bei `dune encrypted-api fingerprint`. Ohne diesen Patch den Container dieses Stacks wie oben beschrieben starten.

**Der Viewer findet es selbst.** Ist MapViewer3D (ab Beta.16) per einfachem HTTP mit einer Console verbunden, fragt er auf demselben Host den Port 8797 an (TLS-Handshake ohne Token, dazu `GET /mvtls`). Antwortet `mvtls`, zeigt der Viewer den **Fingerabdruck** und bittet, ihn mit der Ausgabe von `mvtls -pin` auf dem Server zu vergleichen. **Dieser Vergleich hält einen Angreifer in der Mitte draußen**, deshalb ist es ein bewusster Klick und keine Automatik. Nach der Bestätigung legt der Viewer den Schlüssel fest, sendet den Token nur noch verschlüsselt und nutzt den Weg ab dann für alles (Karten, Basen, Symbole, Realtime Data). Kennt er den Fingerabdruck schon (`-api-pin`), stellt er ohne Rückfrage um.

## 2. „Realtime Data“ für einen API-Key freischalten

In der Console: **Settings → API Keys → Create Key**. Neben Maps, Players und den anderen gibt es eine Zeile **Realtime Data** mit **None / Read**:

- **Read** – Sandwürmer, Gegner, Zivilisten, Fahrzeuge und Stürme.
- Für Live-**Spieler**positionen zusätzlich **Players → Read** und `MV_AGENT_PLAYERS=true` in `.env`.
- Key deaktivieren, ablaufen lassen oder widerrufen sperrt den Zugang; ein offener Strom endet innerhalb von 10 Sekunden.

Die Console-Oberfläche ist, wie die ganze Console, auf Englisch.

## 3. MapViewer3D verbinden

Den Key als Console-Token des Viewers verwenden (Server = Adresse der Console, `token` = der Key; mit `mvtls` bietet der Viewer `https://<Host>:8797` selbst an, siehe oben). Beim Start fragt der Viewer `/api/realtime/healthz` (höchstens 5 s):

- verfügbar und erlaubt → die Schalter **Sandwürmer (live)**, **Gegner**, **Zivilisten & Händler**, **Fahrzeuge (live)** und die Stürme erscheinen;
- sonst bleiben sie ausgeblendet und das Log sagt warum (Dune Docker ohne die Funktion, Agent läuft nicht, Key ohne „Realtime Data“, Console nicht per HTTPS, Zertifikat passt nicht). Alle 10 Minuten fragt er erneut.

**Selbst signiertes oder internes Zertifikat** (z. B. Caddy `tls internal`): Der Viewer lehnt es ab und nennt beim Einrichten seinen Fingerabdruck. Auf dem Server vergleichen und im Feld **Zertifikats-Fingerabdruck** der Einrichtung eintragen (wird je Server gespeichert; **Server wechseln** hält mehrere Server bereit), oder für alle Verbindungen:

```bash
./start.sh -api-pin sha256/…        # oder "apiPin" in der Konfigurationsdatei, oder MV_API_PIN
```

## Sicherheit in Kürze

- Ein einziger Zugang: der API-Key der Console. Rechte, Ablaufdatum, Rate-Limit, Audit-Log und Widerruf gelten; kein zusätzliches Geheimnis. Der verschlüsselte Eingang fügt einen Port (8797) hinzu und keinen neuen Weg in die Admin-Console.
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
| `MV_TLS_PORT` / `MV_TLS_BIND` | `8797` / `0.0.0.0` | wo `mvtls` lauscht (Profil `tls`) |
| `MV_TLS_UPSTREAM` | `http://127.0.0.1:8088` | wo die Console auf dem Host lauscht |
| `MV_TLS_NAMES` | leer | Hostnamen / IPs im Zertifikat (nur für Browser; der Viewer legt den Schlüssel fest). Schlüssel und Fingerabdruck bleiben |
| `MV_TLS_ALLOW` | leer = alle | IPs / CIDRs, die zu `mvtls` verbinden dürfen |
| `MV_TLS_FULL` | `false` | auch Weboberfläche und Login der Console weiterleiten (siehe oben) |
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
| Viewer: „nicht per HTTPS“ | `mvtls` starten (`--profile tls`) und seinen Fingerabdruck im Viewer bestätigen, oder die Console hinter einen eigenen HTTPS-Proxy setzen, oder den Viewer auf dem Host selbst starten |
| Viewer zeigt kein Angebot für `mvtls` | Port 8797 zu/blockiert, `MV_TLS_ALLOW` schließt dich aus, oder „Jetzt nicht“ gewählt (der Viewer merkt es sich; „Ändern“/„Server hinzufügen“ mit `https://<Host>:8797`) |
| `mvtls`-Log: „console unreachable“ | die Console lauscht nicht auf `MV_TLS_UPSTREAM` (anderer Port oder an eine einzelne Adresse gebunden) |
| Viewer: Zertifikatsfehler mit Fingerabdruck | internes Zertifikat: Fingerabdruck auf dem Server vergleichen (`mvtls -pin`), dann bestätigen / `-api-pin` |
| nach einem Spiel-Update alles „nicht bereit“ | im Agent-Log nach „neu bestimmt“ schauen |

## Lizenz

MIT, wie MapViewer3D. Inoffizielles Community-Projekt, nicht verbunden mit Funcom oder Red-Blink.

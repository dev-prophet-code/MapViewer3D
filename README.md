<a id="english"></a>

# 🏜️ MapViewer 3D – Addon v2

**English** · [Deutsch](#deutsch)

3D map for self-hosted *Dune: Awakening* servers running the [Red-Blink Dune-Docker stack](https://github.com/Red-Blink/dune-awakening-selfhost-docker): Hagga Basin and Deep Desert with players, bases and, with Realtime Data, sandworms, enemies, vehicles and storms. Read-only.

> Unofficial fan project, not affiliated with Funcom. Based on [MapViewer3D](https://github.com/dev-prophet-code/MapViewer3D) (MIT).

**Version 2.0.1** · versioning: every change adds 0.0.1 · branch `mva-v2`

## Two parts

| | **Addon** (`addon/`) | **Companion** (`companion/`) |
|---|---|---|
| Runs | inside the console (page "3D Map v2") | as its own container next to the console |
| Install | ZIP via the console's Addons page | `docker compose up -d --build` |
| Network | none (console sandbox) | talks to the console and the CDN |
| Terrain | embedded, 16 m (Hagga) / 48 m (Deep Desert) | streamed, down to 1 m, every tile checked by SHA-256 |
| Players, bases | bridge `database.query` (read-only) | console API |
| Realtime (worms, NPCs, …) | ❌ | ✅ if the token allows it |
| Sign-in | via the console | **API token** (`dak_…`), Realtime Data check |

The console runs addons with `sandbox="allow-scripts"` and `connect-src 'none'`. An addon therefore cannot use a token or load anything; everything that needs a network is done by the companion. Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Start the companion

1. In the console under *Settings → API Keys* create a key with **Maps: Read**, **Bases: Read**, optionally **Realtime Data: Read** (and **Players: Read**).
2. `cd companion && cp .env.example .env`, set `CONSOLE_URL` (https preferred, port 8797), then `docker compose up -d --build`. Without Docker: `CONSOLE_URL=… node server.mjs` (Node ≥ 22, no dependencies).
3. Open `http://127.0.0.1:8799` and enter the token. It stays only in the companion's memory.

On sign-in the companion checks automatically whether Realtime Data is active: **yes** → realtime mode; **no** (scope missing, agent not running) → fallback with everything the regular routes offer. The reason is shown in the system check, and "Check again" switches later. For access from outside, put a TLS reverse proxy in front ([docs/SECURITY-CONCEPT.md](docs/SECURITY-CONCEPT.md)).

## Install the addon

`bash addon/scripts/package.sh` creates `dist/mapviewer3d-v2-<version>.zip` plus its SHA-256. The addon asks for `database:read` (read-only SQL) and `files:addon-data`.

> **Note:** the addon's SQL queries follow the console's own queries but were not tested against a running console bridge. If they fail, the page still shows the terrain and reports the error in the status list.

## Develop

```bash
node scripts/build.mjs                      # builds addon/web/index.html and companion/public/
node --test addon/test/addon.test.mjs       # package checks
node --test companion/test/companion.test.mjs
node companion/test/pentest.mjs             # attack tests, Markdown table
python3 -I tools/embed-terrain.py <cdn-clone> survival_1 addon/data/terrain-survival_1.json 1025
```

```
addon/       console addon (addon.json, built page, validation, tests, embedded terrain)
companion/   Node server (lib/), built page (public/), Docker, tests and pentest
viewer/      viewer source (core.js, addon-app.js, companion-app.js, templates)
vendor/      three.js 0.170.0 (MIT)
tools/       terrain embedding from the cdn branch
docs/        architecture, security concept, review report
```

## Security

No token, password or IP address is ever stored in this repository. The token lives only in the companion's memory; the browser holds a random session ID (HttpOnly, SameSite=Strict). Every map file is verified by SHA-256. See [SECURITY.md](SECURITY.md), [docs/SECURITY-CONCEPT.md](docs/SECURITY-CONCEPT.md) and the code review and penetration test results in [docs/REVIEW-2.0.0.md](docs/REVIEW-2.0.0.md).

## Not in 2.0.x

3D buildings from building-piece meshes (bases appear as markers), sandstorm/Coriolis layouts of the Deep Desert, share links. Player positions from the realtime stream are not used; players come from the console API.

---

<a id="deutsch"></a>

# 🏜️ MapViewer 3D – Addon v2 (Deutsch)

[English](#english) · **Deutsch**

3D-Karte für selbst gehostete *Dune: Awakening*-Server mit dem [Red-Blink Dune-Docker-Stack](https://github.com/Red-Blink/dune-awakening-selfhost-docker): Hagga Basin und Deep Desert mit Spielern, Basen und – mit Realtime Data – Sandwürmern, Gegnern, Fahrzeugen und Stürmen. Nur lesend.

> Inoffizielles Fan-Projekt, nicht mit Funcom verbunden. Basiert auf [MapViewer3D](https://github.com/dev-prophet-code/MapViewer3D) (MIT).

**Version 2.0.1** · Versionierung: jede Anpassung +0.0.1 · Branch `mva-v2`

## Zwei Teile

| | **Addon** (`addon/`) | **Companion** (`companion/`) |
|---|---|---|
| Läuft | in der Console (Seite „3D Map v2“) | als eigener Container neben der Console |
| Installation | ZIP über die Console-Addon-Seite | `docker compose up -d --build` |
| Netzwerk | keins (Console-Sandbox) | spricht mit Console und CDN |
| Gelände | eingebettet, 16 m (Hagga) / 48 m (Deep Desert) | gestreamt, bis 1 m, jede Kachel per SHA-256 geprüft |
| Spieler, Basen | Brücke `database.query` (nur lesen) | Console-API |
| Realtime (Würmer, NPCs, …) | ❌ | ✅ wenn der Token es darf |
| Anmeldung | über die Console | **API-Token** (`dak_…`), Prüfung von Realtime Data |

Die Console startet Addons mit `sandbox="allow-scripts"` und `connect-src 'none'`. Ein Addon kann deshalb keinen Token verwenden und nichts nachladen; alles, was Netzwerk braucht, übernimmt der Companion. Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Companion starten

1. In der Console unter *Settings → API Keys* einen Key mit **Maps: Read**, **Bases: Read**, optional **Realtime Data: Read** (und **Players: Read**) anlegen.
2. `cd companion && cp .env.example .env`, `CONSOLE_URL` eintragen (bevorzugt https, Port 8797), dann `docker compose up -d --build`. Ohne Docker: `CONSOLE_URL=… node server.mjs` (Node ≥ 22, keine Abhängigkeiten).
3. `http://127.0.0.1:8799` öffnen, den Token eingeben. Er bleibt nur im Arbeitsspeicher des Companion.

Beim Anmelden prüft der Companion automatisch, ob Realtime Data aktiv ist: **ja** → Echtzeit-Modus; **nein** (Scope fehlt, Agent läuft nicht) → Fallback mit allen Daten der regulären Routen. Der Grund steht in der Systemprüfung, „Erneut prüfen“ wechselt später um. Für den Zugriff von außen einen TLS-Reverse-Proxy davor setzen ([docs/SECURITY-CONCEPT.md](docs/SECURITY-CONCEPT.md)).

## Addon installieren

`bash addon/scripts/package.sh` erzeugt `dist/mapviewer3d-v2-<Version>.zip` samt SHA-256. Das Addon verlangt `database:read` (nur lesende SQL) und `files:addon-data`.

> **Hinweis:** Die SQL-Abfragen des Addons sind an den Abfragen der Console ausgerichtet, wurden aber nicht gegen eine laufende Console-Brücke getestet. Bei einem Fehler zeigt die Seite trotzdem das Gelände und meldet den Fehler in der Statusliste.

## Entwickeln

```bash
node scripts/build.mjs                      # baut addon/web/index.html und companion/public/
node --test addon/test/addon.test.mjs       # Paket-Prüfung
node --test companion/test/companion.test.mjs
node companion/test/pentest.mjs             # Angriffstests, Markdown-Tabelle
python3 -I tools/embed-terrain.py <cdn-klon> survival_1 addon/data/terrain-survival_1.json 1025
```

Ordner: `addon/` (Console-Addon), `companion/` (Node-Server, Docker, Tests), `viewer/` (Quellcode des Viewers), `vendor/` (three.js, MIT), `tools/` (Gelände-Einbettung), `docs/` (Architektur, Sicherheitskonzept, Review).

## Sicherheit

Es werden nie Token, Passwörter oder IP-Adressen in diesem Repository gespeichert. Der Token liegt nur im Arbeitsspeicher des Companion; der Browser hält nur eine zufällige Sitzungs-ID (HttpOnly, SameSite=Strict). Jede Kartendatei wird per SHA-256 geprüft. Siehe [SECURITY.md](SECURITY.md), [docs/SECURITY-CONCEPT.md](docs/SECURITY-CONCEPT.md) sowie Code-Review und Penetrationstest in [docs/REVIEW-2.0.0.md](docs/REVIEW-2.0.0.md).

## Nicht in 2.0.x

3D-Gebäude aus Bauteil-Meshes (Basen erscheinen als Marker), Sandstürme/Coriolis-Layouts der Deep Desert, Share-Links. Spieler-Positionen im Echtzeit-Strom werden nicht verwendet; Spieler kommen aus der Console-API.

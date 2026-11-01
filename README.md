# 🏜️ MapViewer 3D – Addon v2

3D-Karte für selbst gehostete *Dune: Awakening*-Server mit dem [Red-Blink Dune-Docker-Stack](https://github.com/Red-Blink/dune-awakening-selfhost-docker): Hagga Basin und Deep Desert mit Spielern, Basen und – mit Realtime Data – Sandwürmern, Gegnern, Fahrzeugen und Stürmen. Nur lesend.

> Inoffizielles Fan-Projekt, nicht mit Funcom verbunden. Basiert auf [MapViewer3D](https://github.com/dev-prophet-code/MapViewer3D) (MIT).

**Version 2.0.0** · Versionierung: jede Anpassung +0.0.1 · Branch `mva-v2`

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

Beim Anmelden prüft der Companion automatisch, ob Realtime Data aktiv ist: **ja** → Echtzeit-Modus; **nein** (Scope fehlt, Agent läuft nicht) → Fallback mit allen Daten der regulären Routen, der Grund steht in der Systemprüfung, „Erneut prüfen“ wechselt später um. Für den Zugriff von außen einen TLS-Reverse-Proxy davor setzen ([docs/SECURITY-CONCEPT.md](docs/SECURITY-CONCEPT.md)).

## Addon installieren

`bash addon/scripts/package.sh` erzeugt `dist/mapviewer3d-v2-2.0.0.zip` samt SHA-256. Das Addon verlangt `database:read` (nur lesende SQL) und `files:addon-data`.

> **Hinweis:** Die SQL-Abfragen des Addons wurden an den Abfragen der Console ausgerichtet, aber nicht gegen eine laufende Console-Brücke getestet. Fehlerfall: Die Seite zeigt das Gelände und meldet den Fehler in der Statusliste.

## Entwickeln

```bash
node scripts/build.mjs                      # baut addon/web/index.html und companion/public/
node --test addon/test/addon.test.mjs       # Paket-Prüfung
node --test companion/test/companion.test.mjs
node companion/test/pentest.mjs             # Angriffstests, Markdown-Tabelle
python3 -I tools/embed-terrain.py <cdn-klon> survival_1 addon/data/terrain-survival_1.json 1025
```

```
addon/       Console-Addon (addon.json, gebaute Seite, Validierung, Tests, eingebettetes Gelände)
companion/   Node-Server (lib/), gebaute Seite (public/), Docker, Tests und Pentest
viewer/      Quellcode des Viewers (core.js, addon-app.js, companion-app.js, Vorlagen)
vendor/      three.js 0.170.0 (MIT)
tools/       Gelände-Einbettung aus dem CDN-Branch
docs/        Architektur, Sicherheitskonzept, Review-Bericht
```

## Nicht in 2.0.0

3D-Gebäude aus Bauteil-Meshes (Basen erscheinen als Marker), Sandstürme/Coriolis-Layouts der Deep Desert, Share-Links. Spieler-Positionen im Echtzeit-Strom werden nicht verwendet; Spieler kommen aus der Console-API.

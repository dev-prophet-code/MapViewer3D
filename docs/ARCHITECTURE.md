# Architektur

```
Browser (three.js)
   │                         ┌─ Modus 1: Addon-Seite in der Console-Sandbox ─────────────┐
   ├── Console ◄─ Brücke ───►│ eingebettetes Gelände, database.query (lesen)             │
   │                         └───────────────────────────────────────────────────────────┘
   │                         ┌─ Modus 4: Companion ──────────────────────────────────────┐
   └── HTTPS ───────────────►│ Login (Token im RAM) → Prüfung Realtime                   │
                             │   ├─ aktiv   → /api/realtime/stream (SSE) + /api/map/*    │
                             │   └─ sonst   → /api/map/* (Fallback)                      │
                             │ /cdn/* → CDN-Branch (Tag), Hash-geprüft                   │
                             └──────────────┬────────────────────────────────────────────┘
                                            ▼  Authorization: Bearer dak_…
                                   Dune Docker Console  (+ mvagent für Realtime)
```

**Anmeldeablauf:** `POST /api/login` prüft das Token-Format, fragt `/api/realtime/healthz` an (200 → `realtime`; 403/503 → Grund merken) und danach bei Bedarf `/api/map/partitions` (200 → `fallback`; 401 → ungültig; 403 → Maps-Recht fehlt). Erst dann wird eine Sitzung (256-Bit-ID, HttpOnly-Cookie) angelegt.

**Gelände:** Quadtree aus 129×129-Kacheln (Format 1: Höhen delta-codiert + Materialbyte). Feinere Stufen ersetzen gröbere, sobald alle Kinder geladen sind; Schürzen verdecken Nähte. Jede Kachel heißt wie die ersten 16 Hex-Stellen des SHA-256 ihres entpackten Inhalts. Der Companion prüft das, den Karten-Index gegen `catalog.json`, den Katalog optional gegen einen festen SHA-256 (`CDN_CATALOG_SHA256`).

**Realtime-Objekte:** `snap` ersetzt alles, `pos` aktualisiert Positionen (Format der Console). Die Quellen (`Survival_1`, `DeepDesert_1`) werden je Karte gefiltert.

**3D-Modelle für Marker** (`viewer/meshes.js`): Statt flacher Punkte zeichnet der Viewer je Art (Spieler, Basis, Sandwurm, Fahrzeug, Gegner, Zivilist, Sandsturm, Coriolis) Instanzen eines Meshes: eine Zeichenanweisung je Art (`InstancedMesh`), dieselbe Sonne und derselbe Nebel wie das Gelände, aus der Ferne eine Mindestgröße am Bildschirm, aus der Nähe die echte Größe in Metern. Die Blickrichtung folgt der letzten Bewegung (über die Objekt-ID). Sandstürme sind durchscheinende, leicht wabernde Säulen. Die Modelle sind im Code erzeugte Platzhalter aus Grundkörpern; echte Spielmodelle lassen sich pro Art mit `MV.Markers.register(kind, geometry, radius)` einsetzen, ohne den Rest zu ändern. Ein Schalter im Bedienfeld wechselt zu „nur Symbole“ (`MV.Layer.setModels`). Es werden keine Dateien nachgeladen, daher läuft das auch in der Sandbox.

**Symbole für Marker ohne Mesh** (`viewer/marker-extra.js`, `marker-extra.css`): Für Arten mit nur einem Platzhalter-Modell (Spieler, Basis, Fahrzeug, Sandwurm, Gegner, Zivilist, Sandsturm, Coriolis) beschreibt `MV.GLYPHS` je ein Piktogramm auf einem 24er-Raster aus Kreisen, Rechtecken und Ringen. Daraus entstehen das CSS der Legende (`tools/gen-marker-extra.mjs`, reiner CSS-Verlauf ohne Bild) und die Canvas-Textur der Billboards (`MV.IconPoints`): Legende und Marker sehen gleich aus, auch im Addon. Im Companion ersetzt das Bild und CSS der Console das Piktogramm, wo die Console eines hat. Bei eingeschalteten Modellen stehen Symbole nur über wenigen Arten (Spieler, Würmer, Fahrzeuge, Stürme), ohne Modelle über allen.

**Marker-Atlas und echte Basen (nur Companion):** `/api/markers` liefert die Marker der Console (Erze, Orte, Fahrzeuge …); `viewer/markers.js` zeichnet sie als Symbole (`THREE.Points` mit Textur, feste Bildschirmgröße). Typ, Symbol und Größe kommen aus `viewer/marker-defs.js`, das `tools/extract-marker-css.mjs` aus dem CSS der Console erzeugt; die Legende benutzt dieselben Klassen (`markers.css`). `viewer/buildings.js` baut Basen in der Nähe der Kamera aus ihren echten Teilen (Export `/api/base?id=…` + Modelle `/cdn/buildables/…`, eine `InstancedMesh` je Netz; näher als 1200 m aufgebaut, weiter als 1800 m abgebaut, höchstens 24 gleichzeitig). `viewer/creatures.js` lädt `creatures/index.json` + Netze (Körper aus den Physik-Assets, SHA-256 aus dem Katalog; im Addon eingebettet, siehe `tools/embed-creatures.mjs`) und setzt sie per `MV.Markers.register` anstelle der Platzhalter; das Fahrzeugmodell wird nach der Klasse des Echtzeit-Objekts gewählt (`variantFor`). Im Addon (Sandbox) gibt es Atlas und Bauteile nicht: kein Zugriff auf die Console-API, keine Bilder.

**Grenzen der Sandbox** (Console-Doku „Browser Sandbox“): kein Netzwerk, kein `localStorage`, keine Dialoge. Deshalb liegen Token, Echtzeit und das feine Gelände im Companion.

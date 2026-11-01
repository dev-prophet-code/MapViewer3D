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

**Grenzen der Sandbox** (Console-Doku „Browser Sandbox“): kein Netzwerk, kein `localStorage`, keine Dialoge. Deshalb liegen Token, Echtzeit und das feine Gelände im Companion.

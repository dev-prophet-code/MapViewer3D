# Release-Gate 2.0.0 – Code-Review (High) und Penetrationstest

Stand vor dem Push von Version 2.0.0. Geprüft: `companion/lib`, `companion/server.mjs`, `viewer/`, `addon/scripts`, `scripts/`.

## 1. Code-Review (High)

| # | Datei | Fund | Schwere | Status |
|---|---|---|---|---|
| 1 | `companion/lib/console.mjs` | `CONSOLE_PIN`: der Fingerabdruck wurde aus `cert.pubkey` als SPKI gelesen (falsches Format) → Pin nie nutzbar | Hoch | behoben |
| 1a | `companion/lib/console.mjs` | Beim Nachtest gefunden: Node ruft `checkServerIdentity` bei selbstsignierten Zertifikaten gar nicht auf → eine falsche Console wäre trotz Pin **akzeptiert** worden (Token an falschen Server). Jetzt Handshake und Pin-Prüfung **vor** der Anfrage; Regressionstest mit echtem Zertifikat | Hoch | behoben |
| 2 | `companion/lib/console.mjs` | 15-s-Timeout trennt den SSE-Stream (Keep-alive der Console nur alle ~20 s) → Stream-Flackern | Mittel | behoben (75 s für Streams) |
| 3 | `viewer/core.js`, `viewer/companion-app.js` | Laufende Kachel-Ladevorgänge nach Kartenwechsel landen in der neuen Karte; doppelte Terrain-Instanzen bei schnellem Wechsel | Mittel | behoben (`T.dead`, Generationszähler) |
| 4 | `viewer/addon-app.js` | `addon.storage.put` mit `expectedVersion: null` scheitert beim zweiten Speichern | Mittel | behoben (Version vorher lesen) |
| 5 | `viewer/addon-app.js` | `showMap` nicht gegen parallele Aufrufe geschützt (zwei Gelände gleichzeitig, Kamera-Reset beim Raster-Umschalten) | Mittel | behoben |
| 6 | `companion/lib/server.mjs` | Login-Sperre zählte auch 403 (fehlender Scope) → Selbstaussperrung; hinter Proxy ohne `TRUST_PROXY` teilen alle Nutzer eine Adresse | Mittel | behoben (nur 401/Formatfehler zählen); Proxy-Hinweis im Sicherheitskonzept |
| 7 | `companion/lib/session.mjs` | Sitzungslimit verdrängte fremde Nutzer (50 Logins mit einem gültigen Token) | Mittel | behoben (Limit je Adresse, volle Instanz lehnt ab) |
| 8 | `viewer/core.js` | Marker-Geometrie alle 150 ms neu gebaut, 5 Durchläufe über alle Objekte | Niedrig | behoben (Puffer wiederverwendet, ein Durchlauf) |
| 9 | `companion/lib/server.mjs` | SSE ohne Backpressure | Niedrig | behoben (`pipe`) |
| 10 | `addon/scripts/validate.mjs`, `config.mjs`, `console.mjs` | Absturz ohne `permissions`; `ALLOWED_HOSTS` außerhalb der Konfiguration; toter Code | Niedrig | behoben |

**Bekannt, nicht behoben (dokumentiert):**

| Thema | Schwere | Hinweis |
|---|---|---|
| Docker-Image nicht gebaut/getestet (kein Docker-Daemon in der Entwicklungsumgebung) | Niedrig | `Dockerfile` ist kurz; bitte einmal `docker compose up --build` prüfen |
| Addon-SQL (`database.query`) nicht gegen eine laufende Console-Brücke getestet | Mittel | Fehler zeigt die Statusliste, das Gelände läuft trotzdem |
| Echtzeit-Stream-Reconnect und 1-m-Streaming nur gegen Fake-Console/Fake-CDN und lokale Kacheln getestet, nicht gegen einen Live-Server | Niedrig | |
| Der Companion spricht HTTP; TLS braucht einen Reverse-Proxy | Mittel | siehe `SECURITY-CONCEPT.md` |
| Basen als Marker, keine 3D-Gebäude | – | Funktionsumfang, geplant |

## 2. Penetrationstest (`node companion/test/pentest.mjs`)

57 Angriffe gegen eine laufende Instanz (Fake-Console, Fake-CDN auf Loopback). **0 durchgekommen.**

| Bereich | Angriffe | Ergebnis |
|---|---|---|
| Path-Traversal / SSRF über `/cdn/*` (`..`, `%2e%2e`, `%2f`, `%5c`, Nullbyte, URL im Pfad, Pfad-Anhang) | 8 | alle 404 |
| Statische Dateien (`/server.mjs`, `/lib/config.mjs`, `/../VERSION`, `%00`) | 7 | alle 404, kein Quelltext |
| DNS-Rebinding (fremder/leerer `Host`) | 3 | alle 421 |
| CSRF (fremder Origin, `text/plain`, fehlender Header) | 3 | alle 403 |
| HTTP-Methoden (GET Login, PUT, DELETE, TRACE, PATCH, OPTIONS) | 6 | alle 405 |
| Sitzung (gefälschte, leere, überlange, doppelte Cookies) | 5 | alle 401 |
| Eingabe beim Login (kein JSON, Array, Objekt, CRLF, `__proto__`, überlang, Unicode) | 7 | alle 400/413 |
| Request-Smuggling (doppelter Content-Length, CL+TE) | 2 | 400 |
| Ressourcenerschöpfung (URL 3000 Zeichen, Body 5000 Byte, 4 Streams, 300 Anfragen/min) | 4 | 414 / 413 / 429 / 429 |
| Token-Leck in Antworten, Headern, Cookie | 2 | keins |
| Sicherheitsheader (CSP, X-Frame-Options, nosniff, Referrer-Policy, COOP, kein Server-Header) | 6 | alle gesetzt |
| XSS-Senken im Viewer-Code (`innerHTML`, `eval`, `document.write`, …) | 1 | keine |
| Brute-Force (8 falsche Tokens), Umgehung per `X-Forwarded-For` | 2 | Sperre, Umgehung wirkungslos |
| Fremde Rechte (Realtime-Stream in Fallback-Sitzung) | 1 | 409 |

Zusätzlich in `companion.test.mjs` (20 Tests): Hash-Prüfung von Kacheln, Karten-Index und Katalog (manipulierte Dateien → 502), SSRF-Adressfilter, Konfigurationsprüfung, Token geht nur im `Authorization`-Header an die Console, Pin-Prüfung mit echtem TLS-Zertifikat, Sitzungs- und Sperrgrenzen. Addon: 4 Tests (Paket in sich geschlossen ohne Netzwerkaufrufe, nur `SELECT`, nur `database:read` + `files:addon-data`).

## 3. Secret-Scan

Vor dem Push durchsucht: gesamter Arbeitsbaum und alle zu pushenden Commits nach GitHub-Token-Mustern, `dak_…`-Schlüsseln, Server-IP-Adressen, `.env`-/Schlüsseldateien. Treffer: nur Test-Platzhalter (`dak_` + Wiederholzeichen) und Mustertexte der Prüfskripte. Keine echten Zugangsdaten, keine Server-Adressen. Die Dateien `.env` sind per `.gitignore` ausgeschlossen.

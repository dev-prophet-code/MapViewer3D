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

## 4. Nachtrag: Umbau der Oberfläche (Aufbau nach dem MapViewer3D-Addon, Token-Abfrage zuerst)

Zweites Code-Review (High) über `viewer/` und `scripts/`, danach erneuter Pentest (57 Angriffe, 0 durchgekommen) und 26 Tests (22 Companion, 4 Addon), alle grün.

| # | Datei | Fund | Schwere | Status |
|---|---|---|---|---|
| 1 | `viewer/addon-app.js` | Start wartete bis zu 30 s auf `addon.storage.get` (leere Seite) | Mittel | behoben (nicht blockierend) |
| 2 | `viewer/addon-app.js` | Startdialog nicht schließbar, wenn Speichern scheitert; Schreiben bei jedem Start | Mittel | behoben |
| 3 | `viewer/shell.js` | Realtime-Ebenen blieben nach „Erneut prüfen“ ausgeblendet | Mittel | behoben (Zustand wird gemerkt) |
| 4 | `viewer/addon-app.js`, `companion-app.js` | Abfragen überlappten bei langsamer Console (Limit 60/min der Brücke) | Mittel | behoben |
| 5 | `companion/lib/server.mjs` | Fehlermeldungen nur deutsch | Niedrig | behoben (Codes, Übersetzung im Client) |
| 6 | `viewer/*` | Cursor-Anzeige in jedem Frame, doppelt vorhanden | Niedrig | behoben (`UI.followCursor`) |
| 7 | `viewer/addon-app.js` | eigener Schalter statt gemeinsamer Komponente, toter Text | Niedrig | behoben (`UI.toggle`) |
| 8 | `scripts/build.mjs` | Platzhalter nacheinander im wachsenden Text ersetzt | Niedrig | behoben (ein Durchlauf) |
| 9 | Tests | Reihenfolge „Token-Abfrage zuerst“ ungeprüft | Niedrig | behoben (Test) |

**Hinweis zur Token-Abfrage:** Im Companion ist die Token-Abfrage der erste Bildschirm; vorher lädt weder Karte noch Kachel (der Server liefert ohne Sitzung 401). Im Addon kann ein Token nicht verwendet werden, weil die Console die Addon-Seite mit `connect-src 'none'` ausliefert; der erste Bildschirm fragt dort stattdessen die Adresse des Companion ab und erklärt das.

## 5. Nachtrag: automatische Console-Erkennung statt Adressabfrage

Das Addon fragt beim Start nicht mehr nach einer Adresse. Es erkennt die Dune Docker Console daran, dass die Console-Brücke antwortet. Geprüft im Console-Code (v1.4.59): Realtime Data steckt in der Console-API (`/api/realtime/*`, Scope `realtime:read`), die Addon-Brücke hat aber keine Realtime-Aktion, und die Addon-Seite hat `connect-src 'none'`. Realtime bleibt deshalb dem Companion vorbehalten; die Adresse des Companion ist eine optionale Einstellung im Bereich „Verbindung“.

Code-Review (High) über `viewer/addon-app.js`: 4 Funde (Erkennung nur am Rahmen, Dialogtexte, doppelte Prüfung, doppelter Knopf), alle behoben. 26 Tests und 57 Angriffe: 0 durchgekommen.

## 6. Nachtrag: 3D-Modelle für Marker, Marker-Atlas (Console-CSS) und Basen aus echten Bauteilen

Neu: `viewer/meshes.js` (Marker als Meshes), `viewer/markers.js` + `viewer/marker-defs.js` + `viewer/markers.css` (Atlas, erzeugt aus dem CSS der Console), `viewer/buildings.js` (Basen aus Bauteilen), im Companion `/api/markers`, `/api/base`, `/icons/<Datei>` und die CDN-Pfade `buildables/…`.

Code-Review (High) über die neuen und geänderten Dateien, 7 Funde:

| # | Datei | Fund | Schwere | Status |
|---|---|---|---|---|
| 1 | `viewer/markers.js` | Typ/Untertyp der Console wurden direkt auf Objekten nachgeschlagen: `constructor`/`__proto__` lieferten Prototyp-Mitglieder als „Symbol“ und Größe | Mittel | behoben (nur eigene Eigenschaften, Test) |
| 2 | `viewer/markers.js` | Marker-Typ der Console unbereinigt als Klassenname der Legende (zusätzliche Klassen/Leerzeichen einschleusbar; kein Skript, nur Gestaltung) | Niedrig | behoben (nur `[a-z0-9_]`, Test) |
| 3 | `companion/lib/server.mjs` | Basis-Cache je Sitzung bis 80 Einträge à ~0,4 MB: Speicherdruck bei vielen verschiedenen Basis-IDs | Mittel | behoben (24 Einträge) |
| 4 | `viewer/shell.js` | `UI.layers` meldete bei jedem Neuaufbau einen weiteren Sprach-Hook an, ohne den alten zu entfernen | Niedrig | behoben (`UI.offLang`) |
| 5 | `companion/lib/server.mjs` | Fehlende Symbole (404) werden nicht zwischengespeichert, jede Anfrage geht an die Console | Niedrig | offen, bewusst: begrenzt durch das Limit je Sitzung, Erfolge cached der Browser |
| 6 | `viewer/companion-app.js` | Fehlt „Maps: Read“ während einer Sitzung, bleibt der Atlas stumm leer (für „Bases: Read“ gibt es einen Hinweis) | Niedrig | offen, bewusst: Anmeldung verlangt „Maps: Read“ bereits |
| 7 | `viewer/buildings.js` | Neigung/Rollen der Bauteile (Placeables) und der Versatz je Bauteil stammen aus dem Altprojekt, nicht gegen eine echte Basis geprüft | Info | offen: nur Gier, Ort und Katalogwerte mit Tests belegt |

**Penetrationstest:** 93 Angriffe (vorher 57), 0 durchgekommen. Neu: Pfadtricks und SSRF-Namen bei `/icons/`, falsche Inhaltstypen und zu große Symbole, Token an öffentlichen Console-Pfaden, Parameter-Einschleusung bei `/api/markers?map=`, 9 Basis-IDs (`1;drop`, `../1`, `1e9` …), Pfade unter `buildables/`, manipulierte Meshes/Index (502 durch Katalog-Hash), feindliche Namen und Zusatzfelder der Console (gekürzt, nur 7 Felder).

**Tests:** Addon 13, Companion 28, Validator in Ordnung. Dazu ein Dekodierer-Test für das Netzformat `DML1` (kaputte Kopfzeile, riesige Zahlen, abgeschnittene Datei, Index außerhalb) und Koordinatentests Unreal → three.js.

**Secret-Scan:** keine Token, Passwörter oder echten IP-Adressen in den geänderten Dateien (nur die für Beispiele reservierte Test-Adresse 203.0.113.5 und Test-Fälle). Keine Bilder und keine Spielmodelle im Repository (siehe `NOTICE`).

**Einschränkungen:** Basen aus Bauteilen und der Atlas wurden gegen die Demo-Console geprüft (echte Typnamen und echte Meshes des `cdn`-Branchs), nicht gegen eine laufende Console mit echten Basen.

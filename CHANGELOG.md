# Changelog

Versionierung: Start bei 2.0.0, jede Anpassung erhöht die dritte Stelle um 0.0.1 (2.0.0 → 2.0.1 → 2.0.2 …).

## 2.0.0
- Oberfläche nach dem Aufbau des bisherigen MapViewer3D-Addons: Vollbild-Karte, Bedienfeld links (Karte, Springen zu, Live-Karte mit Ebenengruppen, Verbindung), Schaltflächen rechts, Hell/Dunkel, Englisch/Deutsch.
- Beim Start zuerst die Verbindungsabfrage: im Companion der API-Token, im Addon die Adresse des Companion (die Console-Sandbox kann keinen Token verwenden).
- README zweisprachig.
- **3D-Modelle für Marker** (`viewer/meshes.js`): Spieler, Basen, Sandwürmer, Fahrzeuge, Gegner, Zivilisten, Sandstürme und Coriolis als Meshes statt Punkte (Instanzen, Sonne und Nebel wie das Gelände, Mindestgröße aus der Ferne, Blickrichtung aus der Bewegung). Schalter für Punkte, Modelle später ersetzbar (`MV.Markers.register`). Version bleibt 2.0.0.
- **Marker-Atlas** (Companion): Erze, Schrott, Pflanzen, Orte, Trainer, Hausvertreter, Festungen, Gefahren, Gegnerlager, Gewürzfelder, Lager und Fahrzeuge der Console als Symbole über dem Gelände. Typen, Symbole und Größen stammen aus dem CSS der Console (`tools/extract-marker-css.mjs` erzeugt `viewer/markers.css` und `viewer/marker-defs.js`); die Bilder holt der Companion zur Laufzeit von der Console, es liegen keine im Repository.
- **Basen aus echten Bauteilen** (Companion, Recht „Bases: Read“): Aus dem Export einer Basis und den Modellen des `cdn`-Branchs (`buildables/`, SHA-256-geprüft) werden Basen in der Nähe der Kamera aus ihren echten Teilen aufgebaut, aus der Ferne bleibt das Haus-Symbol.
- Neuaufbau als Dune-Docker-Console-Addon plus optionaler Companion.
- **Addon** (Sandbox, ohne Netzwerk): 3D-Karte Hagga Basin und Deep Desert mit eingebettetem Gelände (16 m / 48 m Raster, wahlweise feiner), Spieler und Basen über die Brücke (`database:read`, nur lesende SQL-Abfragen).
- **Companion** (Node 22, ohne Abhängigkeiten): Anmeldung mit API-Token, automatische Prüfung von Realtime Data, Echtzeit (Sandwürmer, NPCs, Fahrzeuge, Stürme) oder Fallback auf die regulären Karten-Routen, gestreamtes Gelände bis 1 m aus dem `cdn`-Branch mit SHA-256-Prüfung jeder Datei.
- Sicherheit: Token nur im Arbeitsspeicher, HttpOnly/SameSite-Strict-Cookie, CSRF-Schutz, Host-Prüfung, Login-Sperre, SSRF-Filter, feste Pfadlisten, strenge CSP, Rate-Limits. Siehe `docs/SECURITY-CONCEPT.md` und `docs/REVIEW-2.0.0.md`.

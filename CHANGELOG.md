# Changelog

Versionierung: Start bei 2.0.0, jede Anpassung erhöht die dritte Stelle um 0.0.1 (2.0.0 → 2.0.1 → 2.0.2 …).

## 2.0.1
- README zweisprachig (Englisch zuerst, Deutsch darunter). Keine Code-Änderung.

## 2.0.0
- Neuaufbau als Dune-Docker-Console-Addon plus optionaler Companion.
- **Addon** (Sandbox, ohne Netzwerk): 3D-Karte Hagga Basin und Deep Desert mit eingebettetem Gelände (16 m / 48 m Raster, wahlweise feiner), Spieler und Basen über die Brücke (`database:read`, nur lesende SQL-Abfragen).
- **Companion** (Node 22, ohne Abhängigkeiten): Anmeldung mit API-Token, automatische Prüfung von Realtime Data, Echtzeit (Sandwürmer, NPCs, Fahrzeuge, Stürme) oder Fallback auf die regulären Karten-Routen, gestreamtes Gelände bis 1 m aus dem `cdn`-Branch mit SHA-256-Prüfung jeder Datei.
- Sicherheit: Token nur im Arbeitsspeicher, HttpOnly/SameSite-Strict-Cookie, CSRF-Schutz, Host-Prüfung, Login-Sperre, SSRF-Filter, feste Pfadlisten, strenge CSP, Rate-Limits. Siehe `docs/SECURITY-CONCEPT.md` und `docs/REVIEW-2.0.0.md`.

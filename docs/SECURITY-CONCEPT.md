# Sicherheitskonzept

## Schutzziele
Der API-Token der Console darf nicht abfließen; der Companion darf nicht als Proxy zu fremden Zielen oder zu internen Diensten missbraucht werden; Kartendaten dürfen nicht unbemerkt verändert werden; der Addon-Code darf in der Console-Sandbox nichts außerhalb der Brücke tun.

## Maßnahmen
| Bereich | Maßnahme |
|---|---|
| Token | Nur im RAM des Companion, nie in Logs, Cookies, Antworten oder Dateien. Im Browser steht nur eine zufällige Sitzungs-ID (HttpOnly, SameSite=Strict, Secure hinter TLS). Format `dak_…` wird vor jeder Verwendung geprüft. Der Token geht ausschließlich im `Authorization`-Header an `CONSOLE_URL`. |
| Ziele | Console: fest aus `CONSOLE_URL`, Pfadliste (6 feste Routen plus zwei streng geprüfte Muster: `/api/map/markers?map=HaggaBasin|DeepDesert` und `/api/bases/<Ziffern>/export`), keine Umleitungen. Kartenbilder nur `hagga-basin.png` und `deep-desert.png` (feste Namen, höchstens 4 MiB). Symbole der Live-Karte nur aus `/images/maps/<Dateiname>` der Console, Dateiname aus `[A-Za-z0-9_-]{1,64}.(webp|png)`, ohne Token, nur Bild-Inhaltstypen, höchstens 512 KiB. CDN: fest aus `CDN_BASE`, nur 7 Pfadmuster (Katalog, Karten-Index, Kachel, Bauteil-Index, Bauteil-Mesh, Körper-Index, Körper-Mesh). Zieladressen im Link-Local-/Metadaten-/Multicast-Bereich werden beim Verbinden abgewiesen (SSRF, DNS-Rebinding). |
| Transport | `http://`-Console nur mit ausdrücklichem `CONSOLE_ALLOW_HTTP=1`. Selbstsignierte Zertifikate über Fingerabdruck-Pin (`CONSOLE_PIN`). Der Companion selbst spricht HTTP und gehört hinter einen TLS-Reverse-Proxy; standardmäßig bindet er an `127.0.0.1`. |
| Daten | CDN-Dateien: Kachel-Hash, Bauteil-Index (SHA-256 aus dem Katalog), Bauteil-Mesh (SHA-256-Präfix aus dem Katalog, höchstens 1 MiB),  Karten-Index gegen Katalog, Katalog optional gepinnt, festes Tag (`data-v2`, unveränderlich). Antworten der Console werden auf bekannte Felder reduziert (keine Funcom- oder FLS-IDs). |
| Web | CSP `default-src 'none'`, nur eigene Skripte/Styles, keine Inline-Skripte; `nosniff`, `no-referrer`, `X-Frame-Options: DENY`, COOP/CORP. Host-Prüfung gegen DNS-Rebinding (`ALLOWED_HOSTS`). Spielernamen werden nur als Text eingefügt (`textContent`). |
| Missbrauch | Anmeldung: 5–10 Fehlversuche/Minute je Adresse → 10 Minuten Sperre. API 240/min je Sitzung, CDN 3000/min. Höchstens 2 Streams je Sitzung, 16 gesamt, 50 Sitzungen. Größen-, Zeit- und Verbindungslimits. `X-Forwarded-For` nur mit `TRUST_PROXY=1`. |
| CSRF | Mutierende Aufrufe nur als `application/json` mit `X-MV-CSRF: 1`, passender `Origin`, SameSite=Strict. |
| Addon | Kein Netzwerkcode (vom Validierungsskript erzwungen), nur `database:read` + `files:addon-data`, nur `SELECT` mit festem Text. |
| Repository | Keine Geheimnisse (Secret-Scan vor jedem Push, siehe Review-Bericht). `.env` ist ignoriert. |

## Restrisiken
- Der Companion ist HTTP; ohne TLS-Proxy laufen Sitzungs-Cookie und Daten im Klartext. Nur an Loopback binden oder TLS davorsetzen.
- Ist die Console nur per `http://` erreichbar, läuft der Token auf dem Weg dorthin im Klartext (Console-Eigenschaft). Besser den „Encrypted API Access“ (Port 8797) verwenden.
- Der Katalog ist ohne `CDN_CATALOG_SHA256` nur so vertrauenswürdig wie das GitHub-Repository.
- Wer den Companion-Prozess lesen kann (root auf dem Host), sieht Tokens im Speicher.

## Marker-Atlas, Symbole und Basen aus Bauteilen (Ergänzung)
- **Marker-Atlas** (`GET /api/markers?map=hagga|deep`): Der Companion holt `/api/map/markers` mit dem Token der Sitzung (Recht „Maps: Read“), entfernt Spieler und Basen (kommen aus `/api/static`) und reicht nur `t, s, n, id, x, y, z` weiter; Texte sind auf 60 Zeichen gekürzt, Zahlen werden zu Zahlen (nie NaN), höchstens 20 000 Zeilen. Der Browser setzt Namen nur über `textContent`.
- **Symbole** (`/icons/<Datei>`): Es liegen keine Bilder im Repository. Der Companion holt die Symbole zur Laufzeit als öffentliche Dateien von der Console (feste Ordner-URL, enger Dateiname, kein Token), prüft den Inhaltstyp (`image/webp|png`) und die Größe und speichert höchstens 400 Dateien im Arbeitsspeicher. Eine Sitzung ist nötig.
- **Basen aus Bauteilen** (`GET /api/base?id=<Ziffern>`, Recht „Bases: Read“): Aus dem Export der Console werden nur Typ und Lage übernommen (höchstens 6 000 Bauteile und 3 000 Möbel je Basis), 2 Minuten zwischengespeichert. Die Modelle kommen aus dem `cdn`-Branch über `/cdn/buildables/…`, jede Datei wird gegen den Katalog geprüft. Der Browser-Dekodierer (`DML1`) prüft Magic, Größen, Längen und Indizes, bevor er Speicher liest.
- Fehlt dem Token „Bases: Read“, bleiben Basen vereinfacht (Haus-Symbol), und das Bedienfeld sagt es.

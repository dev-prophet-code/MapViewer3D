# Dune MapViewer3D – Was der Viewer macht und wie er deine Zugangsdaten schützt

## Was ist der MapViewer3D?

Der MapViewer3D ist ein 3D-Kartenviewer für einen selbst gehosteten
Dune-Awakening-Server mit dem Docker-Stack von Red-Blink
(*dune-awakening-selfhost-docker*). Er läuft unter Windows, Linux und macOS, ohne
dass etwas installiert werden muss, lokal oder auf einem Server, und wird im Browser
bedient.

## Was der Viewer anzeigt

**Karten**
- **Hagga Basin:** 8 × 8 km, 1-m-Raster.
- **Deep Desert:** 22,5 × 22,5 km, 3-m-Raster.
- **Serverinstanzen:** Jede Instanz einer Karte ist einzeln wählbar, z. B.
  *Hagga Basin – PvE*, *PvP*, *Creative Mode* oder *Deep Desert – PvE*, *PvP*.
- **Gelände:** Dünen, Felsen, Canyons und Bauwerke in 3D. Die Farbe kommt aus dem
  Kartenbild deines Servers, aus der Nähe ergänzt durch Details wie Sandriffel und
  Gesteinsschichten.

**Live-Daten deines Servers**

| Bereich | Darstellung |
|---|---|
| Spieler | Figur mit Namen, weich animiert; Liste der Online-Spieler zum Hinfliegen |
| Basen | Symbol mit Namen und Besitzer; im Sichtfeld aus der Nähe als 3D-Gebäude aus den echten Bauteilen |
| Fahrzeuge | Ornithopter, Buggys, Sandbikes, Crawler … mit Besitzer |
| Orte | Höhlen, Ecolabs, Wracks, Sietches, Handelsposten, Festungen, NPCs |
| Gefahren | Gegnerlager, Treibsand, Trommelsand, Strahlungszonen |
| Ressourcen | Spice-Felder, Erze (nach Sorte gefärbt), Schrott, Pflanzen, Mehlsand, Lager |

- Aus der Ferne zeigt die Karte die Symbole der 2D-Live-Karte, aus der Nähe
  3D-Modelle. Die Schalter im Bedienfeld tragen dieselben Symbole.
- Alle Bereiche lassen sich mit Schaltern ein- und ausblenden. Standardmäßig an sind
  nur *Spieler online*, *Basen*, *Basen in 3D* und *Namen*.
- Ein Klick auf ein Objekt zeigt Details und bietet *Hinfliegen*.
- Spieler werden alle 5 Sekunden aktualisiert, Basen und Fahrzeuge alle 20 Sekunden,
  Orte und Ressourcen alle paar Minuten.

**Steuerung:** Maus (verschieben, drehen, zoomen), dazu W/A/S/D/Q/E zum Fliegen,
mit Shift schneller.

**Sprache:** Die Oberfläche startet auf Englisch. Über die Auswahl oben rechts im
Panel lässt sie sich auf Deutsch umstellen; die Wahl merkt sich der Browser. Die
Menüpunkte in dieser Beschreibung beziehen sich auf die deutsche Oberfläche.

## Was der Viewer *nicht* macht

- **Nur lesen:** Er **verändert nichts** am Spiel oder am Server; er liest
  ausschließlich Daten.
- **Keine Originaltexturen:** Der Server-Build des Spiels enthält keine Bilddaten.
  Modelle von Fahrzeugen, Figuren und Orten sind nachgebaut, Gebäude entstehen aus
  den Kollisionsformen der Bauteile.
- **2,5D-Gelände:** Überhänge und Höhlen werden nicht als Hohlraum dargestellt.
- **Deep Desert:** Das Gelände erzeugt der Server zur Laufzeit (Coriolis). Der
  Viewer zeigt eine wiederholte Dünen-Vorlage plus die festen Felsformationen.
- **Leichte Verzögerung:** Positionen kommen aus der Datenbank des Servers und
  können einige Sekunden bis Minuten hinterherhinken.

## Wie der Viewer an die Daten kommt

```
Browser  ⇄  lokaler Viewer-Server (127.0.0.1)  ⇄  Console deines Servers (API)
```

- Beim ersten Start trägst du **Server-Adresse**, **Port** und den **API-Token**
  der Console ein.
- Der Viewer prüft die Verbindung sofort. Ein falscher Token wird abgelehnt und
  nicht gespeichert.
- Alle Anfragen an deinen Server laufen über den lokalen Viewer-Server. Der
  **Browser bekommt den Token nie zu sehen.**
- Gelände und Bauteil-Geometrie sind vorgebaut mitgeliefert. Alles, was von
  deinem Server abhängt, kommt live von dort:
  - aktive Karten und Instanzen,
  - Kartenbilder,
  - Spieler, Basen und alle weiteren Live-Daten.

## Sicherheit der Zugangsdaten

### Was gespeichert wird

Nur zwei Dinge: die **Server-Adresse** und der **API-Token**. Beide liegen
ausschließlich verschlüsselt auf der Festplatte, in der Datei
`credentials.enc` in deinem Benutzerordner, **nie im Projektordner**. **Nichts davon steht im Klartext darin**, auch nicht die
Adresse.

### Wie verschlüsselt wird

| Schutzschicht | Verfahren | Zweck |
|---|---|---|
| Hauptschlüssel | 256 Bit aus dem Zufallsgenerator des Betriebssystems | Grundlage aller Schlüssel |
| Schlüsselableitung | HKDF-SHA512 mit 256-Bit-Zufallssalz, gebunden an Rechnername und Benutzerkonto | eigener Schlüssel je Schicht; Daten nur auf diesem Rechner und für diesen Benutzer lesbar |
| Verschlüsselung innen | AES-256-GCM | vertraulich und manipulationssicher |
| Verschlüsselung außen | XChaCha20-Poly1305 (anderes Verfahren, anderer Schlüssel) | zweite, unabhängige Schutzschicht |
| Integrität | HMAC-SHA512 über den gesamten Datensatz | jede Änderung an der Datei wird erkannt |
| Fingerabdruck | PBKDF2-SHA512, 210 000 Runden, eigenes Salz | zeigt, welcher Token gespeichert ist, ohne ihn preiszugeben |

Bei jedem Speichern werden Salz und Nonces neu zufällig erzeugt. Dieselben Angaben
ergeben also nie zweimal dieselbe Datei.

### Wo was liegt

| Datei | Ort | Rechte |
|---|---|---|
| Hauptschlüssel `master.key` | Benutzer-Konfigordner, z. B. macOS `~/Library/Application Support/MapViewer3D/`, Linux `~/.config/MapViewer3D/`, Windows `%AppData%\MapViewer3D\` | nur für dich lesbar (0600) |
| Verschlüsselte Zugangsdaten `credentials.enc`, Instanznamen, Zwischenspeicher | Unterordner `state/` im selben Benutzer-Konfigordner | nur für dich lesbar (0600) |

Der **Projektordner enthält nie Zugangsdaten**. Er bleibt immer im
Auslieferungszustand und lässt sich gefahrlos weitergeben; wer ihn bekommt, muss
Server und Token selbst eintragen. Wer die Dateien aus dem Benutzerordner auf einen
anderen Rechner kopiert, scheitert an der Rechnerbindung.

### Schutz im Betrieb

- **Nur lokal:** Der Viewer-Server lauscht nur auf `127.0.0.1` und ist von anderen
  Geräten im Netz nicht erreichbar.
- **Einmal übertragen:** Der Token geht beim Einrichten einmal vom Browser an den
  lokalen Server und wird danach nie wieder an den Browser geschickt. Die
  Oberfläche zeigt nur die Server-Adresse und einen gekürzten Fingerabdruck.
- **Schutz vor fremden Webseiten:** Ändernde Aufrufe (Speichern, Löschen,
  Umbenennen) nimmt der Server nur mit einem eigenen Kopf von der eigenen
  Oberfläche an. Andere Webseiten im selben Browser können die Zugangsdaten so
  weder ändern noch löschen (CSRF-Schutz).
- **Geprüfte Eingaben:** Kartennamen in Anfragen werden gegen ein Muster geprüft;
  Zugriffe außerhalb des Datenordners sind nicht möglich.
- **Nur im Arbeitsspeicher:** Der entschlüsselte Token existiert nur im Speicher des
  laufenden Viewer-Servers.

### Ehrliche Grenzen

- **Wer an dein Benutzerkonto kommt,** kann den Hauptschlüssel lesen und die Daten
  entschlüsseln. Das gilt für jede Anwendung, die sich Zugangsdaten ohne erneute
  Passworteingabe merkt. Schütze dein Benutzerkonto deshalb mit einem guten
  Passwort und Festplattenverschlüsselung (FileVault, BitLocker, LUKS).
- **Rechnername geändert?** Dann lassen sich die gespeicherten Daten nicht mehr
  lesen, weil die Rechnerbindung nicht mehr passt. Der Viewer fragt dann einfach neu
  nach den Zugangsdaten.
- **Verbindung zur Console:** Die Verbindung zwischen Viewer und Console ist nur so
  sicher wie die Console selbst. Läuft sie über `http://`, geht der Token
  unverschlüsselt über das Netz. Wenn möglich die Console per `https://`
  (Reverse Proxy mit TLS) oder über VPN bzw. SSH-Tunnel erreichbar machen.
- **Rechte des API-Tokens:** Der Token sollte nur Leserechte auf die Kartendaten
  haben. Der Viewer braucht nichts anderes.

### Zugangsdaten verwalten

- **Ändern:** *Verbindung → Ändern* (neuer Server oder Token).
- **Löschen:** *Verbindung → Zugangsdaten löschen* entfernt die verschlüsselte
  Datei. Der Hauptschlüssel bleibt erhalten und wird beim nächsten Einrichten
  weiterverwendet.
- **Komplett zurücksetzen:** zusätzlich `master.key` im Benutzer-Konfigordner
  löschen.
- **Nie weitergeben:** den Ordner `MapViewer3D` im Benutzer-Konfigordner
  (`master.key` und `state/`). Der Projektordner selbst enthält nichts davon.

# Beispiel-Webseite mit eingebautem 3D-Viewer

Eine schlichte Webseite (`site/`), die den Dune MapViewer3D in einem `<iframe>` einbettet, dazu fertige, anpassbare Konfiguration für nginx, systemd und den
Viewer. Ordner kopieren, ein paar Zeilen ändern, fertig.

```
Browser der Besucher ⇄ nginx (deine Seite + /map/) ⇄ Viewer (127.0.0.1:8795) ⇄ Dune-Console-API (der Token bleibt hier)
                                                           └───────────⇄ Positions-Agent (127.0.0.1:8796, Echtzeit aus dem RAM)
```

| Datei | Inhalt |
|---|---|
| `site/index.html` | die Beispielseite; der Viewer ist das `<iframe id="viewer">`; die Karten-Knöpfe nutzen `postMessage` |
| `site/assets/site.css` | schlichtes Design, frei änderbar |
| `config.example.json` | **Server-Adresse und API-Token** (+ Optionen); jeder Schlüssel ist darin erklärt |
| `nginx.conf.example` | liefert die Seite aus und leitet `/map/` an den Viewer weiter, damit beide dieselbe Adresse haben |
| `mapviewer.service.example` | systemd-Dienst für den Viewer (unprivilegierter Benutzer) |
| `mapviewer-agent.service.example` | systemd-Dienst für den Echtzeit-Agenten (root, nur lesend) |

## Einrichtung in fünf Schritten

1. **Viewer installieren** auf dem Webserver: Release (`MapViewer3D-Beta.N.zip`) nach `/opt/MapViewer3D` entpacken. Die Karten werden aus dem Branch `cdn`
   auf GitHub gestreamt, sonst ist nichts herunterzuladen.
2. **Server-Adresse und Token eintragen.** `config.example.json` nach `/etc/mapviewer/config.json` kopieren (außerhalb des Web-Verzeichnisses, nie in Git) und
   `apiBase` (`http://<deine Server-IP>:8088`, die Dune-Docker-Console) sowie `token` (API-Token der Console mit **nur Lese-Rechten**) setzen.
   Der Token bleibt auf dem Server, der Browser sieht ihn nie.
3. **Viewer starten** mit `mapviewer.service.example` (`-config /etc/mapviewer/config.json -addr 127.0.0.1:8795`). Er lauscht nur lokal.
4. **Seite veröffentlichen**: `site/` in dein Web-Verzeichnis kopieren und `nginx.conf.example` verwenden, damit der Viewer unter `/map/` auf derselben Adresse erscheint.
   (Seite und Viewer müssen dieselbe Origin haben: Karten-Knöpfe und Einbettung hängen davon ab.)
5. Seite öffnen. Fertig. Zum Ausprobieren ohne nginx: `python3 -m http.server 8080 --directory site`, in `index.html` `VIEWER_URL` auf
   `http://127.0.0.1:8795/` setzen (die Karte erscheint, die Knöpfe brauchen dieselbe Origin).

## Echtzeit-Daten (Sandwürmer, NPCs, Fahrzeuge, Stürme, Spieler)

Diese Objekte gibt es nur im Arbeitsspeicher der Spielprozesse, nicht in der Datenbank. Der Positions-Agent liest sie **nur lesend** aus
`/proc/<pid>/mem`. Das geht **nur auf dem Rechner, auf dem der Dune-Docker-Stack läuft** (die Container teilen den Prozessraum des Hosts) und braucht **root**.
Zwei Wege, beide in `config.example.json` → `agentUrl`:

- **Empfohlen: eigener Agent-Dienst.** `mvagent` (in `bin/`) mit `mapviewer-agent.service.example` starten und `"agentUrl": "http://127.0.0.1:8796"` setzen.
  Der Viewer selbst bleibt unprivilegiert. Er kann sogar auf einem anderen Rechner laufen (den Agenten dann per SSH-Tunnel erreichen; er hat keinen Login, also nur auf Loopback).
- **`"agentUrl": "auto"`** (oder `-agent auto`): Der Viewer prüft, ob Dune-Serverprozesse im `/proc` sichtbar sind (= er läuft auf dem Spiel-Host), und startet den Agenten,
  wenn er als root läuft, in sich selbst. Praktisch für einen privaten Viewer im LAN; für eine öffentliche Seite besser den eigenen Dienst nehmen, weil sonst der
  ganze Viewer als root läuft. Mit `-agent-players` liest der Agent auch Spieler. Läuft der Viewer nicht auf dem Spiel-Host oder nicht als root, meldet er das im Log
  und zeigt einfach keine Echtzeit-Daten.

Details, Offsets und Sicherheit: [docs/Agent-DE.md](../../docs/Agent-DE.md).

## Öffentliche Seite? Bitte lesen

Alles, was der Viewer zeigt (Spielernamen, Positionen, Basen), sieht jeder, der die Seite öffnen kann. Möglichkeiten: Seite schützen (`viewerPassword` in der Konfiguration oder
das eigene Login deiner Seite vor `/map/`) oder den öffentlichen Modus des Viewers nutzen, der nur PvE-Partitionen freigibt (Abschnitt `public`, siehe [README](../../README.de.md)).
Die Verbindungseinstellungen lassen sich über den Proxy nie ändern.

## Updates

`"autoUpdate": true` (oder `-auto-update`) lässt den Viewer neue Releases selbst installieren; `Restart=always` im systemd-Dienst startet ihn danach wieder.
Details: [README → Updates](../../README.de.md#updates).

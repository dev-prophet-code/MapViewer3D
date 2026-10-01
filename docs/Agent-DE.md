# Positions-Agent (`mvagent`) – Sandwürmer, Gegner, Zivilisten und Fahrzeuge live

Seit **Beta.9**. Für selbst gehostete Dune-Awakening-Server (Docker). Geprüft mit dem Build `2134304-0-shipping`.

> **Nur auf eigenen Servern.** Der Agent *liest* nur den Speicher der Spielprozesse (`/proc/<pid>/mem`); er injiziert nichts, hängt sich nirgends ein, hält das Spiel nicht an und verändert nichts. Er braucht **root auf dem Spiel-Host** (nicht im Container). Nur Linux.

## Wozu ein eigenes Programm?

NPCs, Gegner und Sandwürmer stehen **nicht in der Datenbank** (dort liegen nur Spawner-Definitionen), auch nicht im Log oder in RabbitMQ. Sie existieren nur im Arbeitsspeicher des laufenden Spielprozesses (`DuneSandboxServer-Linux-Shipping`). Die Console-API kann sie deshalb nicht zeigen. Der Agent liest sie von dort etwa 10-mal pro Sekunde, der Viewer zeigt sie live.

| Objekt | Klasse | Verhalten (gemessen) |
|---|---|---|
| Sandwürmer | `ASandwormPawn` | weltweit aktiv, ~40 m/s, **~20 Positionsänderungen pro Sekunde** |
| Gegner, Gestrandete, Soldaten | `ADuneNpcCharacter` | stehen still, solange kein Spieler in der Nähe ist (KI schläft) |
| Zivilisten, Händler, Quartiermeister | `ADuneNpcCharacterCivilian`, `ATaxationNpc` | stehen still |
| Ornithopter, Fahrzeuge | `ADuneVehicle`, `ADuneOrnithopter`, `AWheeledVehiclePawn` | meist statisch, einzelne bewegen sich |
| Spieler | `ADunePlayerCharacter` | nur mit `-players`; der Viewer zeigt sie als die Online-Spieler der Console in Echtzeit (siehe unten) |

## Spieler live (`-players`)

Mit `-players` gestartet, bewegt der Viewer die Online-Spieler der Console in Echtzeit (10 Hz, flüssig) statt alle 5 s. Der Agent kennt keine Namen: Der Viewer-Server ordnet jeden Echtzeitspieler einem Console-Spieler derselben Partition nach kleinstem Abstand zu (Console-Positionen sind einige Sekunden alt, bis 300 m Abstand gelten; jeder Console-Spieler nur einmal) und ordnet alle 3 s neu zu. Zwei Spieler dicht beieinander können kurz vertauscht werden. Ohne `-players` ändert sich nichts.

## Schnellstart

```bash
# auf dem Spiel-Host als root (das Release-ZIP enthält bin/mvagent-linux-amd64 und -arm64)
sudo ./bin/mvagent-linux-amd64                  # lauscht auf 127.0.0.1:8796
sudo ./bin/mvagent-linux-amd64 -once | head     # Diagnose: einmal suchen, JSON ausgeben

# der Viewer holt die Daten ab (gleicher Host oder ein Host, der den Agenten erreicht)
./start.sh -agent http://127.0.0.1:8796         # oder MV_AGENT=… / "agentUrl" in der -config-Datei
```

Der Viewer zeigt dann vier zusätzliche Schalter: **Sandwürmer (live)** (standardmäßig an), **Gegner**, **Zivilisten & Händler**, **Fahrzeuge (live)**. Würmer gleiten zwischen den ~10-Hz-Stützpunkten flüssig; Gegner und Zivilisten sind Punktwolken, mehrere Tausend kosten nichts. Ohne `-agent` erscheinen die Schalter nicht, und es ändert sich nichts.

systemd-Dienst (Agent, läuft als root): siehe [Agent-EN.md](Agent-EN.md#quick-start) (gleiche Einheit).

## Optionen

| Option | Standard | Bedeutung |
|---|---|---|
| `-addr` | `127.0.0.1:8796` | lokale Schnittstelle (**ohne Login**: auf Loopback lassen; andere Adressen nur mit `-allow-open`) |
| `-hz` | 10 | Abtastrate der aktiven Objekte (die Quelle liefert höchstens ~20 Hz) |
| `-workers` | 4 | parallele Scan-Worker (immer nur ein Scan zugleich, ~1–4 s je Prozess) |
| `-rescan` | 30m | volle Discovery in diesem Abstand (neue Spawns erscheinen dann; ein voller Scan liest den ganzen Prozessspeicher und ist deshalb bewusst selten) |
| `-rescan-min` | 1m | auf Anforderung höchstens so oft (ein Sandwurm verschwand = ein neuer entstand) |
| `-players` | aus | auch Spieler lesen (nötig für Live-Spieler; Datenschutz: standardmäßig aus) |
| `-pid` | – | nur diesen Prozess (Diagnose) |
| `-blocks`, `-root`, `-pos` | Build 2134304 | Offsets von Hand überschreiben |
| `-once` | – | einmal suchen, JSON ausgeben, beenden |

Schnittstelle: `GET /healthz`, `GET /api/objects[?kinds=worm,vehicle,npc,civilian]`, `GET /stream` (SSE: `snap` = voller Stand, `pos` = Änderungen `[id,x,y,z]` und verschwundene IDs, alle 20 s ein Lebenszeichen als Kommentarzeile).

## So funktioniert es

1. **Vtables.** Der Agent öffnet die laufende Binary (`/proc/<pid>/exe`) und liest die Symbole `_ZTV<Länge><Klasse>` der dynamischen Symboltabelle. Zur Laufzeit beginnt ein Objekt mit dem Zeiger `Modulbasis + Symbol + 0x10` (Itanium-ABI); die Modulbasis steht in `/proc/<pid>/maps` (ASLR).
2. **Discovery.** Er durchsucht den beschreibbaren privaten Speicher in 16-MB-Blöcken (4 Worker, je eigener Dateideskriptor) nach 8-Byte-ausgerichteten Werten, die einer dieser Vtables entsprechen. Jeder Treffer ist ein Kandidat.
3. **Namen und Plausibilität.** Namen kommen aus dem `FNamePool` der Engine; der Klassenname liefert den Blueprint (z. B. `BP_Crea_SandwormArrakis_C`). Ein Treffer zählt nur, wenn der Klassenname gültig ist, das Objekt kein `Default__…` und nicht als zerstört markiert ist, `RootComponent` gültig ist und die Position plausibel (|x|,|y| 1 … 3 000 000 cm). Das filtert Geistertreffer aus freigegebenem Heap und Klassenstandards.
4. **Tracking.** Danach wird nur noch die Weltposition gelesen (`RootComponent + Pos`, 3 × double, cm, ~20 µs je Objekt): aktive Objekte (Würmer, Fahrzeuge, alles, was sich in den letzten 10 s bewegt hat) mit `-hz`, alle anderen alle 2 Sekunden samt Gültigkeitsprüfung (Vtable noch da, nicht zerstört). Verschwindet ein Sandwurm (oder 25 Objekte auf einmal), folgt eine neue Discovery.

| Feld | Build 2064155 | **Build 2134304** (Standard) |
|---|---|---|
| `FNamePool` `Blocks[]` (relativ zur Modulbasis) | `0x166B4328` | `0x174125A8` |
| `AActor::RootComponent` | `+0x240` | `+0x238` |
| Position im RootComponent | `+0x180` | `+0x190` |
| `UObjectBase` Flags / Klasse / Name | `+0x08` / `+0x10` / `+0x18` | gleich |

**Nach einem Spiel-Update ändern sich die Offsets.** Der Agent sichert sich selbst ab: Der Pool-Selbsttest (`None` bei Index 0, `ByteProperty` bei Index 3) muss bestehen, sonst wird der Pool **aus seiner Signatur neu gefunden** (Block 0 beginnt mit `None`, `ByteProperty`, dazu ein Zeiger darauf im `.bss`). Liefern die Actor-Offsets keine plausiblen Objekte mehr, werden `RootComponent` (Zeiger auf ein Objekt, dessen Klasse auf `Component` endet) und Position (drei double, die wie Weltkoordinaten aussehen) **aus einer Stichprobe der Treffer neu bestimmt**. Was gefunden wurde, steht im Log. Klappt nichts, meldet er den Prozess als nicht bereit (`/healthz`, Grund) und liefert keinen Müll. Die Overmap hat keine Akteure mit Position; sie bleibt absichtlich „nicht bereit“.

Gemessen auf einem Live-Server (Build 2134304): Hagga Basin ~2550 Objekte in 3,4 s (2410 Gegner, 86 Zivilisten, 46 Fahrzeuge, 9 Sandwürmer), Deep Desert ~250 (9 Sandwürmer), jeder Social Hub ~100; Sandwürmer aktualisieren ~9,4-mal pro Sekunde.

## Sicherheit und Datenschutz

- Nur lesend; kein ptrace, kein Schreibzugriff, keine Injection.
- Die Kommandozeile der Prozesse enthält einen **Auth-Token** (`-ini:engine:…ServiceAuthToken=…`). Der Agent gibt ihn nie aus, schreibt ihn nie ins Log und reicht ihn nie weiter (ausgewertet werden nur Kartenname und `-PartitionIndex`).
- Die Schnittstelle hat keinen Login: Sie lauscht nur auf Loopback. Der Viewer-Server verbindet sich und filtert:
  - **Spieler gehen nur hinaus, wenn sie zugeordnet sind**: einem Online-Spieler, den die Console ohnehin zeigt (gleiche Partition, nächster Abstand, höchstens 300 m, jeder einmal); nicht zuordenbare bleiben unsichtbar, es erscheinen also keine neuen Namen oder Spieler,
  - im öffentlichen Betrieb (`-public`) nur Partitionen der Erlaubnisliste, die die Seite als **PvE** meldet. Würmer und Gegner folgen den Spielern; ihre Bewegung in PvP-Partitionen würde Spielerpositionen verraten.
- Den Agent-Port niemandem öffnen, dem man keine Spielerpositionen zeigen würde.

## Grenzen

- Offsets sind buildabhängig (siehe oben); nach einem großen Update im Log nach der Meldung „neu bestimmt“ sehen.
- Neue Spawns erscheinen bei der nächsten Discovery (`-rescan`, Standard 30 Minuten; früher, wenn ein verfolgter Sandwurm verschwindet). Neue Fahrzeuge und Gegner, die in Spielernähe entstehen, kommen daher manchmal verspätet; verschwundene Fahrzeuge fallen binnen 2 Sekunden weg.
- Positionen sind kein atomarer Schnappschuss; Objekte können zwischen zwei Lesezugriffen verschwinden (sie werden alle 2 Sekunden geprüft).
- Der Scan belastet kurz die Speicherbandbreite (4 Worker, ein Prozess nach dem anderen).

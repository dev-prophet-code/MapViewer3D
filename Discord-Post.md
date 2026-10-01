# Discord-Post – Dune MapViewer3D

Zwei fertige Fassungen (Deutsch / Englisch), jeweils unter 4000 Zeichen (Nitro-Limit).
Als Bilder anhängen: `Discord-Screenshots/01` bis `04` (max. 10 Anhänge pro Nachricht).
Discord rendert Markdown, Links mit `<…>` unterdrücken die Vorschau-Karte.

---

## 🇩🇪 Deutsch

# 🏜️ Dune MapViewer3D – deine Dune-Awakening-Welt in 3D, live

Hallo zusammen! Ich habe einen **3D-Kartenviewer für selbst gehostete Dune: Awakening Server** gebaut (Red-Blinks Docker-Stack). Er läuft im Browser, ohne Installation von Go oder sonstigem, auf **Windows, macOS und Linux**.

**Was er zeigt**
🗺️ **Hagga Basin** (8 × 8 km) und **Deep Desert** (22,5 × 22,5 km) als echtes 3D-Gelände, alle Server-Instanzen einzeln wählbar (PvE, PvP, Creative …)
🧍 **Spieler** live mit Namen, Liste zum Hinfliegen
🏠 **Basen** mit Besitzer, aus der Nähe als **3D-Gebäude aus den echten Bauteilen**
🚁 Fahrzeuge, Höhlen, Ecolabs, Wracks, Siedlungen, Gegnerlager, Spice, Erze, Quicksand u. v. m. – jede Ebene einzeln schaltbar
🌪️ Deep-Desert-Layout je Coriolis-Woche, inkl. Countdown zum nächsten Sturm

**Neu: Live-Daten aus dem Arbeitsspeicher (Positions-Agent)** 🪱
Sandwürmer, Gegner, Zivilisten/Händler, Fahrzeuge, Spieler und **Sandstürme** stehen nicht in der Datenbank, nur im Speicher des Spielprozesses. Ein kleiner, optionaler Agent liest sie **nur lesend** aus (`/proc/<pid>/mem`, kein Eingriff ins Spiel) und der Viewer zeigt sie ~10× pro Sekunde: Würmer gleiten übers Terrain, tausende NPCs als Punktwolke, Stürme als animierte Wirbel mit Zugrichtung.

**Für die Entwickler hier** 🛠️
• Go-Backend (ein Binary, `bin/` für 7 Plattformen), three.js im Frontend
• Gelände & Modelle werden aus den Spieldaten (Paks/IoStore) selbst gebaut, nichts Fremdes mitgeliefert
• Agent: Vtable-Scan über `/proc/<pid>/mem`, FNamePool-Auflösung, Offsets werden bei neuen Builds selbst neu bestimmt
• Read-only überall, Zugangsdaten bleiben lokal; öffentlicher Modus zeigt nur PvE
• Open Source, Issues & PRs willkommen

**Wichtig:** Nur für **eigene Server**. Der Agent braucht Root auf dem Game-Host und gehört nicht auf fremde Server.

🔗 Code & Download: <https://github.com/dev-prophet-code/MapViewer3D> (Release **Beta.12**)
👀 Live ansehen: <https://lafamilia-gaming.eu/karte3d/>

Feedback, Bugs und Wünsche gern hier oder als Issue auf GitHub! 🙌

---

## 🇬🇧 English

# 🏜️ Dune MapViewer3D – your Dune: Awakening world in 3D, live

Hi all! I built a **3D map viewer for self-hosted Dune: Awakening servers** (Red-Blink's Docker stack). It runs in the browser on **Windows, macOS and Linux**, no Go or other tooling needed.

**What it shows**
🗺️ **Hagga Basin** (8 × 8 km) and **Deep Desert** (22.5 × 22.5 km) as real 3D terrain, every server instance selectable (PvE, PvP, Creative …)
🧍 **Players** live with names, plus a list to fly to them
🏠 **Bases** with owner, up close as **3D buildings made from the real building pieces**
🚁 Vehicles, caves, ecolabs, wrecks, sietches, enemy camps, spice, ores, quicksand and more – every layer toggles on its own
🌪️ The Deep Desert layout of each Coriolis week, with a countdown to the next storm

**New: live data straight from memory (position agent)** 🪱
Sandworms, enemies, civilians/traders, vehicles, players and **sandstorms** are not in the database, only in the game process's memory. A small, optional agent reads them **read-only** (`/proc/<pid>/mem`, nothing injected, game untouched) and the viewer shows them ~10×/s: worms glide across the terrain, thousands of NPCs as a point cloud, storms as animated vortices with heading.

**For the devs here** 🛠️
• Go backend (single binary, prebuilt for 7 platforms in `bin/`), three.js frontend
• Terrain and models are built from the game data (paks/IoStore) itself, nothing third-party shipped
• Agent: vtable scan via `/proc/<pid>/mem`, FNamePool resolution, offsets re-derived by itself on new game builds
• Read-only everywhere, credentials stay local; public mode shows PvE only
• Open source, issues & PRs welcome

**Important:** for **your own servers** only. The agent needs root on the game host and doesn't belong on servers you don't run.

🔗 Code & download: <https://github.com/dev-prophet-code/MapViewer3D> (release **Beta.12**)
👀 Live demo: <https://lafamilia-gaming.eu/karte3d/>

Feedback, bugs and wishes welcome here or as a GitHub issue! 🙌

---

## Bildunterschriften (optional, als Text unter den Bildern)

1. `01-hagga-basin-live.png` – Hagga Basin mit Live-Sandwürmern und tausenden NPCs
2. `02-bases-3d-live-npcs.png` – Basen als 3D-Gebäude, Fahrzeug und Live-NPCs
3. `03-deep-desert-coriolis.png` – Deep Desert mit Coriolis-Layout und Countdown
4. `04-layers-panel.png` – die Ebenen zum Ein- und Ausschalten

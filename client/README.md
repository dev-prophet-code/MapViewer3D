# client/ – Daten aus dem Windows-Spielclient

Geometrie, UVs, Texturen und Platzierungen aus dem Dune-Awakening-Client (Steam-Build 26333948), gelesen aus den IoStore-Paks.
Rein additiv: bestehende Ordner (`m/`, `p/`, `buildables/`, `creatures/`) bleiben unverändert.

| Pfad | Inhalt |
|---|---|
| `meshes.jsonl` | Katalog, eine JSON-Zeile je Netz: `pkg` (Spielpfad), `kind` (`static`/`skeletal`), `source` (`render`/`collision`), `lods` (Ecken/Dreiecke je Detailstufe), `lo`/`hi` (Hülle in Unreal-cm), `dml`, optional `uv` |
| `dml/<Spielpfad ohne /Game/>.bin` | LOD0 im Format DML1 (Unreal-cm, Z oben). Nicht vereinfacht; manche Dateien sind größer als 1 MiB, Netze mit mehr als 65.535 Ecken haben u32-Indizes |
| `uv/<…>.uv` | UV-Kanal 0 als `"UVH1"`, u32 Ecken, dann je Ecke u, v als IEEE-Half; gleiche Eckenreihenfolge wie das DML1-Netz. Nur für Netze mit Albedo-Textur |
| `materials.jsonl` | je Netz `slots[{material, textures{Parametername: Texturpaket}}]` |
| `textures/<Spielpfad>.jpg` / `.png` + `textures.jsonl` | Texturen höchstens 512 px (Masken `_M` höchstens 256 px, PNG; Farbe und Normalen JPEG). `textures.jsonl`: `tex, format, w, h, file, bytes` |
| `placements/<Karte>.json` + `placements.jsonl` | Platzierungen aus den Karten: `{map, meshes[], items[[mesh, x, y, z, pitch, yaw, roll, sx, sy, sz, attached]]}`, cm und Grad (Unreal); `attached=1` = relativ zu einem Elternteil |
| `viewer/` | kleiner Testviewer, der alles vom CDN streamt (siehe unten) |
| `failed.txt` | 157 Pakete mit `SM_`/`SK_`-Namen ohne Geometrie (FoliageType-, CtrlRig-, LODSettings-Assets, einzelne Prefabs) |
| `preview/<bereich>/` | Beispielbilder (Graustufen, je Bild sechs Netze) |

`source`: `render` = Render-Geometrie; `collision` = Kollisionsnetz (Chaos-Trimesh aus dem BodySetup) bei reinen `SM_Collision_*`-Netzen
(5.136 Stück, vor allem Biom-Gelände und Felsen; grob, mit scharfen Kanten).

**Grenzen:** Das Spiel nutzt geschichtete Material-Instanzen (Material-Bibliothek, Masken). Eine einzelne Albedo-Textur je Netz ist nur eine Näherung.
Charakter-Kleidung hat keine Textur-Zuordnung. Mehrere Material-Abschnitte je Netz, Skinning/Animation, Instanz-Komponenten (Foliage) und
Blueprint-Akteure sind nicht enthalten. 187 Texturen sind nicht lesbar (111 × FloatRGBA, 76 Layout).

## Viewer lokal starten und aus dem CDN streamen
Node ≥ 18, kein Klon des Branchs nötig. Die drei Dateien aus `client/viewer/` (`index.html`, `server.mjs`, `setup.mjs`) in einen leeren Ordner laden:

```
node setup.mjs     # holt three.js 0.170.0 + OrbitControls aus dem Branch mva-v2
node server.mjs    # http://127.0.0.1:8801
```

Die Seite lädt Katalog und Dateien zur Laufzeit von `raw.githubusercontent.com/dev-prophet-code/MapViewer3D/cdn/`. Tab „Netze“: Netz wählen
(mit Textur = UV + Albedo). Tab „Karten“: Karte wählen, die Objekte werden aufgestellt. Anderes Hosting: Feld „CDN-Basis“ oder `?cdn=<url>`;
`LOCAL_CDN=<Ordner> node server.mjs` und `?cdn=local` testen einen lokalen Klon vor einem Push.

Hinweis: Die Inhalte gehören dem Spielhersteller (Funcom). Diese Daten liegen nur vorübergehend in diesem Branch.

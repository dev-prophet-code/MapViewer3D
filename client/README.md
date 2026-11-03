# client/ – Netze aus dem Windows-Spielclient

Geometrie (LOD0) aller StaticMesh (`SM_*`) und SkeletalMesh (`SK_*`) des Dune-Awakening-Clients (Steam-Build 26333948),
gelesen aus den IoStore-Paks und im DML1-Format abgelegt. Rein additiv: bestehende Ordner (`m/`, `p/`, `buildables/`,
`creatures/`) bleiben unverändert.

- `meshes.jsonl` – Katalog, eine JSON-Zeile je Netz: `pkg` (Spielpfad), `kind` (`static`|`skeletal`), `lods` (Ecken/Dreiecke je Detailstufe),
  `lo`/`hi` (Hülle in Unreal-cm), `dml` (Pfad der Datei relativ zu `client/`).
- `dml/<Spielpfad ohne /Game/>.bin` – Netz im Format DML1 (siehe `creatures/index.json`-Beschreibung im `cdn`-README).
  Einheiten Unreal-cm, Z oben; der Viewer wandelt nach three (Meter, Y oben, y/z getauscht, Dreiecksreihenfolge gespiegelt).
  Netze mit mehr als 65.535 Ecken haben u32-Indizes; die Viewer-Obergrenze von 200.000 Ecken und 1 MiB je Datei gilt hier nicht,
  manche Dateien sind größer.
- `preview/<bereich>/1..3.png` – Beispielbilder (Graustufen, schräge Ansicht, je Bild sechs Netze; `modelle.txt` nennt die Namen).
- `failed.txt` – Pakete, bei denen keine Geometrie erkannt wurde (ca. 20 %, vermutlich Nanite oder anderes Layout; nicht geprüft).

Nicht enthalten: UVs, Normalen, Materialien, Texturen, Platzierungen, Skinning/Animation. Die Ruhepose der Skelett-Netze ist unverändert.

Hinweis: Die Inhalte gehören dem Spielhersteller (Funcom). Diese Daten liegen nur vorübergehend in diesem Branch.

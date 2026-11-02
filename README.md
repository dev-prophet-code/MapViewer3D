# MapViewer3D data (branch `cdn`)

Streaming data for the MapViewer3D addon (branch `DD-Addon`). This branch contains **only data**, no code.

| Path | Content |
|---|---|
| `catalog.json` | list of maps (name, size, calibration) with the SHA-256 of every map index and building model |
| `m/<map>.json` | tile index of one map: which tile sits at which level / column / row |
| `p/<xx>/<id>.z` | terrain tiles (gzip). The file name is the first 16 hex digits of the SHA-256 of the tile content, so identical tiles are stored once across all maps and Coriolis layouts |
| `buildables/` | building models (`index.json`, `mesh/<id>.bin`) |
| `creatures/` | bodies of sandworm, player figure and Choam ornithopters (`index.json`, `mesh/<id>.bin`), from the physics assets; listed in `catalog.json` under `creatures` |
| `preview/` | 10 example renders of the models (plain shading, no textures) |
| `notes/` | encrypted working notes (not data for the addon) |

The addon is pinned to a tag of this branch (`data-vN`) and verifies every file against the checksums above, starting from the
SHA-256 of `catalog.json` that is built into the addon. Tags never change; new data means a new tag and a new addon release.
Format and generator: `tools/tilepack.mjs` in branch `DD-Addon`.

Nothing here is meant to be opened by hand. Terrain tiles are 129×129 height samples plus material bytes in a compact delta/gzip format.

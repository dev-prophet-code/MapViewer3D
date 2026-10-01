# Data pipeline (maintainers)

The addon streams its terrain and building models from branch `cdn` (tag `data-vN`). This is how a data release is made.

## 1. Extract the terrain (needs the game files)

With the viewer from the `main` branch (`backend/cmd/extract`, see its README), on a machine that has the game's pak files:

```bash
go run ./cmd/extract -layout all      # every Coriolis layout of the Deep Desert, plus Hagga Basin and the dune template
```

This writes `data/<map>/{meta.json,height.u16,material.u8}` (+ `data/buildables/`). A server running Dune Docker has the pak files
in the volume `dune-awakening-selfhost-docker_dune-server`; a locally built `extract` needs the `paks` build tag (C++ compiler for
Oodle) when it reads the paks itself.

## 2. Cut into tiles

```bash
node tools/tilepack.mjs <dataDir> <outDir>        # outDir = a checkout of branch cdn
```

Writes `catalog.json`, `m/<map>.json`, `p/<xx>/<id>.z` and `buildables/`. Tiles are content-addressed (file name = first 16 hex
digits of the SHA-256 of the tile), so unchanged or shared tiles (the repeated dune template, identical areas across layouts) are
stored once; re-running only adds what is new. It prints the SHA-256 of `catalog.json`.

## 3. Publish and pin

1. Commit the new files in branch `cdn` (in several pushes of ~10-25 MB each; one giant push can fail), tag the last commit `data-vN`.
2. `node tools/pin-data.mjs <outDir> data-vN` writes the tag and the catalog checksum into `web/js/config.js`.
3. Bump the addon version, run `bash scripts/package.sh`, release as usual (`addon-vX.Y.Z`).

Older data tags stay valid forever: an installed addon always loads exactly the data it was released with.

## Format (FORMAT 1)

A tile is the patch the viewer asks for: 129×129 height samples (uint16) followed by 129×129 material bytes, from raster position
`(x,y)*128*2^level` with step `2^level`. Stored as gzip of: low-byte plane, high-byte plane (heights delta-coded along rows), material
bytes. `web/js/data.js` (`decodeTile`) reverses it; `tests/unit.mjs` checks the result against the raw rasters.

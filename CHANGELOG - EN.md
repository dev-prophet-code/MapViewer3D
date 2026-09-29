# Patch Notes – Dune MapViewer3D

Every change to the viewer is listed here, with the newest version at the top.

**Rules for this file**

- Every change goes into the current version immediately, not just upon release.
- If a change is discarded, its entry remains. It is ~~struck through~~, marked with **Discarded** and the reason, and additionally listed under *Discarded*. This keeps a record of what was tried.
- The version number is also located in `backend/server/server.go` (`Version`) and at the top of the control panel.

---

## Beta.6 – 09/29/2026

### New

- **Deep Desert: the layout's rocks, ecolabs and wrecks.** Beta.5 built only the terrain tiles of the weekly layout. Now the *content blocks* that the layout's 162 clusters place in the desert (rock formations, ecolab sites, shipwrecks, sandfly camps: about 720 blocks) are read from the game files as well, rotated and placed on the map like the fixed blocks of row A, and rasterised into the terrain. The desert beyond row A therefore shows the objects of the server's current map state, not just the ground.
- The number of blocks and their meshes appears in the log of `extract` (e.g. *162 clusters, 727 content blocks*).

- **Follows every Coriolis storm by itself.** With the game files (`mapviewer -paks <folder>`) the server asks the console for the current layout every 5 minutes; when a storm brings a new one it builds the matching Deep Desert terrain in the background (about 15 s), keeps the newest three layouts and removes older ones. The map list switches to the new terrain by itself, and the open browser tab reloads the Deep Desert without a page reload (camera and selection stay). Until it is ready the panel says that the terrain is being built. Without game files the viewer keeps showing the matching terrain if it has one, otherwise the dune template, and warns.
- Live objects (players, bases, vehicles, spice, ore, scrap) were already read from the console continuously; together with the layout terrain the map now always shows the server's current state.

### Notes

- Block positions fall inside the tile patches of their clusters, which also confirms the placement of the tile grid.
- Blocks stay part of the terrain height map (2.5D, no overhangs), like the rocks in row A.

---

## Beta.5 – 09/29/2026

### New

- **Deep Desert with the weekly Coriolis layout.** Beyond row A the game builds the world from a layout the server picks each Coriolis cycle (`DA_DeepDesert_1_Layout_NN`, the number is `coriolisLayout` in the console). The viewer now reads that layout from the game files and builds the terrain from its 24 × 24 tile plan (tiles of 1016 m: craters, ramps, ecolab and shipwreck sites, spice areas) instead of one repeated dune template. Cells without an override stay dune. The current map state of the server is therefore what you see in 3D.
- **The viewer picks the matching terrain.** The server reports its layout through the console (`coriolisLayout`, `coriolisNextCycleAt`); the viewer loads the terrain built for that layout and shows *Coriolis layout N · changes … (in x d y h)* under the map. If no terrain exists for the current layout, a warning names the command that builds it.
- **Map grid A1–I9.** New switch under the map selection (Deep Desert only): the 9 × 9 cells of 2.5 km as in the game and on the console map (row A north, column 1 west), drawn as lines on the terrain, with the cell names floating above.
- **`extract -layout`** builds Deep Desert terrain per layout into `data/deepdesert_1_lNN/`: `auto` (default: current layout from the console), a list such as `8,9`, `all` (all layouts in the game files) or `none` (old dune template). One layout takes about 10 s and 170 MB, so ready-made packages contain the current layout only.

### Notes

- The tile grid is placed on the map from its centre and the 63.5 m lattice of the layout's generic actors (accuracy about 16 m).
- Rocks, ecolab and shipwreck buildings that the layout places as *content blocks* are not shown yet; the terrain under them is.

---

## Beta.4 – 09/29/2026

### Security

Fixes from an external security review (thanks!).

- **Setup guard no longer fails open behind a reverse proxy.** A request now only counts as the local administrator if it comes from a loopback address, carries no proxy header **and** is addressed to a loopback name (`localhost`, `127.0.0.1`, `[::1]`). A proxy on the same machine that forwards the public host name (even without `X-Forwarded-*`) is therefore treated as a visitor, which also blocks DNS rebinding. New option **`-no-local-admin`** switches browser setup off completely (use `-config` instead).
- **Console check hardened against SSRF.** Link-local targets (including cloud metadata `169.254.169.254`), multicast and `0.0.0.0` are refused when connecting (also after DNS resolution), redirects are not followed and no environment proxy is used. Only the browser on the machine itself gets detailed error messages; with `-remote-setup` all failures collapse into one generic "unreachable", so the check cannot be used as a port scanner.
- **Account IDs are no longer sent to visitors.** `account_id`, `action_player_id`, `funcom_id` and `fls_id` are removed from live data for everyone except the local administrator, even without `-public`. Starting on a network-reachable address without `-public` now prints a prominent warning.
- **No more CDN.** three.js 0.170.0 ships in `viewer/vendor/` (unmodified, MIT). The server sends a `Content-Security-Policy` (own origin only; the import map is allowed by hash), `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`. The page can still be embedded in an iframe.
- **CI security scanning:** `gitleaks` and `govulncheck` now run on every push and pull request.

### Fixed

- Extraction tools no longer panic on truncated or unexpected package data (`zen.Properties`, `zen.StructArray`, container header); they return the truncation error instead. Regression tests cover every truncation length.
- The map list is built once per load instead of twice.

---

## Beta.3 – 09/29/2026

### New

- **Mouse wheel = free camera:** the wheel rotates the camera around the view centre, Shift + wheel tilts it, Ctrl/⌘ + wheel (or trackpad pinch) zooms. Dragging works as before.
- **Compass** (bottom right): shows north, south, east and west and turns with the camera. A click faces north.
- **Light / dark switch:** sun/moon toggle under the compass. It changes the interface and the 3D scene (day sky and light vs. night sky and moonlight). The choice is remembered; the default follows the system setting.
- **Fullscreen button** (or key `F`) shows the whole viewer full screen.
- **Panel toggle** hides and shows the side panel; **Show all / Hide all** switches all layers at once.
- **Guide:** the new `?` button (and the link in the panel) opens a guide to camera, keyboard and buttons.

### Fixed

- Names, icons and markers are now hidden behind mountains instead of shining through the terrain.

---

## Beta.2 – 09/26/2026

### New

- **Runs without Go on Windows, Linux, and macOS.** The program is pre-built for six systems in `bin/`: Windows, Linux, and macOS, each for x64 and ARM. It is launched using `start.bat` (Windows), `start.command` (macOS, double-click), or `./start.sh` (macOS/Linux). The browser opens automatically.
- **Server operation:** `-addr 0.0.0.0:8795` makes the viewer accessible over the network. Access credentials and instance names can then only be changed in the browser on the server itself. Visitors see neither the server address nor the fingerprint; requests via a reverse proxy are always treated as visitors. With `-remote-setup`, setup is enabled for everyone (only behind your own access protection).
- **2D map icons:** From a distance, every object appears with the icon from the 2D live map (Console or lafamilia-gaming.eu): players, bases, vehicles by type, caves, ecolabs, wrecks, sietches, trading posts, enemy camps, strongholds, NPCs, ores by type, scrap, plants, aeolian sand (mehlsand), storage, and spice. Spice fields show "LIVE" or "?" just like in the Console and are scaled by field size. Up close, the 3D models take over.
- **Hazard icons:** Quicksand (treibsand), drum sand (trommelsand), and radiation do not have an image in the Console. They receive custom icons in the same style: dark disc, colored ring, symbol.
- **Legend = Map:** The switches in the control panel, the player list, and the info box display the exact same icons as the map.
- **Version in the control panel** next to the title; `mapviewer -version` displays it as well.
- **Project folder without credentials:** credentials, instance names and all caches
  (map images, icons) now live in the user folder:
  - Windows: `%AppData%\MapViewer3D\state`
  - macOS: `~/Library/Application Support/MapViewer3D/state`
  - Linux: `~/.config/MapViewer3D/state`

  The project folder therefore always stays as shipped: whoever receives it has to
  enter server and token themselves. On the first start of a new version, the viewer
  moves old credentials from `state/` in the project folder to the user folder and
  deletes `state/` and `data/*/mapimage.png`.
- **`check-clean.sh`** verifies that the project folder contains no credentials,
  instance names, caches or plaintext tokens. `build-release.sh --zip` only builds the
  package if the check passes.
- `-config <file>` contains the token in plaintext. If the file lies inside the
  project folder, the program warns on start.

### Fixed

- **Windows did not start.** The distributed `MapViewer3D.zip` was still Beta.1: no
  Windows program, only `start.sh`, which needs Go. The package is now built with
  `build-release.sh --zip` and contains all programs and start scripts.
- `start.bat` is more robust:
  - It lifts the download block (SmartScreen/Mark-of-the-Web) for `bin/`.
  - Paths with umlauts work (UTF-8 code page).
  - It starts the program by its full path.
  - On an error the window stays open with the message.
- **macOS and Linux checked for the same start problems** (tested on Alpine ARM64,
  Debian x64, Debian 32-bit ARM, macOS ARM and Intel via Rosetta; the previous state
  would not have started on macOS and Linux either, because the old package had no
  program):
  - `start.sh` removes the macOS quarantine for the whole folder (not just the
    program), so `start.command` works afterwards too.
  - Lost execute permissions (some unzip tools) are restored by `start.sh` for program
    and scripts; `sh start.sh` always works.
  - New: program for 32-bit ARM Linux (`linux-arm`, e.g. Raspberry Pi); before,
    `start.sh` stopped there with "unsupported architecture".
  - Drives without execute permission (`noexec`) are detected and reported clearly
    instead of "Permission denied".
  - Systems that are too old are reported before starting: macOS below 13
    (`start.sh`) and Windows below 10 (`start.bat`). Before, there was a cryptic
    message or a silent exit.
  - Without a user folder (`$HOME` missing, e.g. in some services) the program names
    the fix (`-state`/`-keydir`).
  - README: Gatekeeper notes for macOS 13–15+ (the program is not notarized).
- The `.exe` also starts by double-click: the browser opens, and on an error the
  window waits for Enter instead of vanishing immediately. Started without arguments,
  the program opens the browser on every system.

### Changed

- **Bases in 3D only in the field of view.** Previously, all bases within a 2.5 km radius around the camera were loaded, even behind it. Now, the viewer only loads bases within the field of view (up to 2.5 km) and directly around the camera (500 m), closest ones first, up to three simultaneously. Anything leaving the field of view and radius is discarded after 4 s and its memory freed. The last 60 base data entries remain in memory so that panning back doesn't reload anything. The status line shows how many bases are in the field of view.
- **Better visibility:** The colored dots of the distant view have been replaced by icons that stand out from the sand with a dark border. From a great distance, the icons become smaller so that the overview remains legible.
- Names are displayed above the icon instead of covering it.
- The program automatically finds `data/` and `viewer/` next to `bin/`. Paths no longer need to be specified manually.

- **Public mode with PvE filter:** `-public <file>` (JSON with `partitions` and
  `modeSource`) only lets through partitions that are on the list **and** reported as
  PvE by `modeSource`. Filtering happens on the server: players only while online and
  without IDs, base exports only for allowed bases, the instance list only with
  allowed partitions. If the source is unreachable for more than 10 min, no partition
  is shown.
- **Embedding (`?embed=1`):** language (`?lang=`) and start map (`?map=HaggaBasin`)
  come from the host page; title, language picker and connection are hidden. The page
  controls the viewer via `postMessage` (`{type: 'dune3d', map, paused}`) and receives
  `{type: 'dune3d', ready: true}` once the terrain is drawn.

### Technical

- New endpoint `GET /api/icons/<file>`: fetches the marker image from the registered Console (`/images/maps/…`) and caches it in the settings folder under `icons/` (~~`state/icons/` in the project folder~~, **Discarded**: does not belong in the shared project). Images are not bundled. When switching servers, the cache is cleared. If an image is missing, a colored dot appears.
- New endpoint `GET /api/version`.
- The viewer server is pure Go without cgo. `build-release.sh` builds all systems, while `build-release.sh --zip` additionally builds `../MapViewer3D.zip` for sharing, with source code and without Paks (~~`dist/MapViewer3D-<version>.zip` without source code~~, **Discarded**: the package replaces the previous `MapViewer3D.zip`, and without `backend/` `start.sh --build` did not work).
- The Console map image now lives in the settings folder (`mapimages/`) instead of `data/<map>/mapimage.png`.
- The old standalone program `bin/mapviewer` has been replaced by `bin/mapviewer-<system>-<cpu>`.

### Cleaned up

- Reduced the project folder to the files that the viewer, the start scripts and the
  map build actually need:
  - Removed `data/*/preview.png` (9.6 MB), along with the endpoint
    `/api/map/<name>/preview.png` and its generation in `cmd/extract`. The minimap
    they were meant for no longer exists since the editor was removed.
  - Of the header library `simde` (Oodle decompressor for the map build), only the
    15 headers that are actually included remain; 457 unused ones are gone
    (10 MB → 0.9 MB). Verified with cgo builds of `cmd/extract` on macOS (ARM, x64)
    and Linux (GCC).
  - Removed `.gitignore` (the project is not a Git repository; protection against
    credentials lives in `check-clean.sh`).
  - Removed the unused constants `FilePreview` and `FileMapImage`.
- The developer scripts `build-release.sh` and `check-clean.sh` are no longer part of
  the distribution package; they stay in the project folder only.
- Distribution package: 1277 files.

### Discarded

- Credentials and caches under `state/` in the project folder: they would have been
  shared along with it. Replaced by the user folder.


---

## Beta.1 – 09/25/2026

- First distributable version: Hagga Basin and Deep Desert per server instance, live Console data, bases in 3D, encrypted access credentials, interface in English/German. Launched with `./start.sh`; Go and a C compiler were required.
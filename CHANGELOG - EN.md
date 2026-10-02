# Patch Notes – Dune MapViewer3D

Every change to the viewer is listed here, with the newest version at the top.

**Rules for this file**

- Every change goes into the current version immediately, not just upon release.
- If a change is discarded, its entry remains. It is ~~struck through~~, marked with **Discarded** and the reason, and additionally listed under *Discarded*. This keeps a record of what was tried.
- The version number is also located in `backend/server/server.go` (`Version`), at the top of the control panel and in the header comment of `start.bat`, `start.command`, `start.sh` and `SECURITY.md`. Update all of them with every release.

---

## Beta.16 – not yet released

### New

- **Realtime Data from Dune Docker.** Sandworms, enemies, civilians, vehicles and storms now also reach a viewer on your own PC – through the Dune Docker Console, with the API key you already use. Grant it in the Console under **Settings → API Keys** with the new row **Realtime Data** (None / Read); live player positions additionally need **Players → Read**. The viewer asks briefly at start (at most 5 s, then every 10 minutes and after every server switch). If the Console does not answer as expected – Dune Docker without the feature, agent not running, key without the permission – the switches for worms, enemies and vehicles are simply not shown; the log says why. When the key is disabled, expires or is revoked, the viewer disconnects. On the game server the position agent runs as a container reachable on `127.0.0.1` only (branch `ddp`); the Console change is a patch there and not yet part of Dune Docker.
- **Encrypted only.** Realtime Data is used only when the Console is connected via **HTTPS** or runs on the same machine. With `http://IP:8088` the switches stay off.
- **The viewer finds the server's encrypted front door by itself.** The stack in branch `ddp` optionally ships `mvtls`: HTTPS with its own long-lived key that forwards to the unchanged Console (only `GET /api/*` with an API key, no web UI, no cookies). When the viewer is connected over plain `http://` to a (non-local) Console, it asks port 8797 of the same host (a TLS handshake without any token, plus `GET /mvtls`). If `mvtls` answers, a dialog shows the key's **fingerprint**; compare it with `mvtls -pin` on the server and confirm. The viewer then re-checks the key, sends the token only over the encrypted connection and uses it for everything (maps, bases, icons, Realtime Data). The entry is replaced and instance names move with it. "Not now" is remembered. A viewer that already knows the fingerprint (`-api-pin`) switches without asking; with a fixed configuration (`-config`) it only logs the address and fingerprint. The *Connection* section now shows whether the connection is encrypted. Dune Docker (with the patch from `ddp`) shows the fingerprint to compare under *Settings → Encrypted API Access*, at the end of the installer and with `dune encrypted-api fingerprint`; the standalone stack with `mvtls -pin`.
- **Self-signed and internal certificates** (e.g. Caddy `tls internal`, note: their key changes every few hours – pin `mvtls` instead): during setup the viewer names the certificate's fingerprint; after comparing it on the server, enter it in the new **Certificate fingerprint** field (or `-api-pin` / `MV_API_PIN` / `apiPin` in `-config`). Exactly that key is then accepted; another one is treated as a possible attack and refused.
- **Switch server.** New button in the *Connection* section: every server you have connected to stays in an encrypted list; one click switches the running program to another one (the page reloads with its maps and live data) without entering the token again. **Add server …** opens the setup, ✕ removes a server and its token. Instance names are kept per server. Not shown with a fixed configuration (`-config`) or to visitors of a public viewer.

### Notes

- The changes Dune Docker needs (API key scope *Realtime Data*, encrypted API access with the fingerprint in the installer and in Settings) are ready as two patches in branch `ddp` and are not yet part of Dune Docker. Without them the realtime switches stay hidden and the viewer behaves like Beta.15.

### Fixed

- `https://server` without a port became port 8088; it is now port 443 (reverse proxy in front of the Console).
- If the viewer cannot reach an agent for a while, the log shows its address without credentials.

### Discarded

- ~~Separate access `mvgate` with a pairing code (`mvlive1:…`, `-agent-pair`) and a Settings section "MapViewer3D Live Data" in the Console~~, **Discarded**: replaced by the API key permission *Realtime Data* – one credential instead of two, no extra port, revocation and expiry like any API key.

---

## Beta.15 – 10/01/2026

### Fixed

- **Second start no longer fails with "address already in use".** If the viewer is already running (e.g. a second double-click on `start.command`), the new start now opens the running one in the browser and exits; if another program holds the port, the message says so and how to pick another port.

### Notes

- Reminder: the example website for your own site (including how to get the real-time data onto it) arrived in Beta.14: `examples/website/`, see [README](README.md#-use-it-on-your-own-website-with-real-time-data).

---

## Beta.14 – 10/01/2026

### New

- **Map data streams from GitHub.** Terrain tiles and building models are no longer shipped in the package; the viewer streams them from the `cdn` branch of the repository (tile by tile, verified against the SHA-256 sums in `catalog.json`, cached in the user folder, mirror via jsDelivr). The release package shrinks from ~250 MB to ~30 MB, and "Download ZIP" of `main` works: `start.sh` / `start.bat` fetch the program from the latest release. A local `data/` folder still works as a fallback, `-cdn off` uses only it, `-cdn <address>` points to your own mirror (`cdn` in `-config`). The Deep Desert layout builder skips layouts the branch already knows.
- **The `cdn` branch updates itself.** `deploy/cdn-sync/` (script, systemd timer, `cmd/cdnsync`) cuts the extracted maps into tiles (the Go port is byte-identical to the addon's `tilepack.mjs`) and pushes only what is new; when the game build changes it extracts maps, **all Coriolis layouts** and building models again. Runs on the live server (cca-server). See [docs/CDN-Sync-EN.md](docs/CDN-Sync-EN.md).
- **Example website** in `examples/website/`: a small page with the viewer built in (`<iframe>`, map buttons via `postMessage`), `config.example.json` for server address and API token, nginx and systemd examples, all commented.
- **`-agent auto`** (`"agentUrl": "auto"`): the viewer detects that it runs on the game host (Dune server processes visible in `/proc`) and, as root, starts the position agent inside itself; `-agent-players` adds players. Otherwise it logs why there is no real-time data.
- **Support link:** a small ☕ icon in the viewer and the repository's Sponsor button point to <https://buymeacoffee.com/lafamiliagaming>.

### Fixed

- Start with a missing `data/` folder is no longer an error (see above); the start scripts explain missing programs.

### Notes

- Needs an internet connection (maps and updates). Offline use: keep a local `data/` and start with `-cdn off`.

---

## Beta.13 – 10/01/2026

### New

- **Updater.** The viewer checks GitHub for a newer release (shortly after start, then every 6 hours). With a download installation the panel shows **Update available** and **Update now** installs it with one click: download of `MapViewer3D-update-Beta.N.zip` (without map data), SHA-256 check, backup of the old files in `.update/`, replacement of program, `viewer/`, docs and start scripts, restart, and the page reloads by itself. Servers can install by themselves with `-auto-update` (`MV_AUTOUPDATE=1`, `"autoUpdate": true` in `-config`); a program built with `-tags paks` is rebuilt from the package's source. `-no-update-check` turns it off; with `-public` nothing is shown. The position agent has its own `-auto-update` (off by default, it runs as root). The release script builds the update package (`./build-release.sh --update`); a release without it is only announced, not installed. Details: [README](README.md#-updates), [SECURITY.md](SECURITY.md).

### Notes

- Installations before Beta.13 have no updater and must be updated once by hand.

---

## Beta.12 – 10/01/2026

### Fixed

- **Live data (sandworms, NPCs, players, vehicles, storms) disappeared.** The position agent re-derives its memory offsets when a map process yields no plausible objects. On small maps (story rooms, Overmap; 9–11 hits) this produced wrong values (`Pos=0x1F8` instead of `0x190`) and adopted them for **all** maps *before* checking them. From then on every position read as about (1,1) and the viewer showed nothing, while the agent still reported `ok`. Re-derived offsets are now adopted only if they actually yield objects, and the re-derivation needs at least 30 sample hits. Verified on a test server and on the live server (27 sandworms, players, correct positions).

### Notes

- Existing installations: replace `mvagent` with the one from this release and restart it. Check: `curl 127.0.0.1:8796/healthz` must show `"pos":"0x190"`.

---

## Beta.11 – 10/01/2026

### New

- **Sandstorms and the Coriolis schedule, live.** The position agent now also reads sandstorms (`ASandStormBase`, shown as *Sandstorms (live)*) with position and **heading** (world rotation; checked against the movement direction of all nine sandworms on a test server) and the **Coriolis cycle** (start of the running and of the next cycle, read from the game's `CoriolisSubsystem`; matches the server log to the minute). The 3D viewer draws a storm as nested, animated ellipse walls (gust front, storm wall, core) with swirling sand, heading arrow and icon, plus a countdown to the next Coriolis storm in the status line. The shape follows the game's data assets (`StormZoneData_*`, `Level3_Settings`); the size per map is **derived** from the game data (Deep Desert: full level-3 scale; Hagga Basin: half-length 3000 m from the route margin) and not yet measured on a running storm. The Coriolis storm itself is only a ring marker, because the game gives no fixed shape for it.
- **A short storm scan.** A storm only exists while it runs, so waiting for the full discovery (30 min) would show it far too late. The agent therefore searches for storm objects only every 3 minutes (`-storm-scan`, negative = off); this is cheaper than a full discovery.
- **Probe mode `mvagent -probe 'Storm|Coriolis' -pid N`.** Lists all classes whose vtable symbol matches a pattern, their instances and an annotated field dump of each actor; for exploring unknown game objects.

### Notes

- No sandstorm was running while this was built, so the live path of the storm *object* was verified with simulated data and unit tests, not on a real storm. The Coriolis schedule and the heading offset were verified on a running server.
- Sandstorms spawn every 45–60 min on Hagga Basin and 55–65 min on Deep Desert (`DA_SandstormSettings_*`); they are not predicted, only shown while they exist.

---

## Beta.10 – 10/01/2026

### New

- **Live players.** With the agent started as `mvagent -players`, the viewer now moves the console's online players in real time (10 Hz, smooth) instead of jumping every 5 s. The agent reads `ADunePlayerCharacter` positions from the game's memory; the viewer server matches each one to an online player of the console (same partition, nearest distance, at most 300 m, each once) and re-matches every 3 s. See [docs/Agent-EN.md](docs/Agent-EN.md#live-players--players). Without `-players` nothing changes.

### Security

- Live players are forwarded only when matched to an online player the console already shows (in public mode: PvE partitions only), so no new names or players appear. Unmatched players stay invisible. Two players standing right next to each other can swap for a moment.

---

## Beta.9 – 10/01/2026

### New

- **Live sandworms, enemies, civilians and vehicles.** NPCs are not in the database or the console API; they exist only in the memory of the running game process. A new program, the **position agent** (`mvagent`, Linux, runs as root on the game host, read-only), reads their positions from there about 10 times per second and the viewer shows them live: **sandworms** (all of them, worldwide, gliding smoothly at ~20 position changes per second), **enemies**, **civilians & traders** (point clouds, thousands cost nothing) and **vehicles (live)**. Four new switches in the panel (worms on by default); clicking an object shows its type, blueprint class and position. Without an agent nothing changes and the switches do not appear. Start the viewer with `-agent http://127.0.0.1:8796` (or `MV_AGENT` / `agentUrl` in the `-config` file). Details, flags, the offsets of game build 2134304 and how the agent re-detects them after a game update: [docs/Agent-EN.md](docs/Agent-EN.md).
- **The agent protects itself against game updates.** It checks the engine's name pool (`None` at index 0, `ByteProperty` at index 3) and, if the stored offsets no longer fit, finds the pool again from its signature and re-determines the actor offsets (RootComponent, position) from a sample of the hits. If nothing gives plausible objects the process is reported as not ready instead of delivering garbage.
- **Light on the game server.** Active objects (worms, vehicles, anything that just moved) are read at 10 Hz, everything else every 2 s; the full memory scan runs every 30 minutes (plus when a sandworm vanishes, at most once a minute), one process at a time. On a live server with 8 map processes this costs a few percent of one core on average.
- **Streaming with interpolation.** The viewer server relays the agent's stream (SSE, `GET /api/agent/<map>/stream`) to the browser: the full state first, then only changes (up to 10 Hz). The browser glides the markers between samples; if the stream is unavailable it asks every 3 s. The program sets `X-Accel-Buffering: no` so nginx does not buffer the stream.

### Security

- **Players are never forwarded.** The agent does not output players unless started with `-players`, and the viewer server drops them in any case (player positions come from the console as before).
- **Public mode only shows PvE.** Sandworms and enemies follow the players, so their movement in a PvP partition would reveal where players are. With `-public` the agent feed contains only partitions on the allow list that the site reports as PvE.
- The agent's interface has no login and refuses non-loopback addresses unless started with `-allow-open`. It never prints or forwards the process command line (it contains the game server's auth token).

### Changed

- Release ZIPs now contain `bin/mvagent-linux-amd64` and `bin/mvagent-linux-arm64` and the `docs/` folder. The CI vets, tests and builds the agent.

---

## Beta.8 – 09/30/2026

### Removed

- **Map grid A1–I9 (Deep Desert) removed.** The console map image shown in the viewer already draws this grid, so the extra lines and floating cell names were redundant. The switch under the map selection, grid.js and the terrain shader's cell overlay are gone. (Beta.5 entry below stays as a record.)

### Security

- **Upgrade of the Dune Docker addon (0.1.6) no longer reuses an old viewer.** Viewer versions before Beta.7 ignore the password setting, so an upgrade that kept the old files could look protected while the viewer stayed open. The addon installer now records which viewer release it unpacked, replaces every install that does not match the pinned release (Beta.8; your config.json with API key and password stays untouched, extra terrain folders under data/ are kept) and, before it reports success, checks the running viewer: without login it must answer 401, with the password 200; otherwise it stops the container. A regression test (scripts/test-upgrade.sh in the addon) runs the upgrade from a real Beta.6 install and asserts exactly this.

---
## Beta.7 – 09/29/2026

### Security

- **Password for network operation.** A viewer bound to a non-loopback address (e.g. `0.0.0.0:8795`) now needs a password (`-password`, `MV_PASSWORD`, or `viewerPassword` in the `-config` file); the browser asks via HTTP login (any user name). The comparison is constant-time. Without a password the program refuses to start on a network address; unprotected network operation needs the explicit `-allow-open`. Loopback operation (the default) is unchanged. Reason: a review of the Dune Docker addon pointed out that the viewer exposed live player names and positions without any login.

---

## Beta.6 – 09/29/2026

### New

- **Deep Desert: the layout's rocks, ecolabs and wrecks.** Beta.5 built only the terrain tiles of the weekly layout. Now the *content blocks* that the layout's 162 clusters place in the desert (rock formations, ecolab sites, shipwrecks, sandfly camps: about 720 blocks) are read from the game files as well, rotated and placed on the map like the fixed blocks of row A, and rasterised into the terrain. The desert beyond row A therefore shows the objects of the server's current map state, not just the ground.
- The number of blocks and their meshes appears in the log of `extract` (e.g. *162 clusters, 727 content blocks*).

- **Follows every Coriolis storm by itself.** With the game files (`mapviewer -paks <folder>`) the server asks the console for the current layout every 5 minutes; when a storm brings a new one it builds the matching Deep Desert terrain in the background (about 15 s), keeps the newest three layouts and removes older ones. The map list switches to the new terrain by itself, and the open browser tab reloads the Deep Desert without a page reload (camera and selection stay). Until it is ready the panel says that the terrain is being built. This needs a program built with `go build -tags paks` (the game-file reader needs a C++ compiler); the ready-made programs stay pure Go and print this hint when started with `-paks`. Without game files the viewer keeps showing the matching terrain if it has one, otherwise the dune template, and warns.
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
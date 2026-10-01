<!-- Text of the pull request to Red-Blink/dune-docker-addons. Update it with every addon release:
     version, release link, SHA-256, "What changed" and "Tested". Placeholders {{...}} are filled after the release exists. -->

## MapViewer3D 0.2.0 (update of the existing catalog entry `mapviewer3d`)

0.2.0 replaces the companion-container design of 0.1.x. **There is no installer, container, listening port or viewer password any more**; the viewer runs entirely inside the addon page. This removes the surface that the earlier reviews of 0.1.x were about (network exposure of the viewer, upgrade of an old viewer, package line endings). Thank you for those reviews, they led here.

- **Source:** https://github.com/dev-prophet-code/MapViewer3D (branch `DD-Addon`, MIT)
- **Release:** https://github.com/dev-prophet-code/MapViewer3D/releases/tag/addon-v0.2.0
- **Pinned package:** `https://github.com/dev-prophet-code/MapViewer3D/releases/download/addon-v0.2.0/mapviewer3d-0.2.0.zip` (about 350 KB)
- **SHA-256 (verified by downloading the published asset):** `acde033801b969d9824c53ad1374c288be86d1b3e810597591f622ee8a24764d`
- **Catalog change:** `addons/mapviewer3d.json` and `index.json`: `version`, `downloadUrl`, `sha256`, `description`, and `permissions` (see below). No new addon file.

### What it does
Live 3D map of Hagga Basin and Deep Desert: players, bases (as 3D buildings), vehicles, hazards, resources, and the Deep Desert as the server's current Coriolis layout. Read-only.

### How it works (what to review)
```
Browser (addon page in the console)
  ├── live data: GET /api/map/..., /api/bases/...   same console, Authorization: Bearer <API key>
  └── terrain + models: GET raw.githubusercontent.com / cdn.jsdelivr.net   branch "cdn", tag data-v1
```
1. **API key, not the admin session.** The user creates a key in the console (*Settings -> API Keys*, scopes `maps: Read` and `bases: Read`, everything else None) and enters it in the addon. Every call to the console is a `GET` with `Authorization: Bearer <key>` and `credentials: "omit"`, so the browser never attaches the logged-in admin's session cookie. The addon has the rights of that key and nothing else. (An addon page is same-origin with the console, so this cannot be enforced technically from outside; it is enforced in code - `web/js/console.js` - and checked by `tests/harness.mjs`, a mock console that records every request lacking the key or carrying a session cookie. In a real browser run it recorded none.)
2. **Key storage (changed in 0.2.1 after review):** the key is held **in memory only**. The console isolates `addon.storage.*` per addon, not per authenticated user, so a key kept there would be retrievable by every user with bridge access; there is no user-isolated, server-enforced storage in the bridge. The key is therefore not written to `addon.storage`, `localStorage`, `sessionStorage`, IndexedDB or the Cache API, there is no `localStorage` fallback when the page is opened directly, and the user enters it again each time the addon is opened (the password manager can fill it). Switching the language no longer reloads the page. The permission `files:addon-data` stays for the non-secret instance names and so that 0.2.1 can delete a `console.key` that 0.2.0 left behind. `tests/key-storage.mjs` (CI) covers multiple authenticated users on shared addon storage, direct page access outside the bridge flow, and the migration; it fails against the 0.2.0 code.
3. **Terrain and building models** (about 190 MB in total, far above the 50 MiB archive limit) are static data in branch `cdn` of the repository, pinned to the tag `data-v1`. They are streamed on demand and cached by the browser. Integrity is verified end to end: the SHA-256 of `catalog.json` is built into the addon (which the catalog already pins by SHA-256); the catalog holds the SHA-256 of each map index and each building model; each terrain tile is named after the SHA-256 of its content. A file that does not match is skipped (second mirror) and, if still wrong, refused. The data files are not code.
4. **No code from a CDN.** Scripts (three.js 0.170.0 and the viewer) are inside the package (`web/vendor`). The page contacts this console, `raw.githubusercontent.com` and `cdn.jsdelivr.net`; GitHub requests carry no cookies and no referrer.
5. **Console served over plain http:** `crypto.subtle` is unavailable there; the addon falls back to a small pure-JS SHA-256 (tested against Node's) so the checks still run.

### Permissions
`{"files": ["addon-data"]}` (0.1.x: none). **Justification:** the optional instance names (non-secret) and the removal of a key left by 0.2.0 use the addon's own storage; the API key itself is not stored. No database, player, reward, message or server permissions are requested.

### What changed since 0.1.7
- Removed: `docker/` (installer, Compose file, entrypoint), the companion container, `-password`/`-allow-open` handling, the "not reachable" help page, upgrade tests of the installer.
- Added: browser backend (`web/js/api.js`, `data.js`, `console.js`, `store.js`), the tile generator `tools/tilepack.mjs` and `tools/pin-data.mjs`, tests (`tests/unit.mjs`, `tests/harness.mjs`), data branch `cdn`.
- Viewer UI is the same as Beta.8 (grid removed), with the connection dialog reduced to the API key.
- **CI** (`.github/workflows/dd-addon.yml`): actions pinned to full commit SHAs, gitleaks, manifest validation, data-path tests, a check that the pinned data tag's `catalog.json` matches the pinned checksum, packaging with checks on the unpacked ZIP (no CR, `node --check`, package well under 10 MiB, no terrain/mesh files inside, pinned data tag and catalog checksum, permission list exactly `files:addon-data`), and on tags a re-verification of the published release asset.

### Upgrade from 0.1.x
The console's Update button replaces the package. The old companion container of 0.1.x keeps running until the admin removes it (`docker compose -f runtime/mapviewer3d/docker-compose.yml down`, `rm -rf runtime/mapviewer3d`, close port 8795); the README says so. The 0.1.x config (key, password) is not read by 0.2.0; the user enters a key once.

### Tested
- `node tests/key-storage.mjs` (CI): the key is never persisted. Two authenticated users on shared addon storage, direct page access without the bridge (no `localStorage` / `sessionStorage` / IndexedDB / Cache write, no bridge call), framed page without bridge, wrong key, migration of a key left by 0.2.0 (deleted, never adopted), and a static check of `console.js` / `store.js`. Verified to fail against the 0.2.0 code.
- `node tests/unit.mjs` (CI): synthetic map -> tile generator -> loader; tiles equal the raw rasters at every level; height sampling equals the reference formula (random points, tile borders, outside, no-data hole); a damaged tile is refused; a tampered catalog is refused; building models are verified; the SHA-256 fallback equals Node's.
- Real browser, mock console: the addon framed like the console does, bridge storage, key entry, maps/instances/player shown, **0 requests without key, 0 with a session cookie, 0 non-GET**, terrain tiles streamed, height sampling identical to the raw data.
- Published data: `catalog.json` fetched from `raw.githubusercontent.com` and `cdn.jsdelivr.net` at tag `data-v1` matches the pinned SHA-256; both send `access-control-allow-origin: *`.
- Live: installed 0.2.0 on a real Dune Docker Console (a test server), opened the addon, entered an API key created in the console (maps: Read, bases: Read), and the 3D map loaded with terrain and live data.

### Known limitations
- **Deep Desert layouts:** the data release contains the dune template and layout 8 (the current one when released). A newer layout falls back to the template with a warning in the panel until a new data release (`data-vN`) and addon version are published. Making this automatic would need a server-side process, which an addon cannot have.
- **Dependency on GitHub:** if both raw.githubusercontent.com and jsDelivr are unreachable, the map stays empty (a message says so). Tiles already seen are cached in the browser.
- **Browser features:** `DecompressionStream`, `fetch`, ES modules (all current browsers).

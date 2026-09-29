## MapViewer3D 0.1.0 (new addon)

Live 3D map of Hagga Basin and Deep Desert: players, bases (as 3D buildings), vehicles, hazards, resources.

- **Source:** https://github.com/dev-prophet-code/MapViewer3D (branch `DD-Addon`, folder `dd-addon/`, MIT)
- **Release:** https://github.com/dev-prophet-code/MapViewer3D/releases/tag/addon-v0.1.0
- **Pinned package:** `https://github.com/dev-prophet-code/MapViewer3D/releases/download/addon-v0.1.0/mapviewer3d-0.1.0.zip`
- **SHA-256 (verified by downloading the published asset):** `31ea68c1bc498ec1a70514a580029e3803351d9920b00676c4bbbac740dc3ed1`

### Permissions
None (`"permissions": {}`). The addon page only embeds the viewer in an iframe.

### How it works / what to review
The viewer is a Go program with ~350 MB of terrain data, so it cannot live inside the addon zip. The zip contains the addon page plus `docker/install.sh` and a Compose file for a **companion container** (host network, non-root, read-only filesystem, all capabilities dropped, `no-new-privileges`).

- The installer auto-detects the stack folder and console port (`ADMIN_BIND_PORT`), checks the key against `/api/map/partitions`, downloads the pinned viewer release and **verifies its SHA-256** before unpacking.
- The one manual step is an API key (Settings → API Keys, scopes `maps: Read`, `bases: Read`), because only an admin can create keys. It is stored owner-only in `runtime/mapviewer3d/config.json` and never sent to the browser.
- Read-only: the addon and viewer never write to the game or database.

### Tests that actually ran
- `node scripts/validate.js` (template validator) and packaging via `scripts/package.sh`; CI (validate, shell syntax, JS syntax) green.
- Addon page in a browser embedding a running viewer: connected state, unreachable state, invalid-URL handling (a bug found here was fixed).
- Installer against a stand-in stack folder with a **mock console API**: wrong key rejected (401), malformed key rejected, good key → container started, viewer inside the container reached the mock API with the bearer token, container is non-root/read-only, re-run reuses the stored key.

### Known limitations (please read)
- **Not tested against a real Dune Docker Console** (no game server available to me). The console API calls used by the viewer are `GET /api/map/{partitions,players,overlays,poi,spice}` and `/api/bases/{id}`; scopes were derived from `console/api/src/actions.js`.
- The container test ran on Docker Desktop (macOS/arm64); `network_mode: host` behaves differently there than on Linux, which is the intended target.
- If the console is served over https, browsers block the plain-http viewer in the iframe; the page offers "Open in new tab" and documents the reverse-proxy option.

<!-- Text of the pull request for 0.3.0 to Red-Blink/dune-docker-addons (update of the existing catalog entry
     `mapviewer3d`). NOT submitted. Fill the {{...}} placeholders after the release exists (version, release link,
     SHA-256 of the published asset), update the "Tested" section, then remove this comment.
     0.2.1 stays documented in PULL_REQUEST.md. -->

## MapViewer3D 0.3.0 (update of the catalog entry `mapviewer3d`): Realtime Data

0.3.0 adds one feature: **live sandworms, enemies, civilians, vehicles and sandstorms** when the console offers them.
Nothing else changes: still no installer, container, port or password; the permission list is unchanged
(`files:addon-data`); the API key is still held in memory only.

- **Source:** https://github.com/dev-prophet-code/MapViewer3D (branch `DD-Addon`, MIT)
- **Release:** https://github.com/dev-prophet-code/MapViewer3D/releases/tag/addon-v{{0.3.0}}
- **Pinned package:** `https://github.com/dev-prophet-code/MapViewer3D/releases/download/addon-v{{0.3.0}}/mapviewer3d-{{0.3.0}}.zip` (about 370 KB)
- **SHA-256 (verified by downloading the published asset):** `{{sha256}}`
- **Catalog change:** `addons/mapviewer3d.json` and `index.json`: `version`, `downloadUrl`, `sha256`, `description`.

### What it does
Those objects are not in the console's database, only in the memory of the game servers. The optional MapViewer3D position agent
reads them (container next to Dune Docker, reachable on the host's loopback only), and a console that includes the **Realtime
Data** change passes them on at `/api/realtime/*` to API keys that hold the new scope **Realtime Data** (a separate row in
*Settings → API Keys*, None / Read; `maps: Read` does not include it). The addon shows five more layer switches when this works.

### How it works (what to review)
```
Browser (addon page in the console)
  ├── live data: GET /api/map/..., /api/bases/...        same console, Authorization: Bearer <API key>
  ├── Realtime Data: GET /api/realtime/healthz, /stream  same console, same key, only if offered
  └── terrain + models: GET raw.githubusercontent.com / cdn.jsdelivr.net   branch "cdn", tag data-v1
```
1. **Same rules as every other call** (`web/js/console.js`): `GET` only, `Authorization: Bearer <key>`, `credentials: "omit"`. The stream
   is read with `fetch` (an `EventSource` cannot send the header) through a new `consoleStream()` in the same file.
2. **`web/js/realtime.js`** does in the browser what the standalone viewer's server does: one shared connection, the state of all
   objects, and each map layer receives only its map and instance. **Players are not included** (the standalone viewer matches them to
   the console's players; the addon keeps using `/api/map/players`).
3. **Hidden when not offered.** At start (and every 10 minutes) the addon asks `/api/realtime/healthz`. Any answer other than
   `available: true` – an older console (404), a key without the scope (403), no agent (503), a network error – means: the five switches are
   not shown, nothing is reported. A refused key (401/403) on the open stream ends it for good; the console re-checks the key while the
   stream is open, so disabling or revoking it stops the data within seconds.
4. **Nothing is stored.** `realtime.js` uses no browser storage, no cookie, no non-GET request (a static test checks this); the key stays in memory.
5. **Transport.** The data travels over the same connection as the console page itself. A browser cannot pin certificates, so on a
   plain-HTTP console (not on this machine) the live status says that keys and positions are not encrypted and to open the console via
   HTTPS. This adds no new exposure beyond what the page already does for the key and the map data.
6. `agent.js`, `storm.js` and the new icons are the standalone viewer's, with the data source replaced.

### Permissions
Unchanged: `{"files": ["addon-data"]}`.

### Tested
- `node tests/realtime.mjs` (CI): availability for ok/404/403/503; each layer gets only its map and instance and never a player; position
  updates and removals only for known objects; one shared connection that closes with the last layer; every request carries the key,
  omits credentials and is a GET; a revoked key ends the stream without retries; the plain-HTTP detection; static check of `realtime.js`.
- `node tests/key-storage.mjs`, `node tests/unit.mjs`, `scripts/validate.js`, `scripts/package.sh` + `verify-package.sh` (package 0.3.0, about 370 KB,
  no data files, no CRLF, key code uses no browser storage API, permission list unchanged).
- Real browser with the mock console (`REALTIME=1`): the five switches appear; without it they are absent and the page shows no error.
- {{Real console: API key with Realtime Data → Read: switches appear and move; key without the scope: no switches; result}}

### Upgrade
The console's Update button replaces the package; no settings to migrate. Without the Realtime Data change in the console, 0.3.0 behaves
exactly like 0.2.1.

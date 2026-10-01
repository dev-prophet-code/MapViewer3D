# MapViewer3D – Dune Docker Console Addon

Adds a **3D Map** page to Dune Docker Console: Hagga Basin and Deep Desert in 3D with live players, bases (as real
3D buildings), vehicles, hazards and resources.

**Nothing to install on the server.** Install the addon, open it, enter an API key, done. There is no container, no
installer, no extra port, no password and no reverse proxy: the whole viewer runs in your browser inside the addon page.
Everything is read-only; nothing is written to the game or the database.

## Use

1. In the console open **Settings → API Keys** and create a key (see below). The key is shown only once.
2. Install **MapViewer3D** on the **Addons** page and approve its single permission (`files:addon-data`, used to keep the key private).
3. Open **3D Map**. Paste the key (`dak_…`) when asked. The addon checks it against the console (both scopes) and stores it.
4. Done. Terrain and building models stream from GitHub on first use and are cached by your browser.

### The API key

| Field | Value |
|---|---|
| Name | `MapViewer3D` (any name) |
| Scope **`maps`** | **Read**: map list, live players, vehicles, storage, locations, hazards, resources, spice |
| Scope **`bases`** | **Read**: the pieces of each base, shown as 3D buildings |
| **All other scopes** | **None** |
| Expiry | none, or a date you will remember: an expired key stops the map |

Choose **Read**, never *Read+write*. Revoke or rotate the key any time under *Settings → API Keys*; use **Change** in the
addon's side panel to enter the new one.

## How it works

```
Browser (addon page inside the console)
  ├── live data ── GET /api/map/..., /api/bases/... ── same console, Authorization: Bearer <your key>
  └── terrain, building models ── GET raw.githubusercontent.com / cdn.jsdelivr.net ── branch "cdn", tag data-vN
```

- **Live data** comes from the console's own API, with the API key and nothing else. Requests are `GET` only and are sent with
  `credentials: "omit"`, so the browser never attaches the logged-in admin's session. The addon has exactly the rights of that
  key (`maps: Read`, `bases: Read`). `tests/harness.mjs` is a mock console that records every request lacking the key or
  carrying a session cookie, so this can be checked in a real browser.
- **Terrain and models** are static data in branch [`cdn`](https://github.com/dev-prophet-code/MapViewer3D/tree/cdn) of this
  repository (terrain tiles for Hagga Basin and the Deep Desert layouts, building models). The addon is pinned to a tag
  (`data-v1`) and **verifies every file**: the SHA-256 of `catalog.json` is built into the addon, the catalog lists the
  SHA-256 of each map index and model, and each terrain tile is named after the SHA-256 of its content. A mirror that
  delivers anything else is skipped. Two mirrors are tried (raw.githubusercontent.com, then jsDelivr).
- **Deep Desert follows the Coriolis cycle.** The console reports the current layout; the addon shows the terrain generated
  for that layout. A layout that is not in the data release yet falls back to the plain dune template and the panel says so
  until a new data release is published (see `tools/README.md`).
- The API key is stored in the addon's private storage in the console (`addon.storage`, permission `files:addon-data`) and
  held in memory while the page is open. It is never written to `localStorage` and never sent anywhere but this console.
  The same storage keeps the instance names you choose.

## Security

- **Least privilege:** the key only needs `maps: Read` and `bases: Read`; the addon asks for the single console permission
  `files:addon-data` and nothing else (no database, no players, no rewards).
- **No session, no write:** only the key is used, only `GET`, never the admin's session cookie.
- **Verified data:** hash chain from the addon package to every downloaded tile (see above). A corrupted or tampered file is
  refused, not rendered. `tests/unit.mjs` covers tampered tiles, a tampered catalog and the checksum fallback.
- **No code from a CDN:** the data files are not code. Scripts (three.js and the viewer) are part of the addon package
  (`web/vendor`, versions in `web/vendor/README.md`).
- **Network use:** the addon page contacts this console, `raw.githubusercontent.com` and `cdn.jsdelivr.net`, and nothing else.
  Requests to GitHub carry no cookies and no referrer.
- **No server component:** there is no listening port, no container, no stored password, no installer.

Found a problem? See the viewer's [SECURITY.md](https://github.com/dev-prophet-code/MapViewer3D/blob/main/SECURITY.md).

## Upgrading from 0.1.x

0.1.x ran a companion container (`runtime/mapviewer3d`). It is no longer used. Update the addon in the console, then remove the
old container and files on the server:

```bash
docker compose -f runtime/mapviewer3d/docker-compose.yml down
rm -rf runtime/mapviewer3d
```

Close TCP port `8795` again if you had opened it for other computers. Then create (or reuse) an API key and enter it in the addon.

## Files

| Path | Purpose |
|---|---|
| `addon.json` | Addon manifest (permission `files:addon-data`) |
| `web/` | The viewer (three.js scene, live layer) and its browser backend: `js/api.js` facade, `js/data.js` verified terrain streaming, `js/console.js` console client with the API key, `js/store.js` private storage |
| `tools/tilepack.mjs`, `tools/pin-data.mjs` | Cut extracted terrain into the streaming format; pin a data release into the addon. See `tools/README.md` |
| `tests/unit.mjs` | Data-path tests (tile generator → loader, checksums, tamper checks) |
| `tests/harness.mjs` | Mock console for trying the addon in a browser without a server |
| `scripts/validate.js`, `scripts/package.sh`, `scripts/verify-package.sh` | Validation and release packaging |

## Source of the data

The terrain is generated from the game files with the `extract` tool of the viewer on the [`main` branch](https://github.com/dev-prophet-code/MapViewer3D)
and cut into tiles by `tools/tilepack.mjs`. The branch `cdn` contains only the result.

MIT licensed. Unofficial fan project, not affiliated with Funcom.

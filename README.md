# MapViewer3D – Dune Docker Console Addon

Adds a **3D Map** page to Dune Docker Console: Hagga Basin and Deep Desert in 3D with live players, bases (as real 3D
buildings), vehicles, caves, hazards, resources and the Coriolis layout of the week.

**Nothing to install on the server, nothing to enter.** Install the addon, approve its two permissions, open it. There is
no container, no port, no API key and no reverse proxy. Everything is read-only.

## Version 0.5.0: built for the Console's sandbox

The Console runs every addon in a locked-down frame (`sandbox="allow-scripts"`, a Content-Security-Policy with
`connect-src 'none'`, an opaque origin): an addon page can load no second file and make no network request; the only way out is
the **addon bridge** (`window.DuneAddon.request`) that the Console itself answers with the permissions you approved. Versions up
to 0.4.x streamed their data from GitHub and called the Console's REST API with an API key, which that sandbox does not allow
(Red-Blink's review of the catalog entry pointed this out). 0.5.0 works the way the sandbox intends:

- **One self-contained page.** `web/index.html` holds the viewer (three.js included), the style and the map data. Nothing is
  loaded from anywhere (`scripts/verify-package.sh` fails the build otherwise).
- **Game data through the bridge.** Players, vehicles, bases, storage and markers are read from the game database with the
  bridge action `database.query` (read-only, permission **`database:read`**, which you approve when you install the addon; the
  Console runs the query in a read-only transaction and refuses write statements). The addon never sees a password or a key.
  It asks for one combined snapshot every few seconds, stays far below the bridge's limit of 60 calls a minute, and keeps the
  last good picture if the database does not answer.
- **Terrain in the package.** The 50 MiB limit for addon packages does not allow the finest terrain tiles, so the package
  carries the coarser levels (about 4 m between height samples on Hagga Basin instead of 1 m) from the same verified data
  release (`tools/embed-data.mjs` checks every tile against the pinned catalog while it builds).
- **Marker images** are those of the Console's own Live Map (Red-Blink/dune-awakening-selfhost-docker, MIT licence).

What the sandbox does not allow, and therefore this edition does not have:

| Missing in the Console | Why | Where to get it |
|---|---|---|
| **Realtime Data** (live sandworms, enemies, civilians, sandstorms) | needs a streaming network connection | the standalone viewer on your PC, branch [`main`](https://github.com/dev-prophet-code/MapViewer3D) / position agent in branch `ddp` |
| Spice fields | not in the database | standalone viewer |
| Share links from inside the addon | needs network access to the share gateway | the gateway's own page, below |

### Permissions

| Permission | Used for |
|---|---|
| `database:read` | the game database, read only, through the bridge: positions of players, vehicles, bases, storage, map markers |
| `files:addon-data` | the instance names you may choose (stored in the Console's addon storage; no secret is ever stored) |

## Use

1. On the Console's **Addons** page install **MapViewer3D** and approve both permissions.
2. Open **3D Map**. The map appears; the side panel lists players and layers.
3. *Name instances* gives your server instances (PvE, PvP, …) names; *Share link …* explains where to create links.

## Share links for your players (optional)

Links to the 3D map for players without a console account are made on the **admin page of the share gateway** (service
`mvshare` of the [MapViewer3D stack](https://github.com/dev-prophet-code/MapViewer3D/tree/ddp), `SHARE.md` there): open
`https://<your gateway>/admin/`, enter an API key that holds `Addons: Read`, choose the duration (or no expiry) and what the
link shows, and copy the link. Visitors open `https://<your gateway>/s/<token>/` with no key and no login. A link is a random
256-bit token, only its hash is stored, links can be revoked at any time (which cuts open sessions), and the gateway answers
visitors only from a short allow list of read-only routes with cleaned data. The addon's own **Share link …** button now just
points to that page, because the sandboxed addon has no network access.

## How it works

```
Console page (signed-in administrator)
  └── <iframe sandbox="allow-scripts">   MapViewer3D, one page, no network
        └── postMessage  database.query / addon.storage.*     ← the only way out
```

`sandbox/` holds what differs from the standalone viewer:

| Path | Purpose |
|---|---|
| `sandbox/bridge.js` | the bridge client (`window.DuneAddon.request`) |
| `sandbox/sql.js` | the SQL for the snapshot, partitions, markers and base export, and the code that shapes rows into what the viewer draws; no write, no comment, no account id selected |
| `sandbox/live-data.js` | the REST-shaped answers the viewer reads, produced from those queries: one shared query, spaced calls (at most 50 a minute), last good data kept |
| `sandbox/api.js`, `sandbox/data-embedded.js`, `sandbox/embedded.js` | the viewer's backend on top of that and on top of the data inside the page |
| `sandbox/realtime-off.js`, `sandbox/share-panel.js`, `sandbox/iconsrc.js` | stand-ins for the parts that need a network |
| `scripts/build-sandbox.mjs`, `tools/embed-data.mjs` | build the single page (esbuild) with the verified map data inside |

The viewer itself (`web/`) is shared with the standalone viewer and with the page the share gateway serves to visitors;
those still work with an API key (`web/js/console.js`, `web/js/realtime.js`, `web/js/data.js`) and are not part of the Console package.

## Build and test

```bash
npm ci
git clone --depth 1 --branch data-v2 https://github.com/dev-prophet-code/MapViewer3D.git data        # the pinned data release
git clone https://github.com/Red-Blink/dune-awakening-selfhost-docker.git console                       # marker images, test console
git -C console checkout "$(cat tests/e2e/console-ref.txt)"
bash scripts/package.sh data console                       # dist/mapviewer3d-<version>.zip, checked
node tests/run-all.mjs                                     # unit tests
node tests/e2e/run.mjs --pkg dist/package --console console
```

`tests/e2e/run.mjs` runs the **real Console** (its own server in mock mode with login, the iframe sandbox, the CSP and the
protected addon routes) against a PostgreSQL-compatible fixture of the game database (`tests/fixtures/`, PGlite), installs the
built package, signs in with a browser and checks: the protected route and CSP, the sandbox attribute, initial rendering,
terrain loading from the embedded data, live data through `database.query` (and that a write statement is refused), the share
dialog, and that no CSP violation or blocked request occurs.

## Security

- **Least privilege:** `database:read` (read-only, enforced by the Console) and `files:addon-data` (instance names). No
  write, no players/rewards/server permissions.
- **No credential in the page:** there is no API key; the Console authenticates the bridge with the administrator's own session.
- **No network:** the page cannot make a request, so it cannot send data anywhere; the sent SQL contains no comments, validates
  every value and selects no account or platform ids.
- **Checked package:** `scripts/verify-package.sh` (exactly three files, no external reference, valid script, valid data,
  exact permissions) runs in CI and again against the published release asset.
- **Verified data:** `tools/embed-data.mjs` verifies the catalog, every map index and every tile and model against the pinned
  hashes before it packs them.

Found a problem? See the viewer's [SECURITY.md](https://github.com/dev-prophet-code/MapViewer3D/blob/main/SECURITY.md).

## Upgrading

From 0.4.x: update on the Addons page and approve `database:read`. Realtime Data and in-addon share links are gone from the
Console edition (see above); existing links keep working. Before 0.2: remove the old companion container
(`docker compose -f runtime/mapviewer3d/docker-compose.yml down; rm -rf runtime/mapviewer3d`).

## Source of the data

The terrain is generated from the game files with the `extract` tool of the viewer on the [`main` branch](https://github.com/dev-prophet-code/MapViewer3D)
and cut into tiles by `tools/tilepack.mjs`; the tag `data-v2` contains only the result. MIT licensed. Unofficial fan project,
not affiliated with Funcom.

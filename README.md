# MapViewer3D – Dune Docker Console Addon

Adds a **3D Map** page to Dune Docker Console: Hagga Basin and Deep Desert in 3D with
live players, bases (as real 3D buildings), vehicles, hazards and resources.

The addon page embeds [MapViewer3D](https://github.com/dev-prophet-code/MapViewer3D),
which runs as a small companion container next to the console. Nothing is written to the
game or the database – it is read-only.

## ⚠️ An API key is required

MapViewer3D **cannot work without a Console API key.** The viewer reads its live data through
the Console HTTP API, and the Console refuses every request without a key (`401`) – also from
the same machine, and addons get no direct API access. Only an admin can create keys.

**Create the key first** (Console → **Settings → API Keys** → create):

| Field | Value |
|---|---|
| Name | `MapViewer3D` (any name) |
| Scope **`maps`** | **Read** – map list, live players, vehicles, storage, locations, hazards, resources, spice |
| Scope **`bases`** | **Read** – the pieces of each base, shown as 3D buildings |
| **All other scopes** | **None** (leave everything else untouched) |
| Expiry | none, or a date you will remember – an expired key stops the map |

- Choose **Read**, never *Read+write*. The viewer only reads.
- With `maps` missing, the map stays empty; with `bases` missing, bases show as icons but not as 3D buildings.
- Copy the key (`dak_…`) when the Console shows it – it is displayed **only once**.
- Revoke or rotate it any time under *Settings → API Keys*; then run the installer again with the new key.

## Install

1. Create the API key as described above.
2. Install the addon from the console's **Addons** page. It needs **no permissions** itself.
3. On the machine that runs the console, run the installer that ships in the addon folder:

   ```bash
   sh runtime/addons/installed/mapviewer3d/docker/install.sh
   ```

   Everything except the key is detected automatically (stack folder, console port from
   `.env`, including `ADMIN_BIND_HOST=auto` and `ADMIN_WEB_PORT`). The installer asks for the key once,
   **checks it against the Console** and refuses to start if it is missing, wrong or lacks `maps: Read` or
   `bases: Read`. The key is never put on a command line. It is stored
   and reused on re-runs.
4. Open **3D Map** in the console. The page finds the viewer on port `8795` of the same host by itself.

By default the viewer is **private** (`127.0.0.1:8795`, only browsers on the server itself).
For other computers opt in with `MV_ADDR=0.0.0.0:8795` when running the installer: it then sets a
**viewer password** (browser login, shown once) and you open TCP port `8795` for those browsers.
Details: [`docker/README.md`](docker/README.md).

## Update / remove

- Update the viewer: delete `runtime/mapviewer3d/app`, run the installer again (the stored key is reused).
- New key: delete `runtime/mapviewer3d/config.json`, run the installer again and paste the new key.
- Remove: `docker compose -f runtime/mapviewer3d/docker-compose.yml down`, then delete `runtime/mapviewer3d`.

## How it works

```
Console → addon page (iframe) → viewer :8795 (companion container, host network)
                                       └──→ console API (address detected by the installer)
```

The API key stays inside the companion container (`config.json`, owner-only). The browser
never sees it. The container runs as your user, read-only, without capabilities.

## Security

- **Private by default.** The viewer listens on `127.0.0.1:8795`; nothing is reachable from the
  network. Serving it to other computers is an explicit opt-in (`MV_ADDR=0.0.0.0:8795` or one
  interface, e.g. `MV_ADDR=192.168.1.5:8795`) and then requires a **viewer password** (the installer
  generates one and stores it in `runtime/mapviewer3d/config.json`; browsers show a login box).
  Without a password the viewer refuses to start on a network address unless you set
  `MV_ALLOW_OPEN=1` - not recommended: anyone with the address then sees player names, positions,
  bases and vehicles. Add a firewall on top where you can.
- **Least privilege:** the API key only needs `maps: Read` and `bases: Read`. It is stored in
  `runtime/mapviewer3d/config.json` (owner-only, plain text, like other console secrets). Revoke it
  under *Settings → API Keys* if the server is ever compromised.
- **Container:** runs as your user, read-only filesystem, no capabilities, `no-new-privileges`;
  browser setup inside the viewer is disabled (`-config`, `-no-local-admin`).
- **Supply chain:** the installer downloads a pinned viewer release and refuses it unless its
  SHA-256 matches. The viewer loads no code from a CDN and sends a Content-Security-Policy.
- The addon page itself has a strict CSP and only embeds the viewer address you configured
  (`http`/`https` only).

Found a problem? See the viewer's [SECURITY.md](https://github.com/dev-prophet-code/MapViewer3D/blob/main/SECURITY.md).

## Notes

- Console served over `https://`? Browsers block the plain-http viewer inside the page.
  Use **Open in new tab**, or serve the viewer through the same TLS reverse proxy and set its
  address under *Advanced* on the addon page.
- The viewer lists what your server reports; positions can lag by seconds to minutes.

## Files

| Path | Purpose |
|---|---|
| `addon.json` | Addon manifest (no permissions) |
| `web/` | The addon page (embeds the viewer, shows setup help if it is unreachable) |
| `docker/` | Installer, Compose file and `README.md` of the companion container |
| `scripts/validate.js`, `scripts/package.sh` | Validation and release packaging (from the addon template) |

## Source of the viewer

This branch contains **only the addon** (what runs inside the Console). The viewer itself
(Go server and 3D web UI) lives on the [`main` branch](https://github.com/dev-prophet-code/MapViewer3D);
the installer downloads its pinned, checksum-verified release package.

MIT licensed. Unofficial fan project, not affiliated with Funcom.

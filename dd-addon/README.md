# MapViewer3D – Dune Docker Console Addon

Adds a **3D Map** page to Dune Docker Console: Hagga Basin and Deep Desert in 3D with
live players, bases (as real 3D buildings), vehicles, hazards and resources.

The addon page embeds [MapViewer3D](https://github.com/dev-prophet-code/MapViewer3D),
which runs as a small companion container next to the console. Nothing is written to the
game or the database – it is read-only.

## Install

1. Install the addon from the console's **Addons** page. It needs **no permissions**.
2. On the machine that runs the console, run the installer that ships in the addon folder:

   ```bash
   sh runtime/addons/installed/mapviewer3d/docker/install.sh
   ```

   Everything is detected automatically (stack folder, console port from `.env`,
   console address). You are asked for **one thing, once**: a console API key. Only an
   admin can create keys, so this cannot be automated:
   *Settings → API Keys → create key, scopes* **maps: Read** and **bases: Read**.
3. Open **3D Map** in the console. Done – the page finds the viewer on port `8795`
   of the same host by itself.

Open TCP port `8795` for the browsers that use the console. The installer checks the key
against the console before it starts anything.

## Update / remove

- Update the viewer: delete `runtime/mapviewer3d/app`, run the installer again (the stored key is reused).
- Remove: `docker compose -f runtime/mapviewer3d/docker-compose.yml down`, then delete `runtime/mapviewer3d`.

## How it works

```
Console → addon page (iframe) → viewer :8795 (companion container, host network)
                                       └──→ console API 127.0.0.1:<console port>
```

The API key stays inside the companion container (`config.json`, owner-only). The browser
never sees it. The container runs as your user, read-only, without capabilities.

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
| `docker/` | Installer and Compose file of the companion container |
| `scripts/validate.js`, `scripts/package.sh` | Validation and release packaging (from the addon template) |

MIT licensed. Unofficial fan project, not affiliated with Funcom.

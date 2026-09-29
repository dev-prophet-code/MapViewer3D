# MapViewer3D companion container

`install.sh` sets up the companion container that runs the MapViewer3D viewer next to
Dune Docker Console. Run it on the machine that runs the console:

```bash
sh runtime/addons/installed/mapviewer3d/docker/install.sh
```

The full addon guide (API key, scopes, security) is in the addon's `README.md`.

## What the installer does

1. Finds the console stack folder (or use `STACK_DIR`).
2. Finds the console: reads `ADMIN_BIND_HOST`, `ADMIN_BIND_PORT` and `ADMIN_WEB_PORT`
   from the stack's `.env` (`ADMIN_WEB_PORT` wins over `ADMIN_BIND_PORT`). With
   `ADMIN_BIND_HOST=auto` (or `0.0.0.0`) the console listens on the machine's LAN
   address, so the installer tries `127.0.0.1` and each LAN address of the machine and uses
   the first that answers. Override with `API_BASE=http://<address>:<port>`.
3. Asks once for the API key (`dak_…`, scopes `maps: Read` and `bases: Read`) and checks
   **both scopes** against the console before starting anything. The key is sent to the
   console without ever appearing in a command line (`curl` reads it from stdin).
4. Downloads the pinned viewer release and verifies its SHA-256.
5. Writes `config.json` (owner-only) and starts the container.

## Who can open the viewer

By default the viewer is **private**: it listens on `127.0.0.1:8795`, so only browsers on
the server itself can open it. Nothing is exposed to the network.

To let other computers use it (for example admins who open the console from their own PC),
opt in explicitly:

```bash
MV_ADDR=0.0.0.0:8795 sh runtime/addons/installed/mapviewer3d/docker/install.sh
```

The installer then sets a **viewer password** (random, stored in
`runtime/mapviewer3d/config.json`, shown once). Browsers ask for it with a normal login
box (any user name). Use `MV_PASSWORD=…` to choose your own. Prefer binding to one
interface (`MV_ADDR=192.168.1.5:8795`) and a firewall on top. Serving the viewer without
any password (`MV_ALLOW_OPEN=1`) is possible but not recommended: everyone who reaches
the port sees player names and positions.

## Variables

| Variable | Meaning | Default |
|---|---|---|
| `STACK_DIR` | Console stack folder | auto-detected |
| `DATA_DIR` | Where the container's files live | `<stack>/runtime/mapviewer3d` |
| `API_BASE` | Console API address | detected (see above) |
| `API_TOKEN` | Console API key | asked once, then reused |
| `MV_ADDR` | Viewer listen address | `127.0.0.1:8795` |
| `MV_PASSWORD` | Viewer password for network operation | generated |
| `MV_ALLOW_OPEN` | `1` = network address without password | off |
| `MV_URL` / `MV_SHA256` / `MV_ZIP` | Viewer release, checksum, local ZIP | pinned release |

## Update / remove

- Update the viewer: delete `runtime/mapviewer3d/app`, run the installer again.
- New key or password: delete `runtime/mapviewer3d/config.json`, run the installer again.
- Remove: `docker compose -f runtime/mapviewer3d/docker-compose.yml down`, then delete
  `runtime/mapviewer3d`.

## Troubleshooting

- *Console not reachable*: check that the console runs, then set `API_BASE` to the address
  you use to open the console (for example `http://192.168.1.5:8088`).
- *The key lacks the scope …*: edit the key under Settings → API Keys.
- *The page says the viewer is not reachable*: with the private default the viewer only
  opens on the server itself; use `MV_ADDR=0.0.0.0:8795` (see above) for other computers.

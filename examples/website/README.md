# Example website with the 3D viewer built in

A minimal website (`site/`) that embeds the Dune MapViewer3D in an `<iframe>`, plus ready-to-adapt
configuration for nginx, systemd and the viewer. Copy the folder, change a few lines, done.

```
visitor's browser ⇄ nginx (your site + /map/) ⇄ viewer (127.0.0.1:8795) ⇄ Dune console API (token stays here)
                                                          └────────────⇄ position agent (127.0.0.1:8796, real time from RAM)
```

| File | What it is |
|---|---|
| `site/index.html` | the example page; the viewer is the `<iframe id="viewer">`; map buttons use `postMessage` |
| `site/assets/site.css` | plain styling, change freely |
| `config.example.json` | **server address and API token** (+ options); every key is explained inside |
| `nginx.conf.example` | serves the site and forwards `/map/` to the viewer so both share one address |
| `mapviewer.service.example` | systemd unit for the viewer (unprivileged user) |
| `mapviewer-agent.service.example` | systemd unit for the real-time agent (root, read-only) |

## Setup in five steps

1. **Install the viewer** on your web server: unpack the release (`MapViewer3D-Beta.N.zip`) to `/opt/MapViewer3D`. The maps are streamed
   from the `cdn` branch on GitHub, nothing else to download.
2. **Enter your server address and token.** Copy `config.example.json` to `/etc/mapviewer/config.json` (outside the web root, never in Git) and set
   `apiBase` (`http://<your server IP>:8088`, the Dune Docker console) and `token` (a console API token with **read-only** scope).
   The token stays on the server, the browser never sees it.
3. **Start the viewer** with `mapviewer.service.example` (`-config /etc/mapviewer/config.json -addr 127.0.0.1:8795`). It listens locally only.
4. **Publish the site**: copy `site/` to your web root and use `nginx.conf.example` so the viewer appears at `/map/` on the same address.
   (Page and viewer must share one origin: the map buttons and the embedding rely on it.)
5. Open your site. Done. Try it without nginx: `python3 -m http.server 8080 --directory site`, set `VIEWER_URL` in `index.html` to
   `http://127.0.0.1:8795/` (the map shows, the buttons need the same origin).

## Real-time data (sandworms, NPCs, vehicles, storms, players)

These objects only exist in the game processes' memory, not in the database. The position agent reads them **read-only** from
`/proc/<pid>/mem`, which works **only on the machine that runs the Dune Docker stack** (the containers share the host's process space) and
needs **root**. Two ways, both in `config.example.json` → `agentUrl`:

- **Recommended: separate agent service.** Run `mvagent` (in `bin/`) with `mapviewer-agent.service.example` and set
  `"agentUrl": "http://127.0.0.1:8796"`. The viewer itself stays unprivileged. The viewer may even run on another machine (reach the agent through
  an SSH tunnel; the agent has no login, so keep it on loopback).
- **`"agentUrl": "auto"`** (or `-agent auto`): the viewer checks whether Dune server processes are visible in `/proc` (= it runs on the game host) and, if it
  runs as root, starts the agent inside itself. Convenient for a private LAN viewer; for a public website prefer the separate service, because
  the whole viewer would run as root. With `-agent-players` the agent also reads players. If the viewer is not on the game host or not root, it logs why and
  simply shows no real-time data.

Details, offsets and security: [docs/Agent-EN.md](../../docs/Agent-EN.md).

## Public site? Read this

Everything the viewer shows (player names, positions, bases) is visible to everyone who can open the page. Options: protect the page
(`viewerPassword` in the config, or your site's own login in front of `/map/`), or run the public mode of the viewer that only releases PvE partitions
(`public` section, see [README](../../README.md#-security)). The connection settings can never be changed through the proxy.

## Updates

`"autoUpdate": true` (or `-auto-update`) lets the viewer install new releases by itself; the systemd unit's `Restart=always` brings it back.
Details: [README → Updates](../../README.md#-updates).

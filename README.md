<div align="center">

# 🏜️ Dune MapViewer3D

**A live 3D map viewer for self-hosted _Dune: Awakening_ servers.**
Explore Hagga Basin and Deep Desert with players, bases, vehicles, hazards and resources – right in your browser.

[![Release](https://img.shields.io/github/v/release/dev-prophet-code/MapViewer3D?include_prereleases&label=release&color=d97706)](https://github.com/dev-prophet-code/MapViewer3D/releases)
[![CI](https://github.com/dev-prophet-code/MapViewer3D/actions/workflows/ci.yml/badge.svg)](https://github.com/dev-prophet-code/MapViewer3D/actions/workflows/ci.yml)
![Go](https://img.shields.io/badge/Go-1.26-00ADD8?logo=go&logoColor=white)
![three.js](https://img.shields.io/badge/three.js-viewer-000000?logo=threedotjs&logoColor=white)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Buy Me a Coffee](https://img.shields.io/badge/%E2%98%95-Buy%20me%20a%20coffee-FFDD00?logo=buymeacoffee&logoColor=black)](https://buymeacoffee.com/lafamiliagaming)
![Platforms](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)

**English** · [Deutsch](README.de.md)

</div>

---

> [!NOTE]
> Unofficial fan project. Not affiliated with or endorsed by Funcom. *Dune: Awakening* and all related names are trademarks of their respective owners.

> [!WARNING]
> **Requires the Red-Blink Docker stack.** MapViewer3D only works with servers running the [Red-Blink](https://github.com/Red-Blink) self-hosting stack (*dune-awakening-selfhost-docker*). It reads its data from that stack's console API (default port `8088`, API token `dak_…`). Other server setups are not supported.

## ✨ Features

- 🗺️ **Two maps in 3D** – Hagga Basin (8 × 8 km, 1 m grid) and Deep Desert (22.5 × 22.5 km, 3 m grid), selectable per server instance (PvE, PvP, Creative …).
- 📡 **Live data** from your server's console: players (smoothly animated), bases, vehicles, storage, locations, hazards, resources, spice fields.
- 🐛 **Live sandworms, enemies and vehicles** *(optional, since Beta.9)* – a small read-only agent on the game host reads their positions from the game processes (~10 Hz); worms glide across the map. See [docs/Agent-EN.md](docs/Agent-EN.md).
- 📶 **Realtime Data through the Dune Docker Console** *(Beta.16)* – the same live data on a viewer on your own PC, with your API key's **Realtime Data** permission, HTTPS only; hidden automatically when the server does not offer it.
- 🔀 **Switch server** *(Beta.16)* – keep several servers and switch between them without restarting.
- 🏗️ **Bases as real 3D buildings**, assembled from the actual building pieces.
- 🧭 **Free camera** – mouse wheel rotates, Shift tilts, Ctrl/⌘ zooms; W/A/S/D/Q/E flight, compass, "fly to" on any object.
- 🎯 **Same icons as the 2D live map**; 3D models take over up close. Every layer can be toggled.
- 🌗 **Light / dark mode**, fullscreen, hideable panel, built-in guide, English & German UI.
- 🔒 **Credentials stay safe** – double-encrypted, bound to your machine, never sent to the browser.
- 🖥️ **No install needed** – pre-built for Windows, macOS and Linux (x64 & ARM, incl. Raspberry Pi). Go is only needed to build from source.
- 👀 **Read-only** – it never changes anything in the game or on the server.

## 🚀 Quick start

1. Download `MapViewer3D-Beta.N.zip` (~30 MB) from the **[Releases](https://github.com/dev-prophet-code/MapViewer3D/releases)** page and unpack it. (Even the plain "Source code" download works: the start script fetches the program from the latest release.) The **maps are not in the package** – the viewer streams them from GitHub (see below), so you need an internet connection.
2. Start it:

| System | Start |
|---|---|
| Windows | double-click `start.bat` |
| macOS | double-click `start.command` or run `./start.sh` |
| Linux | `./start.sh` (or `sh start.sh`) |

3. Your browser opens <http://127.0.0.1:8795>. Enter your server address (`https://…` without a port means 443), console port (default `8088`) and a **read-only API token** (`dak_…`); only for a self-signed or internal HTTPS certificate also its fingerprint (the viewer shows it). The connection is verified immediately; a wrong token is rejected and not stored. Later, **Switch server** in the *Connection* section changes between all servers you have connected to.

On first start the viewer asks for your console's address and API token; nothing about any server is shipped in the package. To follow the weekly Deep Desert layout automatically, point a server-side viewer at the game files with `-paks <folder with .utoc/.ucas>`; it then builds the terrain of each new Coriolis layout itself. That needs a build with the game-file reader: `cd backend && go build -tags paks -o ../bin/mapviewer-<os>-<arch> ./cmd/mapviewer` (C++ compiler required); the ready-made programs are pure Go and only print this hint.

**Map data streams from GitHub.** Terrain tiles and building models come from the [`cdn` branch](../../tree/cdn) of this repository: the viewer loads only the tiles you look at, checks each one against the SHA-256 checksums in `catalog.json` and caches them in your user folder. A server keeps that branch up to date by itself after game updates and new Coriolis layouts ([docs/CDN-Sync-EN.md](docs/CDN-Sync-EN.md)). Options: `-cdn off` (use a local `data/` folder only), `-cdn <address>` (your own mirror), `"cdn"` in `-config`. A local `data/` folder is still used as a fallback (no network, maps the branch does not know). GitHub sees your IP address when tiles are fetched, nothing else is sent.

Detailed notes on Windows SmartScreen, macOS Gatekeeper and running on a server (systemd example, `-addr`, `-remote-setup`, `-state`, `-keydir`) are in the [German README](README.de.md#starten) and the [English description](Description-EN.md).

## 🐛 Live sandworms, enemies and vehicles (position agent)

NPCs and sandworms are not in the database or the console API, only in the memory of the running game processes. The optional **position agent** (`bin/mvagent-linux-amd64`, runs as root on the game host, **read-only**, Linux only) reads them about 10 times per second; the viewer shows them live and glides the markers between samples.

```bash
sudo ./bin/mvagent-linux-amd64                  # on the game host, listens on 127.0.0.1:8796
./start.sh -agent http://127.0.0.1:8796         # viewer: four extra switches appear
```

Players (with `-players`) are shown in real time only as the console's own online players, matched by partition and distance, and in public mode (`-public`) only PvE partitions are shown. The agent re-detects its memory offsets after game updates (verified with build 2134304). Details, flags, systemd unit and limits: [docs/Agent-EN.md](docs/Agent-EN.md) · [Deutsch](docs/Agent-DE.md).

### Through the Dune Docker Console: Realtime Data (Beta.16)

If the viewer runs **on your own PC** instead of the game host, worms, enemies and vehicles come through the Dune Docker Console – with the API key the viewer already uses:

1. run the agent as a container on the game host (branch [`ddp`](https://github.com/dev-prophet-code/MapViewer3D/tree/ddp): `docker compose -f docker-compose.mapviewer-live.yml up -d --build`; reachable on `127.0.0.1` only),
2. in the Console grant the API key **Realtime Data → Read** under **Settings → API Keys** (live players additionally **Players → Read**),
3. **encrypt** the connection to the Console: the stack in `ddp` ships an optional front door for that, `mvtls` (`--profile tls`, port 8797): HTTPS with its own key in front of the unchanged Console, nobody else has to change anything. **The viewer finds it by itself**, shows its fingerprint and switches after you confirm it (compare it first with the one on the server: *Settings → Encrypted API Access* in Dune Docker, the end of the installer, `dune encrypted-api fingerprint`, or `mvtls -pin` for the standalone stack). Your own HTTPS proxy (`https://my-server.com`), an SSH tunnel or a VPN work as well.

The viewer asks briefly at start. If anything is missing – or the Console does not know the feature yet – the switches simply do not appear and the log says why. **Note:** the Console change is a ready patch in branch `ddp` and not yet part of Dune Docker.

## 🧩 Dune Docker Console addon (no server install)

For servers running the Red-Blink stack there is also an **addon for the Dune Docker Console** (branch [`DD-Addon`](https://github.com/dev-prophet-code/MapViewer3D/tree/DD-Addon), listed in the console's *Addons* page). It needs **nothing on the server**: the viewer runs entirely inside the addon page. Install it, open **3D Map**, enter an API key created in the console (*Settings → API Keys*, scopes `maps: Read` and `bases: Read`), done. Live data comes from the console API with that key only (never the admin session); terrain and building models stream from branch [`cdn`](https://github.com/dev-prophet-code/MapViewer3D/tree/cdn) of this repository and are checked against built-in checksums. This page describes the standalone viewer (local Go server); the addon has its own README.

## 🧱 Architecture

```
Browser (three.js)  ⇄  local viewer server (Go, 127.0.0.1)  ⇄  your server's console API
```

| Path | Content |
|---|---|
| `backend/` | Go module `mapviewer3d`: pak/IoStore reading, map building, HTTP server, encrypted storage (`secure/`), position agent (`agent/`, `cmd/mvagent`) |
| `docs/` | Documentation of the position agent |
| `viewer/` | Web UI (three.js) |
| `bin/` | Pre-built binaries per OS/CPU *(in the release ZIP; fetched by the start script if missing)* |
| `data/` | optional local maps (extractor output); normally not needed, the maps stream from the `cdn` branch |
| `start.*`, `download-program.ps1` | Launch scripts (fetch the program if it is missing) |
| `examples/website/` | **Example website with the viewer built in**, plus nginx/systemd/config examples ([README](examples/website/README.md)) |
| `deploy/cdn-sync/` | Script and systemd units that keep the `cdn` branch up to date ([docs/CDN-Sync-EN.md](docs/CDN-Sync-EN.md)) |

> [!IMPORTANT]
> Binaries are too large for git and ship in the **release ZIP**; the terrain data (~400 MB) lives in the **`cdn` branch** and is streamed. A plain `git clone` or "Download ZIP" of `main` contains the source code only – `start.sh` / `start.bat` fetch the program, the viewer streams the maps.

## 🛠️ Build from source

Requires Go ≥ 1.26 (no C compiler needed for the viewer).

```bash
cd backend
go build -trimpath -o ../bin/mapviewer ./cmd/mapviewer   # your own system
GOOS=windows GOARCH=amd64 go build -o ../bin/mapviewer-windows-amd64.exe ./cmd/mapviewer   # cross-compile
```

`./start.sh --build` builds and starts the viewer for your own system in one step.

Rebuilding the maps after a game update (`backend/cmd/extract`) needs the game's pak files and Go with a C compiler (Oodle via cgo). See the German README for the full procedure.

## 🌐 Use it on your own website (with real-time data)

[`examples/website/`](examples/website/) is a small website with the 3D viewer already built in (an `<iframe>`), plus a `config.example.json` where you enter **your server address and API token**, an nginx and systemd example, and comments on how the viewer notices that it runs on the same machine as the Dune Docker stack so it can read the real-time data (sandworms, NPCs, storms) from memory (`"agentUrl"`: separate agent service, or `auto`).

## 🔄 Updates

The viewer asks GitHub for a newer release shortly after start and then every 6 hours. If there is one, a box in the panel shows **Update available: Beta.N**. One click on **Update now** downloads the update package (`MapViewer3D-update-Beta.N.zip`, without map data), verifies its SHA-256 sum against the checksum file of the release, replaces the program, `viewer/`, docs and start scripts (the previous state is kept in `.update/backup-<version>/`) and restarts the viewer; the page reloads by itself. Your credentials and settings (user folder) and `data/` are not touched. Only a browser on the machine itself can start the installation (same rule as the setup screen).

- **Servers:** `-auto-update` (or `MV_AUTOUPDATE=1`, or `"autoUpdate": true` in `-config`) installs without a click. A program built with `-tags paks` (`-paks`) is rebuilt from the source in the package (needs Go and a C++ compiler on the server). With `-public` there is no update display.
- **Off:** `-no-update-check` or `MV_NO_UPDATE=1`.
- **Network:** the only request is an anonymous `GET` to `api.github.com` / `github.com`; nothing about you or your server is sent.
- **Trust:** an update is as trustworthy as the GitHub repository and its release (SHA-256 check, no additional signature). The position agent updates itself only with its own `-auto-update` (it runs as root, so it is off by default).

## 🔐 Security

Only server address and API token are stored – encrypted with **AES-256-GCM + XChaCha20-Poly1305**, keys derived via **HKDF-SHA512** and bound to machine and user, integrity via **HMAC-SHA512**. The token never reaches the browser; the server listens on `127.0.0.1` only by default (since Beta.7 a network address requires `-password` / `MV_PASSWORD` / `viewerPassword` in `-config`, otherwise it refuses to start unless you pass `-allow-open`) and protects state-changing calls against CSRF. Details and honest limits: [Description-EN.md](Description-EN.md). The setup screen only accepts a browser on the machine itself (loopback address **and** loopback host name); use `-no-local-admin` behind a reverse proxy. Account IDs are stripped from live data for everyone but that local administrator, the server sends a strict Content-Security-Policy, and three.js is vendored (no CDN). Anything reachable on the network shows player names and positions to everyone with the address, so restrict the port (firewall or access protection) or use `-public`. To report a vulnerability, see [SECURITY.md](SECURITY.md).

## 📜 Changelog

[CHANGELOG - EN.md](<CHANGELOG - EN.md>) · [CHANGELOG - DE.md](<CHANGELOG - DE.md>)

## ☕ Support

If you like the project, you can [buy me a coffee](https://buymeacoffee.com/lafamiliagaming) – the same link sits as a small ☕ icon in the viewer.

## 📄 License

Released under the [MIT License](LICENSE) – free to use, modify and share, also commercially. Forks and adaptations are welcome.

## 🤝 Contributing

Issues and pull requests are welcome – see [CONTRIBUTING.md](CONTRIBUTING.md).

## ⚠️ Limitations

No original textures (colors come from the console's map image plus procedural detail), 2.5D terrain without overhangs, Deep Desert built from the server's current Coriolis layout (terrain tiles plus its rocks, ecolabs and wrecks) plus fixed rocks, and live positions from the console may lag by seconds to minutes (sandworms, enemies and vehicles are real-time only with the optional position agent, which needs root on the game host).

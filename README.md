<div align="center">

# 🏜️ Dune MapViewer3D

**A live 3D map viewer for self-hosted _Dune: Awakening_ servers.**
Explore Hagga Basin and Deep Desert with players, bases, vehicles, hazards and resources – right in your browser.

[![Release](https://img.shields.io/github/v/release/dev-prophet-code/MapViewer3D?include_prereleases&label=release&color=d97706)](https://github.com/dev-prophet-code/MapViewer3D/releases)
[![CI](https://github.com/dev-prophet-code/MapViewer3D/actions/workflows/ci.yml/badge.svg)](https://github.com/dev-prophet-code/MapViewer3D/actions/workflows/ci.yml)
![Go](https://img.shields.io/badge/Go-1.26-00ADD8?logo=go&logoColor=white)
![three.js](https://img.shields.io/badge/three.js-viewer-000000?logo=threedotjs&logoColor=white)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
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
- 🏗️ **Bases as real 3D buildings**, assembled from the actual building pieces.
- 🧭 **Free camera** – mouse wheel rotates, Shift tilts, Ctrl/⌘ zooms; W/A/S/D/Q/E flight, compass, "fly to" on any object.
- 🎯 **Same icons as the 2D live map**; 3D models take over up close. Every layer can be toggled.
- 🌗 **Light / dark mode**, fullscreen, hideable panel, built-in guide, English & German UI.
- 🔒 **Credentials stay safe** – double-encrypted, bound to your machine, never sent to the browser.
- 🖥️ **No install needed** – pre-built for Windows, macOS and Linux (x64 & ARM, incl. Raspberry Pi). Go is only needed to build from source.
- 👀 **Read-only** – it never changes anything in the game or on the server.

## 🚀 Quick start

1. Download the latest ZIP from the **[Releases](https://github.com/dev-prophet-code/MapViewer3D/releases)** page and unpack it.
2. Start it:

| System | Start |
|---|---|
| Windows | double-click `start.bat` |
| macOS | double-click `start.command` or run `./start.sh` |
| Linux | `./start.sh` (or `sh start.sh`) |

3. Your browser opens <http://127.0.0.1:8795>. Enter your server address, console port (default `8088`) and a **read-only API token** (`dak_…`). The connection is verified immediately; a wrong token is rejected and not stored.

On first start the viewer asks for your console's address and API token; nothing about any server is shipped in the package. To follow the weekly Deep Desert layout automatically, point a server-side viewer at the game files with `-paks <folder with .utoc/.ucas>`; it then builds the terrain of each new Coriolis layout itself. That needs a build with the game-file reader: `cd backend && go build -tags paks -o ../bin/mapviewer-<os>-<arch> ./cmd/mapviewer` (C++ compiler required); the ready-made programs are pure Go and only print this hint.

Detailed notes on Windows SmartScreen, macOS Gatekeeper and running on a server (systemd example, `-addr`, `-remote-setup`, `-state`, `-keydir`) are in the [German README](README.de.md#starten) and the [English description](Description-EN.md).

## 🧩 Dune Docker Console addon (no server install)

For servers running the Red-Blink stack there is also an **addon for the Dune Docker Console** (branch [`DD-Addon`](https://github.com/dev-prophet-code/MapViewer3D/tree/DD-Addon), listed in the console's *Addons* page). It needs **nothing on the server**: the viewer runs entirely inside the addon page. Install it, open **3D Map**, enter an API key created in the console (*Settings → API Keys*, scopes `maps: Read` and `bases: Read`), done. Live data comes from the console API with that key only (never the admin session); terrain and building models stream from branch [`cdn`](https://github.com/dev-prophet-code/MapViewer3D/tree/cdn) of this repository and are checked against built-in checksums. This page describes the standalone viewer (local Go server); the addon has its own README.

## 🧱 Architecture

```
Browser (three.js)  ⇄  local viewer server (Go, 127.0.0.1)  ⇄  your server's console API
```

| Path | Content |
|---|---|
| `backend/` | Go module `mapviewer3d`: pak/IoStore reading, map building, HTTP server, encrypted storage (`secure/`) |
| `viewer/` | Web UI (three.js) |
| `data/` | Pre-built terrain and building catalog *(in release ZIP only – see below)* |
| `bin/` | Pre-built binaries per OS/CPU *(in release ZIP only)* |
| `start.*` | Launch scripts |

> [!IMPORTANT]
> Terrain data (~350 MB) and binaries are too large for git. They are shipped in the **release ZIP**, not in the repository. A plain `git clone` contains the source code only.

## 🛠️ Build from source

Requires Go ≥ 1.26 (no C compiler needed for the viewer).

```bash
cd backend
go build -trimpath -o ../bin/mapviewer ./cmd/mapviewer   # your own system
GOOS=windows GOARCH=amd64 go build -o ../bin/mapviewer-windows-amd64.exe ./cmd/mapviewer   # cross-compile
```

`./start.sh --build` builds and starts the viewer for your own system in one step.

Rebuilding the maps after a game update (`backend/cmd/extract`) needs the game's pak files and Go with a C compiler (Oodle via cgo). See the German README for the full procedure.

## 🔐 Security

Only server address and API token are stored – encrypted with **AES-256-GCM + XChaCha20-Poly1305**, keys derived via **HKDF-SHA512** and bound to machine and user, integrity via **HMAC-SHA512**. The token never reaches the browser; the server listens on `127.0.0.1` only by default (since Beta.7 a network address requires `-password` / `MV_PASSWORD` / `viewerPassword` in `-config`, otherwise it refuses to start unless you pass `-allow-open`) and protects state-changing calls against CSRF. Details and honest limits: [Description-EN.md](Description-EN.md). The setup screen only accepts a browser on the machine itself (loopback address **and** loopback host name); use `-no-local-admin` behind a reverse proxy. Account IDs are stripped from live data for everyone but that local administrator, the server sends a strict Content-Security-Policy, and three.js is vendored (no CDN). Anything reachable on the network shows player names and positions to everyone with the address, so restrict the port (firewall or access protection) or use `-public`. To report a vulnerability, see [SECURITY.md](SECURITY.md).

## 📜 Changelog

[CHANGELOG - EN.md](<CHANGELOG - EN.md>) · [CHANGELOG - DE.md](<CHANGELOG - DE.md>)

## 📄 License

Released under the [MIT License](LICENSE) – free to use, modify and share, also commercially. Forks and adaptations are welcome.

## 🤝 Contributing

Issues and pull requests are welcome – see [CONTRIBUTING.md](CONTRIBUTING.md).

## ⚠️ Limitations

No original textures (colors come from the console's map image plus procedural detail), 2.5D terrain without overhangs, Deep Desert built from the server's current Coriolis layout (terrain tiles plus its rocks, ecolabs and wrecks) plus fixed rocks, and live positions may lag by seconds to minutes.

# MapViewer3D live data for Dune Docker

[Deutsch](README.de.md) · [Security](SECURITY.md)

Real-time **sandworms, enemies, civilians, vehicles, sandstorms** (and, if you want, **players**) from a [Dune Docker](https://github.com/Red-Blink/dune-awakening-selfhost-docker) server in a **MapViewer3D that runs on your own PC** – always encrypted, protected against man-in-the-middle attacks, and only for clients the server admin has paired.

> Branch `ddp` of MapViewer3D: work in progress, not yet part of a release.

## Why a separate container?

Dune Docker's Live Map reads Postgres. Players and vehicles are in the database (saved every few seconds), but **sandworms, NPCs and storms are not**: they exist only in the memory of the running game server process. MapViewer3D's position agent `mvagent` reads them from there, read-only, about 10 times per second ([docs/Agent-EN.md](https://github.com/dev-prophet-code/MapViewer3D/blob/main/docs/Agent-EN.md)).

A Dune Docker *community addon* cannot do this: addons are browser pages in the console with a few approved API permissions, they cannot start containers or see processes. So this is a small **compose project of its own** that runs next to Dune Docker and changes nothing in it.

```
 Dune Docker host                                                     your PC
┌───────────────────────────────────────────────┐
│ dune-server-* containers (game processes)     │
│        ▲ read-only /proc/<pid>/mem            │
│ ┌──────┴──────┐ internal  ┌────────────────┐  │ securelink ┌──────────────────┐
│ │  mvagent    │──network──│    mvgate      │◄─┼────────────│ MapViewer3D      │
│ │ root, no    │  (no      │ TLS 1.3, pinned│  │ TLS 1.3    │ Beta.16+:        │
│ │ port, no    │ internet) │ key, mutual    │  │ :8797      │  -agent-pair     │
│ │ internet    │           │ token proof    │  │            │ older: mvlink    │
│ └─────────────┘           └────────────────┘  │            └──────────────────┘
└───────────────────────────────────────────────┘
```

- **mvagent** – built from the MapViewer3D sources (release tag `MV_REF`, verified against `MV_COMMIT`). `pid: host` lets it see the game server processes of the Dune Docker containers; it needs `SYS_PTRACE` + `DAC_OVERRIDE` to read their memory. All other capabilities are dropped, the file system is read-only, it has **no published port and no internet** (internal network).
- **mvgate** – the only published port (8797/TCP). It speaks **securelink**: TLS 1.3 only, its own key pinned by the client, and a mutual token proof bound to the TLS session – the token itself never travels over the network. Only authenticated clients reach the three read-only agent routes. Runs as non-root. Details: [SECURITY.md](SECURITY.md).
- **mvlink** – optional helper on your PC for MapViewer3D versions before Beta.16 (see below).

## Requirements

- A running Dune Docker host (Linux, Docker with Compose v2 and BuildKit). Works the same on Docker Desktop/WSL2: there `pid: host` means the Docker VM, where the game containers run too.
- MapViewer3D on your PC, connected to the console with an API key (`apiBase` + `token`, see the main README). **Beta.16 or newer** connects directly; older versions (Beta.9+) use `mvlink`.
- Game build `2134304` is verified; after a game update the agent re-detects its offsets by itself (see the agent docs).

## 1. Install (on the Dune Docker host)

```bash
git clone --branch ddp --depth 1 https://github.com/dev-prophet-code/MapViewer3D.git mapviewer-live
cd mapviewer-live
cp .env.example .env
docker compose -f docker-compose.mapviewer-live.yml up -d --build
docker compose -f docker-compose.mapviewer-live.yml logs -f
```

On its first start mvgate creates its own key and a strong token in its volume `mvgate-data` and logs the key fingerprint (`sha256/…`). The agent log lists every game server process it finds and how many objects it reads (Hagga Basin ≈ 2500, Deep Desert ≈ 250). The Overmap is "not ready" by design.

Open port **8797/TCP** in the firewall – ideally only for the IPs that need it (`MV_GATE_ALLOW`).

## 2. Pair (= unlock)

Nothing can be read until the server admin pairs a client. Create the pairing code with the **public** name or IP of the server:

```bash
docker compose -f docker-compose.mapviewer-live.yml exec mvgate mvgate -pair dune.example.org
```

It prints one line `mvlive1:…`. It contains address, key fingerprint and token: **handle it like a password** and give it only over a trusted channel (not by public chat, not over plain HTTP). Revoke all codes at once:

```bash
docker compose -f docker-compose.mapviewer-live.yml exec mvgate mvgate -rotate-token
docker compose -f docker-compose.mapviewer-live.yml restart mvgate
```

## 3. Connect your local MapViewer3D

**Beta.16 or newer** – save the code in a file (e.g. `pairing.txt`) outside the program folder and start with

```bash
./start.sh -agent-pair /path/to/pairing.txt
```

or put it into the config file (`-config`) as `"agentPairing": "mvlive1:…"`, or set `MV_AGENT_PAIR`. The viewer asks the gate briefly (at most 5 s):

- answer and everything checks out → the switches **Sandworms (live)**, **Enemies**, **Civilians & traders**, **Vehicles (live)** and the storms appear;
- no answer, wrong key or wrong token → the switches stay hidden and the log says why (a wrong key is logged as a possible attack). It asks again every 10 minutes; new switches appear after reloading the page.

Without a pairing code the viewer only asks the Dune Docker console whether it offers this feature (today it does not) and keeps the switches hidden.

**Older versions (Beta.9 – Beta.15)** – run `mvlink` on the same PC; it holds the code and offers the data on `127.0.0.1` only:

```bash
cd gate && go build -o mvlink ./cmd/mvlink          # Go 1.24+; or cross-build, see below
./mvlink -pair-file /path/to/pairing.txt
./start.sh -agent http://127.0.0.1:8798
```

## Security in short

- TLS 1.3 only, no plain-text mode; the client accepts exactly the pinned key, no certificate authority involved.
- The token never leaves the PC: both sides prove knowledge of it with an HMAC bound to the TLS session, so a recorded or relayed proof is useless.
- Unauthenticated connections never reach HTTP; 10 failures per minute block the IP for 10 minutes.
- `mvagent` has no port and no internet; `mvgate` forwards only `GET` of `/stream`, `/healthz`, `/api/objects`.
- Keep `MV_AGENT_PLAYERS=false` unless you need live players. In PvP, worms and enemies follow players: do not pair players.
- Back up the volume `mvgate-data`; if it is lost, mvgate gets a new key and all clients must be paired again.

Threat model, protocol and the proposal for an integration into Dune Docker: [SECURITY.md](SECURITY.md).

## Configuration (`.env`)

| Variable | Default | Meaning |
|---|---|---|
| `MV_REF` / `MV_COMMIT` | `beta.15` / its commit | MapViewer3D release the agent is built from; the build stops if the tag points elsewhere |
| `MV_AGENT_PLAYERS` | `false` | also read players |
| `MV_AGENT_HZ` | `10` | sampling rate of moving objects |
| `MV_AGENT_CPUS` | `1.0` | CPU limit of the agent (the discovery scan reads the whole process memory) |
| `MV_AGENT_APPARMOR` | `docker-default` | `unconfined` only if the log shows `permission denied` on `/proc/<pid>/mem` |
| `MV_GATE_ALLOW` | empty = all | IPs / CIDRs that may connect |
| `MV_GATE_BIND` / `MV_GATE_PORT` | `0.0.0.0` / `8797` | where the gate listens on the host (the port also goes into the pairing code) |
| `MV_GATE_MAX_STREAMS` | `8` | parallel viewers |
| `MV_GATE_TOKEN` | empty | leave empty: mvgate creates a 256-bit token itself |

## Update, stop, remove

```bash
git pull                                                     # new compose/gate
# new MapViewer3D release: set MV_REF and MV_COMMIT in .env, then
docker compose -f docker-compose.mapviewer-live.yml up -d --build
docker compose -f docker-compose.mapviewer-live.yml down     # stop (keeps key and token)
docker compose -f docker-compose.mapviewer-live.yml down -v  # remove including key and token
```

The agent never updates itself in the container; a new release means a rebuild.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| agent log: no game server processes | Dune Docker not running, or the container has no `pid: host` (Podman/rootless Docker are not supported) |
| `permission denied` on `/proc/<pid>/mem` | AppArmor: `MV_AGENT_APPARMOR=unconfined`. SELinux: add `label=disable` to `security_opt` of `mvagent`. `kernel.yama.ptrace_scope=3` blocks it completely. |
| viewer log: "keine Antwort" (no answer) | port 8797 closed/forwarded wrong, wrong host in the pairing code, IP not in `MV_GATE_ALLOW`, or blocked after failed attempts (wait 10 minutes) |
| viewer log: key does not match ("anderer Schlüssel") | mvgate was set up again (volume lost) → pair again; otherwise **someone is in between**: do not continue |
| viewer log: code rejected ("lehnt … ab") | token was rotated → get a new pairing code |
| everything "not ready" after a game update | look for "neu bestimmt" (re-determined) in the agent log; if it fails, set `-blocks/-root/-pos` (agent docs) |

The container health check of mvgate connects through securelink itself (`docker compose ps` shows `healthy`).

## Development

```bash
cd gate && go vet ./... && go test ./...           # securelink, mvgate, mvlink
docker compose -f docker-compose.mapviewer-live.yml build
# mvlink for other systems, e.g. Windows:
cd gate && GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -o mvlink.exe ./cmd/mvlink
```

`gate/securelink` and `backend/securelink` in the MapViewer3D main code must stay identical.

## License

MIT, like MapViewer3D. Unofficial community project, not affiliated with Funcom or Red-Blink.

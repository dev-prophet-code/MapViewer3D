# MapViewer3D live data for Dune Docker

[Deutsch](README.de.md)

Real-time **sandworms, enemies, civilians, vehicles, sandstorms** (and, if you want, **players**) from a [Dune Docker](https://github.com/Red-Blink/dune-awakening-selfhost-docker) server in a **MapViewer3D that runs on your own PC**.

> Branch `ddp` of MapViewer3D: work in progress, not yet part of a release.

## Why a separate container?

Dune Docker's Live Map reads Postgres. Players and vehicles are in the database (saved every few seconds), but **sandworms, NPCs and storms are not**: they exist only in the memory of the running game server process. MapViewer3D's position agent `mvagent` reads them from there, read-only, about 10 times per second ([docs/Agent-EN.md](https://github.com/dev-prophet-code/MapViewer3D/blob/main/docs/Agent-EN.md)).

A Dune Docker *community addon* cannot do this: addons are browser pages in the console with a few approved API permissions, they cannot start containers or see processes. So this is a small **compose project of its own** that runs next to Dune Docker and changes nothing in it.

```
 Dune Docker host                                              your PC
┌──────────────────────────────────────────────┐
│ dune-server-* containers (game processes)    │
│        ▲ read-only /proc/<pid>/mem           │
│ ┌──────┴──────┐ internal  ┌───────────────┐  │  token   ┌────────────────────┐
│ │  mvagent    │──network──│    mvgate     │◄─┼──────────│ MapViewer3D        │
│ │ root, no    │  (no      │ token, allow  │  │  :8797   │ start -agent …     │
│ │ port, no    │ internet) │ list, TLS,    │  │          │ + console API key  │
│ │ internet    │           │ GET only      │  │          └────────────────────┘
│ └─────────────┘           └───────────────┘  │
└──────────────────────────────────────────────┘
```

- **mvagent** – built from the MapViewer3D sources (release tag `MV_REF`). `pid: host` lets it see the game server processes of the Dune Docker containers; it needs `SYS_PTRACE` + `DAC_OVERRIDE` to read their memory. All other capabilities are dropped, the file system is read-only, it has **no published port and no internet** (internal network).
- **mvgate** – the only published port. Checks a token (Basic or Bearer), optionally an IP allow list, blocks an IP for 10 minutes after 10 failed logins, forwards only `GET /stream`, `/healthz`, `/api/objects`, never forwards the token, optional TLS. Runs as non-root.

## Requirements

- A running Dune Docker host (Linux, Docker with Compose v2). Works the same on Docker Desktop/WSL2: there `pid: host` means the Docker VM, where the game containers run too.
- MapViewer3D **Beta.9 or newer** on your PC (Beta.15 recommended), already connected to the console with an API key (`apiBase` + `token`, see the main README).
- Game build `2134304` is verified; after a game update the agent re-detects its offsets by itself (see the agent docs).

## Install (on the Dune Docker host)

```bash
git clone --branch ddp --depth 1 https://github.com/dev-prophet-code/MapViewer3D.git mapviewer-live
cd mapviewer-live
cp .env.example .env
sed -i "s/^MV_GATE_TOKEN=.*/MV_GATE_TOKEN=$(openssl rand -hex 24)/" .env
docker compose -f docker-compose.mapviewer-live.yml up -d --build
docker compose -f docker-compose.mapviewer-live.yml logs -f mvagent
```

The agent log lists every game server process it finds and how many objects it reads (Hagga Basin ≈ 2500, Deep Desert ≈ 250). The Overmap is "not ready" by design.

Open port **8797/TCP** in the firewall – ideally only for your own IP (`MV_GATE_ALLOW`), see *Security*.

## Connect your local MapViewer3D

Put the agent URL into your viewer's config file (`-config config.json`) rather than on the command line, so the token does not show up in the process list:

```json
{
  "apiBase": "http://YOUR-SERVER:8088",
  "token": "dak_…",
  "agentUrl": "https://mv:YOUR_GATE_TOKEN@YOUR-SERVER:8797"
}
```

or for a quick test:

```bash
./start.sh -agent "http://mv:YOUR_GATE_TOKEN@YOUR-SERVER:8797"
```

The user name (`mv`) is ignored; the password is the gate token. The viewer then shows the switches **Sandworms (live)**, **Enemies**, **Civilians & traders**, **Vehicles (live)** and the storms. With `MV_AGENT_PLAYERS=true` online players move in real time; the viewer only shows players it can match to the console's own online players.

## Security

The agent sees positions, including (with `MV_AGENT_PLAYERS=true`) player positions. Treat the gate token like a console admin key.

Pick one, from best to simplest:

1. **SSH tunnel / VPN (no open port).** Set `MV_GATE_BIND=127.0.0.1` and connect from your PC with `ssh -N -L 8797:127.0.0.1:8797 you@server`, then use `agentUrl: "http://mv:TOKEN@127.0.0.1:8797"`.
2. **TLS on the gate.** Put `fullchain.pem`/`privkey.pem` for your server name (e.g. Let's Encrypt) into `./certs`, set `MV_GATE_TLS_CERT=/certs/fullchain.pem` and `MV_GATE_TLS_KEY=/certs/privkey.pem`, use `https://…` in `agentUrl`. A self-signed certificate does not work (the viewer checks it).
3. **Reverse proxy** (nginx, Caddy, …) with TLS in front of `127.0.0.1:8797` (`MV_GATE_BIND=127.0.0.1`). Note: the gate then sees the proxy as the client, so the IP allow list and login limiter apply to the proxy – filter IPs in the proxy instead.
4. **Plain HTTP + IP allow list** (`MV_GATE_ALLOW=<your IP>`): token and positions travel unencrypted. Only for a LAN or a test.

Additionally:

- Keep `MV_AGENT_PLAYERS=false` unless you need live players.
- PvP: worms and enemies follow players, so their movement can reveal where players are. Do not give the token to players.
- Never publish the agent itself (port 8796); the compose file does not.
- Known gap: after 30 s of failed connections the viewer writes the agent URL, token included, into its own local log. Keep that log private (fix planned in MapViewer3D).
- Change the token: edit `.env`, then `docker compose -f docker-compose.mapviewer-live.yml up -d`.

## Configuration (`.env`)

| Variable | Default | Meaning |
|---|---|---|
| `MV_GATE_TOKEN` | – (required) | ≥ 24 characters, no `:` `@` `/` (it is used in a URL) |
| `MV_REF` | `beta.15` | MapViewer3D release tag the agent is built from |
| `MV_AGENT_PLAYERS` | `false` | also read players |
| `MV_AGENT_HZ` | `10` | sampling rate of moving objects |
| `MV_AGENT_CPUS` | `1.0` | CPU limit of the agent (the discovery scan reads the whole process memory) |
| `MV_AGENT_APPARMOR` | `docker-default` | `unconfined` only if the log shows `permission denied` on `/proc/<pid>/mem` |
| `MV_GATE_ALLOW` | empty = all | IPs / CIDRs that may connect |
| `MV_GATE_BIND` / `MV_GATE_PORT` | `0.0.0.0` / `8797` | where the gate listens on the host |
| `MV_GATE_MAX_STREAMS` | `8` | parallel viewers |
| `MV_GATE_TLS_CERT` / `MV_GATE_TLS_KEY` | empty | TLS files inside the container (`/certs/…`) |
| `MV_GATE_CERT_DIR` | `./certs` | host folder mounted at `/certs` |

## Update, stop, remove

```bash
git pull                                                     # new compose/gate
# new MapViewer3D release: set MV_REF in .env, then
docker compose -f docker-compose.mapviewer-live.yml up -d --build
docker compose -f docker-compose.mapviewer-live.yml down     # stop and remove
```

The agent never updates itself in the container (`-auto-update` is not used); a new release means a rebuild with a new `MV_REF`.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| agent log: no game server processes | Dune Docker not running, or the container has no `pid: host` (Podman/rootless Docker are not supported) |
| `permission denied` on `/proc/<pid>/mem` | AppArmor/SELinux: set `MV_AGENT_APPARMOR=unconfined` (AppArmor). With SELinux add `label=disable` to `security_opt` of `mvagent`. Kernel `kernel.yama.ptrace_scope=3` blocks it completely. |
| viewer: `HTTP 401` | wrong token in `agentUrl` |
| viewer: `HTTP 403` | your IP is not in `MV_GATE_ALLOW` |
| viewer: `HTTP 429` | 10 failed logins: wait 10 minutes |
| viewer: TLS error | certificate does not match the host name in `agentUrl`, or is self-signed |
| everything "not ready" after a game update | look for "neu bestimmt" (re-determined) in the agent log; if it fails, set `-blocks/-root/-pos` (agent docs) |

Test the gate from your PC: `curl -u mv:TOKEN http://YOUR-SERVER:8797/healthz`.

## Development

```bash
cd gate && go test ./...                         # gate tests
docker compose -f docker-compose.mapviewer-live.yml build
```

## License

MIT, like MapViewer3D. Unofficial community project, not affiliated with Funcom or Red-Blink.

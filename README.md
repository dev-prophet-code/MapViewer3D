# MapViewer3D Realtime Data for Dune Docker

[Deutsch](README.de.md) · [Security](SECURITY.md) · [Dune Docker integration](dune-docker-integration/README.md)

Real-time **sandworms, enemies, civilians, vehicles, sandstorms** (and, if you want, **players**) from a [Dune Docker](https://github.com/Red-Blink/dune-awakening-selfhost-docker) server in a **MapViewer3D that runs on your own PC**. Access is a normal Console **API key** with the permission **Realtime Data**.

> Branch `ddp` of MapViewer3D: work in progress, not yet part of a release.

## How it works

Dune Docker's Live Map reads Postgres. Players and vehicles are in the database, but **sandworms, NPCs and storms are not**: they exist only in the memory of the running game server process. MapViewer3D's position agent `mvagent` reads them from there, read-only, about 10 times per second ([docs/Agent-EN.md](https://github.com/dev-prophet-code/MapViewer3D/blob/main/docs/Agent-EN.md)).

```
 Dune Docker host                                                          your PC
┌─────────────────────────────────────────────────────────────┐
│ dune-server-* containers (game processes)                   │
│        ▲ read-only /proc/<pid>/mem                          │
│ ┌──────┴───────┐ 127.0.0.1:8796 ┌─────────────────┐        │
│ │   mvagent    │◄───────────────│ Dune Docker     │◄─ 8088 │ plain HTTP (as before,
│ │ no port, no  │   (loopback)   │ Console         │        │  for everyone else)
│ │ login        │                │ /api/realtime/* │◄───┐   │
│ └──────────────┘                └─────────────────┘    │   │
│                                  ┌─────────────────┐   │   │ HTTPS ┌────────────────┐
│                                  │ mvtls (optional)│───┘   │◄──────│ MapViewer3D    │
│                                  │ own key, pinned │ :8797 │ API key│ Beta.16+       │
│                                  └─────────────────┘       │       └────────────────┘
└─────────────────────────────────────────────────────────────┘
```

- **mvagent** (this repository) – a container next to Dune Docker. `pid: host` to see the game processes, only `SYS_PTRACE` + `DAC_OVERRIDE`, AppArmor `unconfined` like the Dune containers, read-only file system. It listens on **127.0.0.1:8796 of the host only**; nothing is published to the network.
- **Dune Docker Console** – the only door. Its routes `/api/realtime/*` check the API key like every other API call. This needs the change in [dune-docker-integration/](dune-docker-integration/README.md), which is not part of Dune Docker yet.
- **mvtls** (this repository, optional) – the **encrypted front door**: HTTPS with its own long-lived key that the viewer pins, forwarding to the unchanged Console on `127.0.0.1:8088`. Nothing in Dune Docker has to change for the encryption, and everybody else keeps using `http://…:8088` exactly as before. See [Encrypted connection](#encrypted-connection).
- **MapViewer3D** (Beta.16+) – asks the Console briefly whether Realtime Data is available for its key. If not (older Dune Docker, no agent, key without the permission, no encrypted connection), the live switches are simply not shown. It detects `mvtls` by itself and offers to use it.

## Requirements

- A Dune Docker host (Linux, Docker with Compose v2 and BuildKit) with the Console change from [dune-docker-integration/](dune-docker-integration/README.md).
- An **encrypted connection** from your PC to the Console: the `mvtls` front door of this stack (recommended, [below](#encrypted-connection)), or your own reverse proxy with a certificate, or an SSH tunnel/VPN. MapViewer3D uses Realtime Data only over HTTPS (or on the same machine).
- MapViewer3D **Beta.16 or newer**, connected to the Console with an API key.
- Game build `2134304` is verified; after a game update the agent re-detects its offsets by itself.

## 1. Install the agent (on the Dune Docker host)

```bash
git clone --branch ddp --depth 1 https://github.com/dev-prophet-code/MapViewer3D.git mapviewer-live
cd mapviewer-live
cp .env.example .env
docker compose -f docker-compose.mapviewer-live.yml up -d --build
docker compose -f docker-compose.mapviewer-live.yml logs -f
```

The log lists every game server process and how many objects it reads (Hagga Basin ≈ 2500, Deep Desert ≈ 250). The Overmap is "not ready" by design. No firewall change is needed.

## Encrypted connection

The Console listens on plain HTTP (`http://host:8088`), so the API key and every answer cross the network in clear text. The optional **`mvtls`** container fixes that for the viewer without touching Dune Docker or anyone else's setup:

```bash
docker compose -f docker-compose.mapviewer-live.yml --profile tls up -d --build
docker compose -f docker-compose.mapviewer-live.yml exec mvtls mvtls -pin     # key fingerprint (not secret)
```

Open port **8797/TCP** (ideally only for your own IP: `MV_TLS_ALLOW`). On the first start `mvtls` creates its **own key** (ECDSA P-256, in the volume `mvtls-data`) with a certificate valid for 20 years. The viewer pins the **key**, so the fingerprint never changes by itself – not after a restart, not when the certificate is re-issued (e.g. after changing `MV_TLS_NAMES`). Back the volume up; if it is lost, the fingerprint changes and viewers have to confirm the new one.

- **API door (default):** only `GET`/`HEAD` of `/api/*` and `/images/maps/*`, only with `Authorization: Bearer dak_…` (the public marker images excepted). Sessions and cookies never pass, the Console's `auth`, `settings` and `setup` routes cannot be reached, and the Console web UI is **not** exposed on this port. So it adds no new way into the admin console.
- **Brute force:** rejected API keys are counted per client address in `mvtls` (the Console itself only sees `127.0.0.1` behind a proxy and would lump everybody together); 10 rejections per minute block the address for 10 minutes.
- **`MV_TLS_FULL=true`** also forwards the Console web UI and login, so you can open the whole Console encrypted (needed for the Console addon over HTTPS). That exposes the admin login on this port – only with `MV_TLS_ALLOW`, and think twice if your Console is deliberately not public.
- A Console that is already behind your own reverse proxy with a real certificate (Caddy/nginx + Let's Encrypt) needs no `mvtls`.

**The viewer finds it by itself.** When MapViewer3D (Beta.16+) is connected to a Console over plain HTTP, it asks port 8797 of the same host (a TLS handshake without sending any token, plus `GET /mvtls`). If `mvtls` answers, the viewer shows its **fingerprint** and asks you to compare it with the output of `mvtls -pin` on the server. **That comparison is what keeps a man in the middle out**, so it is a deliberate click, not automatic. After you confirm, the viewer pins the key, sends the token only over the encrypted connection, and from then on uses it for all Console traffic (maps, bases, icons, Realtime Data). If you already know the fingerprint (`-api-pin`), it switches without asking.

## 2. Grant "Realtime Data" to an API key

In the Console: **Settings → API Keys → Create Key**. Next to Maps, Players and the others there is a row **Realtime Data** with **None / Read**:

- **Read** – sandworms, enemies, civilians, vehicles and storms.
- For live **player** positions also grant **Players → Read** and set `MV_AGENT_PLAYERS=true` in `.env`.
- Disable, expire or revoke the key to cut access; an open stream ends within 10 seconds.

## 3. Connect MapViewer3D

Use that key as the viewer's console token (server = the Console's address, `token` = the key; with `mvtls` the viewer offers `https://<host>:8797` itself, see above). On start the viewer asks `/api/realtime/healthz` (at most 5 s):

- available and permitted → the switches **Sandworms (live)**, **Enemies**, **Civilians & traders**, **Vehicles (live)** and the storms appear;
- otherwise they stay hidden and the log says why (Dune Docker without the function, agent not running, key without "Realtime Data", Console not on HTTPS, certificate mismatch). It asks again every 10 minutes.

**Self-signed or internal certificate** (e.g. Caddy `tls internal`): the viewer refuses it and shows its fingerprint during setup. Compare it on the server and enter it in the setup's **Certificate fingerprint** field (stored per server; **Switch server** keeps several servers), or for all connections:

```bash
./start.sh -api-pin sha256/…        # or "apiPin" in the config file, or MV_API_PIN
```

## Security in short

- One credential: the Console API key. Its scope, expiry, rate limit, audit log and revocation all apply; no extra secret. The encrypted front door adds one port (8797) and no new way into the admin console.
- The agent is reachable only on the host's loopback; it has no login and no published port.
- Player positions need both "Realtime Data" and "Players → Read" (and `MV_AGENT_PLAYERS=true`).
- The viewer sends the key only over HTTPS (or to the same machine) and checks the certificate – via the system trust store or a pinned fingerprint.
- In PvP, worms and enemies follow players: do not give such keys to players.

Details: [SECURITY.md](SECURITY.md).

## Configuration (`.env`)

| Variable | Default | Meaning |
|---|---|---|
| `MV_REF` / `MV_COMMIT` | `beta.15` / its commit | MapViewer3D release the agent is built from; the build stops if the tag points elsewhere |
| `MV_AGENT_PLAYERS` | `false` | also read players |
| `MV_AGENT_HZ` | `10` | sampling rate of moving objects |
| `MV_AGENT_CPUS` | `1.0` | CPU limit (the discovery scan reads the whole process memory) |
| `MV_AGENT_PORT` | `8796` | loopback port; the Console reads `DUNE_REALTIME_AGENT_URL` (default `http://127.0.0.1:8796`) |
| `MV_TLS_PORT` / `MV_TLS_BIND` | `8797` / `0.0.0.0` | where `mvtls` listens (profile `tls`) |
| `MV_TLS_UPSTREAM` | `http://127.0.0.1:8088` | where the Console listens on the host |
| `MV_TLS_NAMES` | empty | host names / IPs written into the certificate (browsers only; the viewer pins the key). Keeps key and fingerprint |
| `MV_TLS_ALLOW` | empty = all | IPs / CIDRs that may connect to `mvtls` |
| `MV_TLS_FULL` | `false` | also forward the Console web UI and login (see above) |
| `MV_AGENT_APPARMOR` | `unconfined` | Dune Docker runs the game containers privileged and AppArmor-`unconfined`; `docker-default` refuses to read such a process (`permission denied`, kernel log `apparmor="DENIED" … peer="unconfined"`) |

## Update, stop, remove

```bash
git pull
# new MapViewer3D release: set MV_REF and MV_COMMIT in .env, then
docker compose -f docker-compose.mapviewer-live.yml up -d --build
docker compose -f docker-compose.mapviewer-live.yml down
```

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| agent log: no game server processes | Dune Docker not running, or no `pid: host` (Podman/rootless Docker are not supported) |
| `permission denied` on `/proc/<pid>/mem` | keep `MV_AGENT_APPARMOR=unconfined`; look for `DENIED` in `sudo dmesg`; `kernel.yama.ptrace_scope=3` blocks it completely |
| viewer: "Dune Docker has no Realtime Data" | Console without the integration |
| viewer: "key has no Realtime Data permission" | grant **Realtime Data → Read** to the key |
| viewer: "agent not running" (503) | start this stack; check its log |
| viewer: "not over HTTPS" | start `mvtls` (`--profile tls`) and confirm its fingerprint in the viewer, or put the Console behind your own HTTPS proxy, or run the viewer on the host itself |
| viewer shows no offer for `mvtls` | port 8797 closed/blocked, `MV_TLS_ALLOW` excludes you, or you chose "Not now" earlier (the viewer remembers; use Change/Add server with `https://<host>:8797`) |
| `mvtls` log: "console unreachable" | the Console does not listen on `MV_TLS_UPSTREAM` (another port, or bound to a single address) |
| viewer: certificate error with fingerprint | internal certificate: compare the fingerprint on the server (`mvtls -pin`), then confirm it / `-api-pin` |
| everything "not ready" after a game update | look for "neu bestimmt" (re-determined) in the agent log |

## License

MIT, like MapViewer3D. Unofficial community project, not affiliated with Funcom or Red-Blink.

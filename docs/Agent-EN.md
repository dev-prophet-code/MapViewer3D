# Position agent (`mvagent`) – live sandworms, enemies, civilians and vehicles

Since **Beta.9**. For self-hosted Dune: Awakening servers (Docker). Verified with game build `2134304-0-shipping`.

> **Only on your own servers.** The agent only *reads* the memory of the game processes (`/proc/<pid>/mem`); it injects nothing, hooks nothing, does not stop the game and changes nothing. It needs **root on the game host** (not inside the container). Linux only.

## Why a separate program?

NPCs, enemies and sandworms are **not in the database** (the tables hold spawner definitions only), nor in the log or RabbitMQ. They exist only in the memory of the running game process (`DuneSandboxServer-Linux-Shipping`). The console API therefore cannot show them. The agent reads them from there, about 10 times per second, and the viewer shows them live.

| Object | Class | Behaviour (measured) |
|---|---|---|
| Sandworms | `ASandwormPawn` | active worldwide, ~40 m/s, **~20 position changes per second** |
| Enemies, stranded, soldiers | `ADuneNpcCharacter` | stand still unless a player is nearby (their AI sleeps) |
| Civilians, traders, quartermasters | `ADuneNpcCharacterCivilian`, `ATaxationNpc` | stand still |
| Ornithopters, vehicles | `ADuneVehicle`, `ADuneOrnithopter`, `AWheeledVehiclePawn` | mostly static, some move |
| Players | `ADunePlayerCharacter` | only with `-players`; the viewer shows them as the console's online players moving in real time (see below) |

## Live players (`-players`)

Start the agent with `-players` and the viewer moves the console's online players in real time (10 Hz, smooth) instead of every 5 s. The agent has no names: the viewer server matches each live player to a console player of the same partition by nearest distance (console positions are a few seconds old, so up to 300 m apart is accepted; each console player is used once) and re-matches every 3 s. Two players standing right next to each other can swap for a moment. Without `-players` nothing changes.

## Quick start

```bash
# on the game host, as root (the release ZIP contains bin/mvagent-linux-amd64 and -arm64)
sudo ./bin/mvagent-linux-amd64                  # listens on 127.0.0.1:8796
sudo ./bin/mvagent-linux-amd64 -once | head     # diagnosis: search once, print JSON

# the viewer picks the data up (same host, or any host that can reach the agent)
./start.sh -agent http://127.0.0.1:8796         # or MV_AGENT=… / "agentUrl" in the -config file
```

The viewer then shows four extra switches: **Sandworms (live)** (on by default), **Enemies**, **Civilians & traders**, **Vehicles (live)**. Worms glide smoothly between the ~10 Hz samples; enemies and civilians are point clouds, so thousands cost nothing. Without `-agent` the switches do not appear and nothing changes.

systemd unit (agent, runs as root):

```ini
[Unit]
Description=Dune MapViewer3D position agent
After=docker.service

[Service]
ExecStart=/opt/mapviewer-agent/mvagent -addr 127.0.0.1:8796 -players
Restart=always
RestartSec=10
NoNewPrivileges=yes
ProtectHome=yes
ProtectSystem=strict
PrivateTmp=yes
RestrictAddressFamilies=AF_INET AF_UNIX
MemoryMax=512M

[Install]
WantedBy=multi-user.target
```

## Flags

| Flag | Default | Meaning |
|---|---|---|
| `-addr` | `127.0.0.1:8796` | local interface (**no login**: keep it on loopback; other addresses need `-allow-open`) |
| `-hz` | 10 | sampling rate of active objects (the source delivers at most ~20 Hz) |
| `-workers` | 4 | parallel scan workers (one scan at a time, ~1–4 s per process) |
| `-rescan` | 30m | full discovery interval (new spawns show up then; a full scan reads the whole process memory, so it is deliberately rare) |
| `-rescan-min` | 1m | at most this often on demand (a sandworm vanished = a new one spawned) |
| `-players` | off | also read players (needed for live players; privacy: off by default) |
| `-storm-scan` | 3m | short search for sandstorm objects only (negative = off); a storm exists only while it runs |
| `-probe` | – | diagnosis: list classes by pattern, their instances and an annotated field dump (with `-pid`) |
| `-pid` | – | only this process (diagnosis) |
| `-blocks`, `-root`, `-pos` | build 2134304 | override the offsets by hand |
| `-once` | – | search once, print JSON, exit |

Interface: `GET /healthz`, `GET /api/objects[?kinds=worm,vehicle,npc,civilian,player,storm,coriolis]` (sources carry `weather` = Coriolis cycle start/next, Unix ms), `GET /stream` (SSE: `snap` = full state, `pos` = changes `[id,x,y,z]` and vanished ids, keep-alive comment every 20 s).

## How it works

1. **Vtables.** The agent opens the running binary (`/proc/<pid>/exe`) and reads the `_ZTV<len><class>` symbols of the dynamic symbol table. At run time an object starts with the pointer `module base + symbol + 0x10` (Itanium ABI); the module base comes from `/proc/<pid>/maps` (ASLR).
2. **Discovery.** It scans the writable private memory in 16 MB blocks (4 workers, own file descriptor each) for 8-byte aligned values equal to one of those vtables. Every hit is a candidate object.
3. **Names and plausibility.** Names come from the engine's `FNamePool`; the class name gives the blueprint (e.g. `BP_Crea_SandwormArrakis_C`). A hit counts only if its class name is valid, the object is not a `Default__…` object and not flagged destroyed, `RootComponent` is valid and the position is plausible (|x|,|y| 1 … 3 000 000 cm). This removes ghost hits from freed heap and class defaults.
4. **Tracking.** After discovery only the world position is read (`RootComponent + pos`, 3 × double, cm, ~20 µs per object): active objects (worms, vehicles, anything that moved in the last 10 s) at `-hz`, all others every 2 seconds together with a validity check (vtable still there, not destroyed). A vanished sandworm (or 25 vanished objects at once) triggers a new discovery.

| Field | Build 2064155 | **Build 2134304** (default) |
|---|---|---|
| `FNamePool` `Blocks[]` (relative to module base) | `0x166B4328` | `0x174125A8` |
| `AActor::RootComponent` | `+0x240` | `+0x238` |
| position in the root component | `+0x180` | `+0x190` |
| `UObjectBase` flags / class / name | `+0x08` / `+0x10` / `+0x18` | same |

**After a game update the offsets change.** The agent protects itself: the pool self-test (`None` at index 0, `ByteProperty` at index 3) must pass, otherwise the pool is **found again from its signature** (block 0 starts with `None`, `ByteProperty`, plus a pointer to it in `.bss`), and if the actor offsets no longer give plausible objects, `RootComponent` (a pointer to an object whose class ends in `Component`) and the position (three doubles that look like world coordinates) are **re-determined from a sample of the hits**. Whatever was found is written to the log. If nothing works the process is reported as not ready (`/healthz`, reason) and no garbage is delivered. The Overmap has no actors with positions; it stays "not ready" by design.

Measured on a live server (build 2134304): Hagga Basin ~2550 objects in 3.4 s (2410 enemies, 86 civilians, 46 vehicles, 9 sandworms), Deep Desert ~250 (9 sandworms), each social hub ~100; sandworms update ~9.4 times per second each.

## Security and privacy

- Read-only; no ptrace, no write access, no injection.
- The process command line contains an **auth token** (`-ini:engine:…ServiceAuthToken=…`). The agent never prints, logs or forwards it (only map name and `-PartitionIndex` are parsed).
- The interface has no login: it listens on loopback only. The viewer server connects to it and filters:
  - **players are forwarded only when matched** to an online player the console already shows (same partition, nearest distance, at most 300 m apart, each once); unmatched players stay invisible, so no new names or players appear,
  - in public mode (`-public`) only partitions on the allow list that the site reports as **PvE**. Worms and enemies follow players, so their movement in PvP partitions would reveal player positions.
- Do not give the agent port to anyone you would not trust with player positions.

## Limits

- Offsets are build specific (see above); after a big update check the agent log for the "re-determined" message.
- New spawns appear at the next discovery (`-rescan`, default 30 minutes; sooner when a tracked sandworm vanishes). New vehicles and enemies that spawn near players can therefore be late; vehicles that disappear are removed within 2 seconds.
- Positions are not an atomic snapshot; objects can vanish between two reads (they are validated every 2 seconds).
- The scan briefly uses memory bandwidth (4 workers, one process at a time).

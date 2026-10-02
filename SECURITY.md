# Security of Realtime Data

How live positions get from a Dune Docker host to a MapViewer3D on someone's PC, what protects them, and what the remaining risks are.

## Design in one sentence

The agent that reads the game servers has no network exposure at all; the **Dune Docker Console is the only door**, and it opens only for an **API key with the scope "Realtime Data"**, over a connection the viewer accepts only when it is **HTTPS with a verified certificate** (or on the same machine).

## Parts

| Part | Where | Exposure |
|---|---|---|
| `mvagent` | Dune Docker host, container, root, `pid: host`, caps `SYS_PTRACE` + `DAC_OVERRIDE` only, AppArmor `unconfined` (required: the Dune game containers are privileged and unconfined, and `docker-default` refuses to read an unconfined peer), `no-new-privileges`, read-only FS | `127.0.0.1:8796` of the host only (host networking, `-addr` refuses non-loopback addresses); no login, no published port |
| Dune Docker Console | as shipped by Dune Docker, plus [dune-docker-integration/](dune-docker-integration/README.md) | `/api/realtime/*`, authenticated and authorized like every other API route |
| MapViewer3D Beta.16+ | the user's PC | calls the Console with its API key as Bearer token |

## Authorization (Console)

- Namespace `realtime`, single action `realtime:read`; in the API key form a separate row **Realtime Data** (None / Read). It is not part of `maps:read`, so no existing key gains access.
- Player objects only if the principal also has `players:read`; otherwise they are removed from snapshots and their position updates are dropped (the agent reads players at all only with `MV_AGENT_PLAYERS=true`).
- An open stream re-authenticates its key every 10 s. A disabled, expired or revoked key, or a removed scope, ends it (or stops the player positions).
- Limits: 4 open streams per key, 16 in total; the key's normal rate limit and audit log apply (`realtime.stream-open`).
- Process ids are never passed on; the agent URL must be plain HTTP on loopback.
- Tiers: owner and admin hold `realtime:*`; moderator, player and observer do not.

## Transport (viewer)

The API key and the positions travel inside the Console connection, so the viewer is strict about it:

- **HTTPS required** for Realtime Data, unless the Console is on the same machine (`127.0.0.1`, `localhost`, `::1`). Over plain HTTP the switches stay hidden and the log says why.
- **Certificate check**: either the system trust store (a normal certificate, e.g. Let's Encrypt) or, for a self-signed / internal certificate, a **pinned fingerprint** (`-api-pin sha256/…`, SHA-256 of the public key). Without a pin a certificate the system does not trust is refused, and the log shows its fingerprint so the admin can compare it on the server and pin it. A wrong pin is reported as a possible man in the middle.
- TLS 1.2 minimum (the Console's reverse proxy decides; Caddy and current nginx offer TLS 1.3).
- Redirects are not followed for the Realtime Data check.

## What an attacker can do

| Attacker | Result |
|---|---|
| on the network, Console on HTTPS with a valid or pinned certificate | sees encrypted traffic, size and timing; no key, no positions |
| active MITM with a forged certificate | refused (system trust or pin); nothing is sent |
| on the network, Console on plain HTTP | the viewer does not use Realtime Data at all; note that the normal Console API (and its key) still travels in clear text in such a setup – use HTTPS |
| holder of a stolen API key with Realtime Data | reads positions until the key is revoked/disabled – revocation takes effect on open streams within 10 s |
| key without Realtime Data, or without Players → Read | gets 403, respectively no player positions |
| local user on the Dune Docker host | can reach the agent on loopback; out of scope (root on the host can read the game anyway) |
| the agent itself | reads only; no ptrace attach, no writes, no injection; never prints the game's service token from the command line |

## Remaining advice

- Give Realtime Data only to keys that need it, with an expiry date where possible.
- PvP: worms and enemies follow players, so their movement can hint at player positions. Do not give such keys to players.
- Serve the Console over HTTPS whenever it is reached over the internet – independent of this feature.

## Supply chain

- Base images pinned by digest; the agent is built from the MapViewer3D tag `MV_REF` and the build stops if that tag does not point to `MV_COMMIT`.
- The agent never updates itself in the container.

## Reporting

Security issues: open a private advisory at https://github.com/dev-prophet-code/MapViewer3D/security/advisories (do not open a public issue).

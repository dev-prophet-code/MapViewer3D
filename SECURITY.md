# Security of Realtime Data

How live positions get from a Dune Docker host to a MapViewer3D on someone's PC, what protects them, and what the remaining risks are.

## Design in one sentence

The agent that reads the game servers has no network exposure at all; the **Dune Docker Console is the only door**, and it opens only for an **API key with the scope "Realtime Data"**, over a connection the viewer accepts only when it is **HTTPS with a verified certificate or a pinned key** (or on the same machine). The stack ships an optional **encrypted front door (`mvtls`)** that provides exactly that for a Console that only speaks plain HTTP, without changing the Console or anyone else's setup.

## Parts

| Part | Where | Exposure |
|---|---|---|
| `mvagent` | Dune Docker host, container, root, `pid: host`, caps `SYS_PTRACE` + `DAC_OVERRIDE` only, AppArmor `unconfined` (required: the Dune game containers are privileged and unconfined, and `docker-default` refuses to read an unconfined peer), `no-new-privileges`, read-only FS | `127.0.0.1:8796` of the host only (host networking, `-addr` refuses non-loopback addresses); no login, no published port |
| Dune Docker Console | as shipped by Dune Docker, plus [dune-docker-integration/](dune-docker-integration/README.md) | `/api/realtime/*`, authenticated and authorized like every other API route |
| `mvtls` (optional, profile `tls`) | Dune Docker host, container, non-root, `cap_drop: ALL`, read-only FS, host networking | the one published port (8797/TCP): HTTPS in front of the Console on `127.0.0.1:8088` |
| MapViewer3D Beta.16+ | the user's PC | calls the Console with its API key as Bearer token |

## Authorization (Console)

- Namespace `realtime`, single action `realtime:read`; in the API key form a separate row **Realtime Data** (None / Read). It is not part of `maps:read`, so no existing key gains access.
- Player objects only if the principal also has `players:read`; otherwise they are removed from snapshots and their position updates are dropped (the agent reads players at all only with `MV_AGENT_PLAYERS=true`).
- An open stream re-authenticates its key every 10 s. A disabled, expired or revoked key, or a removed scope, ends it (or stops the player positions).
- Limits: 4 open streams per key, 16 in total; the key's normal rate limit and audit log apply (`realtime.stream-open`).
- Process ids are never passed on; the agent URL must be plain HTTP on loopback.
- Tiers: owner and admin hold `realtime:*`; moderator, player and observer do not.

## Encrypted front door (`mvtls`)

The Console speaks plain HTTP on 8088, so the API key and every answer would cross the network in clear text. `mvtls` terminates TLS in front of the unchanged Console:

- **Own key, pinned.** On first start it creates an ECDSA P-256 key in its volume (mode 0600) with a self-signed certificate valid for 20 years. Viewers pin the **public key** (`sha256/<base64url SHA-256 of the SPKI>`), not the certificate, so the fingerprint is stable across restarts and certificate re-issues (e.g. when `MV_TLS_NAMES` changes). No certificate authority is involved, so a CA-issued or self-made certificate of an attacker fails the pin. TLS 1.2 minimum (Go's default cipher suites: forward secret, no RSA key exchange), TLS 1.3 negotiated by modern clients.
- **API door by default.** Only `GET`/`HEAD` of `/api/*` and `/images/maps/*`; `Authorization: Bearer dak_…` is required (marker images and `/api/health` excepted); the Console's `/api/auth/`, `/api/settings/`, `/api/setup/` and `/api/discord/` routes, path tricks (`..`, `//`, `\`) and every other path are refused here and never reach the Console. Only `Authorization`, `Accept`, `Accept-Encoding`, `Range` and the conditional headers are forwarded: no cookies, no `X-Forwarded-For`; `Set-Cookie` of the Console is dropped. The Console web UI and its login are **not** exposed on this port.
- **Brute force.** The Console only sees `127.0.0.1` behind the proxy, so its per-address failure limiter would be one bucket for all clients (a single attacker could drain it and lock everybody out). `mvtls` therefore counts rejected keys per client address (10 per minute → blocked for 10 minutes, before anything reaches the Console).
- **Optional full mode** (`MV_TLS_FULL=true`) forwards everything, including the web UI and the login. That puts the admin login on this port; use it only with `MV_TLS_ALLOW`.
- IP allow list (`MV_TLS_ALLOW`) is checked before any TLS work; server limits: header timeout 10 s, idle 2 min, headers ≤ 16 KiB, streams are flushed immediately.

### Where the fingerprint is shown (Dune Docker patch 2)

With [patch 2](dune-docker-integration/README.md) the front door is part of Dune Docker, and the fingerprint is shown where the admin already looks: below the first admin password at the **end of the installer**, in **Settings → Encrypted API Access** (status, switch, address, fingerprint with a Copy button) and with `dune encrypted-api fingerprint`. The Console reads only the **certificate** to compute it (never the private key); the Settings routes are `settings:read`/`settings:write`, so no API key can reach them. The installer starts the front door by default on a new install (`DUNE_ENCRYPTED_API=0` skips it); a choice made later in Settings is kept. This also protects Dune Docker's own API access in general, independent of any particular client.

### How a viewer comes to trust the key

An encrypted connection is only as good as the way its key is first learned. A client that fetches the fingerprint over the very connection it wants to protect would accept an attacker's key. So MapViewer3D (Beta.16+) does this:

1. It notices a Console on plain HTTP and asks port 8797 of the same host: a TLS handshake (only to read the public key) and `GET /mvtls`, **without sending any token or secret**.
2. If a `mvtls` answers, it shows the **fingerprint** and asks the human to compare it with `docker compose … exec mvtls mvtls -pin` on the server. **That out-of-band comparison is the step that excludes a man in the middle.** It is a deliberate click, never automatic.
3. Only then does it re-check the key, send the API key – through the pinned, encrypted connection – and store the new address and the pin. The plain-HTTP entry is replaced; instance names move with it.
4. A viewer that already knows the fingerprint (`-api-pin`) switches without asking. A viewer started with a fixed configuration (`-config`) never switches by itself: it only logs the address and fingerprint to set.

A wrong or changed key is refused as a possible attack; nothing is sent. Before the confirmation the viewer behaves exactly as it did on plain HTTP – the confirmation can only improve things.

## Transport (viewer)

The API key and the positions travel inside the Console connection, so the viewer is strict about it:

- **HTTPS required** for Realtime Data, unless the Console is on the same machine (`127.0.0.1`, `localhost`, `::1`). Over plain HTTP the switches stay hidden and the log says why.
- **Certificate check** (every Console connection of the viewer, not only Realtime Data): either the system trust store (a normal certificate, e.g. Let's Encrypt) or, for a self-signed / internal certificate such as `mvtls` or Caddy `tls internal`, a **pinned fingerprint** (SHA-256 of the public key; confirmed in the offer dialog, entered per server in the setup, or `-api-pin sha256/…` for all). Note: Caddy's internal certificates last only hours and get a new key each time, so pin `mvtls` (stable key) instead, or use a real certificate. Without a pin a certificate the system does not trust is refused, and the log shows its fingerprint so the admin can compare it on the server and pin it. A wrong pin is reported as a possible man in the middle.
- TLS 1.2 minimum (the Console's reverse proxy decides; Caddy and current nginx offer TLS 1.3).
- Redirects are not followed for the Realtime Data check.

## What an attacker can do

| Attacker | Result |
|---|---|
| on the network, Console on HTTPS with a valid or pinned certificate (including `mvtls` after the fingerprint was compared) | sees encrypted traffic, size and timing; no key, no positions |
| active MITM during the very first contact, before the fingerprint was compared | can show his own key at port 8797; the human compares it with the server's and refuses – the attacker gets nothing. Without the comparison nothing is worse than plain HTTP |
| someone from the internet against port 8797 | gets 401/404 for everything but `GET /mvtls`; wrong keys block the address after 10 rejections per minute; the Console UI and login are not reachable |
| active MITM with a forged certificate | refused (system trust or pin); nothing is sent |
| on the network, Console on plain HTTP | the viewer does not use Realtime Data at all; note that the normal Console API (and its key) still travels in clear text in such a setup – use HTTPS |
| holder of a stolen API key with Realtime Data | reads positions until the key is revoked/disabled – revocation takes effect on open streams within 10 s |
| key without Realtime Data, or without Players → Read | gets 403, respectively no player positions |
| local user on the Dune Docker host | can reach the agent on loopback; out of scope (root on the host can read the game anyway) |
| the agent itself | reads only; no ptrace attach, no writes, no injection; never prints the game's service token from the command line |

## Remaining advice

- Give Realtime Data only to keys that need it, with an expiry date where possible.
- PvP: worms and enemies follow players, so their movement can hint at player positions. Do not give such keys to players.
- Open 8797 only for the addresses that need it (`MV_TLS_ALLOW`), and keep the Console's own port 8088 closed to the internet where you can.
- Serve the Console over HTTPS whenever it is reached over the internet – independent of this feature (`mvtls`, or your own proxy with a real certificate).

## Supply chain

- Base images pinned by digest; the agent is built from the MapViewer3D tag `MV_REF` and the build stops if that tag does not point to `MV_COMMIT`. `mvtls` is built from this repository with the Go standard library only; `go vet` and its tests run inside the image build.
- The agent never updates itself in the container.

## Reporting

Security issues: open a private advisory at https://github.com/dev-prophet-code/MapViewer3D/security/advisories (do not open a public issue).

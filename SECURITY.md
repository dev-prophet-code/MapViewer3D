# Security of the live data link (securelink v1)

This describes how live positions get from a Dune Docker host to a MapViewer3D on someone's PC, what it protects against, and what Dune Docker has to do to "unlock" the feature if it is integrated there.

## Goals

1. **Confidentiality** – nobody on the network path can read positions or the secret.
2. **Server authenticity** – the viewer talks to *this* gate and nothing else, even if DNS, the network or a certificate authority is compromised (no man in the middle).
3. **Client authenticity** – only someone the server admin explicitly paired can read anything; an unpaired client never reaches HTTP.
4. **No secret on the wire** – the token is never sent, not even inside TLS.
5. **No plain-text mode** – there is no switch that turns any of this off.

## Parts

| Part | Where | Network |
|---|---|---|
| `mvagent` | Dune Docker host, container, root, `pid: host`, caps `SYS_PTRACE`+`DAC_OVERRIDE` only, read-only FS | internal Docker network only: no published port, no internet |
| `mvgate` | Dune Docker host, container, non-root, read-only FS | the only published port (8797/TCP) |
| MapViewer3D Beta.16+ | the user's PC | connects to mvgate itself (`-agent-pair`, same `securelink` code in `backend/securelink`) |
| `mvlink` | the user's PC, for viewers before Beta.16 | connects to mvgate; offers the data to the local viewer on **127.0.0.1 only** |

## Protocol

1. **TCP** to the gate. IP allow list and the failure block list are checked before any TLS work. At most 64 handshakes run at once.
2. **TLS 1.3 only** (1.2 and below are refused), ALPN `http/1.1`. The gate's key is an ECDSA P-256 key it generated itself (`/data/gate-key.pem`, mode 0600, in its own volume).
3. **Key pinning.** The client accepts exactly one public key: `sha256/<base64url(SHA-256(SPKI))>` from the pairing code. No CA is consulted, so a certificate from any CA – or a self-made one – of an attacker fails. Go's TLS stack still verifies the handshake signature, i.e. that the server owns the pinned key.
4. **Mutual token proof bound to the session.** Both sides derive `ekm = TLS-Exporter("EXPORTER-mvgate-auth-v1", "", 32)` (RFC 8446 §7.5), which is unique to this TLS session and known only to its two endpoints.
   - client → gate: `"MVG1" ‖ HMAC-SHA256(token, "mvgate v1 client proof" ‖ ekm)`
   - gate → client: `"MVG1" ‖ HMAC-SHA256(token, "mvgate v1 server proof" ‖ ekm)`

   Both compare in constant time. A wrong proof closes the connection; the IP is blocked for 10 minutes after 10 failures per minute. The whole step has a 10 s deadline.
5. Only then does HTTP start, inside the same TLS connection. The gate forwards only `GET`/`HEAD` of `/stream`, `/healthz` and `/api/objects`, strips all request headers except `Accept`, and limits parallel streams.

### Why the token is never sent

The proof is an HMAC over a value that exists only in this one TLS session. A recorded proof is useless in any other session (no replay). A relay that terminates TLS towards the client and opens its own session to the gate has two *different* exporter values, so the client's proof does not match at the gate (no relay). This holds even in the worst case where an attacker swapped the pin, because the token itself never left the client. The tests cover this case (`TestRelayMITM`).

### What an attacker can still do

| Attacker | Result |
|---|---|
| passive on the network | sees TLS 1.3 traffic to port 8797, its size and timing; no content |
| active MITM with any certificate | handshake fails at the pin check; nothing is sent |
| MITM who also swapped the pin in the pairing code | gets neither token nor data (proof is session-bound); the client fails as well |
| brute force on the token | 256-bit token; 10 tries per minute and IP |
| connection floods | capped pending handshakes, deadline, block list; it can make the gate busy, not leak |
| stolen pairing code | full read access to positions: **handle the code like a password**. Rotate with `mvgate -rotate-token` |
| access to the Docker host | out of scope (root on the host can read the game anyway) |
| other software on the user's PC | can read from mvlink on 127.0.0.1; mvlink refuses requests from web pages (`Origin`/`Sec-Fetch-Site`) and foreign `Host` headers (DNS rebinding) |

## Pairing = unlocking

The feature is **off for a client until the server admin pairs it**. The only way in is the pairing code:

```
mvlive1:<base64url({"v":1,"a":"host:port","p":"sha256/…","t":"<token>"})>
```

It carries the address, the pin and the token. Whoever creates it must be the server admin (shell on the host, or the admin console if Dune Docker integrates this). It must reach the user over a trusted channel, never over plain HTTP.

### Integration into Dune Docker

Implemented as a ready-to-merge patch in [dune-docker-integration/](dune-docker-integration/README.md) (Settings → **MapViewer3D Live Data**); nothing in the protocol changes:

1. **Capability.** The console knows whether the `mapviewer-live` stack runs (container `mvgate` healthy) and shows a *Live data (MapViewer3D)* card in its admin UI. For API keys it answers
   `GET /api/mapviewer-live/status` → `200 application/json {"available":true,"version":1}`; without the feature the route does not exist (404). Nothing is announced to unauthenticated clients, and this answer never contains the token, the address or the pin.
2. **Pair.** An admin (`settings:write`, which API keys can never hold) clicks *Create Pairing Code*; the console runs `mvgate -pair <public address>` in the container and shows the code **once** (copy button, no storage, `cache-control: no-store`; the audit row records only address and fingerprint). Over plain HTTP the console warns first – a pairing code shown over plain HTTP is only as safe as that connection; use HTTPS, the LAN or a tunnel.
3. **Revoke.** *Revoke All Pairings* runs `mvgate -rotate-token` and restarts `mvgate`; every old code stops working.
4. Optional later: one token per paired device (named, revocable individually), stored in the gate volume.

The console never needs the token for anything else, and the viewer never needs a console session for the live data.

### What the viewer does (Beta.16)

- **With a pairing code** it opens one securelink connection to the gate and asks `/healthz`, with a 5 s limit. Only if TLS, pin and both proofs succeed is the agent switched on; otherwise the live switches are not shown at all (`/api/live/status` reports `agent: false`) and the log names the reason – a pin mismatch is reported as a possible attack. It retries every 10 minutes.
- **Without a pairing code** it asks the console route above (5 s, API key, no redirects followed). No answer or 404 means "Dune Docker does not have this (yet)": switches hidden. `available: true` only produces a log hint that a pairing code is needed – an offer alone never unlocks anything.
- Agent errors are logged without credentials.

## Agent side

- Read-only `/proc/<pid>/mem`; no ptrace attach, no writes, no injection.
- The game's command line holds a service auth token; the agent never prints, logs or forwards it.
- Players are read only with `MV_AGENT_PLAYERS=true`. The viewer shows only players it can match to the console's own online players.
- PvP: worms and enemies follow players, so their movement can hint at player positions. Do not pair players.

## Supply chain

- Base images pinned by digest; the agent is built from the MapViewer3D tag `MV_REF` and the build stops if that tag does not point to `MV_COMMIT`.
- `mvgate`/`mvlink` use the Go standard library only; `go vet` and the tests run in the image build.
- The agent never updates itself in the container.

## Reporting

Security issues: open a private advisory at https://github.com/dev-prophet-code/MapViewer3D/security/advisories (do not open a public issue).

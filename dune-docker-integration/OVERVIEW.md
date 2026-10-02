# How it works – overview for Dune Docker maintainers

Two small, independent changes let API clients read **live game objects** (sandworms, NPCs, vehicles, storms) from a Dune Docker
server and let them reach the Console API **encrypted**. Nothing existing changes for anybody who does not use them.

```
 game server containers
        ▲  read-only /proc/<pid>/mem
        │
   ┌────┴─────┐  127.0.0.1:8796   ┌──────────────────────┐  :8088 plain HTTP (unchanged, as today)
   │ mvagent  │◄──────────────────│ Console              │◄─────────────────────────────  existing clients
   │ (no port,│     loopback      │  /api/realtime/*     │
   │  no login)│                  │  Settings page       │◄──┐
   └──────────┘                   └──────────────────────┘   │ 127.0.0.1:8088
                                                             │
                                  ┌──────────────────────┐   │
   API client ──HTTPS :8797──────►│ dune-tls-front       │───┘
   (key + pinned fingerprint)     │ own long-lived key   │
                                  └──────────────────────┘
```

## 1. Realtime Data (patch 1)

**Problem.** Sandworms, NPCs and storms are not in Postgres, only in the memory of the running game server processes.

**Agent.** The optional `mvagent` container (MapViewer3D project) reads them read-only about ten times per second. It has no login and
listens on the host's loopback only (`127.0.0.1:8796`).

**Console.** The Console is the only door to the agent: `GET /api/realtime/{healthz,objects,stream}`, authorized like every other API route.
A new API-key scope **Realtime Data** (one more row in *Settings → API Keys*, None / Read) controls it:

- it is its own namespace, so `maps:read` does not include it and no existing key gains access;
- player positions are included only if the key also has `players:read`;
- an open stream re-checks its key every 10 s, so disabling, expiring or revoking the key (or removing the scope) ends it;
- limits: 4 streams per key, 16 in total; process ids are never passed on; the Console refuses any agent URL that is not plain HTTP on loopback.

## 2. Encrypted API access (patch 2)

**Problem.** The Console speaks plain HTTP, so API keys and answers cross the network in clear text.

**Front door.** An optional container, `dune-tls-front` (Go, standard library only), terminates TLS in front of the unchanged Console:

- **Own key.** On first start it creates an ECDSA P-256 key and a self-signed certificate (20 years) in `runtime/generated/tls-front`.
  Clients **pin the key** (`sha256/<base64url SHA-256 of the public key>`), so the fingerprint is stable across restarts and certificate re-issues and no
  certificate authority or domain is needed.
- **API door.** Only `GET`/`HEAD` of `/api/*` and `/images/maps/*`, only with `Authorization: Bearer dak_…`. No cookies, no web UI,
  `/api/auth|settings|setup|discord` blocked. It adds no new way into the admin console.
- **Brute force.** The Console only sees `127.0.0.1` behind a proxy, so the front door counts rejected keys per client address (10/min → 10 min block).

**Where the admin sees the fingerprint.** Below the first admin password at the **end of the installer**, in **Settings → Encrypted API Access**
(status, switch, address, fingerprint with a Copy button) and with `dune encrypted-api fingerprint`. The Console reads only the **certificate** to
compute it, never the private key; the routes are `settings:read`/`settings:write`, so no API key can reach them.

**Why the admin compares it.** A client that learned the fingerprint over the very connection it wants to protect could be handed an
attacker's key. The admin therefore compares the fingerprint shown by the client with the one in the installer/Settings; only then is the key trusted.

## What changes in Dune Docker

| Patch | New | Touches |
|---|---|---|
| 1 Realtime Data | `services/realtime.js`, routes `/api/realtime/*`, namespace `realtime` | `server.js`, `actions.js`, `policy.js` (admin), `apiKeyScopes.js`, key-form label |
| 2 Encrypted API access | `runtime/tls-front/`, `docker-compose.tls-front.yml`, `runtime/scripts/tls-front.sh`, `services/encryptedApi.js`, Settings section | `install.sh` (start + show fingerprint), `runtime/scripts/dune`, `server.js`, `actions.js`, `SettingsPanel.tsx` |

Defaults and switches: the installer starts the front door on a new install (`DUNE_ENCRYPTED_API=0` skips); a later choice in Settings is kept. It only
listens on `8797`, which still has to be opened in the firewall. The agent is installed separately (compose project in this repository) and only needed for Realtime Data.

## Tested

Automated: new Console, shell, web and Go tests; RBAC/scope parity suites; each patch applies on its own to upstream `main` and passes. On a real
test host (v1.4.44): agent reads ~2,500 objects; the front door builds, is healthy, serves the same fingerprint to the Console, to `dune encrypted-api`
and to an outside client; the API door refuses everything it should. Details: [PULL_REQUEST.md](PULL_REQUEST.md), [PULL_REQUEST-encrypted-api.md](PULL_REQUEST-encrypted-api.md).

More: [README](README.md) (apply the patches) · [../SECURITY.md](../SECURITY.md) (threat model, how trust in the key is established).

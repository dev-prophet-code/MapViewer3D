# Dune Docker integration

Two ready-to-merge changes for [Red-Blink/dune-awakening-selfhost-docker](https://github.com/Red-Blink/dune-awakening-selfhost-docker),
independent in purpose, applied in this order with `git am` on upstream `main` at `da644b7` (v1.4.44):

| # | Patch | What it adds | PR text |
|---|---|---|---|
| 1 | [`0001-api-keys-realtime-data-scope.patch`](0001-api-keys-realtime-data-scope.patch) | API key scope **Realtime Data** (live sandworms, NPCs, vehicles, storms through the Console) | [PULL_REQUEST.md](PULL_REQUEST.md) |
| 2 | [`0002-encrypted-api-access.patch`](0002-encrypted-api-access.patch) | **Encrypted API access**: optional HTTPS front door for the Console API; its key **fingerprint is shown by the installer** and in **Settings → Encrypted API Access** (and `dune encrypted-api fingerprint`) | [PULL_REQUEST-encrypted-api.md](PULL_REQUEST-encrypted-api.md) |

```bash
cd dune-awakening-selfhost-docker
git am /path/to/0001-api-keys-realtime-data-scope.patch /path/to/0002-encrypted-api-access.patch
dune console restart
```

Neither is submitted as a pull request yet. A one-page explanation of how the system works, for maintainers: [OVERVIEW.md](OVERVIEW.md). The data API for other programs (fields, stream format, examples, pinning): [REALTIME-API.md](REALTIME-API.md).

---

# Patch 1: API key scope "Realtime Data"

It adds **Realtime Data** as its own row to the API key permissions (**Settings → API Keys → Create Key**) and lets the
Console pass the live data of the MapViewer3D agent to clients whose key holds it.

## Transport

The patch itself does not change how the Console is reached. A Console that only speaks plain HTTP can be put behind the
optional encrypted front door of this stack, `mvtls` (compose profile `tls`; see the [README](../README.md#encrypted-connection)
and [SECURITY.md](../SECURITY.md)): HTTPS with its own long-lived key that MapViewer3D pins, forwarding to the unchanged
Console. Nothing in Dune Docker has to change for it, and everybody else keeps using the Console as before.

## What the admin sees

When creating an API key there is a new row next to Maps, Players and the others:

```
Realtime Data   [ None | Read ]
```

- **Read** – the key may stream live sandworms, enemies, civilians, vehicles and sandstorms.
- **Player positions** – only if the key also has **Players → Read**.
- `maps:read` does not include it; existing keys gain nothing.
- Disabling, expiring or revoking the key – or removing the scope – stops an open stream within 10 seconds.

## What it adds

| File | Purpose |
|---|---|
| `console/api/src/services/realtime.js` | talks to the agent on `127.0.0.1:8796` (loopback only), filters players, trims process ids, stream limits, periodic re-check |
| `console/api/src/server.js` | routes, `principalMay()` helper, stream route that re-authenticates the key every 10 s |
| `console/api/src/actions.js`, `policy.js`, `apiKeyScopes.js` | namespace `realtime`, action `realtime:read`, granted to owner and admin |
| `console/web/src/api/apiKeys.ts` | label "Realtime Data" |
| tests | `test/realtime.test.js` (9), scope/RBAC parity tests updated, `ApiKeysSection` test for the new row |
| `docs/console/realtime.md`, `docs/console/api-keys.md` | documentation, scope table |

| Route | Action | |
|---|---|---|
| `GET /api/realtime/healthz` | `realtime:read` | availability; `503` without agent |
| `GET /api/realtime/objects` | `realtime:read` | snapshot |
| `GET /api/realtime/stream` | `realtime:read` | server-sent events `snap` / `pos` |

The routes mirror the agent's own (`/healthz`, `/api/objects`, `/stream`), so MapViewer3D uses
`https://<console>/api/realtime` exactly like a local agent, with its API key as Bearer token.

## Verified

Against upstream `da644b7`:

- `node --test` (console/api): new tests pass; RBAC/scope/policy suites 134/134; the same 25
  environment-dependent tests (live DB, Linux shell) fail with and without the patch.
- `vitest run` (console/web): all pass; `tsc -b` and `vite build` succeed.

## Apply

See the top of this page (both patches, in order).

---

# Patch 2: Encrypted API access

The Console speaks plain HTTP on 8088, so the API key and every answer cross the network in clear text. This patch adds an
**optional front door**: a small container that serves the Console **API** over HTTPS with its own long-lived key and
forwards to the unchanged Console. Clients pin the key's **fingerprint**; nothing changes for anybody else.

## Where the fingerprint is shown

- **Installer:** after the first admin password, the final screen prints the address (`https://<ip>:8797`) and the **key
  fingerprint** (`sha256/…`), and says that the same value is shown again in Settings. Re-running `./install.sh` prints it again.
- **Settings → Encrypted API Access:** status, an on/off switch, the address, the **Key Fingerprint** with a Copy button.
- **CLI:** `dune encrypted-api fingerprint` (also `enable`, `disable`, `status`).

## What it adds

| File | Purpose |
|---|---|
| `runtime/tls-front/` | the front door (Go, standard library only; own ECDSA key, API door, brute-force counter per client address) with tests and Dockerfile |
| `docker-compose.tls-front.yml` | host networking, runs as the host user, read-only, `cap_drop: ALL`, key in `runtime/generated/tls-front` |
| `runtime/scripts/tls-front.sh`, `runtime/scripts/dune` | `dune encrypted-api enable\|disable\|status\|fingerprint` |
| `install.sh` | starts it on a new install (`DUNE_ENCRYPTED_API=0` skips) and prints address + fingerprint; a later choice in Settings is kept |
| `console/api/src/services/encryptedApi.js`, `server.js`, `actions.js` | `GET`/`POST /api/settings/encrypted-api` (`settings:read`/`settings:write`, never reachable with an API key); the Console reads only the **certificate** to compute the fingerprint |
| `console/web/.../EncryptedApiSection.tsx`, `SettingsPanel.tsx` | the Settings section (English) |
| tests | `encryptedApi.test.js` (12), `tests/tls-front-script-test.sh`, `EncryptedApiSection.test.tsx` (4), Go tests; CI builds the image |
| `docs/console/encrypted-api.md`, `README.md`, `docs/README.md` | documentation, port table |

## API door

Only `GET`/`HEAD` of `/api/*` and `/images/maps/*`, only with `Authorization: Bearer dak_…` (marker images and `/api/health`
excepted); no cookies, no web UI, `/api/auth/`, `/api/settings/`, `/api/setup/` and `/api/discord/` blocked. It adds no new way
into the admin console. Full details: [docs/console/encrypted-api.md](../../docs/console/encrypted-api.md) in the patch and
[SECURITY.md](../SECURITY.md).

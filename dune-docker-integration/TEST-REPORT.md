# Test report: PR #242 (Realtime Data) and PR #243 (Encrypted API access) on a real host

Both pull requests were installed one after the other on a test server with the maintainer's own QA mechanism (`self-update install-qa`),
tested against the maintainer's checklist plus a few extra cases, and the server was then returned to the stable release.
All checks passed. One pre-existing gap was found (see *Findings*).

| | |
|---|---|
| Date | 2026-10-02 |
| Host | one Linux test server, Dune Docker **v1.4.44** (stable release), Console on the host's loopback behind a TLS reverse proxy |
| Builds tested | #242 `200c05fc8469ed7baaf5ddc5106bd345c14824e5`, #243 `a2c813d836494ad2f388fad21b7516efe094b25c` (each = our commit + the maintainer's follow-up commit) |
| Agent | the MapViewer3D position agent from this repository, container with `pid: host`, reachable on `127.0.0.1` only |
| Test key | one API key with **Realtime Data → Read**, **Players → Read**, **Maps → Read** (nothing else) |
| Client | a separate machine over the internet (curl with key pinning), plus MapViewer Beta.16 for the end-to-end check |

## Preparation

1. **Backup of the original Console**: the whole installation directory, the original Console image (`docker save`) and a restore script that
   removes the patch, restores the sources and reloads the original image. Taken before anything was changed.
2. The agent stack from this repository was running (Hagga Basin: 2,497 objects in one discovery of about 5 s; the Overmap correctly reports
   "not ready").
3. A temporary API key as above. It was only used from the command line; its scopes were changed during the tests and **restored** afterwards.

## Installation method

As given by the maintainer, one PR at a time (installing the second replaces the first):

```bash
cd ~/dune-awakening-selfhost-docker && \
DUNE_SELF_UPDATE_REPO=<fork> \
runtime/scripts/dune self-update install-qa <commit-sha>
```

`install-qa` backed up the project files, replaced them with the commit's snapshot, kept the local state and rebuilt the Console. It worked on
this installation although it is not a Git checkout. No Battlegroup restart was needed.

## PR #242 – Realtime Data (`200c05fc`)

Installed; the maintainer's follow-up is in the running Console (`players && !nextPlayers` is present in `services/realtime.js`), the encrypted-access files are not.

| # | Check | Result |
|---|---|---|
| A1 | `GET /api/realtime/healthz` with the key | `available: true`, `version: 1`, `ok: true`, `ready: 1`; sources carry `map`, `partition`, `ready`, `n`, `weather` – **no process id** |
| A2 | `GET /api/realtime/objects` | keys `gen`, `t`, `sources`, `objects`; 2,404 NPCs, 84 civilians, 9 sandworms; no player objects (agent runs without `-players`) |
| A3 | `GET /api/realtime/stream` for 4 s | one `snap`, then **40 `pos` events** (about 10 per second) |
| A4 | other routes with the same key | `/api/map/status` 200, `/api/settings/api-keys` **403**, no `Authorization` header **401** |
| A5 | **maintainer's test:** stream open (about 265 KB received in 4 s), then remove only **Players → Read** from the key | the stream **ended after 6 s**; scopes restored; a new stream works |
| A6 | disable the key while streaming | stream ended after **7 s**; request with the disabled key **401**; re-enabled |
| A7 | remove **Realtime Data** from the key while streaming | stream ended after **7 s**; request without the scope **403**; scope restored, `healthz` 200 again |

## PR #243 – Encrypted API access (`a2c813d8`)

Installed; the front-door files are present, the realtime service is not (the two PRs are independent).

| # | Check | Result |
|---|---|---|
| B0 | **Settings: switch off, then on** (via the Settings API) | off: container removed, status `enabled: false`; on: image built from the PR, container `healthy`; **fingerprint unchanged** (the key persists) |
| B1 | HTTPS from another machine with the key pinned by its fingerprint | `/api/map/status` **200**, `/api/map/partitions` **200** |
| B2 | what the door must refuse | `/api/settings/api-keys`, `/api/auth/state`, `/` and `/index.html`: **404**; wrong key: **401**; **wrong pin: connection refused** (curl exit 90); plain HTTP on the port: **400** |
| B3 | **maintainer's test: IP restrictions** (see below) | enforced on the **real client address** |
| B4 | **maintainer's test: change the Console port** | Console 8088 → 8089 in Settings: `.env` updated, Console answers on 8089 and no longer on 8088, the front door's upstream followed to `127.0.0.1:8089`, `healthy`, request with the key through the door **200**; changed back to 8088, upstream followed again |

### B3 in detail – `ADMIN_ALLOWED_IPS`

`docker-compose.web.yml` does **not** pass `ADMIN_ALLOWED_IPS` into the Console container (there is no `env_file`, only listed variables), so
the setting has no effect in a stock installation. To test the new code path it was added temporarily to the compose file and `.env`
(both restored afterwards, verified by comparison with the saved copies).

| List | Request | Result |
|---|---|---|
| `127.0.0.1` | directly on the server | 200 |
| `127.0.0.1` | through the TLS reverse proxy (arrives from loopback) | 200 |
| `127.0.0.1` | through the front door from another machine | **403** `Access denied: IP not in ADMIN_ALLOWED_IPS` |
| `127.0.0.1` | same, but the client sends its own `X-Forwarded-For: 127.0.0.1` and fake `X-Dune-Tls-*` headers | **403** (the door strips them and signs the real address) |
| `127.0.0.1` + the client's address | through the front door with the key | **200** |
| `127.0.0.1` + the client's address | client sends fake `X-Dune-Tls-Client` of a different address | 200 – correct: the fake header is dropped, the real (allowed) address is used |
| any | directly on the Console from loopback with wrong `X-Dune-Tls-*` headers | **403** `Invalid encrypted API forwarding identity` |

## Return to stable, and the final state

- `self-update install latest` (from the official repository) returned the installation to v1.4.44: five key files were compared against the saved
  original and are **identical**; the QA channel marker is gone.
- For further tests the combined change of both PRs (with the maintainer's commits) was applied again on top of the stable tree and the Console
  restarted; the restart reconciled the front door by itself (healthy, same fingerprint).

## End-to-end with the viewer (MapViewer Beta.16, separate machine)

| Step | Result |
|---|---|
| connect to `https://<host>:8797` without a fingerprint | refused, the fingerprint is named (`cert_untrusted`) |
| connect with the fingerprint | connected over HTTPS; token sent only through the pinned connection |
| live status | `agent: true` (Realtime Data offered for this key) |
| maps from the server | loaded through the encrypted door |
| live agent data for Hagga Basin | connected, **2,497 objects** (2,404 NPCs, 84 civilians, 9 sandworms) |

## Findings

1. **`ADMIN_ALLOWED_IPS` never reaches the Console in a stock compose deployment** (see B3). Pre-existing, not part of either PR. Either pass it
   through in `docker-compose.web.yml` (`ADMIN_ALLOWED_IPS: "${ADMIN_ALLOWED_IPS:-}"`) or document how to set it; the new signed client identity only
   matters once the variable is actually set.
2. **After `install-qa` of #243 the already running front-door container was not recreated** (it kept running for the previous 13 minutes with its old
   image and configuration); it was replaced when switched off and on in Settings. It may be intended, but then the new image/configuration only takes
   effect at the next toggle or Console restart.
3. Upstream `main` moved on after the PRs' base (`da644b7` → `0cf16f49`); a rebase may be needed before merging.
4. `self-update install-qa` and `install latest` worked on an installation that is not a Git checkout and left a backup of the project files each time.

## Not tested

- Player positions with real players online (the agent ran without `-players`; the scope downgrade was verified independently of that).
- The installer's final screen on a fresh install (covered by the shell test with a mocked Docker).
- IPv6 clients, many parallel viewers, long-running streams beyond several minutes.

## Reproducing

```bash
# a stream you can watch
curl -N -H "Authorization: Bearer dak_<test key>" https://<host>:8797/api/realtime/stream     # or http://127.0.0.1:8088 on the server

# change the key's scopes without the UI (admin session on the server; settings are never reachable with an API key)
#   POST /api/auth/login {password}            -> csrfToken + session cookie
#   PUT  /api/settings/api-keys/<key id>       header x-csrf-token, body {"scopes":{…}} or {"enabled":false}

# pin the front door (curl wants standard base64 with padding and a double slash)
curl --pinnedpubkey "sha256//<fingerprint, - → +, _ → /, plus =>" -k -H "Authorization: Bearer dak_<test key>" https://<host>:8797/api/map/status
```

After testing, revoke or delete the temporary API key.

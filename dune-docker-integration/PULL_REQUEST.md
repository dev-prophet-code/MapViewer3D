<!-- Text of the pull request to Red-Blink/dune-awakening-selfhost-docker.
     Patch: 0001-api-keys-realtime-data-scope.patch (base: upstream main da644b7 = v1.4.44).
     Before opening the PR: rebase on the current upstream main, re-run the tests below,
     fill in the "Tested on a real host" section, then remove this comment. -->

## API keys: new scope "Realtime Data" (live sandworms, NPCs, vehicles and storms)

This adds **Realtime Data** as its own, read-only row to the API key permissions and lets the Console pass on the live
positions of sandworms, enemies, civilians, vehicles and sandstorms to clients whose key holds it – for example a
[MapViewer3D](https://github.com/dev-prophet-code/MapViewer3D) running on an administrator's PC.

Nothing changes for installations that do not run the optional position agent: the new routes answer `503` and no key
gains anything it did not have before.

- **Source of the agent:** https://github.com/dev-prophet-code/MapViewer3D (branch `ddp`, MIT)
- **Base:** `main` at `da644b7` (v1.4.44)
- **Size:** 12 files, +571 / −10

### Why

The Live Map reads Postgres, so it shows players, vehicles and bases – but not sandworms, NPCs or storms. Those exist
only in the memory of the running game server processes. MapViewer3D's position agent `mvagent` reads them there,
read-only, about ten times per second. Until now that worked only for a viewer on the game host itself. With this
change the Console becomes the one door to that data, with the access control it already has.

### What the admin sees

When creating an API key (**Settings → API Keys → Create Key**) there is a new row next to Maps, Players and the others:

```
Realtime Data   [ None | Read ]
```

- **Read** – the key may read and stream live sandworms, enemies, civilians, vehicles and storms.
- **Player positions** are included only if the key also has **Players → Read**.
- `maps:read` does **not** include it, so no existing key gains access.
- Disabling, expiring or revoking the key – or removing the scope – ends an open stream within 10 seconds.

### How it works (what to review)

```
 game server containers ──read-only /proc/<pid>/mem──► mvagent (127.0.0.1:8796, no login, no published port)
                                                          │ loopback only
                                                          ▼
 client ──HTTPS, Authorization: Bearer <API key>──► Console /api/realtime/*  (normal API key / session authorization)
```

1. **The agent is not part of this PR.** It is an optional compose project next to Dune Docker (branch `ddp` of
   MapViewer3D). It runs with `pid: host`, only `SYS_PTRACE` + `DAC_OVERRIDE`, `no-new-privileges`, a read-only file
   system and host networking bound to `127.0.0.1:8796`; it has no login and no published port. AppArmor has to be
   `unconfined` for it, because the Dune game containers run privileged and unconfined, and `docker-default` refuses to
   read an unconfined peer (`apparmor="DENIED" operation="ptrace" peer="unconfined"`).
2. **New namespace `realtime`** with the single action `realtime:read` (`actions.js`). Because the API key catalog is
   built from the known actions, the row appears in the key form without UI code; only the label "Realtime Data" is
   added (`apiKeys.ts`). It has no write action, so the control has two segments, like Logs.
3. **Routes** (`server.js`, all `realtime:read`):

   | Route | Answer |
   |---|---|
   | `GET /api/realtime/healthz` | `{ available, version, ok, ready, sources }`; `503` when the agent does not run |
   | `GET /api/realtime/objects` | snapshot `{ gen, t, sources, objects }` |
   | `GET /api/realtime/stream` | server-sent events `snap` (full state) and `pos` (`d`: `[id, x, y, z]`, `r`: removed ids) |

   They mirror the agent's own routes, so a client uses `https://<console>/api/realtime` exactly like a local agent.
4. **`services/realtime.js`** talks to the agent. The agent URL (`DUNE_REALTIME_AGENT_URL`, default
   `http://127.0.0.1:8796`) must be plain HTTP on loopback without credentials – anything else is refused, because the
   agent has no login. Process ids are removed from `sources`. Answers are size-limited, a stalled client is dropped
   (4 MB buffered), at most 4 streams per key and 16 in total.
5. **Players.** `principalMay(req, "players:read")` applies the same two gates as `handleApi` (policy engine, then the
   key's scope map) without writing a response. Without it, player objects are removed from snapshots and their
   position updates are dropped; only ids the caller may see pass through.
6. **Long-lived streams re-check their key.** A stream outlives the request that authorized it, so every 10 seconds the
   route authenticates the bearer key again (`apiKeys.authenticate(req)`) – or reads the session again for a browser –
   and re-evaluates `realtime:read` and `players:read`. A disabled, expired or revoked key, or a removed scope, ends the
   stream (or stops the player positions).
7. **Tiers:** owner (`*`) and admin (`realtime:*`, added to the Allow list) may read Realtime Data; moderator, player
   and observer may not. Opening a stream is audited as `realtime.stream-open`.

### Files

| File | Change |
|---|---|
| `console/api/src/services/realtime.js` | new: agent access, filtering, stream limits, periodic re-check hook |
| `console/api/src/server.js` | routes, `principalMay()`, `realtimeRoute()`, `realtimeStreamRoute()` |
| `console/api/src/actions.js` | namespace `REALTIME`, three route actions |
| `console/api/src/policy.js` | admin: `realtime:*` |
| `console/api/src/apiKeyScopes.js` | `realtime` in the preferred order, after `maps` |
| `console/web/src/api/apiKeys.ts` | label "Realtime Data" |
| `console/api/test/realtime.test.js` | new, 9 tests |
| `console/api/test/apiKeyScopes.test.js`, `rbacParity.test.js` | read-only namespaces include `realtime`; namespace count 19; known namespaces |
| `console/web/src/features/settings/ApiKeysSection.test.tsx` | the new row renders with None / Read only |
| `docs/console/realtime.md`, `docs/console/api-keys.md` | new page; scope table row and read-only note |

### Security notes

- One credential: the existing API key. Scope, expiry, rate limit, audit and revocation all apply; there is no new
  secret, port or settings screen.
- `realtime:read` is a separate grant; `maps:read` does not imply it, and player positions additionally need
  `players:read`.
- The agent is reachable only on the host's loopback; the Console refuses any other agent URL.
- Transport: keys and positions travel inside the Console connection. Serve the Console over HTTPS when it is reached
  over the internet. The MapViewer3D client uses Realtime Data only over HTTPS (or on the same machine) and checks the
  certificate against the system trust store or a pinned fingerprint. For installations whose Console only speaks plain
  HTTP, the MapViewer3D stack (branch `ddp`) ships an optional encrypted front door, `mvtls`: HTTPS with its own
  long-lived key in front of the unchanged Console (API door: only `GET /api/*` with a key, no web UI, no cookies). It
  needs no change in this repository and nobody else has to change anything.
- PvP: worms and enemies follow players, so their movement can hint at player positions. The docs say not to give such
  keys to players.

### Tested

Against upstream `da644b7`:

- `node --test test/realtime.test.js`: 9/9 – loopback-only agent URL; health/objects without process ids; players only
  with `players:read`; stream without `players:read` never carries a player position; revoking the scope ends an open
  stream; per-key stream limit (`429`); `realtime` is its own read-only catalog entry and not part of `maps:read`;
  owner/admin yes, moderator/player/observer no; the stream route re-authenticates the key.
- `node --test test/apiKeyScopes.test.js test/rbacParity.test.js test/operationsPermissionMatrix.test.js test/policy.test.js test/realtime.test.js`: 134/134.
- Full `node --test` (console/api): the same 25 tests fail with and without the patch on the development machine
  (they need a live database or a Linux shell); no new failure.
- `npx vitest run` (console/web): 104 files, 1259 tests pass, including the new `ApiKeysSection` test; `tsc -b` and `vite build` succeed.

### Tested on a real host

<!-- fill in after the test on the test server -->
- {{Dune Docker version}} with the patch applied, `dune console restart`
- agent stack from branch `ddp`: {{objects per map}}
- API key with Realtime Data → Read: {{result}}; without the scope: `403`; key disabled while streaming: stream ends
- MapViewer3D Beta.16 over HTTPS: {{result}}

### Not in this PR

- No UI beyond the label: the row comes from the existing catalog-driven key form.
- The agent itself and its compose file stay in the MapViewer3D repository.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

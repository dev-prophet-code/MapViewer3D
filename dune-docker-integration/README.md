# Dune Docker integration: API key scope "Realtime Data"

A ready-to-merge change for [Red-Blink/dune-awakening-selfhost-docker](https://github.com/Red-Blink/dune-awakening-selfhost-docker).
It adds **Realtime Data** as its own row to the API key permissions (**Settings → API Keys → Create Key**) and lets the
Console pass the live data of the MapViewer3D agent to clients whose key holds it.

- Patch: [`0001-api-keys-realtime-data-scope.patch`](0001-api-keys-realtime-data-scope.patch)
- Base: upstream `main` at `da644b7` (v1.4.44, applies with `git am`)
- Not submitted as a pull request yet.

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

```bash
cd dune-awakening-selfhost-docker
git am /path/to/0001-api-keys-realtime-data-scope.patch
dune console restart
```

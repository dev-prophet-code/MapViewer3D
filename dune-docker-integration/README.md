# Dune Docker integration: Settings → MapViewer3D Live Data

A ready-to-merge change for [Red-Blink/dune-awakening-selfhost-docker](https://github.com/Red-Blink/dune-awakening-selfhost-docker)
that adds a **MapViewer3D Live Data** section to the Console **Settings** page. There an administrator can see whether
the `mapviewer-live` stack runs, create a **pairing code** for a MapViewer3D and revoke all pairings – no shell needed.

- Patch: [`0001-settings-mapviewer3d-live-data.patch`](0001-settings-mapviewer3d-live-data.patch)
- Base: upstream `main` at `da644b7` (applies cleanly with `git am`)
- Not submitted as a pull request yet.

## What it adds

| File | Purpose |
|---|---|
| `console/api/src/services/mapViewerLive.js` | finds the `mvgate` container by compose labels, reads health and key fingerprint, runs `mvgate -pair`, `mvgate -rotate-token` + restart; `execFile` with fixed arguments, the address is validated first |
| `console/api/src/server.js`, `actions.js` | four routes (below) with IAM actions |
| `console/web/src/features/settings/MapViewerLiveSection.tsx` | the Settings section (English) |
| `console/web/src/features/settings/SettingsPanel.tsx` | collapsible entry "MapViewer3D Live Data" above "API Keys" |
| `console/web/src/api/mapViewerLive.ts`, `styles.css` | API client, a few styles |
| `console/api/test/mapViewerLive.test.js`, `MapViewerLiveSection.test.tsx` | 9 + 5 tests |
| `docs/console/mapviewer-live.md` | documentation |

| Route | Action | |
|---|---|---|
| `GET /api/settings/mapviewer-live` | `settings:read` | status, health, fingerprint – no secret |
| `POST /api/settings/mapviewer-live/pairing-code` | `settings:write` | `{ publicAddress }` → `{ code, address, fingerprint }` |
| `POST /api/settings/mapviewer-live/revoke` | `settings:write` | new token, restart mvgate |
| `GET /api/mapviewer-live/status` | `maps:read` | `{ available, version }` for MapViewer3D Beta.16+ |

## The Settings section

- **Status** – Not Installed / Stopped / Starting / Running / Unhealthy, and the key fingerprint.
- **Not installed** – shows the three install commands instead of any controls.
- **Public Address** – prefilled with the address the Console is opened with; `host`, `host:port` or `[IPv6]:port`.
- **Create Pairing Code** – shown once with Copy and "I've Saved It"; never stored, cached or audited (the audit row has only address and fingerprint). Over plain HTTP the Console warns first.
- **Revoke All Pairings** – confirmation dialog, then every code stops working.

## Security notes

- Pairing and revoking are `settings:write`; API keys can never hold `settings:*`, so only a signed-in administrator can create a code.
- `GET /api/mapviewer-live/status` tells a viewer only *whether* the feature exists. It never returns address, pin or token, and an `available: true` alone unlocks nothing.
- The Console never sees the token except inside the one pairing code it shows; it does not keep it.

## Verified

Against upstream `da644b7`:

- `node --test` (console/api): the new tests pass; the same 25 environment-dependent tests (live DB, Linux shell) fail with and without the patch.
- `rbacParity`, `operationsPermissionMatrix`, `apiKeyScopes`: 100/100.
- `vitest run` (console/web): 105 files, 1263 tests pass; `tsc -b` and `vite build` succeed.

## Apply

```bash
cd dune-awakening-selfhost-docker
git am /path/to/0001-settings-mapviewer3d-live-data.patch
```

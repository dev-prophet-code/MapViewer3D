Title: Catalog mapviewer3d 0.4.1 (share links for players; answers the review of 0.4.0)

## MapViewer3D 0.4.1 (this pull request now points to 0.4.1 instead of 0.4.0)

Thank you, @yacketrj, for the detailed review of 0.4.0. All findings were real and are fixed in a new immutable release; `addon-v0.4.0` is left as it is.

- **Release:** https://github.com/dev-prophet-code/MapViewer3D/releases/tag/addon-v0.4.1
- **Pinned package:** `https://github.com/dev-prophet-code/MapViewer3D/releases/download/addon-v0.4.1/mapviewer3d-0.4.1.zip`
- **SHA-256 (verified by downloading the published asset):** `68acdaba23b37b97255e9dc7a112c1673759dda1c3867eaa900af888a511c2dc`
- **Catalog change:** `addons/mapviewer3d.json` and `index.json`: `version`, `downloadUrl`, `sha256` and one sentence about share links in the description. **No change in permissions** (`files:addon-data`).

### What 0.4.0 added (unchanged)
Share links for players without a console account (time-limited or open-ended, revocable, served by the optional share gateway `mvshare`, branch [`ddp`](https://github.com/dev-prophet-code/MapViewer3D/tree/ddp), `SHARE.md`), a Realtime Data status line, and a layer list structured like the Console's Layers.

### Answers to the review
| Finding | Fix | Test |
|---|---|---|
| 1. `pin-data.mjs` silently kept a stale `CATALOG_SHA256` (`let` vs `const`) | the regex accepts both, each declaration must be found exactly once, otherwise the tool exits non-zero | `tests/pin-data.mjs` (really pins; fails when a declaration is missing) |
| 2. `keyId()` could show most of the key | the label is now an 8-digit hash of the whole key, never a piece of it | `tests/key-storage.mjs` (keys with and without underscores) |
| 3. the key was sent to a guessed gateway address before it was confirmed | each candidate is first asked who it is **without any credential** (`GET /mvshare`: no `Authorization`, no cookies, no redirects, public and cross-origin on the gateway); only an address that answers as the share gateway earns the key | `tests/share.mjs` (a non-gateway address never sees the key; the gateway sees it only after identifying itself) and a Go test for the gateway side |
| 4. `realtime.js` race (stale connection touched the shared state and the shared watchdog) | only the current connection may set `connected=false` / call `error()`; the watchdog lives on its own connection | `tests/realtime.mjs` \"a replaced connection cannot disturb its successor\" (fails on 0.4.0) |
| 5.1 tile/mesh ids were only 64 bits of the SHA-256 | new data release `data-v2` (same tiles; only the indexes and the catalog changed, `tools/upgrade-ids.mjs`) lists full digests, compared in full; `data-v1` still works by prefix; the addon is pinned to `data-v2`; `tilepack.mjs` writes full digests; the published data was fetched and decoded in the real addon | `tests/unit.mjs` (ids are 64 hex; same first 64 bits but different rest is refused) |
| 5.2 cache discarded good data on 5xx | a 5xx/timeout/429 keeps the last good data and asks again within 5 s; a definite answer (404) replaces it | `tests/console-cache.mjs` |
| 5.3 raw error codes in the live status; revoked key vs agent down | translated messages; a key the console refused is reported as such, separately from \"agent not running\" | `tests/ui-layers.mjs` (texts exist in EN and DE) |
| 5.4 package checks were bypassable | the set of scripts is fixed, storage APIs only in the files meant to (Cache API in `data.js`, `localStorage` for language/theme in `i18n.js`/`theme.js`, purge in `store.js`), no dynamic code or computed access to globals anywhere | `tests/verify-package.mjs` (each rule is shown to catch its violation) |
| 5.5 no PR write-up | `PULL_REQUEST-0.4.0.md` (earlier) and this file are in the repository | |
| 5.6 base never retried / picking behind the camera / dead player-interpolation code | retry with growing pauses; objects behind the camera are skipped; dead code removed | (viewer code; covered by running the packaged viewer against the published data) |

### Security notes for reviewers (new network use of 0.4.x)
Besides the console (as before) and `raw.githubusercontent.com` / `cdn.jsdelivr.net`, the addon page calls the **administrator's own share gateway** and only when the share dialog is used. The API key is sent there (as `Authorization: Bearer`, `credentials: 'omit'`) only after the address has identified itself as a share gateway, to authorise link management; the addon itself never stores the key (checked by `scripts/verify-package.sh` and `tests/key-storage.mjs`). A visitor's page has no key at all (`tests/share-visitor.mjs`).

### Tests
CI (branch run and tag run, gitleaks included) is green: `tests/share.mjs`, `share-visitor.mjs`, `ui-layers.mjs`, `realtime.mjs` (10), `key-storage.mjs` (10), `unit.mjs` (8), `console-cache.mjs` (3), `pin-data.mjs` (2), `verify-package.mjs` (9), `scripts/validate.js`, packaging and verification of the published asset. The share gateway has its own Go tests (22, with `-race`).

Title: Catalog mapviewer3d 0.4.2 (share links for players; reviewed and fixed)

## MapViewer3D 0.4.2 (this pull request now points to 0.4.2; it started as 0.4.0)

- **Release:** https://github.com/dev-prophet-code/MapViewer3D/releases/tag/addon-v0.4.2
- **Pinned package:** `https://github.com/dev-prophet-code/MapViewer3D/releases/download/addon-v0.4.2/mapviewer3d-0.4.2.zip`
- **SHA-256 (verified by downloading the published asset):** `81e2a42b07ea64675d8c6045faadabc9c3b2524f15d11480317309b61f644c9d`
- **Catalog change:** `addons/mapviewer3d.json` and `index.json`: `version`, `downloadUrl`, `sha256` and one sentence about share links in the description. **No change in permissions** (`files:addon-data`). Earlier releases (`v0.4.0`, `v0.4.1`) are left as they are.

### What 0.4.x adds
Share links for players without a console account (time-limited or open-ended, revocable, served by the optional share gateway `mvshare`, branch [`ddp`](https://github.com/dev-prophet-code/MapViewer3D/tree/ddp), `SHARE.md`), a Realtime Data status line, a layer list structured like the Console's Layers.

### Review history
1. **@yacketrj's review of 0.4.0** (thank you): five findings, all fixed in 0.4.1 with tests (pin tool, key label, key sent to a guessed address, realtime race, 64-bit tile ids -> data release `data-v2` with full digests, cache, error texts, package checks, retry, picking, dead code).
2. **A `/code-review high` pass over the whole change set before 0.4.2** (as @yacketrj suggested): 10 findings, all fixed in 0.4.2:

| Finding | Fix | Test |
|---|---|---|
| Any console key with `maps: Read` could manage share links (publish, delete everybody's, take over the gateway's key) | a key must also hold `Addons: Read` (read-only; marks an administrator); the refusal names the missing scope and the addon explains it | Go: `TestOnlyAdministratorsManageLinks`; a bot key can neither list, create nor revoke and never becomes the gateway's key |
| The cache served the last good body for a 5xx even for the Realtime health probe (agent stop = 503 never seen) | the rule applies to data feeds only (ttl > 0), probes see the failure | `tests/console-cache.mjs`, `tests/realtime.mjs` (health probe) |
| The remembered gateway address lives in storage every addon user can write, and the identification probe can be spoofed | the remembered address is shown and has to be confirmed before the key is sent to it; derived addresses (console origin, `:8798` of its host) need no question | `tests/share.mjs` (`gatewayCandidates`) |
| The package check was bypassed by `'https://x'; localStorage...` on one line (the `sed` comment stripping) | a real scanner (`scripts/strip-comments.mjs`) that knows strings, templates and regexes; the check fails if the scanner outputs nothing | `tests/verify-package.mjs` (URL-before-call, `//` in a template, scanner cases) |
| Behind a reverse proxy on the same host every visitor shared one rate limit / ban | the address in `X-Forwarded-For` is used when the peer is loopback (or `MV_SHARE_TRUST_PROXY`) | Go: `TestProxyClientAddress` |
| Every admin call re-probed the gateway's key (4 requests) | uses the 15 s cache | Go: `TestAdoptionDoesNotHammerTheConsole` |
| A refused key was shown as "agent not reachable" after the layers closed | the refused-key state stays until the key is replaced or accepted again, reason `scope` | `tests/realtime.mjs` |
| Double click on *Create link* created two links | in-flight guard, buttons disabled | (UI) |
| Visitors' polling fallback hit a 404 | sanitised `/api/realtime/objects` (players removed) | Go: `TestRealtimeSnapshotForVisitors` |
| Dead code, stale comment | removed | |

### Security notes for reviewers
Besides the console (as before) and `raw.githubusercontent.com` / `cdn.jsdelivr.net`, the addon page calls the **administrator's own share gateway**, only when the share dialog is used. The API key is sent there (`Authorization: Bearer`, `credentials: 'omit'`) only after the address identified itself as a share gateway **and** (for an address remembered in storage) after the administrator confirmed it. The addon never stores the key (`scripts/verify-package.sh`, `tests/key-storage.mjs`). A visitor's page has no key at all (`tests/share-visitor.mjs`).

### Tests
CI (branch run and tag run, gitleaks included) is green: `tests/share.mjs`, `share-visitor.mjs`, `ui-layers.mjs`, `realtime.mjs` (11), `key-storage.mjs` (10), `unit.mjs` (8), `console-cache.mjs` (4), `pin-data.mjs` (2), `verify-package.mjs` (12), `scripts/validate.js`, packaging and verification of the published asset. The share gateway has its own Go tests (25, with `-race`).

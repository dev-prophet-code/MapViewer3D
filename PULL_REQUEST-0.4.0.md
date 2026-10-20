Title: Catalog mapviewer3d 0.4.0 (share links for players, layer list like the Console's Layers)

## MapViewer3D 0.4.0

- **Release:** https://github.com/dev-prophet-code/MapViewer3D/releases/tag/addon-v0.4.0
- **Pinned package:** `https://github.com/dev-prophet-code/MapViewer3D/releases/download/addon-v0.4.0/mapviewer3d-0.4.0.zip`
- **SHA-256 (verified by downloading the published asset):** `d41accb26cef8541dbb6fc2ddca60525b3784d3b628c6647a254b824dda947b7`
- **Catalog change:** `addons/mapviewer3d.json` and `index.json`: `version`, `downloadUrl`, `sha256` and the description (one sentence about share links). `v0.3.1` is left as it is. **No change in permissions** (`files:addon-data`).

### What is new
1. **Share links.** The administrator presses *Share link …* in the addon, picks how long the link is valid (or creates one without expiry) and what it shows, and hands the link to players who have no console account. The addon cannot serve the public from inside the console, so the links are issued by a small, optional **share gateway** (`mvshare`, branch [`ddp`](https://github.com/dev-prophet-code/MapViewer3D/tree/ddp), `SHARE.md`) that runs next to the console. Without a gateway the addon behaves exactly like 0.3.x and the dialog just asks for the gateway's address.
2. **Realtime Data status:** the connection panel says whether the key gets Realtime Data and why not.
3. **Layer list** grouped like the Console's Layers, with counts per layer.

### What reviewers should look at (security)
- **New network use:** besides the console (as before) and `raw.githubusercontent.com` / `cdn.jsdelivr.net`, the addon page now calls the **administrator's own share gateway**, and only when the share dialog is used (address: the console's origin, `https://<console host>:8798`, `http://<console host>:8798` for a plain-http console, or what the admin types; `http` only for this machine or the console's own host when the console itself is plain http). `credentials: 'omit'`, no cookies.
- **The API key is sent to that gateway** (as `Authorization: Bearer`) to authorise link management; the gateway verifies it against the console and may keep it as its own read-only key. The addon itself still never stores the key (`scripts/verify-package.sh` and `tests/key-storage.mjs` check that `share.js` and `console.js` use no browser storage; only the gateway's public address is stored in `addon.storage`). A key can only create links that offer what it can read itself.
- **A visitor's page** (served by the gateway under `/s/<token>/`) has **no API key at all**: `tests/share-visitor.mjs` shows every call goes under the link path without an `Authorization` header and with `credentials: 'omit'`.
- **Links:** 256-bit random tokens, only the SHA-256 is stored, revocation deletes the link and cuts open streams within 5 s; the gateway uses one read-only console key of its own with a fixed allow list of 13 `GET` routes and rebuilds every answer from allowed fields (no account ids, no storage contents, no settings files). Details, threat model and the Go tests: [`SHARE.md`](https://github.com/dev-prophet-code/MapViewer3D/blob/ddp/SHARE.md), [`share/`](https://github.com/dev-prophet-code/MapViewer3D/tree/ddp/share).

### Tests (CI, branch run and tag run green; gitleaks included)
| Area | Test |
|---|---|
| Share dialog helpers (gateway address rules: https, plain http only for this machine or a plain-http console's own host; durations; token formats) | `tests/share.mjs` |
| A visitor's page sends no key and only calls its own link path; look-alike paths are not share links | `tests/share-visitor.mjs` (3 tests) |
| Every layer is grouped and translated (EN/DE) | `tests/ui-layers.mjs` |
| Realtime Data incl. the new "why not available" reasons | `tests/realtime.mjs` (9 tests) |
| API key never persisted | `tests/key-storage.mjs` (9 tests) |
| Data path (tiles, checksums, tamper checks) | `tests/unit.mjs` (7 tests) |
| Package checks (no browser storage in `console.js`, `store.js`, `share.js`; permission list exactly `files:addon-data`) | `scripts/package.sh`, `scripts/verify-package.sh` (also run against the published asset) |
| Share gateway (tokens, expiry, revocation, allow list, sanitising, brute force, CORS, realtime fan-out, key adoption) | 20 Go tests in `share/`, run with `-race` |

Tried on a real Dune Docker v1.4.50 test server: link page with live sandworms and NPCs from the position agent, no ids in the answers, revoking a link ended an open stream after 5 s and the link then answered 404.

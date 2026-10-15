<!-- Text for the update of the catalog pull request (Red-Blink/dune-docker-addons #41): 0.3.0 -> 0.3.1.
     Placeholders {{...}} are filled after the release exists (SHA-256 of the PUBLISHED asset). -->

## MapViewer3D 0.3.1 (answers the review of 0.3.0)

Thank you for verifying the published `v0.3.0` package and for the reproduction. You were right: the 65 s
watchdog aborted the stream with `ctrl.abort()`, and the retry logic treated every aborted signal as an
intentional close, so a watchdog timeout stopped reconnection for good while a layer was still attached.

- **Release:** https://github.com/dev-prophet-code/MapViewer3D/releases/tag/addon-v0.3.1
- **Pinned package:** `https://github.com/dev-prophet-code/MapViewer3D/releases/download/addon-v0.3.1/mapviewer3d-0.3.1.zip`
- **SHA-256 (verified by downloading the published asset):** `{{SHA256}}`
- **Catalog change:** `addons/mapviewer3d.json` and `index.json`: `version`, `downloadUrl`, `sha256`. `v0.3.0` is left as it is (new immutable release, as requested). No change in permissions.

### What changed
`web/js/realtime.js` only (plus the version in `addon.json` and `web/js/config.js`):

- The watchdog marks its own abort controller. A reconnect is skipped only when the abort was intentional
  (`close()`, i.e. the last layer went away) or the console refused the key (`denied`).
- The retry is also skipped when the stream that just ended is no longer the current one (a close, or a newer
  connection, took over), so a stale `finally` cannot schedule a second connection.

### Tests (`tests/realtime.mjs`, run in CI)
The watchdog is captured and fired by hand, exactly as the timer would; the 1 s reconnect backoff runs in real time.

| Your request | Test |
|---|---|
| A watchdog timeout reconnects while subscribers remain | `a watchdog timeout reconnects while a layer is attached`: 1 stream, watchdog, 2nd stream by itself, new snapshot delivered, key still available |
| Closing the last subscriber cancels pending retries | `closing the last layer cancels a pending reconnect`: no stream opened afterwards |
| Rejected or revoked keys do not trigger reconnection | existing `a revoked key ends the stream for good ...` plus `a key that is refused at the reconnect is not retried`: key revoked while the stream is open, watchdog fires, exactly one attempt which the console refuses, no further attempt |

Against the 0.3.0 code the first and the last of these fail; with the fix all 9 tests of `tests/realtime.mjs`,
`tests/key-storage.mjs`, `tests/unit.mjs`, `scripts/validate.js` and the package checks pass.

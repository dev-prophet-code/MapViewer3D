<!-- Text of the second pull request to Red-Blink/dune-awakening-selfhost-docker.
     Patch: 0002-encrypted-api-access.patch (applies after 0001-api-keys-realtime-data-scope.patch;
     base: upstream main da644b7 = v1.4.44). Before opening: rebase, re-run the tests below, fill in
     "Tested on a real host", then remove this comment. -->

## Encrypted API access: optional HTTPS front door for the Console API, fingerprint in the installer and in Settings

The Console speaks plain HTTP on 8088. Over the internet that means the admin password, API keys and every answer cross the
network in clear text, and anything that uses API keys has no way to be sure whom it talks to. This adds an **optional front door**: a small container that serves the Console
**API** over HTTPS with its own long-lived key and forwards to the unchanged Console. Clients pin the key's **fingerprint**.
Nothing changes for anybody who does not use it: the normal address keeps working.

- **Size:** 23 files, +1824 (a third of it tests and the front door's source)
- **Base:** `main` at `da644b7`; applies after the Realtime Data patch (separate PR), but does not depend on it

### What the admin sees

- **Installer:** below the first admin password it now prints the encrypted address and the **key fingerprint** and where to see
  it again. `DUNE_ENCRYPTED_API=0` skips it; a choice made later in Settings is kept when the installer runs again.
- **Settings → Encrypted API Access:** a short section with status, an on/off switch, the address and the **Key Fingerprint** with a Copy button. The explanation (what to compare, when the fingerprint changes) is in the docs, not on the page.
- **CLI:** `dune encrypted-api enable | disable | status | fingerprint`.

The fingerprint is `sha256/<base64url of the SHA-256 of the certificate's public key>`. It does not change by itself – not
after a restart, not when the certificate is re-issued. The admin **compares** it with the one a client shows before the
client pins it; that comparison is what excludes a man in the middle (a client that learned the fingerprint over the
connection it wants to protect could be handed an attacker's key).

### How it works (what to review)

```
tool ──HTTPS :8797, Authorization: Bearer dak_…──► dune-tls-front ──HTTP 127.0.0.1:8088──► Console (unchanged)
```

1. **`runtime/tls-front/`** – Go, standard library only (like `runtime/public-probe`). On first start it creates an ECDSA
   P-256 key and a self-signed certificate valid for 20 years in `runtime/generated/tls-front` (key mode 0600). The key is
   kept; the certificate is re-issued from the same key when the names change, so the pin is stable. TLS 1.2 minimum.
2. **API door by default.** Only `GET`/`HEAD` of `/api/*` and `/images/maps/*`; `Authorization: Bearer dak_…` is required
   (marker images and `/api/health` excepted); `/api/auth/`, `/api/settings/`, `/api/setup/` and `/api/discord/` are blocked even
   with a key; path tricks (`..`, `//`, `\`) and every other path are refused; only `Authorization`, `Accept`,
   `Accept-Encoding`, `Range` and the conditional headers are forwarded (no cookies, no `X-Forwarded-For`); `Set-Cookie` is
   dropped. **The Console web UI and its login are not exposed on this port**, so it adds no new way into the admin console.
   (`MV_TLS_FULL=true` forwards everything; not used by the installer.)
3. **Brute force.** The Console only sees `127.0.0.1` behind a proxy, so its per-address failure limiter would be one bucket
   for all clients – one attacker could drain it and lock everybody out. The front door therefore counts rejected keys per
   client address (10 per minute → blocked for 10 minutes) before anything reaches the Console.
4. **`docker-compose.tls-front.yml` + `runtime/scripts/tls-front.sh`**, modelled on the public probe: host networking (it
   reaches the Console on `127.0.0.1` and listens on `8797`), runs as the host user, read-only file system, `cap_drop: ALL`,
   `no-new-privileges`, 64 MB, 64 pids. The script builds when its sources change, persists the choice in
   `runtime/generated/tls-front.env` and prints the fingerprint (`docker exec … -pin`, or `openssl` on the certificate).
5. **Console.** `services/encryptedApi.js` reads `tls-front.env`, asks Docker for the container state and computes the
   fingerprint from the **certificate** with `node:crypto` – the private key is never read (a test asserts it). `GET`/`POST
   /api/settings/encrypted-api` are `settings:read`/`settings:write`, so no API key can reach them; the toggle is serialized and
   audited (`settings.encrypted-api-enable`/`-disable`).
6. **Installer.** `start_tls_front` runs after the Web UI starts and `show_finish` prints the address and fingerprint. POSIX
   `sh` (`dash -n`, `ash -n` as in CI).

### Decision for you

The installer starts the front door **by default** on a new install, so the fingerprint can be shown at the end of the setup.
It listens on 8797 but is only reachable if that port is opened in the firewall, and it passes nothing but API-key `GET`s.
If you prefer opt-in, flip `DUNE_ENCRYPTED_API` to default `0` in `start_tls_front` – everything else stays the same.

### Files

| File | Change |
|---|---|
| `runtime/tls-front/{main.go,main_test.go,go.mod,Dockerfile}` | new: the front door and its tests |
| `docker-compose.tls-front.yml`, `runtime/scripts/tls-front.sh` | new |
| `runtime/scripts/dune` | `dune encrypted-api …` |
| `install.sh` | `start_tls_front`, fingerprint in `show_finish` |
| `console/api/src/services/encryptedApi.js`, `server.js`, `actions.js` | new service, two routes, two IAM actions |
| `console/web/src/api/encryptedApi.ts`, `features/settings/EncryptedApiSection.tsx`, `SettingsPanel.tsx`, `styles.css` | the Settings section |
| `console/api/test/encryptedApi.test.js`, `fixtures/tls-front-cert.pem`, `tests/tls-front-script-test.sh`, `EncryptedApiSection.test.tsx` | tests |
| `.github/workflows/ci.yml` | script test, image build |
| `docs/console/encrypted-api.md`, `docs/README.md`, `README.md` | documentation, port table |

### Tested

Against upstream `da644b7` with both patches applied:

- `node --test test/encryptedApi.test.js` 12/12 – the fingerprint of a certificate produced by the front door equals the value
  `openssl` computes; defaults for a broken env file; no secret in the status; the private key is never read; only a real
  boolean switches it; a second change while one builds is refused and a failure frees the lock; the routes' actions.
- RBAC/scope/policy/realtime suites 74/74 (route parity covers the two new routes).
- `bash tests/tls-front-script-test.sh` – enable/disable/reconcile/fingerprint with a docker mock, private env file, invalid
  port refused, unknown command refused.
- Go tests of the front door (pin stability, API door, SSE flush, brute-force block, allow list, config errors), also run in the
  image build and in CI.
- `dash -n install.sh`; `npx vitest run` (console/web) 105 files, 1263 tests; `tsc -b`, `vite build`.
- The same 25 environment-dependent API tests fail with and without the patches (live database / Linux shell).

### Tested on a real host

Test server, Dune Docker v1.4.44 with both patches applied, `dune console restart`:

- `dune encrypted-api enable`: image built (vet and tests run in the build), container `healthy`, port 8797 listening.
- The fingerprint printed by `dune encrypted-api fingerprint` equals the one the Console's `encryptedApi` service computes from the
  certificate **and** the one seen from outside by `openssl s_client`.
- From another machine: `GET /mvtls` answers without a login; `/`, `/index.html`, `/api/auth/state`, `/api/settings/api-keys` give
  `404`; `/api/map/status` without a key or with a wrong key gives `401`; plain HTTP on the port gets `400`.
- A client with a wrong pin is refused, with the right pin the TLS connection works and only the wrong token is rejected by the
  Console through the front door.
- Restart of the Console and of the front door keeps the key, so the fingerprint is unchanged.
- Not yet checked on the host: the installer's final screen (shown only on a fresh install; covered by the shell test with a
  docker mock), the Settings page rendered in a browser (covered by component tests), an API key with real map data through 8797.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

<!-- Text of the pull request to Red-Blink/dune-docker-addons. Update it with every addon release:
     version, release link, both SHA-256 values, "What changed" and "Tested". -->

**Updated to version 0.1.7 (third review by @Red-Blink addressed: LF line endings; viewer Beta.8).** Thanks for the review. 0.1.6 was built on Windows and its `docker/install.sh` and `docker/entrypoint.sh` (in fact every text file) had CRLF line endings, which fail Linux shell checks. 0.1.7 replaces it; the `0.1.6` release stays untouched but is superseded. Earlier: 0.1.6 (upgrade protection, second review), 0.1.5 (viewer Beta.7: password for network operation, private by default), 0.1.4 (viewer Beta.6: Deep Desert follows the weekly Coriolis layout), 0.1.2 was updated after DarkDante's security analysis, thanks to him for that.

## MapViewer3D 0.1.7 (new addon)

Live 3D map of Hagga Basin and Deep Desert: players, bases (as 3D buildings), vehicles, hazards, resources, and the Deep Desert as the server's current Coriolis layout (terrain tiles plus the layout's rocks, ecolabs and wrecks).

- **Source:** https://github.com/dev-prophet-code/MapViewer3D (branch `DD-Addon`, MIT)
- **Release:** https://github.com/dev-prophet-code/MapViewer3D/releases/tag/addon-v0.1.7
- **Pinned package:** `https://github.com/dev-prophet-code/MapViewer3D/releases/download/addon-v0.1.7/mapviewer3d-0.1.7.zip`
- **SHA-256 (verified by downloading the published asset):** `a9d84d02849c13d8cf1639ef061fd3e25f32e7e6198c49b2956bb341aa10e49d`
- The installer pins the viewer release `beta.8` (`MapViewer3D-Beta.8.zip`, SHA-256 `1f9623ca3b192876c80efb7b0415908346eb30029a190242dbe578ae05873bf7`) and verifies it before unpacking.

### What changed since 0.1.6 (review point: CRLF in the published package)
The package content is identical to 0.1.6 except for the line endings and the version number. Fixes:

1. **LF everywhere:** the package is built on Linux/macOS with `scripts/package.sh`, which refuses to build when any shipped file contains a CR. `.gitattributes` forces LF (`* text=auto eol=lf`) so a Windows checkout cannot bring CRLF back.
2. **Checks against the packaged ZIP, not the checkout** (`scripts/verify-package.sh`): it unpacks the ZIP and checks the extracted files: no CR byte in any text file, `sh -n` on `docker/install.sh` and `docker/entrypoint.sh`, `node --check web/addon.js`, file name matches `addon.json`. It also accepts a URL, so the released asset on GitHub is checked the same way after publishing.
3. **Upgrade regression against the extracted package:** `WITH_UPGRADE_TEST=1 bash scripts/verify-package.sh <zip>` runs `scripts/test-upgrade.sh` with the installer and entrypoint taken from the unpacked ZIP (Beta.6 -> pinned Beta.8, 401 without login, 200 with, fail-closed case). The CI runs both on the ZIP it builds and on the published release asset.

Verified locally on the final ZIP (Linux amd64 container): no CR in 9 text files, `sh -n` ok, upgrade regression passed (401 / 200 / wrong password 401 / API 401 / Beta.8 / config and extra terrain kept / lying install fails closed). The same check applied to the published 0.1.6 ZIP fails with "CRLF line endings in addon.json", so it does catch the reported problem.

### Earlier: 0.1.6 (review point: upgrade security)
The reported problem: the installer reused existing viewer files without checking their version. A viewer older than Beta.7 ignores the password setting, so an upgrade could look password-protected while the viewer stayed open.

1. **Existing viewer files are validated against the pinned release.** The installer records the release it unpacked in `app/.mapviewer3d-release` (version + SHA-256). Files that do not match exactly (older viewer, no record, half-finished install) are replaced by the pinned `beta.8` package, after the running container was stopped. **The user's configuration is preserved:** `config.json` (API key, console address, viewer password) is not touched, and extra terrain folders under `app/data/` are kept.
2. **The running viewer is verified before success is reported** (network address with password): without login it must answer `401`, with the password `200`. Otherwise the container is stopped again and the installer fails.
3. **Defence in depth in `entrypoint.sh`:** on a non-loopback address it refuses to start without `viewerPassword` in `config.json` (unless `MV_ALLOW_OPEN=1`) and refuses a viewer older than Beta.7.
4. **Upgrade regression test** (`scripts/test-upgrade.sh`, run by the addon CI on a Linux runner, not only fresh installs). It uses the real viewers: it first shows that Beta.6 serves without login although a password is configured, then runs the installer over that Beta.6 install with a network address and asserts: unauthenticated request -> **401**, authenticated request -> **200**, wrong password -> 401, API without login -> 401, program is Beta.8, `config.json` (key, address, password) and extra terrain kept. A second case (release record says Beta.8 but the program is Beta.6) must make the installer fail with nothing reachable on the network address.

Also changed: viewer **Beta.8** removes the extra Deep Desert map grid (the console map image already shows it). Permissions are still none (`"permissions": {}`).

### Requires a Console API key
MapViewer3D cannot work without one (the Console returns 401 for `/api/map/*` without a key). An admin creates it under *Settings -> API Keys* with **`maps: Read`** and **`bases: Read`**, all other scopes None. This is documented in the addon README, the addon page and the installer prompt; the installer validates the key and both scopes before starting anything. The package contains **no credentials**.

### Permissions
None (`"permissions": {}`). The addon page only embeds the viewer in an iframe. The template validator (`scripts/validate.js` from `dune-docker-addon-template`) accepts the manifest.

### How it works / what to review
The viewer is a Go program with terrain data (release ZIP ~240 MB), so it cannot live inside the addon zip. The zip contains the addon page plus `docker/install.sh`, `docker/README.md` and a Compose file for a **companion container** (host network, non-root, read-only filesystem, all capabilities dropped, `no-new-privileges`).

- The installer auto-detects the stack folder and the console (`ADMIN_BIND_HOST`, `ADMIN_BIND_PORT`, `ADMIN_WEB_PORT`; `API_BASE` overrides), checks the key and both scopes, downloads the pinned viewer release and **verifies its SHA-256** before unpacking.
- The viewer is **private by default** (`127.0.0.1:8795`). Network access is an explicit opt-in (`MV_ADDR=0.0.0.0:8795`) with a generated viewer password (HTTP login, shown once).
- The API key (and the viewer password, if any) is stored owner-only in `runtime/mapviewer3d/config.json` and never sent to the browser; the key never appears in a command line.
- Read-only: the addon and viewer never write to the game or database.

### Known limitations (please read)
- **Private default:** the iframe only works in a browser on the server itself; other admins need the opt-in above (or a reverse proxy).
- **Deep Desert layouts:** the package ships the terrain for the current layout (8) plus a generic fallback. The container has no access to the game files, so it cannot build the terrain for a *new* layout by itself after a Coriolis storm; the panel then warns and shows the fallback until the addon is updated. A viewer with the game files (`-paks`, build tag `paks`) follows every storm automatically. If you would rather have the addon ship several layouts or mount the Paks folder, tell me and I will add it.
- **Tested:** the upgrade test above passes in CI (Linux, real Beta.6 and Beta.8 viewers, mock console). Viewer unit tests pass. Earlier live tests on a real Dune Docker stack (console detection, both scope checks, private start, network start with password -> 401 without login, re-run reusing the stored key) were done for 0.1.5; the installer logic they cover is unchanged apart from the changes listed here. Not re-run live on a real stack for 0.1.7: the map in a browser with a real key.
- If the console is served over https, browsers block the plain-http viewer in the iframe; the page offers "Open in new tab" and documents the reverse-proxy option.

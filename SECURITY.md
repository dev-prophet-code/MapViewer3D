# Security Policy

Applies to the current release, Dune MapViewer3D Beta.16.

## Reporting a vulnerability

Please **do not** open a public issue for security problems. Use GitHub's
[private vulnerability reporting](https://github.com/dev-prophet-code/MapViewer3D/security/advisories/new)
instead. Include steps to reproduce and the affected version.

## Scope

The viewer stores a server address and an API token encrypted on disk
(see [Description-EN.md](Description-EN.md)). Reports about credential handling,
the local HTTP server, CSRF protection or path traversal are especially welcome.

## Position agent (optional, Beta.9)

`mvagent` reads the memory of the game server processes (`/proc/<pid>/mem`) and therefore
runs as root on the game host. It is read-only (no ptrace, no writes, no injection), listens
on loopback only and never outputs or forwards the process command line (it contains the game
server's auth token). Players are not output unless `-players` is given; the viewer server forwards a
live player only when it can match it to an online player the console already shows
(same partition, nearest distance), so no new names or players appear; in public mode only PvE partitions leave the server. Run it only on
servers you operate. Details: [docs/Agent-EN.md](docs/Agent-EN.md).

## Realtime Data and server list (Beta.16)

- Realtime Data (live worms, NPCs, vehicles, storms) comes only through the Dune Docker Console's `/api/realtime/*`, authorized by the API key's *Realtime Data* scope (players additionally need *Players: Read*). The viewer sends the key there only over **HTTPS** or to a Console on the same machine; redirects are not followed for the check.
- Console certificates are verified by the system trust store, or – for self-signed / internal certificates – by a **pinned fingerprint** (SHA-256 of the public key; per server, or `-api-pin` for all). Without a pin an untrusted certificate is refused and its fingerprint shown for comparison; a mismatch is reported as a possible attack. This applies to every Console connection, not only Realtime Data.
- **Encrypted front door detection.** For a Console on plain HTTP (not on this machine) the viewer asks port 8797 of the same host for an `mvtls` (TLS handshake only to read the public key, and `GET /mvtls`) – **no token or secret is sent**. A positive answer is only an *offer*: the viewer shows the key's fingerprint and switches after the human has compared it with `mvtls -pin` on the server; that comparison is what excludes a man in the middle, so it is never automatic (except when the fingerprint is already known from `-api-pin`). After the switch the token is sent only through the pinned connection. A viewer with a fixed configuration never switches by itself.
- A 401/403 on the open stream (key disabled, expired, revoked or scope removed) ends it.
- **Switch server** keeps each connected server as its own encrypted file in `servers/` (same master key and protection as `credentials.enc`); the list endpoint never returns tokens, and switching or removing is limited to the local administrator (same checks as setup).

## Updater (Beta.13)

The viewer (and, only with its own `-auto-update`, the position agent) can fetch new releases from GitHub: anonymous `GET` to `api.github.com`/`github.com`, download of `MapViewer3D-update-Beta.N.zip`, SHA-256 check against the release's `.sha256` file, path-escape and link checks while unpacking, a self-test of the new program (`-version`) before the swap, and a backup of the old files for rollback. Download URLs must belong to this repository's release downloads. The installation endpoint is limited to the local administrator (loopback browser, CSRF header; never with `-public`). There is no extra code signature: an update is only as trustworthy as the GitHub repository and its release. Turn it off with `-no-update-check` / `MV_NO_UPDATE=1`. The agent runs as root, so its updater is off unless you pass `-auto-update`.

## Map data from GitHub (Beta.14)

The viewer streams terrain tiles and building models from the `cdn` branch (`raw.githubusercontent.com`, mirror `cdn.jsdelivr.net`). Every tile is checked against its content hash (its file name) and the map index against the SHA-256 in `catalog.json`; the building models against the checksums in the catalog. The catalog itself is not signed and not pinned: its trust is the trust in the GitHub repository (as for updates). Fetched files only ever feed the renderer (heights, materials, meshes); they are never executed. The server that keeps the branch up to date (`deploy/cdn-sync/`) holds a repository deploy key with write access – keep that host secure. `-cdn off` disables streaming.

## Tip for users

Give the API token **read access to map data only** and never share the
`MapViewer3D` folder in your user config directory.

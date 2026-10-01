# Security Policy

Applies to the current release, Dune MapViewer3D Beta.12.

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

## Tip for users

Give the API token **read access to map data only** and never share the
`MapViewer3D` folder in your user config directory.

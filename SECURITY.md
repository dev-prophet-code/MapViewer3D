# Security Policy

Applies to the current release, Dune MapViewer3D Beta.8.

## Reporting a vulnerability

Please **do not** open a public issue for security problems. Use GitHub's
[private vulnerability reporting](https://github.com/dev-prophet-code/MapViewer3D/security/advisories/new)
instead. Include steps to reproduce and the affected version.

## Scope

The viewer stores a server address and an API token encrypted on disk
(see [Description-EN.md](Description-EN.md)). Reports about credential handling,
the local HTTP server, CSRF protection or path traversal are especially welcome.

## Tip for users

Give the API token **read access to map data only** and never share the
`MapViewer3D` folder in your user config directory.

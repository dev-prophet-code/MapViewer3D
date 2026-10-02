# Contributing

Thanks for helping out! 

## Ground rules

- Never commit credentials, tokens, `state/`, `master.key` or map caches. Check release packages for them before publishing.
- Binaries (`bin/`) are not tracked in git; they ship with releases. Map data is not in the repository or the packages either: it is streamed from the `cdn` branch, which `deploy/cdn-sync/` keeps up to date. Every release needs the update package (`./build-release.sh --update`, see README → Updates).
- Every user-visible change gets an entry in **both** `CHANGELOG - EN.md` and `CHANGELOG - DE.md` (current version, newest on top). Discarded changes stay in the file, struck through.
- New UI strings go into `viewer/js/i18n.js` (English and German).
- Keep the version in `backend/server/server.go` (`Version`) in sync with the changelog.

## Development

```bash
cd backend && go vet ./... && go test ./...
# MV_SECURE_PORT=<port> lets the viewer look for the encrypted front door on this machine (tests/development)
./start.sh --build     # build and run locally
```

## Pull requests

1. Fork and create a topic branch.
2. Keep changes focused; describe *what* and *why*.
3. Make sure CI passes.

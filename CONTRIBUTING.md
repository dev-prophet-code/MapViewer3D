# Contributing

Thanks for helping out! 

## Ground rules

- Never commit credentials, tokens, `state/`, `master.key` or map caches. Check release packages for them before publishing.
- Terrain data (`data/`) and binaries (`bin/`) are not tracked in git; they ship with releases.
- Every user-visible change gets an entry in **both** `CHANGELOG - EN.md` and `CHANGELOG - DE.md` (current version, newest on top). Discarded changes stay in the file, struck through.
- New UI strings go into `viewer/js/i18n.js` (English and German).
- Keep the version in `backend/server/server.go` (`Version`) in sync with the changelog.

## Development

```bash
cd backend && go vet ./... && go test ./...
./start.sh --build     # build and run locally
```

## Pull requests

1. Fork and create a topic branch.
2. Keep changes focused; describe *what* and *why*.
3. Make sure CI passes.

# Keeping the `cdn` branch up to date (`deploy/cdn-sync`)

The viewer streams terrain tiles and building models from the **`cdn` branch** of this repository (see [README](../README.md)).
That branch is generated from the game files, so it must follow the game: after a game update, and for every new Coriolis layout of the Deep Desert.
A server that has the game files does this by itself.

## What is in the branch

| Path | Content |
|---|---|
| `catalog.json` | all maps (name, size, calibration) with the SHA-256 of every map index; checksums of the building models |
| `m/<map>.json` | tile index of one map (which tile sits at which level / column / row) |
| `p/<xx>/<id>.z` | terrain tiles, gzip. `<id>` = first 16 hex digits of the SHA-256 of the content, so identical tiles are stored once across all maps and layouts |
| `buildables/` | building models |

Tiles are **never deleted**: the older data tag `data-v1` (used by the Dune console addon) and older viewers keep working. A new game build only adds
the tiles that really changed.

## How the sync works

`cdn-sync.sh` runs on the game host as root (systemd timer, every 30 minutes, low priority):

1. **Viewer data**: the maps of the running viewer (`DATA_LIVE`, e.g. self-built Coriolis layouts) are cut into tiles (`cmd/cdnsync`).
2. **Game build changed?** The signature of the `.pak/.ucas/.utoc` files in the running game server (`/proc/<pid>/root/home/dune/server/DuneSandbox/Content/Paks`)
   is compared with the last one. If it differs, `extract` (`cmd/extract`, built with `-tags paks`) rebuilds Hagga Basin, the Deep Desert **with all Coriolis layouts** and
   the building catalog from the game files (about 20–30 minutes), then they are packed like in step 1.
3. New files are committed and pushed in packages of at most 12 MB; `catalog.json` always comes last, so it never points to anything missing.
   Without changes there is no commit.

Because every viewer reads the branch head, a new layout is available to everyone shortly after the server has it, and the viewers need no `-paks` build of their own.

## Setup (on the game host)

```bash
# 1. Programs (Go ≥ 1.26 and a C++ compiler; build from the repository or the update package's backend/ folder)
cd backend
sudo mkdir -p /opt/mapviewer-cdn
sudo go build -trimpath -o /opt/mapviewer-cdn/cdnsync ./cmd/cdnsync
sudo CGO_ENABLED=1 go build -tags paks -trimpath -o /opt/mapviewer-cdn/extract ./cmd/extract
sudo install -m755 ../deploy/cdn-sync/cdn-sync.sh /opt/mapviewer-cdn/

# 2. Deploy key (the sync pushes with it; create it in GitHub: repository → Settings → Deploy keys → "Allow write access")
sudo ssh-keygen -t ed25519 -N "" -f /opt/mapviewer-cdn/deploy_key
sudo cat /opt/mapviewer-cdn/deploy_key.pub        # paste this into the deploy key

# 3. Settings and timer
sudo cp ../deploy/cdn-sync/cdn-sync.env.example /etc/mapviewer-cdn.env     # adjust DATA_LIVE etc.
sudo cp ../deploy/cdn-sync/mapviewer-cdn-sync.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now mapviewer-cdn-sync.timer

# Try it without pushing:           sudo DRY_RUN=1 /opt/mapviewer-cdn/cdn-sync.sh
# Force a re-extraction:            sudo touch /var/lib/mapviewer-cdn/force
# Follow it:                        journalctl -u mapviewer-cdn-sync -f
```

**Security.** The deploy key can write to the whole repository (GitHub offers no per-branch deploy keys): keep the host secure. The key lives only in
`/opt/mapviewer-cdn/deploy_key` (mode 600). A viewer that streams from the branch verifies every file against the catalog, but the catalog itself is
only as trustworthy as the repository (see [SECURITY.md](../SECURITY.md)). The branch grows with new tiles only (identical tiles are shared), a new Coriolis
layout adds a few MB.

Run it only on servers you operate. The extraction reads the game files, nothing is changed in the game.

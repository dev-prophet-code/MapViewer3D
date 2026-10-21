# Share links for the 3D map

[Deutsch](#deutsch) · [README](README.md) · [Security](SECURITY.md)

The MapViewer3D addon of the Dune Docker Console can create **links to the 3D map** that you hand to your players. They open the map in a browser, with no account and no API key. Links are issued and checked by the small **share gateway** `mvshare` of this stack.

```
 player's browser ── https://share.example.org/s/<token>/ ──►  HTTPS reverse proxy (or mvshare with a certificate)
                                                                       │
 admin, in the Console ──► addon "Share link …" ──────────────────────►│ /share-admin/…  (the admin's API key)
                                                                       ▼
                                                     mvshare  127.0.0.1:8798
                                                        │  holds ONE read-only API key (a file on the host)
                                                        ▼
                                             Dune Docker Console 127.0.0.1:8088   (unchanged)
```

## What a link is

- **A random token** of 256 bits (`mvs_…`, 43 characters). There is nothing to guess and nothing to forge: it either is one of the values the gateway issued or it is not. The gateway stores only the **SHA-256 of each token**, so a copy of its data volume cannot be turned into working links. A token is shown **once**, when it is created.
- **Time-limited or open-ended.** The admin picks 1 hour, 6 hours, 1 day, 7 days, 30 days, any own duration (1 minute to 5 years), or presses **Create link without expiry**. Expiry and revocation are checked on every request, and **streams that are already open are cut within 5 seconds**.
- **Chosen content per link:** map and live markers always; **Realtime Data**, **bases as 3D buildings** and **player positions and names** are separate switches (players are off by default).
- **Revocable** at any time from the addon; ended links stay visible for a week.

## Why it cannot be used to get into Dune Docker

| Risk | What prevents it |
|---|---|
| A visitor gets an API key | The key is a file on the host, read by the gateway only. It never appears in a page, a header or a log, and visitors send no credentials of their own (a visitor's own `Authorization` header and cookies are dropped). |
| A visitor reaches other Console routes | The gateway has an **allow list of 13 read-only `GET` routes** with validated query values (map name, partition id, one of two setting scopes). Everything else under a link is 404; the Console's auth, settings, setup, write and admin routes and its web UI are not forwarded at all. Only `GET` and `HEAD` are accepted. |
| The Console's answers contain private data | Every answer is **rebuilt from an allow list of fields**: no account, FLS or Funcom ids, no storage contents, no server settings files (the settings route returns two lines), no process ids. Player rows and owner names appear only if the link allows players. A field added to the Console later stays private by default. |
| Guessing tokens / the admin secret | 256-bit tokens; failed tokens and secrets are counted per client address (15 per minute → blocked for 10 minutes) and requests are rate limited. Unknown, expired and revoked links all answer the same `404`. |
| Taking over link management | The admin API accepts only a **Console API key that the Console itself accepts** (checked live; wrong keys are counted and blocked per address) or the gateway's own admin secret (`mva_…`, for scripts), and answers browsers only for the origins in `MV_SHARE_ADMIN_ORIGINS`. A key can only create links that offer what it can read itself. A link token is never an admin credential. |
| Load on the server | Answers are cached for a few seconds and shared between visitors, and all visitors of Realtime Data share **one** upstream stream (the Console allows few per key). Hard limits on concurrent requests and viewers. |
| Page injection | The viewer page is served with a strict Content Security Policy (scripts only from the gateway, the single inline import map by hash, connections only to the gateway and the two terrain-data hosts), `Referrer-Policy: no-referrer`, no framing. |
| A compromised gateway | It can read what its key can read, nothing more: give that key **only** `maps: Read`, `bases: Read`, `Realtime Data: Read` (and `players: Read` only if you ever want to offer players). Never a write scope. Revoke the key in the Console to cut the gateway off. |

## Set up

1. **Start the gateway** (on the Dune Docker host):

   ```bash
   cp .env.example .env              # set MV_SHARE_ADMIN_ORIGINS=https://console.example.org
   share/fetch-web.sh                # viewer files of the addon release, SHA-256 verified
   docker compose -f docker-compose.mapviewer-live.yml --profile share up -d --build mvshare
   ```

2. **Put HTTPS in front.** The gateway listens on `127.0.0.1:8798` and **refuses to start on a public address without a certificate**. Either forward `/s/` and `/share-admin/` from your reverse proxy, e.g. Caddy:

   ```
   share.example.org {
       reverse_proxy /s/* 127.0.0.1:8798
       reverse_proxy /share-admin/* 127.0.0.1:8798
   }
   ```

   (set `MV_SHARE_TRUST_PROXY=true` so the per-address limits see the real visitor), or give the gateway its own certificate (`MV_SHARE_CERT` / `MV_SHARE_CERT_KEY`, files in `./certs`) and a public `MV_SHARE_ADDR`. Browsers need a certificate they trust, so a self-signed one is only good for your own tests.
3. **In the Console:** open the MapViewer3D addon (0.4.0 or newer), enter your API key as usual and press **Share link …**. The addon looks for the gateway at the Console's own address (if your proxy serves both) or at the address you enter once (remembered). Then only choose how long the link is valid (or **Create link without expiry**) and what it shows, and copy the link. Before it sends your key to an address it only guessed (the console's own address or port 8798 of its host), the addon asks that address who it is **without any credential** (`GET /mvshare`, public, nothing secret) and only a share gateway earns the key. **There is nothing else to set up:** the gateway checks your API key against the Console and, if it has no key of its own yet (or its key was rotated or revoked), **takes over your key as its read-only key**. A working key is never replaced.

The key you use should be read-only anyway (`maps: Read`, `bases: Read`, `Realtime Data: Read`, everything else **None**; `players: Read` only if you want links that can show players). The gateway stores it as a file (mode 0600) in its volume; revoke the key in the Console to cut the gateway off.

The addon's status panel shows what the gateway's key can serve (maps, bases, players, Realtime Data); an option the key cannot serve is switched off in the dialog.

**Console with `ADMIN_ALLOWED_IPS`:** the gateway talks to the Console from the host itself (`127.0.0.1`); if you restrict Console access by IP, that address must be allowed.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `MV_SHARE_ADDR` | `127.0.0.1:8798` | listen address |
| `MV_SHARE_UPSTREAM` | `http://127.0.0.1:8088` | the Console (plain `http` only for loopback, otherwise `https`) |
| `MV_SHARE_ADMIN_ORIGINS` | – | origin(s) of the Console page that runs the addon (browser access to the admin API) |
| `MV_SHARE_TRUST_PROXY` | `false` | use the last `X-Forwarded-For` entry as client address (only behind a proxy that sets it) |
| `MV_SHARE_CERT`, `MV_SHARE_CERT_KEY` | – | own TLS certificate and key (paths in the container) |
| `MV_SHARE_ALLOW_PLAIN` | `false` | allow plain HTTP on a non-loopback address (you know why) |
| `MV_SHARE_WEB` | `./share-web` | host folder with the viewer files (`share/fetch-web.sh`) |

Back up the volume `mvshare-data` (links as hashes, the gateway's key, admin secret for scripts: `mvshare -admin-key`).

## Limits

- Visitors see the map as it is at the moment; there is no history.
- A link's options are fixed when it is created. Create another link for other content.
- Terrain and building models load from `raw.githubusercontent.com` / `cdn.jsdelivr.net` (hash-verified), like in the addon itself; visitors' browsers contact those hosts, not your server, for them.

---

## Deutsch

Das MapViewer3D-Addon der Dune-Docker-Console kann **Links zur 3D-Karte** erzeugen, die du an deine Spieler weitergibst. Sie öffnen die Karte im Browser, ohne Konto und ohne API-Schlüssel. Ausgestellt und geprüft werden die Links vom kleinen **Share-Gateway** `mvshare` dieses Stacks.

**Der Link:** ein zufälliges 256-Bit-Token (`mvs_…`), nicht erratbar und nicht fälschbar; das Gateway speichert nur den **SHA-256** jedes Tokens, das Token selbst wird **einmal** beim Erstellen angezeigt. Der Admin wählt eine **Gültigkeit** (1 Stunde, 6 Stunden, 1 Tag, 7 Tage, 30 Tage, eigene Dauer) oder erstellt per Knopfdruck einen Link **ohne Ablauf**; Ablauf und Widerruf wirken sofort, auch auf geöffnete Streams (innerhalb von 5 Sekunden). Pro Link wählbar: Echtzeitdaten, Basen als 3D-Gebäude, Spielerpositionen und -namen (standardmäßig aus).

**Warum man darüber nicht in Dune Docker kommt:** Besucher bekommen nie einen API-Schlüssel; das Gateway hält **einen** nur lesenden Schlüssel als Datei auf dem Host und nutzt ihn selbst für eine **Positivliste von 13 GET-Routen** (alles andere: 404; Login, Einstellungen, Setup, Schreib- und Admin-Routen und die Web-Oberfläche der Console werden nicht weitergereicht). Jede Antwort wird aus einer **Positivliste von Feldern neu aufgebaut** (keine Konto-/Funcom-IDs, keine Lagerinhalte, keine Server-Einstellungsdateien). Falsche Tokens und Admin-Geheimnisse werden je Adresse gezählt und gesperrt; die Verwaltung erlaubt nur einen **API-Schlüssel, den die Console selbst akzeptiert** (und ein Schlüssel kann nur anbieten, was er selbst lesen darf).

**Einrichten:** (1) `share/fetch-web.sh`, dann `docker compose -f docker-compose.mapviewer-live.yml --profile share up -d --build mvshare`. (2) HTTPS davorsetzen (Reverse-Proxy auf `/s/` und `/share-admin/`, oder eigenes Zertifikat); das Gateway startet auf einer öffentlichen Adresse ohne Zertifikat nicht. (3) Im Addon **Link teilen …** klicken, Gebiet auswählen (die Gateway-Adresse wird nur beim ersten Mal abgefragt), Dauer und Inhalt wählen, Link kopieren. Mehr ist nicht einzurichten: Das Gateway prüft deinen API-Schlüssel bei der Console und übernimmt ihn beim ersten Mal selbst als seinen Lese-Schlüssel (ein funktionierender Schlüssel wird nie ersetzt).

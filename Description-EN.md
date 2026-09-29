# Dune MapViewer3D – What the Viewer Does and How It Protects Your Credentials

## What is MapViewer3D?

MapViewer3D is a 3D map viewer for a self-hosted Dune: Awakening server running
Red-Blink's Docker stack (*dune-awakening-selfhost-docker*). It runs on Windows, Linux
and macOS without installing anything, locally or on a server, and you use it in the
browser.

## What the viewer shows

**Maps**
- **Hagga Basin:** 8 × 8 km, 1 m grid.
- **Deep Desert:** 22.5 × 22.5 km, 3 m grid.
- **Server instances:** Each instance of a map can be selected on its own, e.g.
  *Hagga Basin – PvE*, *PvP*, *Creative Mode* or *Deep Desert – PvE*, *PvP*.
- **Terrain:** Dunes, rocks, canyons and structures in 3D. The colour comes from your
  server's map image, with detail such as sand ripples and rock strata added up close.

**Live data from your server**

| Area | Shown as |
|---|---|
| Players | figure with name, smoothly animated; list of online players to fly to |
| Bases | icon with name and owner; within view and up close as 3D buildings made from the actual building pieces |
| Vehicles | ornithopters, buggies, sandbikes, crawlers … with owner |
| Locations | caves, ecolabs, wrecks, sietches, trading posts, fortresses, NPCs |
| Hazards | enemy camps, quicksand, drumsand, radiation zones |
| Resources | spice fields, ores (coloured by type), scrap, plants, flour sand, storage |

- From afar the map shows the icons of the 2D live map, up close 3D models. The
  toggles in the panel carry the same icons.
- Every area can be toggled on and off. By default only *online players*, *bases*,
  *bases in 3D* and *names* are on.
- Clicking an object shows details and offers *Fly there*.
- Players refresh every 5 seconds, bases and vehicles every 20 seconds, locations
  and resources every few minutes.

**Controls:** mouse (pan, rotate, zoom), plus W/A/S/D/Q/E to fly, with Shift for
more speed.

**Language:** The UI is in English by default. The selector at the top right of the
panel switches to German (*Deutsch*); the choice is remembered in the browser.

## What the viewer does *not* do

- **Read-only:** It **changes nothing** in the game or on the server; it only reads
  data.
- **No original textures:** The game's server build contains no image data. Models
  of vehicles, figures and locations are rebuilt; buildings are built from the
  collision shapes of the building pieces.
- **2.5D terrain:** Overhangs and caves are not shown as hollow spaces.
- **Deep Desert:** The server picks a Coriolis layout each week. The viewer
  builds the terrain from that layout's tile plan (craters, ramps, sites) plus the
  fixed rock formations; content blocks such as rocks and buildings of the layout are
  not shown yet, and only the layout the terrain was built for matches the server.
- **Slight delay:** Positions come from the server's database and can lag by a few
  seconds to minutes.

## How the viewer gets its data

```
Browser  ⇄  local viewer server (127.0.0.1)  ⇄  your server's console (API)
```

- On first start you enter the console's **server address**, **port** and **API
  token**.
- The viewer checks the connection right away. A wrong token is rejected and not
  stored.
- All requests to your server go through the local viewer server. **The browser
  never sees the token.**
- Terrain and building geometry ship pre-built. Everything that depends on your
  server comes live from it:
  - active maps and instances,
  - map images,
  - players, bases and all other live data.

## Security of your credentials

### What is stored

Only two things: the **server address** and the **API token**. Both are stored on
disk encrypted only, in the file `credentials.enc` in your user folder, **never in
the project folder**. **Nothing in it is
plaintext**, not even the address.

### How it is encrypted

| Layer | Method | Purpose |
|---|---|---|
| Master key | 256 bits from the operating system's random generator | basis of all keys |
| Key derivation | HKDF-SHA512 with a 256-bit random salt, bound to the computer name and user account | a separate key per layer; data is readable only on this computer and for this user |
| Inner encryption | AES-256-GCM | confidential and tamper-proof |
| Outer encryption | XChaCha20-Poly1305 (different algorithm, different key) | a second, independent layer |
| Integrity | HMAC-SHA512 over the whole record | any change to the file is detected |
| Fingerprint | PBKDF2-SHA512, 210,000 rounds, own salt | shows which token is stored without revealing it |

Salt and nonces are regenerated at random on every save, so the same data never
produces the same file twice.

### Where things are stored

| File | Location | Permissions |
|---|---|---|
| Master key `master.key` | user config folder, e.g. macOS `~/Library/Application Support/MapViewer3D/`, Linux `~/.config/MapViewer3D/`, Windows `%AppData%\MapViewer3D\` | readable by you only (0600) |
| Encrypted credentials `credentials.enc`, instance names, caches | subfolder `state/` in the same user config folder | readable by you only (0600) |

The **project folder never contains credentials**. It always stays in its
as-shipped state and can be shared safely; whoever receives it has to enter server
and token themselves. Copying the files from the user folder to another computer
fails because of the computer binding.

### Protection while running

- **Local only:** The viewer server listens only on `127.0.0.1` and cannot be
  reached from other devices on the network.
- **Sent once:** The token travels once from the browser to the local server during
  setup and is never sent back to the browser. The UI shows only the server address
  and a shortened fingerprint.
- **Protection from other websites:** The server accepts changing requests (save,
  delete, rename) only with its own header from its own UI. Other websites in the
  same browser cannot change or delete the credentials (CSRF protection).
- **Checked input:** Map names in requests are checked against a pattern; access
  outside the data folder is not possible.
- **Memory only:** The decrypted token exists only in the memory of the running
  viewer server.

### Honest limits

- **Anyone with access to your user account** can read the master key and decrypt
  the data. This applies to any application that remembers credentials without
  asking for a password again. Protect your account with a strong password and
  full-disk encryption (FileVault, BitLocker, LUKS).
- **Changed your computer name?** The stored data can then no longer be read, because
  the computer binding no longer matches. The viewer simply asks for the credentials
  again.
- **Connection to the console:** The link between the viewer and the console is only
  as secure as the console itself. If it runs over `http://`, the token crosses the
  network unencrypted. Where possible, reach the console over `https://` (reverse
  proxy with TLS) or through a VPN or SSH tunnel.
- **API token permissions:** Give the token read access to map data only. The viewer
  needs nothing else.

### Managing your credentials

- **Change:** *Connection → Change* (new server or token).
- **Delete:** *Connection → Delete credentials* removes the encrypted file. The
  master key stays and is reused on the next setup.
- **Rename instances:** *Connection → Name instances*.
- **Full reset:** also delete `master.key` from the user config folder.
- **Never share:** the `MapViewer3D` folder in your user config folder (`master.key`
  and `state/`). The project folder itself contains none of it.

# Realtime Data API

Live **sandworms, enemies, civilians, vehicles, sandstorms** (and, with extra permission, **player positions**) of a Dune Docker
server as a read-only HTTP API. Any program can use it: a Discord bot, a website, a dashboard, a script.

Needs the Dune Docker Console with [patch 1](README.md) and the position agent running ([README](../README.md)). The
Console is the only door; the agent itself is not reachable from the network.

## Access

| | |
|---|---|
| Key | a Console **API key** (*Settings → API Keys*) with **Realtime Data → Read**. `Maps → Read` alone is not enough |
| Players | positions of players only if the key **also** has **Players → Read** (and the agent runs with `MV_AGENT_PLAYERS=true`) |
| Header | `Authorization: Bearer dak_…` |
| Base URL | `https://<host>:8797` (encrypted front door, [patch 2](README.md)) or `http://<host>:8088` (plain HTTP, not encrypted) |
| Methods | `GET` only |
| Limits | 4 open streams per key, 16 in total; the key's normal rate limit applies |

An open stream re-checks its key every 10 seconds: disabling, expiring or revoking the key – or removing the scope – ends it.

## Routes

### `GET /api/realtime/healthz`

```json
{
  "available": true,
  "version": 1,
  "ok": true,
  "ready": 1,
  "sources": [
    { "map": "Survival_1", "partition": 1, "ready": true, "n": 2498,
      "weather": { "coriolisStart": 1790658000000, "coriolisNext": 1791262800000 } },
    { "map": "Overmap", "partition": 2, "ready": false, "n": 0, "reason": "no plausible object (normal for the Overmap)" }
  ]
}
```

`503` with `{"available":false,…}` when the agent is not running. Use this to check availability before streaming.

### `GET /api/realtime/objects`

The current state, once.

```json
{
  "gen": 14,
  "t": 1790941372638,
  "sources": [ { "map": "Survival_1", "partition": 1, "ready": true, "n": 2498, "weather": { "coriolisStart": 1790658000000, "coriolisNext": 1791262800000 } } ],
  "objects": [
    { "i": 463,  "k": "worm",     "c": "BP_Crea_SandwormArrakis_C",             "s": 0, "x": 228910,  "y": 186192,  "z": 983 },
    { "i": 2505, "k": "storm",    "c": "BP_SandStorm_C",                        "s": 0, "x": 80724,   "y": -267569, "z": 0, "yaw": -175.6 },
    { "i": 1,    "k": "npc",      "c": "BP_Npc_SoldierBase_Character_Baked_C",  "s": 0, "x": -177028, "y": -283096, "z": 12840 },
    { "i": 7,    "k": "civilian", "c": "BP_NpcCivilian_C",                      "s": 0, "x": 190626,  "y": 3913,    "z": 13610 }
  ]
}
```

(Example values, shortened. A full Hagga Basin snapshot holds a few thousand objects: mostly enemies, plus civilians, sandworms and vehicles.)

### `GET /api/realtime/stream`

Server-sent events (`text/event-stream`). First the full state, then only changes:

```
event: snap
data: {"gen":14,"t":1790941351225,"sources":[…],"objects":[…]}

event: pos
data: {"d":[[463,229114,186537,932],[2505,80224,-267608,0]],"gen":14,"r":[],"t":1790941351325}

: keepalive
```

- **`snap`** – the complete state, same shape as `/objects`. **Replace everything you hold.** Sent first, and again after every full re-scan (a new object appeared, a sandworm vanished, an instance restarted).
- **`pos`** – `d` = changed positions `[id, x, y, z]` (up to about 10 per second), `r` = ids that are gone. Only ids from the last `snap` appear; a new object comes with the next `snap`.
- A line starting with `:` is a keep-alive (about every 20 s); a connection silent for more than a minute is dead – reconnect.

## Fields

| Field | Meaning |
|---|---|
| `i` | object id, assigned by the agent. Use it to match `pos` updates to objects; **do not store it** (it is not stable across agent restarts) |
| `k` | kind: `worm`, `npc` (enemies and other NPCs), `civilian` (traders, quartermasters), `vehicle`, `storm` (sandstorm), `coriolis` (the Coriolis storm, while it runs), `player` (see Access) |
| `c` | Unreal class name, e.g. `BP_Crea_SandwormArrakis_C`; tells subtypes apart (sandbike, ornithopter, soldier, …) |
| `s` | index into `sources` of the same message → which `map` and `partition` (instance) the object belongs to |
| `x`, `y`, `z` | world position in Unreal units (centimetres), the same coordinate system as `x`, `y`, `z` in the Console's `/api/map/*` answers |
| `yaw` | storms only: heading in degrees |
| `sources[].map` | `Survival_1` (Hagga Basin), `DeepDesert_1` (Deep Desert), hubs, `Overmap` (never ready, no positions by design) |
| `sources[].partition` | instance number (`/api/map/partitions` names them: PvE, PvP, …) |
| `sources[].weather` | Coriolis schedule in Unix ms: `coriolisStart` (last), `coriolisNext` (next) |
| `gen`, `t` | generation counter and server time (Unix ms) |

Player objects (`k: "player"`) carry no names – only a position. To put a name on one, match it with the online players of `/api/map/players` (same partition, nearest position).

## Errors

| Status | Meaning |
|---|---|
| `401` | missing, invalid, disabled or expired key |
| `403` | the key has no **Realtime Data** scope (or the route does not exist in this Console version) |
| `429` | too many streams for this key, or the key's rate limit |
| `503` | the agent is not running on the host |

## Examples

```bash
# once
curl -H "Authorization: Bearer dak_YOUR_KEY" https://<host>:8797/api/realtime/objects

# stream (-N: no buffering)
curl -N -H "Authorization: Bearer dak_YOUR_KEY" https://<host>:8797/api/realtime/stream
```

## Connecting securely

The encrypted front door uses its own key; clients **pin it** instead of trusting a certificate authority. The fingerprint is shown in the
installer, in *Settings → Encrypted API Access* and by `dune encrypted-api fingerprint` – compare it with what your program pins.
The format is `sha256/<base64url>`.

**curl** wants standard base64 with padding and a double slash:

```bash
PIN='<fingerprint>'            # the part after "sha256/"
curl --pinnedpubkey "sha256//$(printf %s "$PIN" | tr -- '-_' '+/')=" -k \
     -H "Authorization: Bearer dak_YOUR_KEY" https://<host>:8797/api/realtime/objects
```

(`-k` only switches off the certificate-authority check that cannot succeed for a self-signed key; the pin is still enforced.)

**Node.js** – verify the key *before* anything, the API key included, is sent. (`checkServerIdentity` is **not** called for a self-signed
certificate, so do not rely on it.)

```js
import tls from 'node:tls';
import net from 'node:net';
import https from 'node:https';
import { createHash, X509Certificate } from 'node:crypto';

function pinnedSocket(host, port, pin) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port, rejectUnauthorized: false, servername: net.isIP(host) ? undefined : host }, () => {
      const spki = new X509Certificate(socket.getPeerCertificate().raw).publicKey.export({ type: 'spki', format: 'der' });
      const seen = `sha256/${createHash('sha256').update(spki).digest('base64url')}`;
      if (seen !== pin) { socket.destroy(); reject(new Error(`unexpected key ${seen}`)); } else resolve(socket);
    });
    socket.on('error', reject);
  });
}

const socket = await pinnedSocket('<host>', 8797, 'sha256/<fingerprint>');
https.get({ host: '<host>', port: 8797, path: '/api/realtime/objects', createConnection: () => socket,
            headers: { Authorization: 'Bearer dak_YOUR_KEY' } }, (res) => res.pipe(process.stdout));
```

Other languages: use the library's public-key pinning (Go: `VerifyConnection`; Java: a `TrustManager`; Python: compare the SPKI hash of
`ssl.SSLSocket.getpeercert(True)` yourself). If you would rather use a normal certificate, put the Console behind a reverse proxy with a real
one (Let's Encrypt) and skip the pin.

## Good to know

- **PvP:** worms and enemies follow players, so their movement can hint at where players are. Do not give such keys to players.
- **Stability:** the field names above are what the agent delivers today; new fields may appear, so ignore fields you do not know.
- **After a game update** the agent finds its memory offsets again by itself; until then the sources report `ready: false` and the lists are empty.
- **Plain HTTP** (`:8088`) works too but is not encrypted: the API key and the positions can be read on the network.

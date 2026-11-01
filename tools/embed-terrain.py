#!/usr/bin/env python3
"""Baut aus lokalen CDN-Kacheln (Branch `cdn`, Tag data-vN) die grobe Hoehenkarte fuers Addon.
Jede Kachel wird gegen ihren Inhalts-Hash geprueft und der Karten-Index gegen catalog.json.
Aufruf: python3 -I tools/embed-terrain.py <cdn-ordner> <karte> <ausgabe.json> [zielbreite]
"""
import base64, gzip, hashlib, json, struct, sys

cdn, name, out = sys.argv[1:4]
target = int(sys.argv[4]) if len(sys.argv) > 4 else 1100
N = 129
raw_idx = open(f'{cdn}/m/{name}.json', 'rb').read()
cat = json.load(open(f'{cdn}/catalog.json'))
entry = next(m for m in cat['maps'] if m['file'] == f'm/{name}.json')
assert hashlib.sha256(raw_idx).hexdigest() == entry['sha256'], 'Karten-Index passt nicht zum Katalog'
d = json.loads(raw_idx)
meta = d['meta']
level = min(range(len(d['levels'])), key=lambda i: abs(d['levels'][i]['nx'] * 128 + 1 - target))
lv = d['levels'][level]
nx, ny = lv['nx'], lv['ny']
SX, SY = nx * 128 + 1, ny * 128 + 1
H = [0] * (SX * SY)
for c, ci in enumerate(lv['cells']):
    if ci < 0:
        continue
    tid = d['ids'][ci]
    raw = gzip.decompress(open(f'{cdn}/p/{tid[:2]}/{tid[2:]}.z', 'rb').read())
    assert len(raw) == 3 * N * N and hashlib.sha256(raw).hexdigest()[:16] == tid, 'Kachel-Hash falsch'
    ti, tj = c % nx, c // nx
    for j in range(N):
        v = 0
        for i in range(N):
            v = (v + (raw[j * N + i] | raw[N * N + j * N + i] << 8)) & 0xFFFF
            H[(tj * 128 + j) * SX + ti * 128 + i] = v
G = max(SX, SY)  # quadratisch auffuellen
buf = bytearray()
for j in range(G):
    for i in range(G):
        buf += struct.pack('<H', H[min(j, SY - 1) * SX + min(i, SX - 1)] or 0)
# 0 = "keine Daten": als niedrigste Hoehe darstellen
mn = min((v for v in struct.unpack(f'<{G*G}H', bytes(buf)) if v), default=0)
fixed = bytearray(struct.pack(f'<{G*G}H', *[(v or mn) for v in struct.unpack(f'<{G*G}H', bytes(buf))]))
cell_cm = meta['spacing'] * (1 << level) * 128 / 128  # cm je Stichprobe auf dieser Stufe
json.dump({'grid': G, 'level': level, 'minZ': meta['minZ'], 'maxZ': meta['maxZ'], 'originX': meta['originX'], 'originY': meta['originY'],
           'extent': cell_cm * (G - 1), 'h': base64.b64encode(gzip.compress(bytes(fixed), 9)).decode()}, open(out, 'w'), separators=(',', ':'))
print(name, 'Stufe', level, 'Raster', G, 'x', G)

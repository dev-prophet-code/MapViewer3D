// Release settings of the addon. tools/pin-data.mjs rewrites DATA_TAG and CATALOG_SHA256
// when a new data release is published; everything else in the chain is verified from them:
//   addon (checksum pinned by the Red-Blink catalog)
//     -> CATALOG_SHA256 -> catalog.json -> sha256 of every map index (m/<map>.json)
//       -> content id of every terrain tile (p/..): the SHA-256 of the tile itself.
export const ADDON_VERSION = '0.2.0';

export const DATA_REPO = 'dev-prophet-code/MapViewer3D';
export const DATA_TAG = 'data-v1';
export let CATALOG_SHA256 = '4b0fcaa50b1c64d336301b825724ecb74e1f1132ac608eb85c1810314f08515b';

// Mirrors for the data files, tried in this order. A tag never changes its content, so
// both are safe to cache for a long time.
export const DATA_MIRRORS = [
  (path) => `https://raw.githubusercontent.com/${DATA_REPO}/${DATA_TAG}/${path}`,
  (path) => `https://cdn.jsdelivr.net/gh/${DATA_REPO}@${DATA_TAG}/${path}`,
];

// Tests can point the data at a local server: ?data=http://127.0.0.1:8099/
const override = new URLSearchParams(location.search).get('data');
if (override && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(override)) {
  DATA_MIRRORS.splice(0, DATA_MIRRORS.length, (path) => override + path);
  const sha = new URLSearchParams(location.search).get('catalog');
  if (sha && /^[0-9a-f]{64}$/.test(sha)) CATALOG_SHA256 = sha; // local test data has its own catalog
}

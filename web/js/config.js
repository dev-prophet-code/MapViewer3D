// Release settings of the addon. tools/pin-data.mjs rewrites DATA_TAG and CATALOG_SHA256
// when a new data release is published; everything else in the chain is verified from them:
//   addon (checksum pinned by the Red-Blink catalog)
//     -> CATALOG_SHA256 -> catalog.json -> sha256 of every map index (m/<map>.json)
//       -> content id of every terrain tile (p/..): the SHA-256 of the tile itself.
export const ADDON_VERSION = '0.4.2';

// A visitor of a share link (https://<host>/s/<token>/) opens the viewer from the share gateway
// (MapViewer3D stack, branch ddp). There is no API key in the page: every console call goes to the
// gateway under the link's own path, which answers with the allowed, cleaned data only.
const shareMatch = (location.pathname ?? '').match(/^(\/s\/mvs_[A-Za-z0-9_-]{43})\//);
export const SHARE_BASE = shareMatch ? shareMatch[1] : null;
export const apiUrl = (path) => (SHARE_BASE ? SHARE_BASE + path : path);

export const DATA_REPO = 'dev-prophet-code/MapViewer3D';
export const DATA_TAG = 'data-v2';
export let CATALOG_SHA256 = 'a802bb664262c742286c5e445805cff18c56e699b8ff8f727bb8f1355fe23ff8';

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

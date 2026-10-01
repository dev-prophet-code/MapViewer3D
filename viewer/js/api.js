// Zugriff auf die API des Viewer-Servers (backend/server).
// Fehler tragen, falls der Server sie liefert, einen Code und ein Detail
// (siehe backend/server/setup.go), damit die Oberfläche sie übersetzen kann.
async function json(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) {
    const text = await r.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* kein JSON */ }
    const e = new Error(body?.error ?? `${url}: ${r.status} ${text}`);
    e.code = body?.code;
    e.detail = body?.detail;
    throw e;
  }
  return r.json();
}

// Ändernde Aufrufe tragen einen eigenen Kopf, den der Server als Schutz gegen
// Anfragen fremder Webseiten verlangt.
const send = (url, method, body) => json(url, {
  method,
  headers: { 'Content-Type': 'application/json', 'X-MapViewer': '1' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

export const api = {
  setupStatus: () => json('api/setup'),
  setupSave: (server, port, token) => send('api/setup', 'POST', { server, port, token }),
  setupDelete: () => send('api/setup', 'DELETE'),
  labels: () => json('api/setup/labels'),
  saveLabels: (labels) => send('api/setup/labels', 'POST', labels),
  maps: () => json('api/maps'),
  version: () => json('api/version'),
  patchUrl: (map, l, x, y, v) => `api/map/${map}/patch?l=${l}&x=${x}&y=${y}&v=${v}`,
  mapImageUrl: (map) => `api/map/${map}/mapimage`,
  sample: (map, pts) => json(`api/map/${map}/sample`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(pts),
  }),
  liveStatus: () => json('api/live/status'),
  liveFeed: (map, feed) => json(`api/live/${map}/${feed}`),
  liveBase: (id) => json(`api/live/base/${id}`),
  agent: (map, partition = null) => json(`api/agent/${map}${partition === null ? '' : `?partition=${partition}`}`),
  buildables: () => json('api/buildables'),
  buildableMeshUrl: (id) => `api/buildables/mesh/${id}.bin`,
};

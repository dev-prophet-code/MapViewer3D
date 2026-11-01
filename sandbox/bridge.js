// The addon bridge of the Dune Docker Console (window.DuneAddon.request): the ONLY way out of the
// sandboxed page. The page posts a request to the console page that embeds it, the console runs it with
// the logged-in administrator's session and the permissions the owner approved, and posts the answer back.
// (Format: console/web/src/features/addons/AddonsPanel.tsx; same helper as the addon template.)
const addonId = document.documentElement.dataset.addonId || 'mapviewer3d';
const pending = new Map();

function createRequestId() {
  return window.crypto && typeof window.crypto.randomUUID === 'function'
    ? window.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function request(action, payload = {}) {
  if (window.parent === window) return Promise.reject(new Error('Open this addon in Dune Docker Console.'));
  const requestId = createRequestId();
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      if (pending.delete(requestId)) reject(new Error('Bridge request timed out.'));
    }, 30000);
    pending.set(requestId, { resolve, reject, timer });
    try {
      window.parent.postMessage({ type: 'dune-addon-request', addonId, requestId, action, payload }, window.location.origin);
    } catch (error) {
      pending.delete(requestId);
      window.clearTimeout(timer);
      reject(error);
    }
  });
}

window.addEventListener('message', (event) => {
  if (event.source !== window.parent || event.origin !== window.location.origin) return;
  const message = event.data || {};
  if (message.type !== 'dune-addon-response') return;
  if (typeof message.requestId !== 'string' || typeof message.ok !== 'boolean') return;
  if (message.addonId && message.addonId !== addonId) return;
  const entry = pending.get(message.requestId);
  if (!entry) return;
  pending.delete(message.requestId);
  window.clearTimeout(entry.timer);
  if (message.ok) entry.resolve(message.result);
  else entry.reject(new Error(message.error || 'Bridge request failed.'));
});

// store.js (instance names in the addon storage) reaches the console through this.
window.DuneAddon = { request };

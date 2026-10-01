// Private storage of the addon: the console's addon storage (permission files:addon-data),
// reached through the iframe bridge. This is where the API key and the instance names live.
// The key is never written to localStorage or any other place other addons could read.
//
// Opened outside the console (no parent frame, local testing only) the browser's
// localStorage stands in; the page is then not same-origin with a console anyway.
const inConsole = window.parent !== window && typeof window.DuneAddon?.request === 'function';
const LOCAL = 'mapviewer3d.dev.';

async function bridge(action, payload) {
  return window.DuneAddon.request(action, payload);
}

export const store = {
  inConsole,

  // resolves to the stored JSON value or null
  async get(key) {
    if (!inConsole) {
      try { return JSON.parse(localStorage.getItem(LOCAL + key)); } catch { return null; }
    }
    const r = await bridge('addon.storage.get', { key });
    return r?.found ? r.value : null;
  },

  async put(key, value) {
    if (!inConsole) {
      localStorage.setItem(LOCAL + key, JSON.stringify(value));
      return;
    }
    await bridge('addon.storage.put', { key, value });
  },

  async remove(key) {
    if (!inConsole) {
      localStorage.removeItem(LOCAL + key);
      return;
    }
    await bridge('addon.storage.delete', { key });
  },
};

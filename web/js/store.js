// Private storage of the addon: the console's addon storage (permission files:addon-data),
// reached through the iframe bridge. It holds only non-secret data (the instance names).
//
// The API key is NEVER stored here or anywhere else: the console isolates addon storage per
// addon, not per signed-in user, so everything in it is readable by every user who can reach
// the bridge. console.js keeps the key in memory only.
//
// Outside the console (page opened directly, no parent frame or no bridge) nothing is
// persisted at all: values live in memory until the page is closed. There is deliberately no
// localStorage / sessionStorage / IndexedDB path.
const inConsole = window.parent !== window && typeof window.DuneAddon?.request === 'function';
const memory = new Map();

async function bridge(action, payload) {
  return window.DuneAddon.request(action, payload);
}

export const store = {
  inConsole,

  // resolves to the stored JSON value or null
  async get(key) {
    if (!inConsole) return memory.has(key) ? structuredClone(memory.get(key)) : null;
    const r = await bridge('addon.storage.get', { key });
    return r?.found ? r.value : null;
  },

  async put(key, value) {
    if (!inConsole) { memory.set(key, structuredClone(value)); return; }
    await bridge('addon.storage.put', { key, value });
  },

  async remove(key) {
    if (!inConsole) { memory.delete(key); return; }
    await bridge('addon.storage.delete', { key });
  },

  // Removes what versions up to 0.2.0 left behind: the key in the shared addon storage (when
  // inside the console) and the development copy in this origin's localStorage. Best effort.
  async purgeLegacyKey(name) {
    if (inConsole) await bridge('addon.storage.delete', { key: name }).catch(() => {});
    try { localStorage.removeItem(`mapviewer3d.dev.${name}`); } catch { /* no access */ }
  },
};

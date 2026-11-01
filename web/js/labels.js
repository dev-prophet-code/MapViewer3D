// Names the administrator gives to the server instances. Not secret: kept in the addon storage.
import { store } from './store.js';
import { fail } from './errors.js';

const LABEL_STORE = 'instance.names';
const LABEL_PATTERN = /^[\p{L}\p{N} ._\-()/+&]{1,40}$/u;

export async function customLabels() {
  const v = await store.get(LABEL_STORE).catch(() => null);
  return v && typeof v === 'object' ? v : {};
}

export async function saveLabels(labels) {
  const out = {};
  for (const [k, raw] of Object.entries(labels ?? {})) {
    const v = String(raw).trim();
    if (!/^\d+$/.test(k) || !v) continue;
    if (!LABEL_PATTERN.test(v)) throw fail('name_invalid', v);
    out[k] = v;
  }
  try { await store.put(LABEL_STORE, out); } catch (e) { throw fail('save_failed', e.message); }
  return out;
}

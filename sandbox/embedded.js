// The data packed into the page by build-sandbox.mjs (tools/embed-data.mjs): terrain tiles, building
// models, marker images. It sits in three <script type="application/json"> blocks, parsed when first
// needed (the models and the map backgrounds only when a base or the map is drawn).
let cache = {};

function block(id) {
  if (!(id in cache)) {
    const el = typeof document !== 'undefined' ? document.getElementById(id) : null;
    if (!el) throw new Error(`the page carries no embedded data (${id})`);
    cache[id] = JSON.parse(el.textContent);
  }
  return cache[id];
}

// For tests: use a given document instead of the page's blocks.
export function useEmbedded(blocks) { cache = { ...blocks }; }

export const core = () => block('mv-core');       // catalog, map indexes, tiles, icons
export const models = () => block('mv-models');   // building models and their index
export const maps = () => block('mv-maps');       // the map background images

export const bytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

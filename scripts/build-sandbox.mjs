// Builds the addon package for the Dune Docker Console's sandbox: ONE self-contained web/index.html.
//
// The console serves an addon inside <iframe sandbox="allow-scripts"> with the policy
//   default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline';
//   img-src 'self' data: blob:; connect-src 'none'
// and the page has an opaque origin, so separate script/style files cannot be loaded and nothing can be
// fetched. Everything the viewer needs is therefore in the page: the script (three.js included), the
// style, and the map data (tools/embed-data.mjs). Live data comes through the addon bridge (sandbox/).
//
//   node scripts/build-sandbox.mjs <embedded.json> <outDir>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [embeddedFile, outDir] = process.argv.slice(2);
if (!embeddedFile || !outDir) { console.error('usage: node scripts/build-sandbox.mjs <embedded.json> <outDir>'); process.exit(1); }

const sandbox = (f) => path.join(root, 'sandbox', f);
const web = (f) => path.join(root, 'web', f);

// The viewer's modules that differ in the sandbox: same exports, other source.
const swaps = new Map([
  [web('js/api.js'), sandbox('api.js')],
  [web('js/realtime.js'), sandbox('realtime-off.js')],
  [web('js/iconsrc.js'), sandbox('iconsrc.js')],
  [web('js/share.js'), sandbox('share-panel.js')],
]);
const swapPlugin = {
  name: 'sandbox-swaps',
  setup(b) {
    b.onResolve({ filter: /^\./ }, (args) => {
      const full = path.resolve(args.resolveDir, args.path);
      return swaps.has(full) ? { path: swaps.get(full) } : undefined;
    });
    b.onResolve({ filter: /^three(\/|$)/ }, (args) => {
      const sub = args.path === 'three' ? 'build/three.module.js' : args.path.replace(/^three\//, 'examples/jsm/').replace(/^examples\/jsm\/addons\//, 'examples/jsm/');
      return { path: path.join(root, 'web/vendor/three', sub) };
    });
  },
};

const bundle = await build({
  entryPoints: [sandbox('entry.js')],
  bundle: true, write: false, format: 'esm', minify: true, target: 'es2022', legalComments: 'none',
  plugins: [swapPlugin],
});
const js = bundle.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');

const embedded = JSON.parse(fs.readFileSync(embeddedFile, 'utf8'));
const blocks = {
  'mv-core': { minLevel: embedded.minLevel, catalog: embedded.catalog, indexes: embedded.indexes, tiles: embedded.tiles, icons: embedded.icons },
  'mv-models': { index: embedded.buildablesIndex, meshes: embedded.meshes },
  'mv-maps': embedded.mapImages,
};
const jsonBlock = (id, v) => `<script type="application/json" id="${id}">${JSON.stringify(v).replace(/</g, '\\u003c')}</script>`;

let html = fs.readFileSync(web('index.html'), 'utf8');
const css = ['style.css', 'icons.css'].map((f) => fs.readFileSync(web(f), 'utf8')).join('\n');
const strip = (re, what) => { if (!re.test(html)) throw new Error(`index.html: ${what} not found`); html = html.replace(re, ''); };
strip(/<link rel="stylesheet" href="style.css">\s*/, 'style link');
strip(/<link rel="stylesheet" href="icons.css">\s*/, 'icons link');
strip(/<script type="importmap">[\s\S]*?<\/script>\s*/, 'import map');
strip(/<script src="dune-addon-bridge.js"><\/script>\s*/, 'bridge script');
strip(/<script type="module" src="js\/main.js"><\/script>\s*/, 'main script');
html = html.replace('</head>', () => `<style>\n${css}\n</style>\n</head>`);
html = html.replace('</body>', () => `${Object.entries(blocks).map(([id, v]) => jsonBlock(id, v)).join('\n')}\n<script type="module">${js}</script>\n</body>`);

const pkg = path.join(outDir, 'web');
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(pkg, { recursive: true });
fs.writeFileSync(path.join(pkg, 'index.html'), html);
for (const f of ['addon.json', 'README.md']) fs.copyFileSync(path.join(root, f), path.join(outDir, f));
console.log(`sandbox page: ${(html.length / 1048576).toFixed(1)} MB (script ${(js.length / 1024).toFixed(0)} KB)`);

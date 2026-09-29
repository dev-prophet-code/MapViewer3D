// Kartensymbole wie auf der 2D-Live-Karte (Console bzw. lafamilia-gaming.eu):
// dieselben Markerbilder, geholt über /api/icons/<datei> (Viewer-Server holt sie
// von der Console und speichert sie zwischen). Aus der Ferne stehen diese Symbole
// auf der Karte, aus der Nähe die 3D-Modelle. Die Schalter im Bedienfeld zeigen
// dasselbe Symbol, damit man Karte und Legende sofort zuordnen kann.
//
// Für Gefahren hat die Console keine Bilder; sie werden hier im gleichen Stil
// (dunkle Scheibe, farbiger Ring, helles Zeichen) gezeichnet.
import * as THREE from 'three';

export const iconUrl = (file) => `api/icons/${file}`;

// Untertyp (klein geschrieben) → Datei, wie im Stylesheet der Console
// (.live-map-marker.subtype-<untertyp>)
const SUBTYPE = {
  cave: 'cave.webp', ecolab: 'ecolab.webp', shipwreck: 'shipwreck.webp', sietch: 'sietch.webp',
  tradingpost: 'tradingpost.webp', taxiservice: 'taxiservice.webp',
  enemycamp: 'enemycamp.webp', enemyoutpost: 'enemyoutpost.webp', enemylaboroutpost: 'enemylaboroutpost.webp',
  atreidesfortress: 'atreidesfortress.webp', harkonnenfortress: 'harkonnenfortress.webp',
  fuelcellpart: 'fuelcellwreckage.webp', fuelcellwreckage: 'fuelcellwreckage.webp',
  scrapmetalpart: 'scrapmetalwreckage.webp', scrapmetalwreckage: 'scrapmetalwreckage.webp',
  primrosefield: 'PrimroseField.png', saguaroseed: 'resourcesaguarorawr.webp', brittlebush: 'plantfiber.webp',
  dolomiterock: 'dolomiterock.webp', dolomitepickup: 'dolomiterock.webp',
  buggy: 'buggyvehicle.webp', sandbike: 'sandbikevehicle.webp', sandcrawler: 'sandcrawlervehicle.webp',
  treadwheel: 'treadwheelvehicle.webp', containervehicle: 'cargocontainervehicle.webp',
  lightornithopter: 'ornithoptervehicle.webp', mediumornithopter: 'ornithoptervehicle.webp',
  transportornithopter: 'ornithoptervehicle.webp', assaultornithopter: 'assaultornivehicle.webp',
};
// Erze: <Sorte>Ore und <Sorte>Pickup teilen sich ein Bild
for (const o of ['azurite', 'basalt', 'bauxite', 'erythrite', 'jasmium', 'magnetite', 'rhyolite', 'stravidium', 'titanium']) {
  SUBTYPE[`${o}ore`] = SUBTYPE[`${o}pickup`] = `${o}ore.webp`;
}
// NPCs: Bildname = Untertyp
for (const n of ['trainerbenegesserit', 'trainermentat', 'trainerplanetologist', 'trainerswordmaster', 'trainertrooper',
  ...['argosaz', 'dyvetz', 'ecaz', 'hagal', 'hurata', 'imota', 'kenola', 'lindaren', 'maros', 'mikarrol', 'moritani',
    'novebruns', 'richese', 'sor', 'taligari', 'thorvald', 'vernius', 'wayku', 'wydras'].map((h) => `houserepresentative${h}`)]) {
  SUBTYPE[n] = `${n}.webp`;
}

// Gezeichnete Symbole (ohne Bild bei der Console): Ringfarbe und Zeichen
const DRAWN = {
  quicksand: { ring: '#d08a3a', glyph: 'swirl' },
  drumsand: { ring: '#f2c14e', glyph: 'waves' },
  radiation: { ring: '#9dff4a', glyph: 'trefoil' },
  hazard: { ring: '#ef4444', glyph: 'warn' },
};

// Symbol je Schalter/Kategorie für das Bedienfeld (ein typischer Vertreter)
const LEGEND = {
  players: 'Characters.webp', offline: 'Characters.webp', vehicles: 'ornithoptervehicle.webp', bases: 'Base.webp',
  cave: 'cave.webp', ecolab: 'ecolab.webp', wreck: 'shipwreck.webp', sietch: 'sietch.webp', trading: 'tradingpost.webp',
  enemy: 'enemycamp.webp', spice: 'spicefieldlarge.webp', ore: 'azuriteore.webp', scrap: 'scrapmetalwreckage.webp',
  flora: 'plantfiber.webp', flour: 'floursand.webp', storage: 'storage.png', npc: 'trainermentat.webp',
  fortress: 'harkonnenfortress.webp',
  quicksand: '@quicksand', drumsand: '@drumsand', radiation: '@radiation',
};

// Farbe des Ersatzpunkts, solange ein Bild lädt oder fehlt (wie im Docker)
const FALLBACK = {
  players: '#ff9d2e', offline: '#8a8a8a', vehicles: '#22c55e', bases: '#3fa7ff', storage: '#b8864b',
  ore: '#9ca3af', scrap: '#b45309', enemy: '#f97316', fortress: '#c9b27a', spice: '#ff7b1c', flour: '#f2d7a0',
  flora: '#7bd66b', npc: '#4dd2c6',
};

// Größe auf dem Bildschirm (CSS-Pixel), angelehnt an die 2D-Karte
export const ICON_PX = {
  players: 34, offline: 28, bases: 34, vehicles: 28, storage: 18, spice: 40, flour: 24, fortress: 34,
  ore: 22, scrap: 22, flora: 22, default: 28,
};

// Symbol einer Zeile: { id, file | draw, px, variant }
export function iconFor(kind, row = {}) {
  const sub = String(row.subtype ?? row.class ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  let file = SUBTYPE[sub] ?? null;
  let variant = '';
  let px = ICON_PX[kind] ?? ICON_PX.default;
  switch (kind) {
    case 'players': file = 'Characters.webp'; break;
    case 'offline': file = 'Characters.webp'; variant = 'gray'; break;
    case 'bases': file = 'Base.webp'; break;
    case 'storage': file = 'storage.png'; break;
    case 'flour': file = 'floursand.webp'; break;
    case 'vehicles': file ??= 'sandbikevehicle.webp'; break;
    case 'spice':
      // Größe nach Feldgröße, aktive Felder mit „LIVE“, mögliche mit „?“ – wie in der Console
      file = 'spicefieldlarge.webp';
      variant = row.type === 'spice_active' ? 'live' : 'maybe';
      px = row.subtype === 'Small' ? 26 : row.subtype === 'Medium' ? 34 : 44;
      break;
    case 'flora': file ??= 'plantfiber.webp'; break;
    case 'quicksand': case 'drumsand': case 'radiation':
      return { id: `@${kind}`, draw: kind, px: 26, variant };
    default: break;
  }
  if (!file) return { id: `@dot:${kind}`, draw: 'dot', color: FALLBACK[kind] ?? '#60a5fa', px: 18, variant };
  return { id: `${file}|${variant}`, file, px, variant, color: FALLBACK[kind] ?? '#d9782b' };
}

// ---------- Texturen ----------
const SIZE = 128;
const textures = new Map();

// Textur eines Symbols. Sofort nutzbar: zuerst Ersatzpunkt, nach dem Laden das Bild.
export function iconTexture(icon) {
  let tex = textures.get(icon.id);
  if (tex) return tex;
  const c = document.createElement('canvas');
  c.width = c.height = SIZE;
  const ctx = c.getContext('2d');
  tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  textures.set(icon.id, tex);
  if (icon.draw) {
    drawSymbol(ctx, icon);
  } else {
    drawDot(ctx, icon.color);
    loadImage(icon.file).then((img) => {
      ctx.clearRect(0, 0, SIZE, SIZE);
      drawImage(ctx, img, icon.variant);
      tex.needsUpdate = true;
    }, () => { /* Ersatzpunkt bleibt */ });
  }
  return tex;
}

const images = new Map();
function loadImage(file) {
  if (!images.has(file)) {
    images.set(file, new Promise((resolve, reject) => {
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = iconUrl(file);
    }));
  }
  return images.get(file);
}

function drawImage(ctx, img, variant) {
  const pad = variant === 'live' || variant === 'maybe' ? 14 : 4;
  if (variant === 'gray') ctx.filter = 'grayscale(1) brightness(0.7)';
  if (variant === 'live') { ctx.shadowColor = 'rgba(232,135,30,0.95)'; ctx.shadowBlur = 14; }
  ctx.drawImage(img, pad, pad, SIZE - pad * 2, SIZE - pad * 2);
  ctx.filter = 'none';
  ctx.shadowBlur = 0;
  if (variant === 'live' || variant === 'maybe') badge(ctx, variant === 'live' ? 'LIVE' : '?', variant === 'live' ? '#b85d0b' : '#59636d');
}

// Fähnchen oben rechts, wie in der Console
function badge(ctx, text, color) {
  ctx.font = '800 22px ui-monospace, Menlo, monospace';
  const w = Math.max(30, ctx.measureText(text).width + 14), h = 28;
  const x = SIZE - w - 2, y = 2;
  ctx.fillStyle = color;
  ctx.strokeStyle = '#090b0d';
  ctx.lineWidth = 3;
  ctx.beginPath(); ctx.roundRect(x, y, w, h, h / 2); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + w / 2, y + h / 2 + 1);
}

function drawDot(ctx, color) {
  ctx.beginPath();
  ctx.arc(SIZE / 2, SIZE / 2, SIZE * 0.3, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = 12;
  ctx.strokeStyle = '#090b0d';
  ctx.stroke();
}

// Gefahrensymbol: dunkle Scheibe, farbiger Ring, Zeichen in Ringfarbe
function drawSymbol(ctx, icon) {
  if (icon.draw === 'dot') { drawDot(ctx, icon.color); return; }
  const { ring, glyph } = DRAWN[icon.draw] ?? DRAWN.hazard;
  const m = SIZE / 2;
  ctx.beginPath();
  ctx.arc(m, m, 54, 0, Math.PI * 2);
  ctx.fillStyle = '#15110d';
  ctx.fill();
  ctx.lineWidth = 9;
  ctx.strokeStyle = ring;
  ctx.stroke();
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#090b0d';
  ctx.beginPath(); ctx.arc(m, m, 60, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = ring;
  ctx.fillStyle = ring;
  ctx.lineWidth = 8;
  ctx.lineCap = 'round';
  switch (glyph) {
    case 'swirl': // Treibsand: Spirale
      ctx.beginPath();
      for (let a = 0; a < Math.PI * 5; a += 0.1) {
        const r = 4 + a * 2.3;
        ctx.lineTo(m + Math.cos(a) * r, m + Math.sin(a) * r);
      }
      ctx.stroke();
      break;
    case 'waves': // Trommelsand: drei Schallwellen
      for (const dy of [-20, 0, 20]) {
        ctx.beginPath();
        for (let x = -30; x <= 30; x += 2) ctx.lineTo(m + x, m + dy + Math.sin(x / 7) * 6);
        ctx.stroke();
      }
      break;
    case 'trefoil': // Strahlung: Kleeblatt
      for (let i = 0; i < 3; i++) {
        const a = -Math.PI / 2 + i * (Math.PI * 2 / 3);
        ctx.beginPath();
        ctx.moveTo(m, m);
        ctx.arc(m, m, 36, a - 0.5, a + 0.5);
        ctx.closePath();
        ctx.fill();
      }
      ctx.beginPath(); ctx.arc(m, m, 14, 0, Math.PI * 2); ctx.fillStyle = '#15110d'; ctx.fill();
      ctx.beginPath(); ctx.arc(m, m, 8, 0, Math.PI * 2); ctx.fillStyle = ring; ctx.fill();
      break;
    default: // Warnzeichen
      ctx.font = '900 64px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('!', m, m + 3);
  }
}

// ---------- Bedienfeld ----------
// Symbol für einen Schalter: Markerbild bzw. gezeichnetes Symbol; ohne Bild
// (oder wenn es nicht lädt) das bisherige CSS-Symbol.
export function legendIcon(key) {
  const src = LEGEND[key];
  if (!src) return cssIcon(key);
  return iconElement(src.startsWith('@') ? { draw: src.slice(1) } : { file: src, variant: key === 'offline' ? 'gray' : '' }, key);
}

const cssIcon = (key) => Object.assign(document.createElement('span'), { className: `ico ico-${key}` });

// Symbol (aus iconFor) als Bild im Bedienfeld; key = CSS-Ersatz
export function iconElement(icon, key) {
  if (!icon) return cssIcon(key);
  const img = Object.assign(document.createElement('img'), { className: `ico-img${icon.variant === 'gray' ? ' gray' : ''}`, alt: '' });
  if (icon.draw) {
    const c = document.createElement('canvas');
    c.width = c.height = SIZE;
    drawSymbol(c.getContext('2d'), icon);
    img.src = c.toDataURL();
  } else {
    img.src = iconUrl(icon.file);
    img.onerror = () => img.replaceWith(cssIcon(key));
  }
  return img;
}

// ---------- Darstellung in 3D ----------

// Bildschirmgröße (px) → Maßstab eines Sprites mit sizeAttenuation = false
export function spriteScale(camera, heightPx, px) {
  return px * 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) / heightPx;
}

// Einzelnes Symbol als Sprite (Spieler, Basen, Fahrzeuge): bewegt sich mit dem Objekt.
export function iconSprite(icon) {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({
    map: iconTexture(icon), depthTest: true, depthWrite: false, sizeAttenuation: false, transparent: true,
  }));
  s.renderOrder = 9;
  s.userData.px = icon.px;
  return s;
}

// Viele Symbole gleicher Art als Punktwolke (Orte, Ressourcen …). Nah an der
// Kamera blenden sie aus, dort stehen die 3D-Modelle; ganz weit weg werden sie
// etwas kleiner, damit die Übersicht nicht zugeschüttet wird.
export function iconPoints(icon, positions, sizes, { near = 180, far = 420 } = {}) {
  const g = new THREE.BufferGeometry().setFromPoints(positions);
  g.setAttribute('aSize', new THREE.Float32BufferAttribute(sizes, 1));
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthTest: true, depthWrite: false,
    uniforms: {
      uMap: { value: iconTexture(icon) },
      uDpr: { value: Math.min(devicePixelRatio, 2) },
      uNear: { value: near }, uFar: { value: far },
    },
    vertexShader: /* glsl */`
      #include <common>
      #include <logdepthbuf_pars_vertex>
      attribute float aSize;
      uniform float uDpr, uNear, uFar;
      varying float vFade;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        float d = -mv.z;
        // Zur Kamera hin versetzen (Bildschirmposition bleibt): sonst schneidet das Gelände die Symbole an
        mv.xyz -= normalize(mv.xyz) * (3.0 + d * 0.003);
        vFade = smoothstep(uNear, uFar, d);
        float shrink = mix(1.0, 0.55, smoothstep(2500.0, 20000.0, d));
        gl_Position = projectionMatrix * mv;
        gl_PointSize = aSize * shrink * uDpr;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: /* glsl */`
      #include <logdepthbuf_pars_fragment>
      uniform sampler2D uMap;
      varying float vFade;
      void main() {
        #include <logdepthbuf_fragment>
        if (vFade < 0.01) discard;
        vec4 c = texture2D(uMap, vec2(gl_PointCoord.x, 1.0 - gl_PointCoord.y));
        if (c.a < 0.04) discard;
        gl_FragColor = vec4(c.rgb, c.a * vFade);
        #include <colorspace_fragment>
      }`,
  });
  const pts = new THREE.Points(g, mat);
  pts.renderOrder = 5;
  pts.frustumCulled = false;
  return pts;
}

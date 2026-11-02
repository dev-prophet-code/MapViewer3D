// MapViewer 3D v2 - gemeinsamer Viewer-Kern (Addon und Companion).
// Klassisches Skript: erwartet die globalen THREE und OrbitControls (siehe scripts/build.mjs).
// Das Geländeverfahren (Quadtree aus 128-Quad-Kacheln mit Schürzen) und der Shader folgen dem
// Original MapViewer3D (MIT).
(function () {
  'use strict';
  const MV = (globalThis.MV = {});

  // ---------------------------------------------------------------- Shader
  const VERT = `
attribute float valid;attribute float mat;
varying vec3 vWorld;varying vec3 vNormal;varying float vH,vValid,vMat,vDist;
void main(){vH=position.y+modelMatrix[3][1];vValid=valid;vMat=mat;vNormal=normalize(normal);
vec4 wp=modelMatrix*vec4(position,1.0);vWorld=wp.xyz;vec4 mv=viewMatrix*wp;vDist=-mv.z;gl_Position=projectionMatrix*mv;}`;
  const FRAG = `
uniform vec3 uSun,uLodTint,uFogColor,uTone;uniform float uMinH,uMaxH,uContours,uGrid,uFogDensity,uMapOn,uMapFlip;uniform sampler2D uMapImg;uniform vec4 uMapBounds;
varying vec3 vWorld;varying vec3 vNormal;varying float vH,vValid,vMat,vDist;
float hash2(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}
float vnoise(vec2 p){vec2 i=floor(p),f=fract(p);vec2 u=f*f*(3.0-2.0*f);return mix(mix(hash2(i),hash2(i+vec2(1,0)),u.x),mix(hash2(i+vec2(0,1)),hash2(i+vec2(1,1)),u.x),u.y);}
float fbm(vec2 p){float v=0.0,a=0.5;for(int i=0;i<5;i++){v+=a*vnoise(p);p=p*2.03+17.1;a*=0.5;}return v;}
float triFbm(vec3 p,vec3 n,float s){vec3 w=pow(abs(n),vec3(4.0));w/=(w.x+w.y+w.z);return fbm(p.zy*s)*w.x+fbm(p.xz*s)*w.y+fbm(p.xy*s)*w.z;}
float line(float v,float w){float d=abs(fract(v-0.5)-0.5)/fwidth(v);return 1.0-clamp(d/w,0.0,1.0);}
void main(){
 if(vValid<0.5)discard;
 vec3 n=normalize(vNormal);vec2 w=vWorld.xz;
 float t=clamp((vH-uMinH)/max(uMaxH-uMinH,1.0),0.0,1.0);
 float slope=1.0-n.y;
 float isRock=smoothstep(2.5,2.9,vMat);
 float rocky=max(isRock,smoothstep(0.3,0.65,slope));
 float near=1.0-smoothstep(80.0,900.0,vDist);
 float big=fbm(w*0.0025);
 vec3 sand=mix(vec3(0.70,0.49,0.29),vec3(0.93,0.76,0.52),clamp(t*0.7+big*0.6-0.15,0.0,1.0));
 sand*=0.93+0.14*fbm(w*0.03);
 vec2 wind=normalize(vec2(0.82,0.57));
 float phase=dot(w,wind)*2.2+fbm(w*0.04)*9.0+vnoise(w*0.4)*1.5;
 float flat_=1.0-smoothstep(0.05,0.3,slope);
 n=normalize(n+vec3(wind.x,0.0,wind.y)*cos(phase)*0.22*near*flat_*(1.0-rocky));
 sand*=1.0+0.05*sin(phase)*near*flat_;
 sand*=0.96+0.08*vnoise(w*3.0)*near;
 vec3 col=sand;
 if(rocky>0.005){
  float rn=triFbm(vWorld,n,0.08);
  float strata=sin(vH*0.55+rn*6.0+fbm(w*0.01)*8.0);
  vec3 stone=mix(vec3(0.43,0.33,0.27),vec3(0.70,0.58,0.47),clamp(0.35+0.5*t+0.35*big,0.0,1.0));
  stone*=0.72+0.45*rn;stone*=0.93+0.07*strata;
  stone=mix(stone,stone*vec3(0.9,0.82,0.76),smoothstep(0.6,0.95,slope));
  col=mix(sand,stone,rocky);}
 float wImg=0.0;
 if(uMapOn>0.5){vec2 uv=vec2((vWorld.x-uMapBounds.x)/(uMapBounds.y-uMapBounds.x),(vWorld.z-uMapBounds.z)/(uMapBounds.w-uMapBounds.z));if(uMapFlip>0.5)uv.y=1.0-uv.y;
  if(uv.x>=0.0&&uv.x<=1.0&&uv.y>=0.0&&uv.y<=1.0){vec3 img=texture2D(uMapImg,uv).rgb;float detail=dot(col,vec3(0.3,0.5,0.2))/0.42;wImg=mix(0.7,0.92,smoothstep(60.0,900.0,vDist));col=mix(col,img*mix(1.0,detail,near*0.8),wImg);}}
 col*=uLodTint;
 vec3 L=normalize(uSun);float diff=max(dot(n,L),0.0);float sky=0.5+0.5*n.y;
 vec3 light=vec3(1.0,0.95,0.86)*1.15*diff+vec3(0.42,0.47,0.56)*0.45*sky+vec3(0.30,0.20,0.12)*0.25*(1.0-sky);
 light=mix(light,vec3(0.78)+0.35*diff,0.55*wImg);
 vec3 lit=col*light;
 if(uContours>0.5){float c=line(vH/10.0,1.0);float c50=line(vH/50.0,1.4);lit=mix(lit,vec3(0.25,0.15,0.08),max(c*0.45,c50*0.75));}
 if(uGrid>0.5){float g=max(line(vWorld.x/1000.0,1.2),line(vWorld.z/1000.0,1.2));lit=mix(lit,vec3(0.1,0.3,0.5),g*0.6);}
 lit*=uTone;
 float fog=1.0-exp(-pow(vDist*uFogDensity,2.0));
 gl_FragColor=vec4(mix(lit,uFogColor,fog),1.0);
 #include <tonemapping_fragment>
 #include <colorspace_fragment>
}`;

  const SKY = 0xe3c29a; // Horizont- und Nebelfarbe wie im Dune Map Viewer
  const TINTS = [0xffffff, 0xffb0b0, 0xb0ffb0, 0xb0b0ff, 0xffffa0, 0xffa0ff, 0xa0ffff];

  // Karten, die der Viewer kennt. live = Name der Console-Karte, source = Name der Realtime-Quelle.
  MV.MAPS = {
    hagga: { name: 'survival_1', title: 'Hagga Basin', live: 'HaggaBasin', source: 'Survival_1', image: 'hagga-basin.png', bounds: [-456752.21, 354547.46, -450630.14, 353821.95] },
    deep: { name: 'deepdesert_1', title: 'Deep Desert', live: 'DeepDesert', source: 'DeepDesert_1', image: 'deep-desert.png', bounds: [-1268450, 1158400, -1261434, 1165416] },
  };

  // ---------------------------------------------------------------- Umgebung
  MV.createEnv = function (canvas, stage) {
    const R = new THREE.WebGLRenderer({ canvas, antialias: true });
    R.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    R.toneMapping = THREE.ACESFilmicToneMapping; R.toneMappingExposure = 1.05;
    const sc = new THREE.Scene();
    sc.background = new THREE.Color(SKY);
    const cam = new THREE.PerspectiveCamera(55, 1, 2, 90000);
    const ctl = new OrbitControls(cam, canvas);
    // Steuerung wie im Dune Map Viewer (MapControls): links ziehen verschiebt, rechts ziehen dreht und neigt, Rad dreht um den Zielpunkt,
    // Shift + Rad neigt, Strg/Cmd + Rad (und Trackpad-Pinch) zoomt zum Zeiger, WASD/Pfeile fliegen, Q/E runter/hoch, Shift schneller
    ctl.enableDamping = true; ctl.dampingFactor = 0.12; ctl.zoomToCursor = true; ctl.screenSpacePanning = false;
    ctl.maxPolarAngle = Math.PI * 0.495; ctl.minDistance = 5; ctl.maxDistance = 40000;
    ctl.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
    ctl.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE };
    {
      const off = new THREE.Vector3(), sph = new THREE.Spherical();
      addEventListener('wheel', (e) => {
        if (e.target !== canvas || e.ctrlKey || e.metaKey) return;
        e.preventDefault(); e.stopImmediatePropagation();
        const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
        const d = (Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX) * unit * 0.0035; // mit Shift macht der Browser oft eine waagrechte Bewegung
        off.subVectors(cam.position, ctl.target); sph.setFromVector3(off);
        if (e.shiftKey) sph.phi = THREE.MathUtils.clamp(sph.phi + d, 0.05, ctl.maxPolarAngle); else sph.theta -= d;
        off.setFromSpherical(sph); cam.position.copy(ctl.target).add(off); cam.lookAt(ctl.target);
      }, { capture: true, passive: false });
    }
    const env = {
      R, sc, cam, ctl, meta: null, group: new THREE.Group(), cb: [],
      uniforms: {
        uSun: { value: new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(55), THREE.MathUtils.degToRad(-135)) }, uTone: { value: new THREE.Color(1, 1, 1) }, uMapOn: { value: 0 }, uMapFlip: { value: 0 }, uMapImg: { value: null }, uMapBounds: { value: new THREE.Vector4(0, 1, 0, 1) }, uMinH: { value: 0 }, uMaxH: { value: 1 },
        uContours: { value: 0 }, uGrid: { value: 0 }, uFogColor: { value: new THREE.Color(SKY) }, uFogDensity: { value: 0.00004 },
      },
      mats: [],
    };
    // Himmelskuppel (Verlauf Horizont → Zenit, Sonnenscheibe, Dunst) und Tag/Nacht wie im Dune Map Viewer
    const DAY = { horizon: new THREE.Color(0xe3c29a), zenith: new THREE.Color(0x6d8fb3), disc: new THREE.Color(1.0, 0.85, 0.6), tone: new THREE.Color(1, 1, 1) };
    const NIGHT = { horizon: new THREE.Color(0x141c38), zenith: new THREE.Color(0x02040b), disc: new THREE.Color(0.55, 0.65, 0.95), tone: new THREE.Color(0.2, 0.27, 0.48) };
    const skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: { uSun: env.uniforms.uSun, uHorizon: { value: env.uniforms.uFogColor.value }, uZenith: { value: DAY.zenith.clone() }, uSunCol: { value: DAY.disc.clone() } },
      vertexShader: 'varying vec3 vDir;void main(){vDir=normalize(position);vec4 p=projectionMatrix*modelViewMatrix*vec4(position,1.0);gl_Position=p.xyww;}',
      fragmentShader: 'uniform vec3 uSun,uHorizon,uZenith,uSunCol;varying vec3 vDir;void main(){vec3 d=normalize(vDir);float h=max(d.y,0.0);vec3 col=mix(uHorizon,uZenith,pow(h,0.55));float s=max(dot(d,normalize(uSun)),0.0);col+=uSunCol*(pow(s,12.0)*0.35+pow(s,400.0)*1.2);col=mix(col,uHorizon*0.9,smoothstep(0.0,-0.2,d.y));gl_FragColor=vec4(col,1.0);\n#include <tonemapping_fragment>\n#include <colorspace_fragment>\n}',
    });
    const sky = new THREE.Mesh(new THREE.SphereGeometry(1000, 32, 16), skyMat); sky.frustumCulled = false; sky.renderOrder = -1; sky.onBeforeRender = (r, s, c) => { sky.position.copy(c.position); };
    sc.add(sky);
    let nightK = 0, nightTo = 0;
    env.setNight = function (on) { nightTo = on ? 1 : 0; };
    env.onFrame = (f) => env.cb.push(f);
    env.onFrame(() => { // weiche Überblendung zwischen Tag und Nacht
      if (nightK === nightTo) return;
      nightK = Math.abs(nightTo - nightK) < 0.005 ? nightTo : nightK + (nightTo - nightK) * 0.12;
      env.uniforms.uFogColor.value.copy(DAY.horizon).lerp(NIGHT.horizon, nightK); sc.background.copy(env.uniforms.uFogColor.value);
      skyMat.uniforms.uZenith.value.copy(DAY.zenith).lerp(NIGHT.zenith, nightK); skyMat.uniforms.uSunCol.value.copy(DAY.disc).lerp(NIGHT.disc, nightK);
      env.uniforms.uTone.value.copy(DAY.tone).lerp(NIGHT.tone, nightK);
    });
    sc.add(env.group); MV.env = env; // Zugriff für Tests und Fehlersuche in der Konsole
    env.setMeta = function (m) {
      env.meta = m;
      env.ox = m.originX / 100; env.oy = m.originY / 100; env.ext = ((m.width - 1) * m.spacing) / 100;
      env.uniforms.uMinH.value = m.minZ / 100; env.uniforms.uMaxH.value = m.maxZ / 100;
      env.uniforms.uFogDensity.value = 0.35 / env.ext;
      env.home();
    };
    env.home = function () {
      cam.position.set(env.ox + env.ext * 0.5, env.ext * 0.32, env.oy + env.ext * 0.95);
      ctl.target.set(env.ox + env.ext * 0.5, 200, env.oy + env.ext * 0.5);
      ctl.update();
    };
    env.jump = function (x, z, y, dist) {
      ctl.target.set(x, y, z);
      cam.position.set(x + dist * 0.6, y + dist * 0.45, z + dist * 0.8);
      ctl.update();
    };
    env.material = function (level) {
      if (!env.mats[level]) {
        const u = Object.assign({}, env.uniforms, { uLodTint: { value: new THREE.Color(1, 1, 1) } });
        env.mats[level] = new THREE.ShaderMaterial({ uniforms: u, vertexShader: VERT, fragmentShader: FRAG, wireframe: !!env.wire });
      }
      return env.mats[level];
    };
    // Kartenbild der Console als Farbgrundlage (nur Companion). bounds: [minX, maxX, minY, maxY] in cm (Welt), flip: Y gespiegelt
    env.setMapImage = function (img, bounds, flip) {
      const u = env.uniforms; if (u.uMapImg.value) { u.uMapImg.value.dispose(); u.uMapImg.value = null; }
      u.uMapOn.value = 0; if (!img) return;
      const tex = new THREE.Texture(img); tex.colorSpace = THREE.SRGBColorSpace; tex.flipY = false; tex.anisotropy = 8; tex.needsUpdate = true;
      u.uMapImg.value = tex; u.uMapBounds.value.set(bounds[0] / 100, bounds[1] / 100, bounds[2] / 100, bounds[3] / 100); u.uMapFlip.value = flip ? 1 : 0; u.uMapOn.value = 1;
    };
    env.setWire = function (on) { env.wire = !!on; env.mats.forEach((m) => { if (m) m.wireframe = env.wire; }); };
    env.tint = function (on) { env.mats.forEach((m, l) => { if (m) m.uniforms.uLodTint.value.set(on ? TINTS[l % TINTS.length] : 0xffffff); }); };
    env.resize = function () {
      const w = Math.max(1, stage.clientWidth), h = Math.max(1, stage.clientHeight);
      R.setSize(w, h, false); cam.aspect = w / h; cam.updateProjectionMatrix();
    };
    addEventListener('resize', env.resize);
    env.resize();
    env.onFrame = (f) => env.cb.push(f);
    { // Tastaturflug: bewegt Kamera und Ziel gemeinsam; Eingabefelder sind ausgenommen
      const keys = new Set(), fwd = new THREE.Vector3(), right = new THREE.Vector3(), mv = new THREE.Vector3(); let last = performance.now();
      const typing = (e) => /^(INPUT|SELECT|TEXTAREA)$/.test((e.target && e.target.tagName) || '');
      addEventListener('keydown', (e) => {
        if (e.ctrlKey || e.metaKey || e.altKey || typing(e)) return;
        if (e.code === 'KeyF' && !e.repeat) { const b = document.getElementById('fsBtn'); if (b) b.click(); return; }
        keys.add(e.code);
      });
      addEventListener('keyup', (e) => keys.delete(e.code)); addEventListener('blur', () => keys.clear());
      env.onFrame(() => {
        const now = performance.now(), dt = Math.min(0.1, (now - last) / 1000); last = now;
        if (!keys.size) return;
        const fast = keys.has('ShiftLeft') || keys.has('ShiftRight') ? 3 : 1, speed = Math.max(20, cam.position.distanceTo(ctl.target)) * fast;
        cam.getWorldDirection(fwd); fwd.y = 0; fwd.normalize(); right.crossVectors(fwd, cam.up).normalize(); mv.set(0, 0, 0);
        if (keys.has('KeyW') || keys.has('ArrowUp')) mv.add(fwd); if (keys.has('KeyS') || keys.has('ArrowDown')) mv.sub(fwd);
        if (keys.has('KeyD') || keys.has('ArrowRight')) mv.add(right); if (keys.has('KeyA') || keys.has('ArrowLeft')) mv.sub(right);
        if (keys.has('KeyE') || keys.has('PageUp')) mv.y += 1; if (keys.has('KeyQ') || keys.has('PageDown')) mv.y -= 1;
        if (mv.lengthSq() === 0) return;
        mv.multiplyScalar(speed * dt * 0.6); cam.position.add(mv); ctl.target.add(mv);
      });
    }
    (function loop() { requestAnimationFrame(loop); ctl.update(); for (const f of env.cb) f(); R.render(sc, cam); })();
    env.clear = function () { while (env.group.children.length) { const c = env.group.children.pop(); if (c.geometry) c.geometry.dispose(); } };
    return env;
  };

  // ------------------------------------------------- grobes Gelände (Addon, eingebettet)
  // data: { grid, minZ, maxZ, originX, originY, extent, h } mit h = base64(gzip(uint16 LE))
  MV.CoarseTerrain = async function (env, data, stride) {
    const bin = Uint8Array.from(atob(data.h), (c) => c.charCodeAt(0));
    const raw = new Uint8Array(await new Response(new Blob([bin]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
    const H = new Uint16Array(raw.buffer, raw.byteOffset, raw.byteLength >> 1);
    const G = data.grid, cell = data.extent / 100 / (G - 1);
    const zMin = data.minZ / 100, zRng = (data.maxZ - data.minZ) / 100, ox = data.originX / 100, oy = data.originY / 100;
    const n = Math.floor((G - 1) / stride) + 1, pos = new Float32Array(n * n * 3), valid = new Float32Array(n * n).fill(1), mat = new Float32Array(n * n), idx = [];
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const gi = Math.min(G - 1, i * stride), gj = Math.min(G - 1, j * stride), v = H[gj * G + gi];
      pos.set([ox + gi * cell, zMin + (v / 65535) * zRng, oy + gj * cell], (j * n + i) * 3);
    }
    for (let j = 0; j < n - 1; j++) for (let i = 0; i < n - 1; i++) { const a = j * n + i; idx.push(a, a + n, a + 1, a + 1, a + n, a + n + 1); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('valid', new THREE.BufferAttribute(valid, 1));
    g.setAttribute('mat', new THREE.BufferAttribute(mat, 1));
    g.setIndex(idx); g.computeVertexNormals();
    const mesh = new THREE.Mesh(g, env.material(0)); mesh.frustumCulled = false;
    env.group.add(mesh);
    return { remove() { env.group.remove(mesh); g.dispose(); }, info: () => `Gelände (eingebettet): ${n}×${n} Punkte · ${Math.round((data.extent / 100) / (n - 1))} m Raster` };
  };

  // ------------------------------------------------- Quadtree-Gelände (Companion, gestreamt)
  MV.Terrain = function (env, idx, loadTile) {
    const meta = idx.meta, PQ = idx.patchQuads, N = PQ + 1, MAXL = idx.maxLevel;
    const T = { nodes: new Map(), queue: new Set(), inflight: 0, loaded: 0, drawn: [], frame: 0, detail: 3,
      fr: new THREE.Frustum(), box: new THREE.Box3(), m: new THREE.Matrix4(), errors: 0 };
    const toM = (v) => (meta.minZ + ((v - 1) * (meta.maxZ - meta.minZ)) / 65534) / 100;
    function node(l, x, y) {
      const k = l + '/' + x + '/' + y; let n = T.nodes.get(k);
      if (!n) {
        const span = PQ << l, s = meta.spacing / 100;
        n = { l, x, y, k, state: 'new', mesh: null, used: 0, x0: env.ox + x * span * s, z0: env.oy + y * span * s, size: span * s,
          minH: meta.minZ / 100, maxH: meta.maxZ / 100, inside: x * span < meta.width - 1 && y * span < meta.height - 1 };
        T.nodes.set(k, n);
      }
      return n;
    }
    const kids = (n) => { const o = []; for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) { const c = node(n.l - 1, n.x * 2 + i, n.y * 2 + j); if (c.inside) o.push(c); } return o; };
    const request = (n) => { if (n.state === 'new') { n.state = 'queued'; T.queue.add(n); } };
    function build(n, t) {
      const M = N + 2, step = n.size / PQ, hgt = new Float32Array(N * N);
      let minH = 1e9, maxH = -1e9, any = false;
      for (let i = 0; i < N * N; i++) { if (!t.hg[i]) continue; const h = toM(t.hg[i]); hgt[i] = h; any = true; if (h < minH) minH = h; if (h > maxH) maxH = h; }
      if (!any) { n.state = 'empty'; return; }
      for (let i = 0; i < N * N; i++) if (!t.hg[i]) hgt[i] = minH;
      n.minH = minH; n.maxH = maxH;
      const pos = new Float32Array(M * M * 3), nor = new Float32Array(M * M * 3), valid = new Float32Array(M * M), mat = new Float32Array(M * M), skirt = Math.max(2, n.size * 0.01);
      const H = (i, j) => hgt[Math.min(N - 1, Math.max(0, j)) * N + Math.min(N - 1, Math.max(0, i))];
      for (let j = 0; j < M; j++) for (let i = 0; i < M; i++) {
        const ci = Math.min(N - 1, Math.max(0, i - 1)), cj = Math.min(N - 1, Math.max(0, j - 1)), edge = i === 0 || j === 0 || i === M - 1 || j === M - 1, v = j * M + i;
        pos[3 * v] = ci * step; pos[3 * v + 1] = H(ci, cj) - (edge ? skirt : 0); pos[3 * v + 2] = cj * step;
        const dx = (H(ci + 1, cj) - H(ci - 1, cj)) / (2 * step), dz = (H(ci, cj + 1) - H(ci, cj - 1)) / (2 * step), l = Math.hypot(dx, 1, dz);
        nor[3 * v] = -dx / l; nor[3 * v + 1] = 1 / l; nor[3 * v + 2] = -dz / l;
        valid[v] = t.hg[cj * N + ci] ? 1 : 0; mat[v] = t.mt[cj * N + ci];
      }
      const ix = new Uint32Array((M - 1) * (M - 1) * 6); let p = 0;
      for (let j = 0; j < M - 1; j++) for (let i = 0; i < M - 1; i++) { const a = j * M + i, b = a + 1, c = a + M, d = c + 1; ix[p++] = a; ix[p++] = c; ix[p++] = b; ix[p++] = b; ix[p++] = c; ix[p++] = d; }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
      g.setAttribute('valid', new THREE.BufferAttribute(valid, 1)); g.setAttribute('mat', new THREE.BufferAttribute(mat, 1));
      g.setIndex(new THREE.BufferAttribute(ix, 1));
      const mesh = new THREE.Mesh(g, env.material(n.l)); mesh.position.set(n.x0, 0, n.z0);
      mesh.matrixAutoUpdate = false; mesh.updateMatrix(); mesh.visible = false; mesh.frustumCulled = false;
      n.mesh = mesh; n.state = 'ready'; env.group.add(mesh); T.loaded++;
    }
    function dispose(n) { if (n.mesh) { env.group.remove(n.mesh); n.mesh.geometry.dispose(); n.mesh = null; T.loaded--; } n.state = 'new'; }
    const nodeBox = (n) => { T.box.min.set(n.x0, n.minH, n.z0); T.box.max.set(n.x0 + n.size, n.maxH, n.z0 + n.size); return T.box; };
    function select(n) {
      n.used = T.frame;
      if (n.state === 'empty' || !T.fr.intersectsBox(nodeBox(n))) return;
      const d = T.box.distanceToPoint(env.cam.position);
      if (n.l > 0 && d < T.detail * n.size) {
        const cs = kids(n); let ready = true;
        for (const c of cs) { c.used = T.frame; if (c.state !== 'ready' && c.state !== 'empty') { request(c); ready = false; } }
        if (ready) { for (const c of cs) select(c); return; }
      }
      if (n.state === 'ready') T.drawn.push(n); else request(n);
    }
    function pump() {
      if (T.inflight >= 8 || !T.queue.size) return;
      const q = [...T.queue].filter((n) => n.state === 'queued')
        .sort((a, b) => b.l - a.l || nodeBox(a).distanceToPoint(env.cam.position) - nodeBox(b).distanceToPoint(env.cam.position));
      for (const n of q) {
        if (T.inflight >= 8) break;
        T.queue.delete(n); n.state = 'loading'; T.inflight++;
        loadTile(n, idx, N).then((t) => { if (T.dead) return; if (!t) n.state = 'empty'; else build(n, t); })
          .catch(() => { n.state = 'new'; T.errors++; }).finally(() => { T.inflight--; });
      }
    }
    T.update = function () {
      if (T.dead) return;
      T.frame++; env.cam.updateMatrixWorld();
      T.m.multiplyMatrices(env.cam.projectionMatrix, env.cam.matrixWorldInverse); T.fr.setFromProjectionMatrix(T.m);
      for (const n of T.drawn) n.mesh.visible = false; T.drawn = [];
      select(node(MAXL, 0, 0));
      for (const n of T.drawn) n.mesh.visible = true;
      pump();
      if (T.loaded > 1600) {
        const old = [...T.nodes.values()].filter((n) => n.state === 'ready' && n.used < T.frame - 60 && n.l < MAXL).sort((a, b) => a.used - b.used);
        for (const n of old.slice(0, T.loaded - 1200)) dispose(n);
      }
    };
    T.info = function () {
      const minL = T.drawn.reduce((a, n) => Math.min(a, n.l), 99);
      return `Kacheln: ${T.drawn.length} sichtbar · ${T.loaded} geladen · ${T.inflight} in Arbeit` + (minL === 99 ? '' : ` · feinste Stufe ${minL} (${(meta.spacing / 100) * (1 << minL)} m)`);
    };
    T.dispose = function () { T.dead = true; for (const n of T.nodes.values()) dispose(n); T.nodes.clear(); const i = env.cb.indexOf(T.update); if (i >= 0) env.cb.splice(i, 1); };
    env.onFrame(T.update);
    return T;
  };

  // Kachel aus dem Rohinhalt (Format 1: Höhen zeilenweise delta-codiert, Lo-/Hi-Byte-Ebene, dann Material).
  MV.decodeTile = function (raw, N) {
    if (raw.length !== 3 * N * N) throw new Error('Kachelgröße');
    const hg = new Uint16Array(N * N);
    for (let j = 0; j < N; j++) { let v = 0; for (let i = 0; i < N; i++) { v = (v + (raw[j * N + i] | (raw[N * N + j * N + i] << 8))) & 0xffff; hg[j * N + i] = v; } }
    return { hg, mt: raw.subarray(2 * N * N) };
  };

  // ---------------------------------------------------------------- Marker
  MV.Points = function (env, color, size) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3));
    const obj = new THREE.Points(g, new THREE.PointsMaterial({ color, size, sizeAttenuation: false }));
    obj.frustumCulled = false; env.sc.add(obj);
    return {
      obj,
      // arr: [{x,y,z}] in Metern (x/y Weltkoordinaten, z Höhe)
      set(arr) {
        let a = obj.geometry.getAttribute('position');
        if (a.count < arr.length) { // nur bei Wachstum neu anlegen, sonst Puffer weiterverwenden
          obj.geometry.dispose(); obj.geometry = new THREE.BufferGeometry();
          a = new THREE.BufferAttribute(new Float32Array(Math.ceil(arr.length * 1.5 + 16) * 3), 3); obj.geometry.setAttribute('position', a);
        }
        const p = a.array;
        for (let i = 0; i < arr.length; i++) { p[i * 3] = arr[i].x; p[i * 3 + 1] = arr[i].z + 6; p[i * 3 + 2] = arr[i].y; }
        a.needsUpdate = true; obj.geometry.setDrawRange(0, arr.length); this.count = arr.length;
      },
      count: 0,
    };
  };

  // Hilfen
  MV.el = function (tag, props, text) {
    const e = document.createElement(tag);
    if (props) for (const k in props) e.setAttribute(k, props[k]);
    if (text != null) e.textContent = String(text);
    return e;
  };
  MV.cm2m = (v) => Math.round(Number(v) / 100);
})();

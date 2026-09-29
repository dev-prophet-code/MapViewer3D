// Renderer, Kamera, Steuerung und die gemeinsamen Szenengruppen.
import * as THREE from 'three';
import { MapControls } from 'three/addons/controls/MapControls.js';

// Horizontfarbe; zugleich Nebelfarbe, damit das Gelände in den Himmel übergeht
export const SKY = new THREE.Color(0xe3c29a);

export function createScene(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  const scene = new THREE.Scene();
  scene.background = SKY;
  scene.fog = new THREE.FogExp2(SKY, 0.00004);

  const camera = new THREE.PerspectiveCamera(55, 1, 1, 200000);
  const controls = new MapControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.12;
  controls.maxPolarAngle = Math.PI * 0.495;
  controls.zoomToCursor = true;
  controls.minDistance = 5;
  controls.maxDistance = 40000;
  bindWheelRotate(canvas, camera, controls);

  // world: wird für die Überhöhung in Y skaliert; Gelände und Objekte hängen darunter,
  // ihre lokalen Koordinaten sind daher immer echte Meter.
  const world = new THREE.Group();
  scene.add(world);
  const hemi = new THREE.HemisphereLight(0xcfd9e6, 0x8a6a48, 1.1);
  const sun = new THREE.DirectionalLight(0xfff1dc, 2.2);
  scene.add(hemi, sun, sun.target);
  const sky = createSky();
  scene.add(sky);

  function resize() {
    renderer.setSize(innerWidth, innerHeight, false);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
  }
  addEventListener('resize', resize);
  resize();

  return { renderer, scene, camera, controls, world, sun, sky, hemi };
}

// Mausrad = freie Kamerabewegung: Rad dreht um den Zielpunkt, Shift + Rad neigt,
// Strg/Cmd + Rad (auch Trackpad-Pinch) zoomt – das übernimmt MapControls selbst.
function bindWheelRotate(canvas, camera, controls) {
  const off = new THREE.Vector3();
  const sph = new THREE.Spherical();
  addEventListener('wheel', (e) => {
    if (e.target !== canvas || e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    // Mit Shift macht der Browser aus dem Rad oft eine waagrechte Bewegung
    const d = (Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX) * unit * 0.0035;
    off.subVectors(camera.position, controls.target);
    sph.setFromVector3(off);
    if (e.shiftKey) sph.phi = THREE.MathUtils.clamp(sph.phi + d, 0.05, controls.maxPolarAngle);
    else sph.theta -= d;
    off.setFromSpherical(sph);
    camera.position.copy(controls.target).add(off);
    camera.lookAt(controls.target);
  }, { capture: true, passive: false });
}

// Himmelskuppel: Verlauf Horizont → Zenit, Sonnenscheibe und Dunst in Sonnenrichtung.
function createSky() {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      uSun: { value: new THREE.Vector3(0, 1, 0) },
      uHorizon: { value: SKY },
      uZenith: { value: new THREE.Color(0x6d8fb3) },
      uSunCol: { value: new THREE.Color(1.0, 0.85, 0.6) },
    },
    vertexShader: /* glsl */`
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = p.xyww; // immer ganz hinten
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uSun, uHorizon, uZenith, uSunCol;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        float h = max(d.y, 0.0);
        vec3 col = mix(uHorizon, uZenith, pow(h, 0.55));
        float s = max(dot(d, normalize(uSun)), 0.0);
        col += uSunCol * (pow(s, 12.0) * 0.35 + pow(s, 400.0) * 1.2);
        col = mix(col, uHorizon * 0.9, smoothstep(0.0, -0.2, d.y)); // unter dem Horizont
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(1000, 32, 16), mat);
  sky.frustumCulled = false;
  sky.renderOrder = -1;
  sky.onBeforeRender = (r, s, cam) => { sky.position.copy(cam.position); };
  return sky;
}

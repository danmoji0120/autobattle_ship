// Hull lineup (?lineup=p17[&cls=destroyer][&team=1][&view=top|side|three][&ids=a,b][&dist=k]): every P17.3
// silhouette side by side at true scale, fitted with its standard preset, for comparing shapes and turret /
// engine placement. A content author's check, not part of the game (docs/P17_3_ARSENAL.md).
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { CONTENT } from '../content/registry';
import { SHIP_CLASSES } from '../sim/data/ships';
import { shipLoadout } from '../world/fitting';
import { buildShip, type ShipModel } from './shipMesh';

const ORDER = ['corvette', 'frigate', 'destroyer', 'light_cruiser', 'cruiser', 'battlecruiser', 'battleship', 'dreadnought', 'carrier'];

export function startLineup(app: HTMLElement, canvas: HTMLCanvasElement, params: URLSearchParams) {
  canvas.style.visibility = 'visible';
  const team = params.get('team') === '1' ? 1 : 0;
  const ids = params.get('ids')?.split(',').filter(Boolean);
  const cls = params.get('cls')?.split(',');
  const hulls = Object.values(CONTENT.hulls)
    .filter(h => h.id.startsWith(params.get('lineup') === 'all' ? '' : 'p17_') && !h.dev && !h.exclusive && SHIP_CLASSES[h.classId])
    .filter(h => (!ids || ids.includes(h.id)) && (!cls || cls.includes(h.classId)))
    .sort((a, b) => ORDER.indexOf(a.classId) - ORDER.indexOf(b.classId) || SHIP_CLASSES[a.classId].length - SHIP_CLASSES[b.classId].length);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(2, devicePixelRatio));
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x04070c);
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture; scene.environmentIntensity = 0.32;
  scene.add(new THREE.HemisphereLight(0x3a4a6a, 0x0a0608, 0.55), new THREE.AmbientLight(0x202838, 0.35));
  const sun = new THREE.DirectionalLight(0xfff0dc, 2.6); sun.position.set(60, 90, 40); scene.add(sun);
  const fill = new THREE.DirectionalLight(0x5070c0, 0.9); fill.position.set(-60, 20, -50); scene.add(fill);

  // rows by class, ships side by side (bows +z), true scale
  const models: { m: ShipModel; label: HTMLDivElement; anchor: THREE.Vector3 }[] = [];
  const labels = document.createElement('div'); labels.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:4;font:600 11px/1.25 "Noto Sans KR",sans-serif;color:#d8ecff';
  app.appendChild(labels);
  let z = 0, maxW = 0;
  const rows = ORDER.map(c => hulls.filter(h => h.classId === c)).filter(r => r.length);
  for (const row of rows) {
    const L = SHIP_CLASSES[row[0].classId].length;
    let x = 0;
    const placed: ShipModel[] = [];
    for (const h of row) {
      const variant = `${h.id}_std`;
      const p = Object.values(CONTENT.presets).find(q => q.variant === variant);
      const lo = shipLoadout({ classId: h.classId, loadoutId: '', variant, fitting: { hp: { ...(p?.weapons ?? {}) }, bay: {} } });
      const m = buildShip(SHIP_CLASSES[h.classId], lo, team);
      const w = Math.max(L * 0.42, 16);
      m.root.position.set(x, 0, z); scene.add(m.root); placed.push(m);
      for (const e of m.engines) { e.plume.scale.z = e.base * 5; e.glow.scale.setScalar(e.base); }
      const label = document.createElement('div'); label.style.cssText = 'position:absolute;transform:translate(-50%,0);text-align:center;white-space:nowrap;text-shadow:0 0 4px #000,0 0 2px #000';
      label.innerHTML = `${h.name}<br><span style="font-weight:400;color:#8fb3cc">${h.maker ?? ''}</span>`;
      labels.appendChild(label);
      models.push({ m, label, anchor: new THREE.Vector3(x, -L * 0.12 - 2, z - L * 0.55) });
      x += w;
    }
    const off = -(x - Math.max(L * 0.42, 16)) / 2;
    for (const m of placed) m.root.position.x += off;
    for (const o of models.slice(-placed.length)) o.anchor.x += off;
    maxW = Math.max(maxW, x);
    z -= L * 1.25 + 12;
  }
  const bb = new THREE.Box3(); for (const o of models) bb.expandByObject(o.m.root);
  const center = bb.getCenter(new THREE.Vector3()), R = bb.getSize(new THREE.Vector3()).length() / 2;
  const camera = new THREE.PerspectiveCamera(32, 1, 0.5, 20000);
  const view = params.get('view') ?? 'three';
  const k = Number(params.get('dist') ?? 1);
  const dir = view === 'top' ? new THREE.Vector3(0, 1, 0.001) : view === 'side' ? new THREE.Vector3(1, 0.12, 0) : new THREE.Vector3(0.45, 0.62, 0.65);
  camera.position.copy(center).addScaledVector(dir.normalize(), R * 1.9 * k);
  const cz = center.z;
  const ctl = new OrbitControls(camera, canvas); ctl.target.copy(center); ctl.update(); void cz;
  const resize = () => { const w = innerWidth, hh = innerHeight; renderer.setSize(w, hh, false); canvas.style.width = w + 'px'; canvas.style.height = hh + 'px'; camera.aspect = w / hh; camera.updateProjectionMatrix(); };
  addEventListener('resize', resize); resize();
  const v = new THREE.Vector3();
  let t = 0;
  const frame = () => {
    t += 0.016;
    for (const o of models) {
      for (const tv of o.m.turrets) if (tv.rotates) tv.root.rotation.y = tv.mount.facing * Math.PI / 180 + Math.sin(t * 0.6 + o.anchor.x) * 0.35;
      v.copy(o.anchor).project(camera);
      const on = v.z < 1 && !params.has('nolabel');
      o.label.style.display = on ? '' : 'none';
      if (on) { o.label.style.left = `${(v.x * 0.5 + 0.5) * innerWidth}px`; o.label.style.top = `${(-v.y * 0.5 + 0.5) * innerHeight}px`; }
    }
    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  };
  frame();
  (window as any).__lineup = { n: models.length, camera, ctl, scene };
}

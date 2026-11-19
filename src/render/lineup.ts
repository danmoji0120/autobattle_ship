// Hull lineup — a content author's comparison screen, not part of the game (docs/P17_3_1_POLISH.md).
//   ?lineup=p17                         every P17 hull, rows by class, wrapped to fit the screen
//   &mode=grid|class|scale|close         grid (default) · class: one class (or &cls=a,b) per screen · scale: one
//                                        hull per class side by side at true scale · close: a single hull (&ids=x)
//   &cls=a,b  &ids=a,b                  filters        &view=three|top|side|front|rear   &dist=k (camera factor)
//   &sil                                silhouette: one flat grey material, no glow, plain lighting
//   &team=1  &nolabel  &lineup=all (every hull, not only P17)
// The camera is fitted to the bounding box of what is shown; labels are laid out in screen space so they never
// overlap each other or leave the screen.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { CONTENT } from '../content/registry';
import { SHIP_CLASSES } from '../sim/data/ships';
import { shipLoadout } from '../world/fitting';
import { buildShip, type ShipModel } from './shipMesh';

const ORDER = ['corvette', 'frigate', 'destroyer', 'light_cruiser', 'cruiser', 'battlecruiser', 'battleship', 'dreadnought', 'carrier'];
const CLASS_KO: Record<string, string> = { corvette: '초계함', frigate: '호위함', destroyer: '구축함', light_cruiser: '경순양함', cruiser: '중순양함', battlecruiser: '순양전함', battleship: '전함', dreadnought: '드레드노트', carrier: '항모' };

interface Placed { m: ShipModel; label: HTMLDivElement; anchor: THREE.Vector3; box: THREE.Box3 }

export function startLineup(app: HTMLElement, canvas: HTMLCanvasElement, params: URLSearchParams) {
  canvas.style.visibility = 'visible';
  const team = params.get('team') === '1' ? 1 : 0;
  const mode = params.get('mode') ?? 'grid';
  const sil = params.has('sil');
  const ids = params.get('ids')?.split(',').filter(Boolean);
  const cls = params.get('cls')?.split(',');
  let hulls = Object.values(CONTENT.hulls)
    .filter(h => h.id.startsWith(params.get('lineup') === 'all' ? '' : 'p17_') && !h.dev && !h.exclusive && SHIP_CLASSES[h.classId])
    .filter(h => (!ids || ids.includes(h.id)) && (!cls || cls.includes(h.classId)))
    .sort((a, b) => ORDER.indexOf(a.classId) - ORDER.indexOf(b.classId) || SHIP_CLASSES[a.classId].length - SHIP_CLASSES[b.classId].length || a.id.localeCompare(b.id));
  if (mode === 'scale') hulls = ORDER.map(c => hulls.find(h => h.classId === c)).filter((h): h is NonNullable<typeof h> => !!h);
  if (mode === 'close') hulls = hulls.slice(0, 1);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(2, devicePixelRatio));
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(sil ? 0xe9edf2 : 0x04070c);
  if (!sil) {
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture; scene.environmentIntensity = 0.32;
    scene.add(new THREE.HemisphereLight(0x3a4a6a, 0x0a0608, 0.55), new THREE.AmbientLight(0x202838, 0.35));
    const sun = new THREE.DirectionalLight(0xfff0dc, 2.6); sun.position.set(60, 90, 40); scene.add(sun);
    const fill = new THREE.DirectionalLight(0x5070c0, 0.9); fill.position.set(-60, 20, -50); scene.add(fill);
  } else {
    // silhouette: one even light so only the shape reads (maker colour, panel texture and glow all removed)
    scene.add(new THREE.HemisphereLight(0xffffff, 0x9098a0, 1.6));
    const key = new THREE.DirectionalLight(0xffffff, 0.8); key.position.set(30, 80, 50); scene.add(key);
  }
  const grey = new THREE.MeshLambertMaterial({ color: 0x3a3f46 });

  const labels = document.createElement('div');
  labels.style.cssText = `position:fixed;inset:0;pointer-events:none;z-index:4;font:600 11px/1.25 "Noto Sans KR",sans-serif;color:${sil ? '#1b2430' : '#d8ecff'}`;
  app.appendChild(labels);

  const build = (h: (typeof hulls)[number]): ShipModel => {
    const variant = `${h.id}_std`;
    const p = Object.values(CONTENT.presets).find(q => q.variant === variant);
    const lo = shipLoadout({ classId: h.classId, loadoutId: '', variant, fitting: { hp: { ...(p?.weapons ?? {}) }, bay: {} } });
    const m = buildShip(SHIP_CLASSES[h.classId], lo, team);
    for (const e of m.engines) { e.plume.scale.z = e.base * 5; e.glow.scale.setScalar(e.base); }
    if (sil) {
      const fx = new Set<THREE.Object3D>([...m.engines.flatMap(e => [e.plume, e.glow]), ...m.lights]);
      m.root.traverse(o => { if (fx.has(o)) o.visible = false; else if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).material = grey; });
    }
    return m;
  };

  // ---- layout in the screen plane: H = screen right, U = screen up (world axes for the chosen view). Ships go in
  // rows along H (a new row per class unless `scale`), rows wrap at a width that keeps the sheet near the screen's
  // aspect, and rows stack downwards along -U. Every placement uses the hull's real bounding box.
  const view = params.get('view') ?? (mode === 'scale' ? 'side' : 'three');
  const DIRS: Record<string, THREE.Vector3> = {
    top: new THREE.Vector3(0, 1, 0.001), side: new THREE.Vector3(1, 0.1, 0), front: new THREE.Vector3(0.05, 0.1, 1),
    rear: new THREE.Vector3(0.05, 0.15, -1), three: new THREE.Vector3(0.62, 0.62, 0.48),
  };
  const dir = (DIRS[view] ?? DIRS.three).clone().normalize();
  // three: the sheet lies flat (y = 0) with H across the screen and U pointing away from the camera
  const h3 = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), dir).normalize();
  const AX: Record<string, [THREE.Vector3, THREE.Vector3]> = {        // [H, U] per view
    top: [new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 0, 1)], three: [h3, new THREE.Vector3(-dir.x, 0, -dir.z).normalize()],
    side: [new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 1, 0)], front: [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0)],
    rear: [new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 1, 0)],
  };
  const [H, U] = AX[view] ?? AX.three;
  const ext = (b: THREE.Box3, a: THREE.Vector3) => { const s = b.getSize(new THREE.Vector3()); return Math.abs(s.x * a.x) + Math.abs(s.y * a.y) + Math.abs(s.z * a.z); };
  const lo = (b: THREE.Box3, a: THREE.Vector3) => b.getCenter(new THREE.Vector3()).dot(a) - ext(b, a) / 2;
  const placed: Placed[] = [];
  const norm = mode === 'grid' && !params.has('true');
  const groups: (typeof hulls)[] = mode === 'scale' || mode === 'close' || norm ? [hulls] : ORDER.map(c => hulls.filter(h => h.classId === c)).filter(r => r.length);
  const aspect = innerWidth / Math.max(1, innerHeight);
  // grid: every hull scaled to the same cell so 36 hulls stay legible on one screen (labels give the real length);
  // class / scale / close and &true keep true scale
  const all = groups.map(g => g.map(h => {
    const m = build(h); m.root.updateMatrixWorld(true);
    let box = new THREE.Box3().setFromObject(m.root);
    if (norm) { const sz = box.getSize(new THREE.Vector3()); m.root.scale.setScalar(40 / Math.max(sz.x, sz.z)); m.root.updateMatrixWorld(true); box = new THREE.Box3().setFromObject(m.root); }
    return { h, m, box };
  }));
  const pad = (o: { box: THREE.Box3 }) => Math.max(3, ext(o.box, H) * 0.25, ext(o.box, U) * 0.06);
  const area = all.flat().reduce((a, o) => a + (ext(o.box, H) + pad(o)) * (ext(o.box, U) * 1.35 + 8), 0) * (norm ? 0.8 : 1);
  const maxRowW = mode === 'scale' || mode === 'close' ? Infinity : Math.max(Math.sqrt(area * aspect) * 1.05, ...all.flat().map(o => ext(o.box, H) + pad(o)));
  let vCursor = 0;
  for (const models of all) {
    let row: typeof models = [], w = 0;
    const flush = () => {
      if (!row.length) return;
      const widths = row.map(o => ext(o.box, H) + pad(o));
      const total = widths.reduce((a, b) => a + b, 0), rowH = Math.max(...row.map(o => ext(o.box, U)));
      let h = -total / 2;
      row.forEach((o, i) => {
        // H: centred in its cell; U: tops aligned on the row line (side view: keels differ, so align on top deck;
        // top view: bows on one line, so lengths compare directly)
        const dh = h + widths[i] / 2 - (lo(o.box, H) + ext(o.box, H) / 2);
        const du = vCursor - (lo(o.box, U) + ext(o.box, U));
        o.m.root.position.addScaledVector(H, dh).addScaledVector(U, du); scene.add(o.m.root); o.m.root.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(o.m.root);
        const c = box.getCenter(new THREE.Vector3());
        const anchor = c.clone().addScaledVector(U, lo(box, U) - c.dot(U));
        const label = document.createElement('div');
        label.style.cssText = 'position:absolute;text-align:center;white-space:nowrap;' + (sil ? '' : 'text-shadow:0 0 4px #000,0 0 2px #000');
        const L = SHIP_CLASSES[o.h.classId].length;
        label.innerHTML = `${o.h.name}<br><span style="font-weight:400;opacity:.75">${mode === 'scale' || norm ? `${CLASS_KO[o.h.classId]} · ${L}m` : ''}${mode === 'scale' || norm ? '' : (o.h.maker ?? '')}</span>`;
        labels.appendChild(label);
        placed.push({ m: o.m, label, anchor, box });
        h += widths[i];
      });
      vCursor -= rowH * 1.35 + 8;
      row = []; w = 0;
    };
    for (const o of models) {
      const ow = ext(o.box, H) + pad(o);
      if (row.length && w + ow > maxRowW) flush();
      row.push(o); w += ow;
    }
    flush();
  }

  // ---- camera fitted to the bounding box from the chosen direction
  const bb = new THREE.Box3(); for (const o of placed) bb.union(o.box);
  const center = bb.getCenter(new THREE.Vector3());
  const camera = new THREE.PerspectiveCamera(30, aspect, 0.5, 40000);
  const k = Number(params.get('dist') ?? (mode === 'close' ? 0.8 : 1));
  const corners: THREE.Vector3[] = [];
  for (const o of placed) for (let i = 0; i < 8; i++) corners.push(new THREE.Vector3(i & 1 ? o.box.max.x : o.box.min.x, i & 2 ? o.box.max.y : o.box.min.y, i & 4 ? o.box.max.z : o.box.min.z));
  const fit = () => {
    // fit every hull's box corners (not the union box: on a turned sheet that is mostly empty space)
    const up = Math.abs(dir.y) > 0.99 ? U.clone() : new THREE.Vector3(0, 1, 0);
    camera.up.copy(up);
    const right = new THREE.Vector3().crossVectors(up, dir).normalize(), u = new THREE.Vector3().crossVectors(dir, right);
    let r0 = Infinity, r1 = -Infinity, u0 = Infinity, u1 = -Infinity;
    for (const c of corners) { const a = c.dot(right), b = c.dot(u); r0 = Math.min(r0, a); r1 = Math.max(r1, a); u0 = Math.min(u0, b); u1 = Math.max(u1, b); }
    center.addScaledVector(right, (r0 + r1) / 2 - center.dot(right)).addScaledVector(u, (u0 + u1) / 2 - center.dot(u));
    const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)), tanH = tanV * camera.aspect;
    let d = 1;
    for (const p of corners) {
      const c = p.clone().sub(center), along = c.dot(dir);
      // leave room under the hulls for the labels (≈ 7 % of the frame)
      d = Math.max(d, along + Math.abs(c.dot(right)) / (tanH * 0.96), along + Math.abs(c.dot(u)) / (tanV * 0.86));
    }
    camera.position.copy(center).addScaledVector(dir, d * k);
    camera.lookAt(center);
  };
  const resize = () => { const w = innerWidth, hh = innerHeight; renderer.setSize(w, hh, false); canvas.style.width = w + 'px'; canvas.style.height = hh + 'px'; camera.aspect = w / hh; camera.updateProjectionMatrix(); };
  resize(); fit();
  const ctl = new OrbitControls(camera, canvas); ctl.target.copy(center); ctl.update();
  addEventListener('resize', () => { resize(); });

  // ---- labels: anchored under each hull, then pushed apart in screen space and clamped to the screen
  const v = new THREE.Vector3();
  const layoutLabels = () => {
    const rects: { x: number; y: number; w: number; h: number }[] = [];
    const items = placed.map(o => {
      v.copy(o.anchor).project(camera);
      const on = v.z < 1 && !params.has('nolabel');
      return { o, on, x: (v.x * 0.5 + 0.5) * innerWidth, y: (-v.y * 0.5 + 0.5) * innerHeight + 4 };
    }).sort((a, b) => a.y - b.y || a.x - b.x);
    for (const it of items) {
      it.o.label.style.display = it.on ? '' : 'none';
      if (!it.on) continue;
      const w = it.o.label.offsetWidth || 80, h = it.o.label.offsetHeight || 28;
      let x = Math.min(Math.max(4, it.x - w / 2), innerWidth - w - 4), y = Math.min(Math.max(4, it.y), innerHeight - h - 4);
      for (let guard = 0; guard < 40; guard++) {
        const hit = rects.find(r => x < r.x + r.w + 4 && x + w + 4 > r.x && y < r.y + r.h + 2 && y + h + 2 > r.y);
        if (!hit) break;
        y = hit.y + hit.h + 2;
        if (y + h > innerHeight - 4) { y = Math.max(4, it.y - h - 8); x = Math.min(hit.x + hit.w + 6, innerWidth - w - 4); }
      }
      rects.push({ x, y, w, h });
      it.o.label.style.left = `${x}px`; it.o.label.style.top = `${y}px`;
    }
  };
  let t = 0;
  const frame = () => {
    t += 0.016;
    if (!params.has('still')) for (const o of placed) for (const tv of o.m.turrets) if (tv.rotates) tv.root.rotation.y = tv.mount.facing * Math.PI / 180 + Math.sin(t * 0.6 + o.anchor.x) * 0.35;
    layoutLabels();
    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  };
  frame();
  (window as any).__lineup = { n: placed.length, camera, ctl, scene, mode };
}

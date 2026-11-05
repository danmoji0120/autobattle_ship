import * as THREE from 'three';
import type { Field, Station, Lair } from '../../world/types';
import { rockPos, modulePos } from '../../world/geom';

// ------------------------------------------------------------------ materials

function windowTex(seed: number, warm = true): THREE.CanvasTexture {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = '#000'; g.fillRect(0, 0, 256, 256);
  let r = seed; const rnd = () => ((r = (r * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < 120; i++) {
    g.fillStyle = rnd() < (warm ? 0.75 : 0.3) ? `rgba(255,${200 + rnd() * 40},${140 + rnd() * 60},1)` : 'rgba(150,220,255,1)';
    g.fillRect(Math.floor(rnd() * 64) * 4, Math.floor(rnd() * 64) * 4, 2, 1);
  }
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(4, 4); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

let M: ReturnType<typeof makeMats> | null = null;
function makeMats() {
  const win = windowTex(7);
  return {
    hull: new THREE.MeshStandardMaterial({ color: 0x5e6670, roughness: 0.6, metalness: 0.7, emissive: 0xffffff, emissiveMap: win, emissiveIntensity: 0.45 }),
    hullDark: new THREE.MeshStandardMaterial({ color: 0x4a525e, roughness: 0.7, metalness: 0.6 }),
    trim: new THREE.MeshStandardMaterial({ color: 0x8090a4, roughness: 0.35, metalness: 0.85 }),
    glowCyan: new THREE.MeshBasicMaterial({ color: new THREE.Color(0x60d8ff).multiplyScalar(1.3) }),
    glowWarm: new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffa040).multiplyScalar(2.4) }),
    glowRed: new THREE.MeshBasicMaterial({ color: new THREE.Color(0xff3020).multiplyScalar(2.6) }),
    glowGreen: new THREE.MeshBasicMaterial({ color: new THREE.Color(0x60ffa0).multiplyScalar(2.2) }),
    holo: new THREE.MeshBasicMaterial({ color: 0x40c8ff, transparent: true, opacity: 0.18, wireframe: true, depthWrite: false, blending: THREE.AdditiveBlending }),
    holoSolid: new THREE.MeshBasicMaterial({ color: 0x2aa0e0, transparent: true, opacity: 0.08, depthWrite: false, blending: THREE.AdditiveBlending }),
    rock: new THREE.MeshStandardMaterial({ color: 0x6a5a4c, roughness: 0.95, metalness: 0.15, flatShading: true }),
    rockDark: new THREE.MeshStandardMaterial({ color: 0x3a3a44, roughness: 0.9, metalness: 0.3, flatShading: true }),
    crystal: new THREE.MeshStandardMaterial({ color: 0x80e0ff, roughness: 0.15, metalness: 0.2, emissive: 0x2aa8ff, emissiveIntensity: 1.6, flatShading: true }),
    ore: new THREE.MeshStandardMaterial({ color: 0xe0a060, roughness: 0.4, metalness: 0.8, emissive: 0x6a3008, emissiveIntensity: 0.6, flatShading: true }),
    scrap: new THREE.MeshStandardMaterial({ color: 0x3a3634, roughness: 0.8, metalness: 0.6, emissive: 0x401000, emissiveIntensity: 0.8 }),
    pirate: new THREE.MeshStandardMaterial({ color: 0x3a2a28, roughness: 0.8, metalness: 0.5, flatShading: true }),
  };
}
export function mats() { return (M ??= makeMats()); }

const tr = (g: THREE.BufferGeometry, x: number, y: number, z: number) => { g.translate(x, y, z); return g; };
const mesh = (g: THREE.BufferGeometry, m: THREE.Material) => new THREE.Mesh(g, m);

// ------------------------------------------------------------------ public stations

export interface StationView { root: THREE.Group; spin: THREE.Object3D[]; modules: Map<number, { obj: THREE.Group; built: boolean; progress: number; kind: string }>; station: Station; lights: THREE.Mesh[] }

export function buildStation(s: Station): StationView {
  const m = mats();
  const root = new THREE.Group();
  root.position.set(s.pos.x, s.pos.y, s.pos.z);
  const spin: THREE.Object3D[] = [];
  const lights: THREE.Mesh[] = [];
  const light = (x: number, y: number, z: number, mat = m.glowRed, r = 3) => { const l = mesh(new THREE.SphereGeometry(r, 8, 6), mat); l.position.set(x, y, z); root.add(l); lights.push(l); };
  if (s.style === 0) {
    // free port: spine + rotating habitat ring + docking arms
    root.add(mesh(new THREE.CylinderGeometry(34, 40, 300, 16), m.hull));
    root.add(mesh(tr(new THREE.CylinderGeometry(60, 60, 40, 16), 0, 60, 0), m.trim));
    root.add(mesh(tr(new THREE.CylinderGeometry(70, 50, 30, 16), 0, -150, 0), m.hullDark));
    const ring = new THREE.Group();
    ring.add(mesh(new THREE.TorusGeometry(200, 20, 12, 64).rotateX(Math.PI / 2), m.hull));
    for (let i = 0; i < 6; i++) { const sp = mesh(new THREE.BoxGeometry(170, 8, 12), m.trim); sp.rotation.y = i * Math.PI / 3; sp.position.set(Math.cos(-i * Math.PI / 3) * 85, 0, Math.sin(-i * Math.PI / 3) * 85); ring.add(sp); }
    ring.add(mesh(new THREE.TorusGeometry(200, 3, 6, 64).rotateX(Math.PI / 2).translate(0, 22, 0), m.glowCyan));
    root.add(ring); spin.push(ring);
    for (let i = 0; i < 4; i++) {
      const a = i * Math.PI / 2 + Math.PI / 4;
      const arm = mesh(new THREE.BoxGeometry(14, 10, 140), m.hullDark);
      arm.position.set(Math.cos(a) * 120, -90, Math.sin(a) * 120); arm.lookAt(0, -90, 0);
      root.add(arm);
      light(Math.cos(a) * 190, -90, Math.sin(a) * 190, m.glowGreen);
    }
    for (let i = 0; i < 8; i++) { const ant = mesh(new THREE.CylinderGeometry(1.2, 1.2, 70), m.trim); ant.position.set(Math.cos(i) * 20, 185, Math.sin(i) * 20); root.add(ant); }
    light(0, 222, 0);
  } else if (s.style === 1) {
    // shipyard: open gantries with a hull under construction
    root.add(mesh(new THREE.BoxGeometry(120, 80, 160), m.hull));
    for (const side of [-1, 1]) {
      for (let i = 0; i < 6; i++) {
        root.add(mesh(tr(new THREE.BoxGeometry(8, 160, 8), side * 120, 0, -200 - i * 70), m.trim));
        root.add(mesh(tr(new THREE.BoxGeometry(8, 8, 70), side * 120, 80, -235 - i * 70), m.trim));
        root.add(mesh(tr(new THREE.BoxGeometry(8, 8, 70), side * 120, -80, -235 - i * 70), m.trim));
        light(side * 120, 84, -200 - i * 70, m.glowWarm, 2.5);
      }
    }
    for (let i = 0; i < 6; i++) root.add(mesh(tr(new THREE.BoxGeometry(248, 6, 6), 0, 80, -200 - i * 70), m.trim));
    const hullShape = mesh(tr(new THREE.BoxGeometry(60, 40, 300), 0, -10, -380), m.hullDark);
    root.add(hullShape);
    root.add(mesh(tr(new THREE.CylinderGeometry(50, 50, 30, 16).rotateX(Math.PI / 2), 0, 0, 95), m.trim));
    root.add(mesh(tr(new THREE.TorusGeometry(70, 4, 6, 40), 0, 0, 112), m.glowCyan));
    light(0, 50, 80);
  } else if (s.style === 2) {
    // refinery: spherical tanks, furnace stack
    root.add(mesh(new THREE.CylinderGeometry(50, 60, 120, 12), m.hullDark));
    for (let i = 0; i < 6; i++) {
      const a = i * Math.PI / 3;
      root.add(mesh(tr(new THREE.SphereGeometry(42, 20, 14), Math.cos(a) * 120, (i % 2) * 40 - 20, Math.sin(a) * 120), m.hull));
      root.add(mesh(tr(new THREE.CylinderGeometry(6, 6, 120).rotateZ(Math.PI / 2).rotateY(-a), Math.cos(a) * 60, 0, Math.sin(a) * 60), m.trim));
    }
    root.add(mesh(tr(new THREE.CylinderGeometry(22, 30, 200, 12), 0, 150, 0), m.hullDark));
    const furnace = mesh(tr(new THREE.CylinderGeometry(20, 20, 10, 12), 0, 252, 0), m.glowWarm);
    root.add(furnace);
    root.add(mesh(tr(new THREE.TorusGeometry(64, 5, 6, 40).rotateX(Math.PI / 2), 0, -40, 0), m.glowWarm));
    light(0, 270, 0);
  }
  return { root, spin, modules: new Map(), station: s, lights };
}

// ------------------------------------------------------------------ player stations (modular)

/** facility kinds share a handful of silhouettes; size tells yard classes apart */
const LOOK: Record<string, [string, number]> = {
  yard_s: ['shipyard', 0.8], yard_m: ['shipyard', 1.05], yard_l: ['shipyard', 1.35], yard_xl: ['shipyard', 1.7], fitting: ['shipyard', 0.6],
  warehouse: ['depot', 1], dock: ['depot', 0.8], armory: ['depot', 0.7], hangar: ['depot', 1.1],
  smelter: ['refinery', 0.9], alloy_plant: ['refinery', 1], rare_refinery: ['refinery', 0.85], gas_plant: ['refinery', 0.9], composite_plant: ['refinery', 1],
  machine_shop: ['factory', 0.9], hull_works: ['factory', 1.1], electronics_fab: ['factory', 0.85], engine_plant: ['factory', 1], reactor_plant: ['factory', 1.05], weapons_factory: ['factory', 1], armor_plant: ['factory', 1],
  lab_basic: ['lab', 0.85], lab_materials: ['lab', 0.9], lab_propulsion: ['lab', 0.9], lab_electronics: ['lab', 0.9], lab_weapons: ['lab', 0.95], design_bureau: ['lab', 1.05], lab_industry: ['lab', 0.9], lab_tactics: ['lab', 0.85],
  logistics: ['depot', 0.9], trade_hub: ['lab', 0.8], comms: ['comms', 1], habitat: ['habitat', 1], power: ['power', 1],
};

function moduleMesh(kind: string): THREE.Group {
  const m = mats();
  const g = new THREE.Group();
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material) => { g.add(mesh(geo, mat)); };
  const look = Object.hasOwn(LOOK, kind) ? LOOK[kind] : undefined;
  if (look && look[0] !== kind) { const inner = moduleMesh(look[0]); inner.scale.setScalar(look[1]); g.add(inner); return g; }
  switch (kind) {
    case 'factory':
      add(new THREE.BoxGeometry(60, 34, 44), m.hull);
      add(tr(new THREE.BoxGeometry(62, 6, 46), 0, 20, 0), m.trim);
      for (const x of [-18, 0, 18]) add(tr(new THREE.CylinderGeometry(5, 6, 30, 8), x, 34, -10), m.hullDark);
      add(tr(new THREE.BoxGeometry(40, 4, 4), 0, 4, 23), m.glowWarm);
      break;
    case 'lab':
      add(new THREE.CylinderGeometry(32, 36, 22, 12), m.hullDark);
      add(tr(new THREE.SphereGeometry(28, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), 0, 11, 0), m.hull);
      add(tr(new THREE.CylinderGeometry(1.5, 1.5, 50), 0, 50, 0), m.trim);
      add(tr(new THREE.SphereGeometry(4, 8, 6), 0, 76, 0), m.glowCyan);
      break;
    case 'power':
      add(new THREE.CylinderGeometry(18, 18, 50, 12), m.hullDark);
      add(tr(new THREE.TorusGeometry(36, 7, 10, 32).rotateX(Math.PI / 2), 0, 0, 0), m.hull);
      add(tr(new THREE.TorusGeometry(36, 2, 6, 32).rotateX(Math.PI / 2), 0, 8, 0), m.glowCyan);
      add(tr(new THREE.SphereGeometry(12, 12, 8), 0, 30, 0), m.glowWarm);
      break;
    case 'comms':
      add(new THREE.BoxGeometry(24, 20, 24), m.hullDark);
      add(tr(new THREE.CylinderGeometry(1.5, 1.5, 70), 0, 45, 0), m.trim);
      add(tr(new THREE.CylinderGeometry(26, 4, 10, 16, 1, true), 0, 30, 0), m.hull);
      add(tr(new THREE.SphereGeometry(3, 8, 6), 0, 82, 0), m.glowRed);
      break;
    case 'habitat':
      add(tr(new THREE.TorusGeometry(40, 9, 10, 36).rotateX(Math.PI / 2), 0, 0, 0), m.hull);
      for (let i = 0; i < 4; i++) { const a = i * Math.PI / 2; add(tr(new THREE.BoxGeometry(40, 3, 3).rotateY(-a), Math.cos(a) * 20, 0, Math.sin(a) * 20), m.trim); }
      add(tr(new THREE.TorusGeometry(40, 2, 6, 36).rotateX(Math.PI / 2), 0, 8, 0), m.glowGreen);
      break;
    case 'core':
      add(new THREE.CylinderGeometry(55, 55, 70, 6), m.hull);
      add(tr(new THREE.CylinderGeometry(30, 55, 30, 6), 0, 50, 0), m.trim);
      add(tr(new THREE.CylinderGeometry(70, 70, 10, 24), 0, -40, 0), m.hullDark);
      add(tr(new THREE.TorusGeometry(110, 5, 8, 48).rotateX(Math.PI / 2), 0, 0, 0), m.trim);
      add(tr(new THREE.TorusGeometry(110, 1.5, 6, 48).rotateX(Math.PI / 2), 0, 7, 0), m.glowCyan);
      for (let i = 0; i < 6; i++) { const a = i * Math.PI / 3; add(tr(new THREE.BoxGeometry(60, 5, 5).rotateY(-a), Math.cos(a) * 80, 0, Math.sin(a) * 80), m.trim); }
      add(tr(new THREE.CylinderGeometry(1, 1, 60), 0, 95, 0), m.trim);
      break;
    case 'repair':
      add(new THREE.BoxGeometry(50, 30, 50), m.hull);
      for (const s of [-1, 1]) { add(tr(new THREE.BoxGeometry(6, 6, 70), s * 22, 18, 30), m.trim); add(tr(new THREE.BoxGeometry(10, 10, 10), s * 22, 18, 68), m.glowGreen); }
      break;
    case 'refinery':
      add(new THREE.SphereGeometry(28, 16, 12), m.hull);
      add(tr(new THREE.SphereGeometry(20, 14, 10), 30, -10, 10), m.hull);
      add(tr(new THREE.CylinderGeometry(10, 14, 60, 10), -20, 30, -10), m.hullDark);
      add(tr(new THREE.CylinderGeometry(9, 9, 6, 10), -20, 62, -10), m.glowWarm);
      break;
    case 'defense':
      add(new THREE.CylinderGeometry(30, 36, 18, 8), m.hullDark);
      add(tr(new THREE.BoxGeometry(26, 14, 26), 0, 16, 0), m.hull);
      for (const x of [-6, 6]) add(tr(new THREE.CylinderGeometry(2, 2.5, 50).rotateX(Math.PI / 2), x, 18, 30), m.trim);
      add(tr(new THREE.BoxGeometry(4, 4, 4), 0, 26, 0), m.glowRed);
      break;
    case 'shipyard':
      for (let i = 0; i < 4; i++) { add(tr(new THREE.BoxGeometry(6, 70, 6), -40, 0, -60 + i * 40), m.trim); add(tr(new THREE.BoxGeometry(6, 70, 6), 40, 0, -60 + i * 40), m.trim); add(tr(new THREE.BoxGeometry(86, 6, 6), 0, 35, -60 + i * 40), m.trim); }
      add(tr(new THREE.BoxGeometry(86, 6, 130), 0, -35, -0), m.hullDark);
      add(tr(new THREE.BoxGeometry(30, 4, 4), 0, 38, 0), m.glowWarm);
      break;
    case 'depot':
      for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) add(tr(new THREE.BoxGeometry(18, 18, 30), -20 + i * 20, -10 + j * 20, 0), (i + j) % 2 ? m.hull : m.hullDark);
      break;
  }
  return g;
}

export function syncPlayerStation(v: StationView, s: Station) {
  for (const mod of s.modules) {
    let mv = v.modules.get(mod.slot);
    if (!mv || mv.kind !== mod.kind) {
      if (mv) v.root.remove(mv.obj);
      const obj = new THREE.Group();
      const holo = moduleMesh(mod.kind); holo.name = 'holo';
      holo.traverse(o => { const me = o as THREE.Mesh; if (me.isMesh) me.material = mats().holo; });
      const solid = moduleMesh(mod.kind); solid.name = 'solid';
      obj.add(holo, solid);
      const p = modulePos(s, mod.slot);
      obj.position.set(p.x - s.pos.x, p.y - s.pos.y, p.z - s.pos.z);
      if (mod.slot) obj.lookAt(0, obj.position.y, 0);
      v.root.add(obj);
      mv = { obj, built: !mod.built, progress: -1, kind: mod.kind };
      v.modules.set(mod.slot, mv);
      if (mod.slot) {
        const len = Math.hypot(obj.position.x, obj.position.z) - 60;
        const truss = mesh(new THREE.BoxGeometry(5, 5, len), mats().trim);
        truss.position.set(obj.position.x / 2, obj.position.y / 2, obj.position.z / 2);
        truss.lookAt(0, 0, 0);
        v.root.add(truss);
      }
    }
    if (mv.built !== mod.built || Math.abs(mv.progress - mod.progress) > 0.005) {
      mv.built = mod.built; mv.progress = mod.progress;
      // under construction: wireframe hologram, with the finished part growing solid from below
      const holo = mv.obj.getObjectByName('holo')!, solid = mv.obj.getObjectByName('solid')!;
      holo.visible = !mod.built;
      const k = mod.built ? 1 : Math.max(0.02, mod.progress);
      solid.scale.set(1, k, 1);
      solid.position.y = mod.built ? 0 : -35 * (1 - k);
    }
  }
}

export function buildPlayerStation(s: Station): StationView {
  const root = new THREE.Group();
  root.position.set(s.pos.x, s.pos.y, s.pos.z);
  const v: StationView = { root, spin: [], modules: new Map(), station: s, lights: [] };
  syncPlayerStation(v, s);
  return v;
}

// ------------------------------------------------------------------ lairs

export function buildLair(l: Lair): THREE.Group {
  const m = mats();
  const g = new THREE.Group();
  g.position.set(l.pos.x, l.pos.y, l.pos.z);
  const rock = new THREE.IcosahedronGeometry(160, 1);
  const pos = rock.getAttribute('position');
  for (let i = 0; i < pos.count; i++) { const k = 0.75 + Math.abs(Math.sin(i * 12.9898) * 0.5); pos.setXYZ(i, pos.getX(i) * k, pos.getY(i) * k * 0.8, pos.getZ(i) * k); }
  rock.computeVertexNormals();
  g.add(mesh(rock, m.pirate));
  for (let i = 0; i < 9; i++) {
    const a = i / 9 * Math.PI * 2;
    const spike = mesh(new THREE.ConeGeometry(10, 120, 5), m.hullDark);
    spike.position.set(Math.cos(a) * 150, (i % 3 - 1) * 40, Math.sin(a) * 150);
    spike.lookAt(spike.position.clone().multiplyScalar(2));
    spike.rotateX(Math.PI / 2);
    g.add(spike);
  }
  for (let i = 0; i < 12; i++) { const l2 = mesh(new THREE.SphereGeometry(4, 6, 4), m.glowRed); const a = i * 0.9; l2.position.set(Math.cos(a) * 170, Math.sin(i) * 60, Math.sin(a) * 170); g.add(l2); }
  g.add(mesh(tr(new THREE.BoxGeometry(40, 30, 200), 0, 120, 0), m.hullDark));
  return g;
}

// ------------------------------------------------------------------ asteroid fields

export interface FieldView { group: THREE.Group; rocks: THREE.InstancedMesh; shards: THREE.InstancedMesh | null; lastFrac: number; field: Field }

const rockGeo = (() => {
  const g = new THREE.IcosahedronGeometry(1, 1);
  const p = g.getAttribute('position');
  for (let i = 0; i < p.count; i++) { const k = 0.7 + ((Math.sin(i * 78.233) * 43758.5453) % 1 + 1) % 1 * 0.55; p.setXYZ(i, p.getX(i) * k, p.getY(i) * k * 0.8, p.getZ(i) * k); }
  g.computeVertexNormals();
  return g;
})();
const shardGeo = new THREE.OctahedronGeometry(1, 0).scale(0.5, 1.6, 0.5);
const scrapGeo = new THREE.BoxGeometry(1.6, 0.4, 1);

export function buildField(f: Field): FieldView {
  const m = mats();
  const group = new THREE.Group();
  const rocks = new THREE.InstancedMesh(f.salvage ? scrapGeo : rockGeo, f.salvage ? m.scrap : f.res === 'crystal' ? m.rockDark : m.rock, f.rocks);
  const shards = f.salvage ? null : new THREE.InstancedMesh(shardGeo, f.res === 'crystal' ? m.crystal : m.ore, f.rocks * 2);
  group.add(rocks); if (shards) group.add(shards);
  const v: FieldView = { group, rocks, shards, lastFrac: -1, field: f };
  updateField(v, f);
  return v;
}

export function updateField(v: FieldView, f: Field) {
  const frac = Math.max(0, f.amount / f.max);
  if (Math.abs(frac - v.lastFrac) < 0.01) return;
  v.lastFrac = frac;
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), p = new THREE.Vector3();
  const k = 0.35 + 0.65 * Math.sqrt(frac);
  for (let i = 0; i < f.rocks; i++) {
    const r = rockPos(f, i);
    q.setFromEuler(new THREE.Euler(i * 1.3, i * 2.1, i * 0.7));
    const s = r.size * (f.salvage ? Math.max(0.3, k) : 1);
    sc.set(s, s, s);
    p.set(r.x, r.y, r.z);
    m4.compose(p, q, sc);
    v.rocks.setMatrixAt(i, m4);
    if (v.shards) {
      // ore veins / crystals shrink as the field is mined out
      for (let j = 0; j < 2; j++) {
        const a = i * 2.7 + j * 2.1;
        const off = new THREE.Vector3(Math.cos(a), 0.6 + j * 0.3, Math.sin(a)).multiplyScalar(r.size * 0.8);
        const ss = r.size * 0.35 * k * (f.res === 'crystal' ? 1.4 : 0.8);
        q.setFromEuler(new THREE.Euler(a, a * 0.5, 0.4));
        m4.compose(p.clone().add(off), q, sc.set(ss, ss, ss));
        v.shards.setMatrixAt(i * 2 + j, m4);
      }
    }
  }
  v.rocks.instanceMatrix.needsUpdate = true;
  if (v.shards) v.shards.instanceMatrix.needsUpdate = true;
}

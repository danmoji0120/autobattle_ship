import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { ShipClassDef, LoadoutDef, MountDef } from '../sim/data/ships';
import { WEAPONS } from '../sim/data/weapons';

// Ship-local frame: +x port, +y up, +z bow (matches the simulation).

export interface TurretView { root: THREE.Object3D; barrels: THREE.Object3D | null; mount: MountDef; recoil: number; rotates: boolean }
export interface ShipModel {
  root: THREE.Group;          // positioned/rotated by the renderer
  bank: THREE.Group;          // roll for banking
  front: THREE.Group;         // front half (separates on death)
  rear: THREE.Group;
  turrets: TurretView[];
  engines: { glow: THREE.Mesh; plume: THREE.Mesh; base: number }[];
  lights: THREE.Mesh[];
  hullMats: THREE.MeshStandardMaterial[];
  length: number;
}

// -------------------------------------------------------------------------- textures / materials

function panelTexture(seed: number, emissive: boolean): THREE.CanvasTexture {
  const S = 512;
  const c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d')!;
  let r = seed;
  const rnd = () => ((r = (r * 1664525 + 1013904223) >>> 0) / 4294967296);
  if (!emissive) {
    g.fillStyle = '#9a9fa6'; g.fillRect(0, 0, S, S);
    for (let i = 0; i < 140; i++) {
      const w = 30 + rnd() * 140, h = 16 + rnd() * 70, x = rnd() * S, y = rnd() * S;
      const v = 140 + rnd() * 22;
      g.fillStyle = `rgb(${v},${v + 2},${v + 6})`;
      g.fillRect(x, y, w, h);
      g.strokeStyle = 'rgba(40,44,52,0.45)'; g.lineWidth = 1.5; g.strokeRect(x, y, w, h);
    }
    for (let i = 0; i < 40; i++) { g.fillStyle = 'rgba(40,42,48,0.5)'; g.fillRect(rnd() * S, rnd() * S, 2 + rnd() * 50, 2); }
    
  } else {
    g.fillStyle = '#000'; g.fillRect(0, 0, S, S);
    for (let i = 0; i < 90; i++) {
      const x = rnd() * S, y = rnd() * S, n = 2 + Math.floor(rnd() * 8);
      const warm = rnd() < 0.7;
      g.fillStyle = warm ? 'rgba(255,220,160,0.95)' : 'rgba(160,220,255,0.95)';
      for (let k = 0; k < n; k++) g.fillRect(x + k * 5, y, 3, 2);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(1 / 40, 1 / 40);
  t.colorSpace = emissive ? THREE.SRGBColorSpace : THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

interface FactionStyle {
  hull: number; dark: number; accent: number; engine: number; glowMul: number;
}
const STYLE: [FactionStyle, FactionStyle] = [
  { hull: 0xc9d2dc, dark: 0x3a4250, accent: 0x49c6ff, engine: 0x6fd0ff, glowMul: 1 },
  { hull: 0x8a7a72, dark: 0x3a2e2e, accent: 0xff4030, engine: 0xff7a3a, glowMul: 1 },
];

interface Mats { hull: THREE.MeshStandardMaterial; dark: THREE.MeshStandardMaterial; trim: THREE.MeshStandardMaterial; accent: THREE.MeshBasicMaterial; engine: THREE.MeshBasicMaterial; plume: THREE.MeshBasicMaterial; light: THREE.MeshBasicMaterial; gun: THREE.MeshStandardMaterial }
const matCache: Partial<Record<number, Mats>> = {};

function mats(team: 0 | 1): Mats {
  if (matCache[team]) return matCache[team]!;
  const st = STYLE[team];
  const map = panelTexture(team === 0 ? 1234 : 987, false);
  const emap = panelTexture(team === 0 ? 55 : 77, true);
  const m: Mats = {
    hull: new THREE.MeshStandardMaterial({ color: st.hull, map, roughness: 0.55, metalness: 0.55, emissive: 0xffffff, emissiveMap: emap, emissiveIntensity: 0.9 }),
    dark: new THREE.MeshStandardMaterial({ color: st.dark, map, roughness: 0.7, metalness: 0.6 }),
    trim: new THREE.MeshStandardMaterial({ color: team === 0 ? 0x8fa0b4 : 0x4a3a3a, roughness: 0.4, metalness: 0.8 }),
    accent: new THREE.MeshBasicMaterial({ color: new THREE.Color(st.accent).multiplyScalar(1.6) }),
    engine: new THREE.MeshBasicMaterial({ color: new THREE.Color(st.engine).multiplyScalar(2.5) }),
    plume: new THREE.MeshBasicMaterial({ color: st.engine, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
    light: new THREE.MeshBasicMaterial({ color: new THREE.Color(team === 0 ? 0xbfefff : 0xff5040).multiplyScalar(3) }),
    gun: new THREE.MeshStandardMaterial({ color: team === 0 ? 0x5a6470 : 0x3a3234, roughness: 0.45, metalness: 0.85 }),
  };
  matCache[team] = m;
  return m;
}

export const wreckMaterial = new THREE.MeshStandardMaterial({ color: 0x1c1a19, roughness: 0.95, metalness: 0.3, emissive: 0x3a1000, emissiveIntensity: 0.6 });

// -------------------------------------------------------------------------- hull geometry

type Profile = [number, number][]; // [t (-0.5 stern .. 0.5 bow), half-width fraction]

function hw(profile: Profile, t: number): number {
  for (let i = 0; i < profile.length - 1; i++) {
    const [t0, w0] = profile[i], [t1, w1] = profile[i + 1];
    if (t >= t0 && t <= t1) return w0 + (w1 - w0) * (t - t0) / (t1 - t0);
  }
  return t < profile[0][0] ? profile[0][1] : profile[profile.length - 1][1];
}

/** extruded hull slab between t0..t1 of the profile; bottom at y0, height h */
function slab(profile: Profile, L: number, W: number, t0: number, t1: number, y0: number, h: number, bevel = 0.35): THREE.BufferGeometry {
  const ts = new Set<number>([t0, t1]);
  for (const [t] of profile) if (t > t0 && t < t1) ts.add(t);
  const arr = [...ts].sort((a, b) => a - b);
  const shape = new THREE.Shape();
  arr.forEach((t, i) => { const x = Math.max(0.05, hw(profile, t)) * W, y = t * L; if (i === 0) shape.moveTo(x, y); else shape.lineTo(x, y); });
  for (let i = arr.length - 1; i >= 0; i--) { const t = arr[i]; shape.lineTo(-Math.max(0.05, hw(profile, t)) * W, t * L); }
  const b = Math.min(bevel, h * 0.3);
  const geo = new THREE.ExtrudeGeometry(shape, { depth: Math.max(0.1, h - b * 2), bevelEnabled: true, bevelThickness: b, bevelSize: b, bevelSegments: 1 });
  geo.rotateX(Math.PI / 2); // shape y → +z, extrusion → -y
  geo.translate(0, y0 + h - b, 0);
  return geo;
}

function box(w: number, h: number, d: number, x: number, y: number, z: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d); g.translate(x, y, z); return g;
}
function cyl(rt: number, rb: number, h: number, x: number, y: number, z: number, axis: 'y' | 'z' = 'y', seg = 12): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(rt, rb, h, seg);
  if (axis === 'z') g.rotateX(Math.PI / 2);
  g.translate(x, y, z); return g;
}

interface Parts { hull: THREE.BufferGeometry[]; dark: THREE.BufferGeometry[]; trim: THREE.BufferGeometry[]; accent: THREE.BufferGeometry[]; light: THREE.Vector3[]; engines: { x: number; y: number; z: number; r: number }[] }

function design(cls: ShipClassDef, team: 0 | 1): { profile: Profile; W: number; build: (p: Parts, L: number) => void } {
  const L = cls.length;
  const enemy = team === 1;
  switch (cls.id) {
    case 'battleship': {
      const profile: Profile = enemy
        ? [[-0.5, 0.82], [-0.38, 1], [0.12, 0.95], [0.3, 0.62], [0.38, 0.72], [0.46, 0.5], [0.5, 0.2]]
        : [[-0.5, 0.72], [-0.42, 0.95], [0.05, 1], [0.3, 0.74], [0.5, 0.14]];
      const W = 7.6;
      return {
        profile, W, build: (p) => {
          p.hull.push(slab(profile, L, W, -0.5, 0, -2.6, 4.6), slab(profile, L, W, 0, 0.5, -2.6, 4.6));
          const up: Profile = profile.map(([t, w]) => [t, w * 0.68]);
          p.hull.push(slab(up, L, W, -0.42, 0, 2.0, 2.5), slab(up, L, W, 0, 0.36, 2.0, 2.5));
          // keel / belt armor
          p.dark.push(slab(profile.map(([t, w]) => [t, w * 0.8]) as Profile, L, W, -0.48, 0.44, -4.2, 1.8));
          p.accent.push(box(0.15, 0.35, L * 0.62, W * 0.93, 0.6, -L * 0.04), box(0.15, 0.35, L * 0.62, -W * 0.93, 0.6, -L * 0.04));
          // bridge tower
          if (enemy) {
            p.hull.push(box(5.6, 3.2, 9, 0, 6.1, -3.5), box(4.2, 3.4, 6, 0, 9.4, -4.6), box(2.4, 5.5, 2.4, 0, 13.6, -5.2));
            p.dark.push(box(6.8, 0.6, 2.6, 0, 11.2, -3), cyl(0.18, 0.18, 9, 1.4, 16, -6), cyl(0.18, 0.18, 7, -1.4, 15, -6));
            p.trim.push(box(0.6, 3, 4, 3.2, 6, -12), box(0.6, 3, 4, -3.2, 6, -12));
          } else {
            p.hull.push(box(5, 3, 10, 0, 6, -3), box(3.6, 2.6, 6.5, 0, 8.8, -4), box(5.8, 1, 3, 0, 10.4, -3.2));
            p.dark.push(box(2.2, 1.2, 2.2, 0, 11.4, -4.4), cyl(0.16, 0.16, 8, 0, 15.5, -5.5));
            p.trim.push(box(1.2, 0.6, 14, 0, 4.7, -14));
          }
          p.accent.push(box(4.4, 0.3, 0.2, 0, 9.2, -0.9));
          p.light.push(new THREE.Vector3(0, 16.6, -5.5), new THREE.Vector3(W * 0.95, 0.5, -L * 0.42), new THREE.Vector3(-W * 0.95, 0.5, -L * 0.42), new THREE.Vector3(0, 2.5, L * 0.48));
          // engine block
          p.dark.push(box(W * 1.3, 4.4, 5, 0, -0.2, -L * 0.5 - 1.5));
          p.engines.push({ x: 0, y: 0, z: -L * 0.5 - 4, r: 2.1 }, { x: 4.6, y: 0, z: -L * 0.5 - 4, r: 1.7 }, { x: -4.6, y: 0, z: -L * 0.5 - 4, r: 1.7 });
          if (enemy) p.engines.push({ x: 0, y: 2.6, z: -L * 0.5 - 4, r: 1.2 });
        },
      };
    }
    case 'cruiser': {
      const profile: Profile = enemy
        ? [[-0.5, 0.9], [-0.25, 1], [0.15, 0.85], [0.35, 0.45], [0.42, 0.6], [0.5, 0.15]]
        : [[-0.5, 0.7], [-0.35, 1], [0.1, 0.95], [0.35, 0.6], [0.5, 0.12]];
      const W = 4.8;
      return {
        profile, W, build: (p) => {
          p.hull.push(slab(profile, L, W, -0.5, 0, -1.8, 3.2), slab(profile, L, W, 0, 0.5, -1.8, 3.2));
          const up: Profile = profile.map(([t, w]) => [t, w * 0.62]);
          p.hull.push(slab(up, L, W, -0.4, 0, 1.4, 1.8), slab(up, L, W, 0, 0.32, 1.4, 1.8));
          p.dark.push(slab(profile.map(([t, w]) => [t, w * 0.75]) as Profile, L, W, -0.46, 0.4, -2.9, 1.2));
          if (enemy) { p.hull.push(box(3.2, 2.6, 5, 0, 4.4, -1.8), box(1.6, 4, 1.6, 0, 7, -2.4)); p.dark.push(cyl(0.12, 0.12, 5, 0.9, 9, -2.6)); }
          else { p.hull.push(box(3, 2.2, 6, 0, 4.2, -1.5), box(3.8, 0.7, 2, 0, 5.6, -1)); p.dark.push(cyl(0.12, 0.12, 5, 0, 8, -2.5)); }
          p.accent.push(box(0.12, 0.25, L * 0.55, W * 0.95, 0.4, -L * 0.05), box(0.12, 0.25, L * 0.55, -W * 0.95, 0.4, -L * 0.05));
          p.light.push(new THREE.Vector3(0, 10.5, -2.5), new THREE.Vector3(W * 0.9, 0.3, -L * 0.45), new THREE.Vector3(-W * 0.9, 0.3, -L * 0.45));
          p.dark.push(box(W * 1.2, 2.8, 3, 0, -0.2, -L * 0.5 - 1));
          p.engines.push({ x: 1.8, y: 0, z: -L * 0.5 - 2.6, r: 1.3 }, { x: -1.8, y: 0, z: -L * 0.5 - 2.6, r: 1.3 });
        },
      };
    }
    case 'destroyer': {
      const profile: Profile = enemy
        ? [[-0.5, 0.8], [-0.2, 1], [0.25, 0.5], [0.5, 0.3]]
        : [[-0.5, 0.6], [-0.3, 1], [0.2, 0.85], [0.5, 0.1]];
      const W = 3.2;
      return {
        profile, W, build: (p) => {
          p.hull.push(slab(profile, L, W, -0.5, 0, -1.2, 2.2), slab(profile, L, W, 0, 0.5, -1.2, 2.2));
          const up: Profile = profile.map(([t, w]) => [t, w * 0.6]);
          p.hull.push(slab(up, L, W, -0.38, 0.3, 1.0, 1.3));
          p.hull.push(box(2, 1.6, 3.5, 0, 3, 2.2));
          p.dark.push(cyl(0.1, 0.1, 3.5, 0, 5, 1.6));
          if (enemy) p.trim.push(box(6.5, 0.3, 2.5, 0, 0.6, -6));
          p.accent.push(box(0.1, 0.2, L * 0.5, W * 0.95, 0.2, -1), box(0.1, 0.2, L * 0.5, -W * 0.95, 0.2, -1));
          p.light.push(new THREE.Vector3(0, 6.8, 1.6));
          p.engines.push({ x: 1.1, y: 0, z: -L * 0.5 - 1.2, r: 0.9 }, { x: -1.1, y: 0, z: -L * 0.5 - 1.2, r: 0.9 });
        },
      };
    }
    default: {
      // corvette
      const profile: Profile = enemy ? [[-0.5, 0.7], [-0.25, 1], [0.1, 0.45], [0.5, 0.1]] : [[-0.5, 1], [-0.3, 0.85], [0.5, 0.1]];
      const W = 2.4;
      return {
        profile, W, build: (p) => {
          p.hull.push(slab(profile, L, W, -0.5, 0, -0.6, 1.3), slab(profile, L, W, 0, 0.5, -0.6, 1.3));
          p.hull.push(box(1.2, 0.8, 3, 0, 1.0, 0.5));
          // wings / fins
          if (enemy) { p.trim.push(box(7.5, 0.2, 2.2, 0, 0.1, -4.6)); p.dark.push(box(0.2, 2.4, 2.2, 3.6, 0.8, -4.6), box(0.2, 2.4, 2.2, -3.6, 0.8, -4.6)); }
          else { p.trim.push(box(6.5, 0.18, 3, 0, -0.1, -4)); p.dark.push(box(0.2, 1.8, 2.5, 0, 1.4, -5)); }
          p.accent.push(box(1.0, 0.25, 0.8, 0, 1.25, 2.1));
          p.light.push(new THREE.Vector3(3.2, 0, -4.5), new THREE.Vector3(-3.2, 0, -4.5));
          p.engines.push({ x: 0, y: 0, z: -L * 0.5 - 0.6, r: 0.75 });
        },
      };
    }
  }
}

// -------------------------------------------------------------------------- turrets

function buildTurret(md: MountDef, team: 0 | 1): TurretView {
  const m = mats(team);
  const w = WEAPONS[md.weapon];
  const root = new THREE.Group();
  root.position.set(md.pos[0], md.pos[1], md.pos[2]);
  let barrels: THREE.Group | null = new THREE.Group();
  // collect sub-parts per (parent, material) and merge them to keep draw calls low
  const buckets = new Map<THREE.Object3D, Map<THREE.Material, THREE.BufferGeometry[]>>();
  const add = (g: THREE.BufferGeometry, mat: THREE.Material, parent: THREE.Object3D = root) => {
    let b = buckets.get(parent); if (!b) { b = new Map(); buckets.set(parent, b); }
    let arr = b.get(mat); if (!arr) { arr = []; b.set(mat, arr); }
    arr.push(g);
  };
  let rotates = true;
  switch (md.weapon) {
    case 'heavy_cannon': {
      add(cyl(3.0, 3.3, 3.2, 0, -1.8, 0), m.dark);
      const housing = new THREE.Shape();
      housing.moveTo(-2.8, -2.6); housing.lineTo(2.8, -2.6); housing.lineTo(2.6, 2.2); housing.lineTo(1.6, 3.2); housing.lineTo(-1.6, 3.2); housing.lineTo(-2.6, 2.2); housing.closePath();
      const hg = new THREE.ExtrudeGeometry(housing, { depth: 1.8, bevelEnabled: true, bevelSize: 0.25, bevelThickness: 0.25, bevelSegments: 1 });
      hg.rotateX(Math.PI / 2); hg.translate(0, 1.2, 0);
      add(hg, m.hull);
      barrels.position.set(0, 0.3, 2.6);
      for (const x of [-1.2, 0, 1.2]) { add(cyl(0.32, 0.42, 10, x, 0, 5, 'z', 10), m.gun, barrels); add(cyl(0.5, 0.5, 1.2, x, 0, 9.6, 'z', 10), m.gun, barrels); }
      break;
    }
    case 'rail_cannon': {
      add(cyl(2.6, 3.0, 3, 0, -1.6, 0), m.dark);
      add(box(4.4, 2, 6, 0, 0.4, 0), m.hull);
      barrels.position.set(0, 0.4, 2);
      for (const x of [-0.8, 0.8]) add(box(0.5, 0.8, 16, x, 0, 8), m.gun, barrels);
      for (let k = 0; k < 4; k++) add(box(2.6, 1.2, 0.4, 0, 0, 4 + k * 3.2), m.accent, barrels);
      break;
    }
    case 'medium_gun': {
      add(cyl(1.5, 1.7, 2.2, 0, -1, 0), m.dark);
      add(box(2.6, 1.3, 3, 0, 0.4, 0), m.hull);
      barrels.position.set(0, 0.4, 1.2);
      for (const x of [-0.5, 0.5]) add(cyl(0.18, 0.22, 4.6, x, 0, 2.3, 'z', 8), m.gun, barrels);
      break;
    }
    case 'autocannon': {
      add(box(0.8, 0.6, 1.2, 0, 0, 0), m.dark);
      barrels.position.set(0, 0.1, 0.5);
      add(cyl(0.12, 0.14, 2.6, 0, 0, 1.3, 'z', 6), m.gun, barrels);
      break;
    }
    case 'pd_gun': {
      const s = 0.8;
      add(new THREE.SphereGeometry(0.75 * s, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), m.trim);
      barrels.position.set(0, 0.35, 0.3);
      add(cyl(0.16, 0.16, 1.8, 0, 0, 0.9, 'z', 6), m.gun, barrels);
      break;
    }
    case 'missile_rack': {
      rotates = false; barrels = null;
      add(box(2.2, 1, 3.2, 0, 0, 0), m.dark);
      for (let i = 0; i < 2; i++) for (let j = 0; j < 3; j++) add(box(0.7, 0.12, 0.7, -0.5 + i, 0.52, -1 + j), m.accent);
      break;
    }
    case 'torpedo': {
      rotates = false; barrels = null;
      add(cyl(0.6, 0.6, 2.4, 0, 0, 0, 'z', 10), m.dark);
      add(cyl(0.45, 0.45, 0.2, 0, 0, 1.25, 'z', 10), m.accent);
      break;
    }
  }
  for (const [parent, b] of buckets) for (const [mat, geos] of b) parent.add(new THREE.Mesh(mergeAll(geos), mat));
  if (barrels) root.add(barrels);
  root.rotation.y = md.facing * Math.PI / 180;
  void w;
  return { root, barrels, mount: md, recoil: 0, rotates };
}

// -------------------------------------------------------------------------- build

function normalizeGeo(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const ng = g.index ? g.toNonIndexed() : g;
  for (const k of Object.keys(ng.attributes)) if (!['position', 'normal', 'uv'].includes(k)) ng.deleteAttribute(k);
  ng.clearGroups();
  return ng;
}
function mergeAll(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  if (geos.length === 1) return geos[0];
  return mergeGeometries(geos.map(normalizeGeo)) ?? geos[0];
}
const turretCache = new Map<string, TurretView>();

const geoCache = new Map<string, { hull: THREE.BufferGeometry[]; dark: THREE.BufferGeometry[]; trim: THREE.BufferGeometry[]; accent: THREE.BufferGeometry[]; parts: Parts }>();

function splitByZ(geos: THREE.BufferGeometry[]): [THREE.BufferGeometry | null, THREE.BufferGeometry | null] {
  const f: THREE.BufferGeometry[] = [], r: THREE.BufferGeometry[] = [];
  for (const g of geos) {
    g.computeBoundingBox();
    const cz = (g.boundingBox!.min.z + g.boundingBox!.max.z) / 2;
    const ng = g.index ? g.toNonIndexed() : g;
    if (ng.getAttribute('uv') === undefined) continue;
    (cz >= 0 ? f : r).push(ng);
  }
  const strip = (arr: THREE.BufferGeometry[]) => arr.map(g => { for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k); return g; });
  return [f.length ? mergeGeometries(strip(f)) : null, r.length ? mergeGeometries(strip(r)) : null];
}

export function buildShip(cls: ShipClassDef, loadout: LoadoutDef, team: 0 | 1): ShipModel {
  const m = mats(team);
  const key = `${cls.id}:${team}`;
  let cached = geoCache.get(key);
  if (!cached) {
    const d = design(cls, team);
    const parts: Parts = { hull: [], dark: [], trim: [], accent: [], light: [], engines: [] };
    d.build(parts, cls.length);
    cached = { hull: parts.hull, dark: parts.dark, trim: parts.trim, accent: parts.accent, parts };
    geoCache.set(key, cached);
  }
  const parts = cached.parts;
  const root = new THREE.Group();
  const bank = new THREE.Group();
  const front = new THREE.Group(), rear = new THREE.Group();
  root.add(bank); bank.add(front, rear);
  const hullMats: THREE.MeshStandardMaterial[] = [];
  const addMerged = (geos: THREE.BufferGeometry[], mat: THREE.Material) => {
    const [f, r] = (cached as any)[`split_${geos === cached!.hull ? 'h' : geos === cached!.dark ? 'd' : geos === cached!.trim ? 't' : 'a'}`] ??= splitByZ(geos);
    if (f) { const mesh = new THREE.Mesh(f, mat); mesh.castShadow = false; front.add(mesh); }
    if (r) { const mesh = new THREE.Mesh(r, mat); rear.add(mesh); }
  };
  addMerged(cached.hull, m.hull); addMerged(cached.dark, m.dark); addMerged(cached.trim, m.trim); addMerged(cached.accent, m.accent);
  hullMats.push(m.hull);

  const turrets: TurretView[] = [];
  const peds: [THREE.BufferGeometry[], THREE.BufferGeometry[]] = [[], []];
  for (const md of loadout.mounts) {
    const key = `${md.weapon}:${team}`;
    let proto = turretCache.get(key);
    if (!proto) { proto = buildTurret({ ...md, pos: [0, 0, 0], facing: 0 }, team); turretCache.set(key, proto); }
    const root = proto.root.clone(true);
    root.position.set(md.pos[0], md.pos[1], md.pos[2]);
    root.rotation.y = md.facing * Math.PI / 180;
    const barrels = proto.barrels ? root.children[root.children.length - 1] : null;
    const t: TurretView = { root, barrels, mount: md, recoil: 0, rotates: proto.rotates };
    // pedestal for raised mounts so nothing floats
    peds[md.pos[2] >= 0 ? 0 : 1].push(cyl(WEAPONS[md.weapon].caliber * 0.6 + 0.3, WEAPONS[md.weapon].caliber * 0.7 + 0.4, 3, md.pos[0], md.pos[1] - 2, md.pos[2]));
    (md.pos[2] >= 0 ? front : rear).add(t.root);
    turrets.push(t);
  }
  if (peds[0].length) front.add(new THREE.Mesh(mergeAll(peds[0]), m.dark));
  if (peds[1].length) rear.add(new THREE.Mesh(mergeAll(peds[1]), m.dark));

  const engines: ShipModel['engines'] = [];
  const glowGeo = new THREE.CircleGeometry(1, 20);
  const plumeGeo = new THREE.ConeGeometry(1, 1, 16, 1, true);
  plumeGeo.rotateX(-Math.PI / 2); plumeGeo.translate(0, 0, -0.5);
  rear.add(new THREE.Mesh(mergeAll(parts.engines.map(e => cyl(e.r * 1.1, e.r * 1.35, e.r * 1.6, e.x, e.y, e.z + e.r * 0.6, 'z', 14))), m.trim));
  for (const e of parts.engines) {
    const glow = new THREE.Mesh(glowGeo, m.engine);
    glow.position.set(e.x, e.y, e.z - 0.25); glow.rotation.y = Math.PI; glow.scale.setScalar(e.r);
    rear.add(glow);
    const plume = new THREE.Mesh(plumeGeo, m.plume);
    plume.position.set(e.x, e.y, e.z - 0.3);
    plume.scale.set(e.r * 0.9, e.r * 0.9, e.r * 6);
    rear.add(plume);
    engines.push({ glow, plume, base: e.r });
  }
  const lights: THREE.Mesh[] = [];
  const lg = new THREE.SphereGeometry(0.3, 6, 4);
  for (const p of parts.light) { const l = new THREE.Mesh(lg, m.light); l.position.copy(p); (p.z >= 0 ? front : rear).add(l); lights.push(l); }
  return { root, bank, front, rear, turrets, engines, lights, hullMats, length: cls.length };
}

export function factionColor(team: 0 | 1): number { return STYLE[team].accent; }
export function engineColor(team: 0 | 1): number { return STYLE[team].engine; }

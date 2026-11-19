import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { ShipClassDef, LoadoutDef, MountDef } from '../sim/data/ships';
import { WEAPONS } from '../sim/data/weapons';
import { loadModel, modelReady, modelsEnabled, type ModelTemplate } from './modelLoader';
import { bbexDesign, bbexTurret, BBEX_COLORS } from './bbex/hull';
import { design17, TINT } from './hulls17';
import { BBEX_CLASS } from '../sim/bbex/data';

// Ship-local frame: +x port, +y up, +z bow (matches the simulation).

export interface TurretView { root: THREE.Object3D; barrels: THREE.Object3D | null; mount: MountDef; recoil: number; rotates: boolean }
export interface ShipModel {
  root: THREE.Group;          // positioned/rotated by the renderer
  bank: THREE.Group;          // roll for banking
  front: THREE.Group;         // front half (separates on death)
  rear: THREE.Group;
  turrets: TurretView[];
  /** plume: energy exhaust (per-engine ShaderMaterial, uniform uI = brightness); len: maker length factor;
   *  cur: eased throttle the renderer keeps between frames */
  engines: { glow: THREE.Mesh; plume: THREE.Mesh; base: number; len: number; cur: number }[];
  lights: THREE.Mesh[];
  hullMats: THREE.MeshStandardMaterial[];
  length: number;
  /** external model state: none (procedural design), loading (procedural placeholder), model, fallback
   *  (the file was missing or broken — procedural hull kept) */
  model: { id: string; state: 'loading' | 'model' | 'fallback' } | null;
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
let bbexMats: Mats | null = null;

/** BB-EX wears its own colours whichever side it fights on: pearl armour, black structure, violet light */
function matsBbex(): Mats {
  if (bbexMats) return bbexMats;
  const B = BBEX_COLORS;
  const map = bbexPanels();
  const emap = bbexEmissive();
  bbexMats = {
    hull: new THREE.MeshStandardMaterial({ color: B.hull, map, roughness: 0.34, metalness: 0.62, emissive: 0xffffff, emissiveMap: emap, emissiveIntensity: 1.25 }),
    dark: new THREE.MeshStandardMaterial({ color: B.dark, roughness: 0.5, metalness: 0.8 }),
    trim: new THREE.MeshStandardMaterial({ color: B.trim, roughness: 0.3, metalness: 0.9, emissive: 0x2a1060, emissiveIntensity: 0.6 }),
    accent: new THREE.MeshBasicMaterial({ color: new THREE.Color(B.accent).multiplyScalar(2.3) }),
    engine: new THREE.MeshBasicMaterial({ color: new THREE.Color(B.engine).multiplyScalar(2.8) }),
    plume: new THREE.MeshBasicMaterial({ color: B.accent, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
    light: new THREE.MeshBasicMaterial({ color: new THREE.Color(B.light).multiplyScalar(3) }),
    gun: new THREE.MeshStandardMaterial({ color: B.gun, roughness: 0.35, metalness: 0.9 }),
  };
  return bbexMats;
}
/** pearl armour: bright plates with fine dark seams (the shared panel texture is mid-grey) */
function bbexPanels(): THREE.CanvasTexture {
  const S = 512;
  const c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d')!;
  g.fillStyle = '#f3f1f8'; g.fillRect(0, 0, S, S);
  let r = 4242;
  const rnd = () => ((r = (r * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < 90; i++) {
    const w = 40 + rnd() * 150, h = 20 + rnd() * 80, x = rnd() * S, y = rnd() * S;
    const v = 232 + rnd() * 22;
    g.fillStyle = `rgb(${v},${v - 2},${Math.min(255, v + 6)})`; g.fillRect(x, y, w, h);
    g.strokeStyle = 'rgba(70,60,100,0.5)'; g.lineWidth = 1.2; g.strokeRect(x, y, w, h);
  }
  for (let i = 0; i < 26; i++) { g.fillStyle = 'rgba(60,40,110,0.55)'; g.fillRect(rnd() * S, rnd() * S, 3 + rnd() * 60, 1.6); }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(1 / 34, 1 / 34); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}
/** sparse violet circuit lines instead of the warm window lights of ordinary hulls */
function bbexEmissive(): THREE.CanvasTexture {
  const S = 512;
  const c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d')!;
  g.fillStyle = '#000'; g.fillRect(0, 0, S, S);
  let r = 97;
  const rnd = () => ((r = (r * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < 46; i++) {
    let x = rnd() * S, y = rnd() * S;
    g.strokeStyle = rnd() < 0.75 ? 'rgba(190,120,255,0.9)' : 'rgba(255,170,240,0.9)'; g.lineWidth = 1.6;
    g.beginPath(); g.moveTo(x, y);
    for (let k = 0; k < 3; k++) { if (rnd() < 0.5) x += (rnd() - 0.5) * 150; else y += (rnd() - 0.5) * 90; g.lineTo(x, y); }
    g.stroke();
    g.fillStyle = 'rgba(235,200,255,1)'; g.fillRect(x - 2, y - 2, 4, 4);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(1 / 34, 1 / 34); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}
const isBbexWeapon = (id: string) => !!WEAPONS[id] && (id === 'dcp_omega' || id === 'abyss_lance' || id === 'violet_edge' || id === 'lilac_stinger' || id === 'seraph_ex' || id === 'purple_rain');

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

const FINISH: Record<number, { r: number; m: number; tr: number; tm: number; win: number }> = {
  [TINT.helios]: { r: 0.32, m: 0.7, tr: 0.22, tm: 0.95, win: 1.1 }, [TINT.ceres]: { r: 0.4, m: 0.45, tr: 0.3, tm: 0.7, win: 1.0 },
  [TINT.bastion]: { r: 0.78, m: 0.5, tr: 0.65, tm: 0.7, win: 0.7 }, [TINT.rust]: { r: 0.85, m: 0.4, tr: 0.75, tm: 0.55, win: 0.6 },
  [TINT.old]: { r: 0.7, m: 0.45, tr: 0.6, tm: 0.6, win: 0.8 }, [TINT.cobalt]: { r: 0.62, m: 0.5, tr: 0.5, tm: 0.7, win: 0.75 },
};
/** maker-tinted hull materials (P17.3): same textures, hull/dark colours multiplied by the maker tint */
const tintCache = new Map<string, Mats>();
function matsTint(team: 0 | 1, tint: number | undefined): Mats {
  const base = mats(team);
  if (tint === undefined || tint === 0xffffff) return base;
  const k = `${team}:${tint}`;
  let m = tintCache.get(k);
  if (!m) {
    const hull = base.hull.clone(); hull.color.multiply(new THREE.Color(tint));
    const dark = base.dark.clone(); dark.color.multiply(new THREE.Color(tint));
    // P17.3.1 maker finish: same textures, different surface — Helios polished, Ceres pearl, Bastion heavy matte
    // armour, Rustport/pirate weathered, old empire dull, Cobalt plain (window light also differs a little)
    const F = FINISH[tint];
    let trim = base.trim;
    if (F) {
      hull.roughness = F.r; hull.metalness = F.m; hull.emissiveIntensity = base.hull.emissiveIntensity * F.win;
      dark.roughness = Math.min(1, F.r + 0.15);
      trim = base.trim.clone(); trim.roughness = F.tr; trim.metalness = F.tm;
    }
    m = { ...base, hull, dark, trim };
    tintCache.set(k, m);
  }
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

interface Parts { hull: THREE.BufferGeometry[]; dark: THREE.BufferGeometry[]; trim: THREE.BufferGeometry[]; accent: THREE.BufferGeometry[]; light: THREE.Vector3[]; engines: { x: number; y: number; z: number; r: number }[]; spinal?: { x: number; y: number; z: number } }

const MESH_ALIAS: Record<string, [string, number]> = { frigate: ['destroyer', 1.0], light_cruiser: ['cruiser', 1.0], battlecruiser: ['battleship', 0.92], dreadnought: ['battleship', 1.6] };

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
    case 'miner': {
      const profile: Profile = [[-0.5, 0.75], [-0.25, 1], [0.2, 0.95], [0.4, 0.7], [0.5, 0.45]];
      const W = 6;
      return {
        profile, W, build: (p) => {
          p.hull.push(slab(profile, L, W, -0.5, 0, -2.4, 4.4), slab(profile, L, W, 0, 0.5, -2.4, 4.4));
          p.hull.push(box(4.4, 2.6, 8, 0, 3.2, -8));                       // bridge block
          p.dark.push(box(3, 1.2, 3.6, 0, 5, -9));
          // twin mining arms + emitter
          for (const x of [-3.4, 3.4]) { p.trim.push(box(1.2, 1.4, 10, x, 0, L * 0.5 + 3)); p.dark.push(box(2, 2, 2, x, 0, L * 0.5 + 8)); }
          p.accent.push(box(1, 1, 0.6, 3.4, 0, L * 0.5 + 9.2), box(1, 1, 0.6, -3.4, 0, L * 0.5 + 9.2));
          // side ore hoppers
          for (const x of [-W - 1.2, W + 1.2]) { p.dark.push(cyl(2.2, 2.2, 14, x, -0.6, -1, 'z', 10)); p.trim.push(box(0.4, 0.5, 14, x * 1.12, 1.2, -1)); }
          p.light.push(new THREE.Vector3(0, 6, -9), new THREE.Vector3(W + 2, 0, -8), new THREE.Vector3(-W - 2, 0, -8));
          p.dark.push(box(W * 1.4, 3.6, 3, 0, -0.4, -L * 0.5 - 1));
          p.engines.push({ x: 2.6, y: 0, z: -L * 0.5 - 3, r: 1.4 }, { x: -2.6, y: 0, z: -L * 0.5 - 3, r: 1.4 });
        },
      };
    }
    case 'hauler': {
      const profile: Profile = [[-0.5, 1], [0.5, 1]];
      const W = 1.6;
      return {
        profile, W, build: (p) => {
          p.dark.push(box(3.2, 2.4, L * 0.92, 0, 0, -1));                    // spine
          p.hull.push(box(7, 5, 7, 0, 1, L * 0.5 - 2), box(5, 2, 3, 0, 4.4, L * 0.5 - 3)); // cab
          p.accent.push(box(5.2, 0.5, 0.3, 0, 3.6, L * 0.5 + 1.5));
          // cargo containers: 2 x 4 on each side
          for (let i = 0; i < 4; i++) for (const x of [-3.4, 3.4]) for (const y of [-1.8, 2.2]) {
            const z = -L * 0.38 + i * 7.6;
            (i + (x > 0 ? 1 : 0) + (y > 0 ? 1 : 0)) % 2 ? p.hull.push(box(3.4, 3.6, 7, x, y, z)) : p.trim.push(box(3.4, 3.6, 7, x, y, z));
          }
          p.light.push(new THREE.Vector3(0, 5.6, L * 0.5 - 3), new THREE.Vector3(5.4, 4, -L * 0.4), new THREE.Vector3(-5.4, 4, -L * 0.4));
          p.dark.push(box(7, 5, 3, 0, 0, -L * 0.5 - 0.5));
          p.engines.push({ x: 2.2, y: 0, z: -L * 0.5 - 2.5, r: 1.6 }, { x: -2.2, y: 0, z: -L * 0.5 - 2.5, r: 1.6 });
        },
      };
    }
    case 'constructor': {
      const profile: Profile = [[-0.5, 0.9], [-0.1, 1], [0.3, 0.8], [0.5, 0.35]];
      const W = 5.5;
      return {
        profile, W, build: (p) => {
          p.hull.push(slab(profile, L, W, -0.5, 0, -2.2, 4), slab(profile, L, W, 0, 0.5, -2.2, 4));
          p.hull.push(box(6, 3, 9, 0, 3.2, 2));
          // crane gantry
          p.trim.push(box(0.8, 9, 0.8, 4.5, 5.5, -6), box(0.8, 9, 0.8, -4.5, 5.5, -6), box(10, 0.8, 0.8, 0, 10, -6), box(0.8, 0.8, 16, 0, 10, 1));
          p.accent.push(box(1.4, 1.4, 1.4, 0, 9, 9));
          p.dark.push(box(8, 2.4, 8, 0, 2.2, -10));                          // drone bay
          p.accent.push(box(6, 0.3, 0.4, 0, 3.5, -6));
          p.light.push(new THREE.Vector3(0, 11, 9), new THREE.Vector3(5, 10, -6), new THREE.Vector3(-5, 10, -6));
          p.dark.push(box(W * 1.3, 3.4, 3, 0, -0.4, -L * 0.5 - 1));
          p.engines.push({ x: 2.4, y: 0, z: -L * 0.5 - 3, r: 1.3 }, { x: -2.4, y: 0, z: -L * 0.5 - 3, r: 1.3 });
        },
      };
    }
    case 'platform': {
      const profile: Profile = [[-0.5, 1], [0.5, 1]];
      const W = 12;
      return {
        profile, W, build: (p) => {
          p.hull.push(cyl(13, 15, 5, 0, 0, 0, 'y', 8), cyl(7, 9, 4, 0, 4.5, 0, 'y', 8));
          p.dark.push(cyl(16, 16, 1.2, 0, -2.8, 0, 'y', 8), cyl(2, 3, 8, 0, -7, 0, 'y', 6));
          p.accent.push(box(30, 0.4, 0.4, 0, -1.6, 0), box(0.4, 0.4, 30, 0, -1.6, 0));
          p.light.push(new THREE.Vector3(14, 0, 0), new THREE.Vector3(-14, 0, 0), new THREE.Vector3(0, 0, 14), new THREE.Vector3(0, 0, -14));
        },
      };
    }
    case 'carrier': {
      // P16.4 provisional carrier: long flat flight deck overhanging a narrow hull, island offset to one side,
      // deck stripes; the H mounts sit on the deck as elevator plates (buildTurret)
      const profile: Profile = enemy
        ? [[-0.5, 0.85], [-0.3, 1], [0.2, 0.9], [0.42, 0.55], [0.5, 0.25]]
        : [[-0.5, 0.8], [-0.35, 1], [0.25, 0.95], [0.45, 0.5], [0.5, 0.2]];
      const W = 5.2;
      return {
        profile, W, build: (p) => {
          p.hull.push(slab(profile, L, W, -0.5, 0, -2.4, 4.4), slab(profile, L, W, 0, 0.5, -2.4, 4.4));
          p.dark.push(slab(profile.map(([t, w]) => [t, w * 0.78]) as Profile, L, W, -0.47, 0.42, -3.8, 1.6));
          // flight deck (wider than the hull, slight bow overhang)
          const deck: Profile = enemy
            ? [[-0.5, 1.0], [0.3, 1.0], [0.44, 0.7], [0.5, 0.45]]
            : [[-0.5, 0.95], [0.38, 1.0], [0.5, 0.6]];
          p.hull.push(slab(deck, L * 1.04, 7.6, -0.5, 0.5, 2.0, 3.0, 0.2));
          p.dark.push(slab(deck.map(([t, w]) => [t, w * 0.9]) as Profile, L * 1.0, 7.6, -0.48, 0.48, 4.95, 0.12, 0.05));
          // centreline and edge stripes
          p.accent.push(box(0.35, 0.06, L * 0.86, 0, 5.1, 0), box(0.18, 0.06, L * 0.8, 6.2, 5.1, -L * 0.02), box(0.18, 0.06, L * 0.8, -6.2, 5.1, -L * 0.02));
          for (let k = 0; k < 6; k++) p.trim.push(box(1.6, 0.05, 0.3, 0, 5.12, L * 0.38 - k * 1.4));
          // island
          if (enemy) { p.hull.push(box(2.4, 4.4, 9, -6.6, 7.1, -6)); p.dark.push(box(2.8, 0.8, 3.5, -6.6, 9.7, -4), cyl(0.14, 0.14, 5, -6.6, 12.5, -8)); }
          else { p.hull.push(box(2.2, 3.6, 11, 6.6, 6.8, -4), box(1.8, 2.2, 5, 6.6, 9.7, -5)); p.dark.push(box(2.6, 0.9, 2, 6.6, 10.4, -2.2), cyl(0.14, 0.14, 5, 6.6, 13.2, -6)); }
          p.light.push(new THREE.Vector3(enemy ? -6.6 : 6.6, enemy ? 15 : 15.7, enemy ? -8 : -6), new THREE.Vector3(0, 5.3, L * 0.5), new THREE.Vector3(7.4, 5.2, -L * 0.48), new THREE.Vector3(-7.4, 5.2, -L * 0.48));
          p.dark.push(box(W * 1.4, 3.6, 4, 0, -0.4, -L * 0.5 - 1.2));
          p.engines.push({ x: 2.6, y: -0.4, z: -L * 0.5 - 3.4, r: 1.5 }, { x: -2.6, y: -0.4, z: -L * 0.5 - 3.4, r: 1.5 });
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


// ---------------------------------------------------------------- content hull silhouettes (P3)
// Each base is its own shape (not a recolor or a scaled copy). Built at the class length; buildShip
// then scales the whole model uniformly by HullDef.mesh.scale so hardpoints line up.
type Design = { profile: Profile; W: number; build: (p: Parts, L: number) => void; tint?: number };
function designExtra(base: string, L: number, team: 0 | 1): Design | undefined {
  const enemy = team === 1;
  const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  switch (base) {
    case 'bbex': return bbexDesign(L, { slab, box, cyl });
    default: { const d17 = design17(base, L, { slab, box, cyl }); if (d17) return d17; break; }
    case 'dd_vls': {            // flat broad deck, missile cell grid amidships, low aft bridge
      const profile: Profile = [[-0.5, 0.85], [-0.2, 1], [0.25, 0.9], [0.5, 0.25]];
      const W = 3.8;
      return { profile, W, build: (p) => {
        p.hull.push(slab(profile, L, W, -0.5, 0, -1.0, 1.8), slab(profile, L, W, 0, 0.5, -1.0, 1.8));
        p.dark.push(box(4.2, 0.9, 8, 0, 1.3, 1.5));
        for (let i = 0; i < 4; i++) for (const x of [-1.2, 1.2]) p.trim.push(box(1.6, 0.35, 1.6, x, 1.9, -1 + i * 1.9));
        p.hull.push(box(2.6, 1.6, 3, 0, 2.1, -7.4), box(1.6, 0.9, 1.6, 0, 3.3, -7.6));
        p.accent.push(box(4.4, 0.2, 0.25, 0, 1.85, 5.6));
        p.light.push(V(0, 4, -7.6), V(W, 0.4, -9), V(-W, 0.4, -9));
        p.engines.push({ x: 1.4, y: 0, z: -L * 0.5 - 1, r: 0.8 }, { x: -1.4, y: 0, z: -L * 0.5 - 1, r: 0.8 }, { x: 0, y: 0.2, z: -L * 0.5 - 1, r: 0.6 });
      } };
    }
    case 'dd_picket': {         // narrow hull, tall lattice mast with radar dish, PD sponsons along the sides
      const profile: Profile = [[-0.5, 0.55], [-0.25, 0.8], [0.15, 0.75], [0.5, 0.15]];
      const W = 2.8;
      return { profile, W, build: (p) => {
        p.hull.push(slab(profile, L, W, -0.5, 0, -1.1, 2.0), slab(profile, L, W, 0, 0.5, -1.1, 2.0));
        p.hull.push(box(1.8, 1.4, 4, 0, 1.6, 0.5));
        p.dark.push(cyl(0.18, 0.28, 7, 0, 5.4, 0), box(0.12, 6, 0.12, 0.5, 4.8, 0.4), box(0.12, 6, 0.12, -0.5, 4.8, 0.4));
        p.trim.push(cyl(1.7, 1.7, 0.25, 0, 8.8, 0, 'y', 16), box(3.6, 0.15, 0.15, 0, 7.4, 0));
        for (const z of [-6, -2, 3, 7]) for (const x of [-W * 0.95, W * 0.95]) p.dark.push(cyl(0.55, 0.6, 0.7, x, 0.4, z));
        p.accent.push(box(0.1, 0.2, L * 0.6, W * 0.9, -0.2, 0), box(0.1, 0.2, L * 0.6, -W * 0.9, -0.2, 0));
        p.light.push(V(0, 9.2, 0), V(1.8, 8.8, 0), V(-1.8, 8.8, 0));
        p.engines.push({ x: 0, y: 0, z: -L * 0.5 - 1.1, r: 1.0 });
      } };
    }
    case 'dd_heavy': {          // wide armored brick with a ram prow, belt armor and two big barbettes
      const profile: Profile = [[-0.5, 0.95], [-0.1, 1], [0.32, 0.92], [0.44, 0.55], [0.5, 0.42]];
      const W = 4.4;
      return { profile, W, build: (p) => {
        p.hull.push(slab(profile, L, W, -0.5, 0, -1.6, 2.8), slab(profile, L, W, 0, 0.5, -1.6, 2.8));
        p.dark.push(slab(profile.map(([t, w]) => [t, w * 1.06]) as Profile, L, W, -0.46, 0.4, -1.2, 1.4));
        p.trim.push(box(2.2, 1.2, 4.5, 0, -0.6, L * 0.5 + 1.2), box(1.2, 0.8, 2, 0, -0.6, L * 0.5 + 3.6));
        for (const z of [5, -4]) p.dark.push(cyl(2.0, 2.3, 1.4, 0, 1.6, z, 'y', 14));
        p.hull.push(box(3.2, 2.2, 3, 0, 2.6, 0.5), box(2, 1, 2, 0, 4.2, 0.2));
        if (enemy) p.trim.push(box(9, 0.35, 2, 0, 0.4, -7));
        p.light.push(V(0, 4.9, 0.2), V(W, 0.6, -10), V(-W, 0.6, -10));
        p.dark.push(box(W * 1.5, 2.6, 2.4, 0, 0, -L * 0.5 - 0.6));
        p.engines.push({ x: 2.2, y: 0, z: -L * 0.5 - 2, r: 1.0 }, { x: -2.2, y: 0, z: -L * 0.5 - 2, r: 1.0 }, { x: 0, y: 0, z: -L * 0.5 - 2, r: 1.0 });
      } };
    }
    case 'dd_fast': {           // dart hull, swept wings with fins, oversized engine pods
      const profile: Profile = [[-0.5, 0.5], [-0.35, 1], [-0.05, 0.6], [0.5, 0.06]];
      const W = 2.6;
      return { profile, W, build: (p) => {
        p.hull.push(slab(profile, L, W, -0.5, 0, -0.7, 1.4), slab(profile, L, W, 0, 0.5, -0.7, 1.4));
        p.hull.push(box(1.3, 0.8, 4, 0, 1.0, 1.5));
        p.trim.push(box(9, 0.18, 3.5, 0, 0, -6.5), box(5, 0.18, 2, 0, 0, -3.4));
        for (const x of [-4.4, 4.4]) p.dark.push(box(0.18, 2, 2.6, x, 0.9, -7), cyl(0.9, 1.0, 6, x * 0.62, 0, -8.5, 'z', 12));
        p.accent.push(box(0.9, 0.2, 1.2, 0, 1.45, 3.2), box(8.6, 0.12, 0.3, 0, 0.12, -4.8));
        p.light.push(V(4.5, 0, -6.5), V(-4.5, 0, -6.5));
        p.engines.push({ x: 2.73, y: 0, z: -L * 0.5 - 0.6, r: 1.0 }, { x: -2.73, y: 0, z: -L * 0.5 - 0.6, r: 1.0 }, { x: 0, y: 0, z: -L * 0.5 - 0.4, r: 0.7 });
      } };
    }
    case 'miner_m': {           // compact hull, one central drill boom, single belly hopper
      const profile: Profile = [[-0.5, 0.8], [-0.2, 1], [0.3, 0.85], [0.5, 0.5]];
      const W = 4.6;
      return { profile, W, build: (p) => {
        p.hull.push(slab(profile, L, W, -0.5, 0, -2.0, 3.6), slab(profile, L, W, 0, 0.5, -2.0, 3.6));
        p.hull.push(box(3.4, 2.2, 5, 0, 2.8, -6));
        p.trim.push(box(1.4, 1.4, 12, 0, 0.4, L * 0.5 + 4));
        p.dark.push(cyl(1.1, 0.2, 3, 0, 0.4, L * 0.5 + 11, 'z', 10), cyl(3.4, 3.4, 16, 0, -3.4, -2, 'z', 12));
        p.accent.push(box(0.8, 0.8, 0.5, 0, 0.4, L * 0.5 + 12.6));
        p.light.push(V(0, 4.5, -6), V(0, -6.5, -2));
        p.dark.push(box(W * 1.3, 3, 2.6, 0, -0.4, -L * 0.5 - 0.8));
        p.engines.push({ x: 1.8, y: 0, z: -L * 0.5 - 2.6, r: 1.2 }, { x: -1.8, y: 0, z: -L * 0.5 - 2.6, r: 1.2 });
      } };
    }
    case 'miner_l': {           // catamaran: two hoppers joined by a processing bridge, four arms forward
      const profile: Profile = [[-0.5, 1], [0.4, 1], [0.5, 0.6]];
      const W = 2.4;
      return { profile, W, build: (p) => {
        for (const x of [-5.5, 5.5]) { p.hull.push(box(4.6, 4.2, L * 0.9, x, 0, -1)); p.dark.push(cyl(1.9, 1.9, L * 0.7, x, 2.6, -2, 'z', 10)); }
        p.hull.push(box(7, 3.4, 12, 0, 1.4, -3), box(4, 2.4, 5, 0, 4.2, -6));
        for (const x of [-7, -3.6, 3.6, 7]) { p.trim.push(box(0.9, 1.1, 9, x, -0.6, L * 0.5 + 3)); p.dark.push(box(1.6, 1.6, 1.6, x, -0.6, L * 0.5 + 8)); }
        p.accent.push(box(14, 0.4, 0.4, 0, 3.2, L * 0.4));
        p.light.push(V(0, 6, -6), V(7.8, 2, -12), V(-7.8, 2, -12));
        for (const x of [-5.5, 5.5]) p.engines.push({ x, y: 0, z: -L * 0.5 - 2, r: 1.5 });
      } };
    }
    case 'miner_xl': {          // refinery: ringed cylinder core, drill array on a forward frame, drone hangars
      const profile: Profile = [[-0.5, 1], [0.5, 1]];
      const W = 6;
      return { profile, W, build: (p) => {
        p.hull.push(cyl(5.5, 5.5, L * 0.62, 0, 0, -2, 'z', 14));
        for (const z of [-12, -4, 4]) p.trim.push(cyl(7.4, 7.4, 1.4, 0, 0, z, 'z', 14));
        p.dark.push(box(16, 1, 1, 0, 0, L * 0.38), box(1, 12, 1, 0, 0, L * 0.38));
        for (const [x, y] of [[-7, 0], [7, 0], [0, 5.5], [0, -5.5]]) { p.trim.push(box(1, 1, 8, x, y, L * 0.38 + 4)); p.dark.push(cyl(1.0, 0.15, 2.6, x, y, L * 0.38 + 9, 'z', 8)); }
        for (const x of [-8.5, 8.5]) p.hull.push(box(3.6, 4, 9, x, -1, -9));
        p.hull.push(box(4, 3, 5, 0, 7, -10));
        p.accent.push(box(0.5, 0.5, L * 0.5, 5.8, 0, -2), box(0.5, 0.5, L * 0.5, -5.8, 0, -2));
        p.light.push(V(0, 8.8, -10), V(8.5, 1.5, -13.5), V(-8.5, 1.5, -13.5), V(0, 0, L * 0.38 + 11));
        p.dark.push(box(12, 8, 4, 0, 0, -L * 0.5 + 1));
        for (const [x, y] of [[3, 2.4], [-3, 2.4], [3, -2.4], [-3, -2.4]]) p.engines.push({ x, y, z: -L * 0.5 - 1.5, r: 1.6 });
      } };
    }
    case 'hauler_m': {          // short spine, 2×2 container stack, tall cab
      const profile: Profile = [[-0.5, 1], [0.5, 1]];
      const W = 1.6;
      return { profile, W, build: (p) => {
        p.dark.push(box(2.6, 2, L * 0.88, 0, 0, -1));
        p.hull.push(box(5, 6, 6, 0, 1.5, L * 0.5 - 2.5));
        p.accent.push(box(4, 0.5, 0.3, 0, 3.8, L * 0.5 + 0.6));
        for (const z of [-6, 3]) for (const x of [-2.8, 2.8]) (z > 0) === (x > 0) ? p.hull.push(box(3, 4.4, 8, x, 0.6, z)) : p.trim.push(box(3, 4.4, 8, x, 0.6, z));
        p.light.push(V(0, 5, L * 0.5 - 2.5), V(4.4, 3, -10));
        p.dark.push(box(5, 4, 2.4, 0, 0, -L * 0.5 - 0.2));
        p.engines.push({ x: 0, y: 0, z: -L * 0.5 - 2, r: 1.8 });
      } };
    }
    case 'hauler_l': {          // enclosed bulk hull: one long box hold with clamshell seams, bridge on top
      const profile: Profile = [[-0.5, 0.9], [-0.35, 1], [0.38, 1], [0.5, 0.7]];
      const W = 5;
      return { profile, W, build: (p) => {
        p.hull.push(slab(profile, L, W, -0.5, 0, -3.2, 6.2), slab(profile, L, W, 0, 0.5, -3.2, 6.2));
        for (const z of [-10, -2, 6, 14]) p.dark.push(box(W * 2.04, 0.3, 0.5, 0, 3.05, z));
        p.trim.push(box(1.0, 0.4, L * 0.7, 0, 3.15, 0));
        p.hull.push(box(4.4, 2.6, 5, 0, 4.4, -L * 0.5 + 5), box(2.4, 1.2, 2.4, 0, 6.3, -L * 0.5 + 5));
        p.accent.push(box(0.3, 0.6, L * 0.8, W, 0, 0), box(0.3, 0.6, L * 0.8, -W, 0, 0));
        p.light.push(V(0, 7, -L * 0.5 + 5), V(W, 3, L * 0.45), V(-W, 3, L * 0.45));
        p.dark.push(box(W * 1.8, 5, 3, 0, 0, -L * 0.5 - 1));
        for (const x of [-3, 0, 3]) p.engines.push({ x, y: 0, z: -L * 0.5 - 3, r: 1.5 });
      } };
    }
    case 'hauler_xl': {         // open truss freighter: long lattice keel with three tiers of container racks
      const profile: Profile = [[-0.5, 1], [0.5, 1]];
      const W = 2;
      return { profile, W, build: (p) => {
        for (const [x, y] of [[-1.2, -1.2], [1.2, -1.2], [-1.2, 1.2], [1.2, 1.2]]) p.dark.push(box(0.5, 0.5, L * 0.95, x, y, -1));
        const n = 6;
        for (let i = 0; i < n; i++) {
          const z = -L * 0.42 + i * (L * 0.8 / (n - 1));
          p.dark.push(box(10, 0.4, 0.6, 0, 0, z), box(0.4, 9, 0.6, 0, 0, z));
          for (const x of [-3.2, 3.2]) for (const y of [-2.6, 0.9, 4.4]) ((i + (x > 0 ? 1 : 0) + Math.round(y)) % 3 === 0 ? p.trim : p.hull).push(box(2.9, 3.1, L * 0.11, x, y, z));
        }
        p.hull.push(box(6, 5, 7, 0, 1.5, L * 0.5 + 1), box(3, 1.6, 3, 0, 4.6, L * 0.5));
        p.accent.push(box(5, 0.4, 0.3, 0, 3.4, L * 0.5 + 4.6));
        p.light.push(V(0, 5.6, L * 0.5), V(5, 6.2, -L * 0.42), V(-5, 6.2, -L * 0.42));
        p.dark.push(box(10, 6, 3, 0, 0, -L * 0.5 - 1));
        for (const [x, y] of [[-3, 1.6], [3, 1.6], [-3, -1.6], [3, -1.6]]) p.engines.push({ x, y, z: -L * 0.5 - 3, r: 1.4 });
      } };
    }
    case 'con_s': {             // tug: stubby hull, single manipulator arm, nose clamp
      const profile: Profile = [[-0.5, 0.9], [0, 1], [0.5, 0.7]];
      const W = 4.2;
      return { profile, W, build: (p) => {
        p.hull.push(slab(profile, L, W, -0.5, 0, -2.2, 4.4), slab(profile, L, W, 0, 0.5, -2.2, 4.4));
        p.hull.push(box(3.4, 2, 4, 0, 3.1, -3));
        p.trim.push(box(0.9, 0.9, 10, 2.6, 2.6, 6), box(0.9, 4, 0.9, 2.6, 0.8, 11));
        p.dark.push(box(4, 1.4, 2, 0, -0.4, L * 0.5 + 0.8), box(0.8, 2.6, 2, 1.8, -0.4, L * 0.5 + 2.2), box(0.8, 2.6, 2, -1.8, -0.4, L * 0.5 + 2.2));
        p.accent.push(box(1.2, 1.2, 1.2, 2.6, -1.2, 11));
        p.light.push(V(0, 4.4, -3), V(2.6, -1.4, 11.8));
        p.engines.push({ x: 1.6, y: 0, z: -L * 0.5 - 1.6, r: 1.3 }, { x: -1.6, y: 0, z: -L * 0.5 - 1.6, r: 1.3 });
      } };
    }
    case 'salv_s': {            // salvage tug: low hull, twin claw arms forward, tow-beam emitter, rear scrap cradle
      const profile: Profile = [[-0.5, 0.85], [0.1, 1], [0.5, 0.65]];
      const W = 4.6;
      return { profile, W, build: (p) => {
        p.hull.push(slab(profile, L, W, -0.5, 0, -2, 4), slab(profile, L, W, 0, 0.5, -2, 4));
        p.hull.push(box(3, 1.8, 3.6, 0, 2.9, -1));
        for (const x of [-2.4, 2.4]) {
          p.trim.push(box(0.8, 0.8, 8, x, 0.6, L * 0.5 + 2), box(0.8, 0.8, 2.6, x * 0.75, 0.6, L * 0.5 + 6.4));
          p.dark.push(box(0.6, 2.2, 0.8, x * 0.75, -0.2, L * 0.5 + 7.4));
        }
        p.accent.push(cyl(0.7, 0.9, 1.4, 0, 1.8, L * 0.5 + 0.8, 'z', 10));
        p.dark.push(box(5.4, 0.5, 6, 0, -1.6, -L * 0.25), box(0.5, 2.4, 6, 2.7, -0.6, -L * 0.25), box(0.5, 2.4, 6, -2.7, -0.6, -L * 0.25));
        p.light.push(V(0, 4, -1), V(0, 1.8, L * 0.5 + 1.6));
        p.engines.push({ x: 1.5, y: 0, z: -L * 0.5 - 1.5, r: 1.2 }, { x: -1.5, y: 0, z: -L * 0.5 - 1.5, r: 1.2 });
      } };
    }
    case 'con_l': {             // broad platform with twin gantries and a fabricator drum
      const profile: Profile = [[-0.5, 1], [0.35, 1], [0.5, 0.75]];
      const W = 6.5;
      return { profile, W, build: (p) => {
        p.hull.push(slab(profile, L, W, -0.5, 0, -1.6, 3.0), slab(profile, L, W, 0, 0.5, -1.6, 3.0));
        for (const z of [-7, 7]) p.trim.push(box(0.7, 8, 0.7, 5.6, 5, z), box(0.7, 8, 0.7, -5.6, 5, z), box(12, 0.7, 0.7, 0, 9, z));
        p.trim.push(box(0.7, 0.7, 15, 5.6, 9, 0), box(0.7, 0.7, 15, -5.6, 9, 0));
        p.dark.push(cyl(2.4, 2.4, 9, 0, 3.6, 0, 'z', 14), box(2.6, 2, 2.6, 0, 7.4, 3));
        p.hull.push(box(4.4, 2.6, 4, 0, 2.6, -L * 0.5 + 3));
        p.accent.push(box(1.2, 1.2, 1.2, 0, 8.2, 3), box(12.8, 0.3, 0.3, 0, 1.6, L * 0.48));
        p.light.push(V(5.6, 9.6, -7), V(-5.6, 9.6, 7), V(0, 4.2, -L * 0.5 + 3));
        p.dark.push(box(W * 1.5, 3, 3, 0, -0.3, -L * 0.5 - 1));
        for (const x of [-4, 0, 4]) p.engines.push({ x, y: 0, z: -L * 0.5 - 3, r: 1.2 });
      } };
    }
    case 'con_xl': {            // mobile slipway: open rectangular frame dock with cranes riding the rails
      const profile: Profile = [[-0.5, 1], [0.5, 1]];
      const W = 8;
      return { profile, W, build: (p) => {
        for (const x of [-W, W]) for (const y of [-4, 4]) p.dark.push(box(1.2, 1.2, L * 0.95, x, y, 0));
        for (const z of [-L * 0.45, -L * 0.15, L * 0.15, L * 0.45]) p.hull.push(box(W * 2 + 1.2, 1.2, 1.4, 0, 4, z), box(W * 2 + 1.2, 1.2, 1.4, 0, -4, z), box(1.2, 9.2, 1.4, W, 0, z), box(1.2, 9.2, 1.4, -W, 0, z));
        for (const z of [-L * 0.25, L * 0.2]) { p.trim.push(box(W * 2, 1, 1.6, 0, 5.4, z), box(1.4, 3, 1.4, z > 0 ? 2 : -3, 3.4, z)); p.accent.push(box(1.6, 0.8, 1.6, z > 0 ? 2 : -3, 1.6, z)); }
        p.hull.push(box(5, 4, 6, W + 3, 2, -L * 0.42), box(2.6, 1.4, 2.6, W + 3, 4.7, -L * 0.42));
        p.light.push(V(W, 4.8, L * 0.45), V(-W, 4.8, L * 0.45), V(W, -4.8, -L * 0.45), V(-W, -4.8, -L * 0.45), V(W + 3, 5.6, -L * 0.42));
        for (const [x, y] of [[W, 4], [-W, 4], [W, -4], [-W, -4]]) p.engines.push({ x, y, z: -L * 0.48 - 1, r: 1.3 });
      } };
    }
  }
  void enemy;
  return undefined;
}

// -------------------------------------------------------------------------- turrets

function buildTurret(md: MountDef, team: 0 | 1): TurretView {
  const m = isBbexWeapon(md.weapon) ? matsBbex() : mats(team);
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
  const ex = isBbexWeapon(md.weapon) ? bbexTurret(md, (g, mat, part) => add(g, m[mat], part === 'barrels' ? barrels! : root), { slab, box, cyl }) : null;
  if (ex) { rotates = ex.rotates; if (ex.barrels) barrels.position.set(...ex.barrels); else barrels = null; }
  else switch (md.weapon) {
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
    case 'pulse_laser': {
      add(cyl(1.3, 1.5, 2, 0, -0.9, 0), m.dark);
      add(new THREE.SphereGeometry(1.4, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), m.hull);
      barrels.position.set(0, 0.5, 0.8);
      add(cyl(0.22, 0.3, 4, 0, 0, 2, 'z', 8), m.gun, barrels);
      add(cyl(0.34, 0.34, 0.3, 0, 0, 3.9, 'z', 8), m.accent, barrels);
      break;
    }
    case 'particle_lance': {
      add(cyl(2.6, 3.0, 3, 0, -1.6, 0), m.dark);
      add(box(4.8, 2.4, 7, 0, 0.5, 0), m.hull);
      barrels.position.set(0, 0.5, 2.5);
      add(cyl(0.9, 1.1, 18, 0, 0, 9, 'z', 12), m.gun, barrels);
      for (let k = 0; k < 5; k++) add(cyl(1.4, 1.4, 0.4, 0, 0, 3 + k * 3, 'z', 12), m.accent, barrels);
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
    default: {
      // P5 arsenal weapons: a model per family, scaled by calibre, so families read apart at a glance
      const k = Math.max(0.5, w?.caliber ?? 1), fam = w?.family;
      if (w?.kind === 'craft') {
        // P16.4 hangar (H) mount: a deck elevator plate with a launch-lane marking — it launches craft, never aims
        rotates = false; barrels = null;
        add(box(3.2, 0.14, 4.2, 0, -0.9, 0), m.dark);
        add(box(0.2, 0.08, 3.6, 1.45, -0.8, 0), m.accent); add(box(0.2, 0.08, 3.6, -1.45, -0.8, 0), m.accent);
      } else if (fam === 'missile' || fam === 'torpedo') {
        rotates = false; barrels = null;
        if (fam === 'torpedo') { add(cyl(0.5 * k, 0.5 * k, 2.2 * k, 0, 0, 0, 'z', 10), m.dark); add(cyl(0.38 * k, 0.38 * k, 0.2, 0, 0, 1.15 * k, 'z', 10), m.accent); }
        else { add(box(1.6 * k, 0.8, 2.6 * k, 0, 0, 0), m.dark); for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) add(box(0.55 * k, 0.12, 0.55 * k, (-0.4 + i * 0.8) * k, 0.45, (-0.6 + j * 1.2) * k), m.accent); }
      } else if (fam === 'pd') {
        add(cyl(0.7, 0.8, 0.8, 0, -0.3, 0), m.dark);
        add(new THREE.SphereGeometry(0.75, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), m.hull);
        barrels.position.set(0, 0.35, 0.3);
        add(cyl(0.12, 0.14, 1.6, 0, 0, 0.8, 'z', 6), m.gun, barrels);
      } else if (fam === 'laser' || fam === 'plasma' || fam === 'particle') {
        add(cyl(1.1 * k, 1.3 * k, 1.6 * k, 0, -0.7 * k, 0), m.dark);
        add(new THREE.SphereGeometry(1.2 * k, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), m.hull);
        barrels.position.set(0, 0.45 * k, 0.6 * k);
        const len = (fam === 'plasma' ? 2.6 : fam === 'particle' ? 5 : 3.6) * k;
        add(cyl((fam === 'plasma' ? 0.42 : 0.2) * k, (fam === 'plasma' ? 0.5 : 0.28) * k, len, 0, 0, len / 2, 'z', 8), m.gun, barrels);
        for (let i = 0; i < (fam === 'particle' ? 3 : 1); i++) add(cyl(0.34 * k, 0.34 * k, 0.25, 0, 0, len * (0.95 - i * 0.28), 'z', 8), m.accent, barrels);
      } else {
        // coil / rail: boxy turret with twin rails
        add(cyl(1.2 * k, 1.4 * k, 1.4 * k, 0, -0.6 * k, 0), m.dark);
        add(box(2.2 * k, 1.1 * k, 2.6 * k, 0, 0.2 * k, 0), m.hull);
        barrels.position.set(0, 0.3 * k, 1.2 * k);
        const len = (w?.tier ?? 1) >= 3 ? 7 * k : 3.5 * k;
        for (const x of [-0.35, 0.35]) add(box(0.22 * k, 0.3 * k, len, x * k, 0, len / 2), m.gun, barrels);
      }
      break;
    }
  }
  if (ex && !ex.barrels) for (const [parent] of [...buckets]) if (parent !== root) buckets.delete(parent);
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
// shared by every ship (they used to be created per ship and never freed)
const glowGeo = new THREE.CircleGeometry(1, 20);
// P17.3.1 energy exhaust: a narrow white-hot core inside a wider sheath, both open cones running from the nozzle
// (z 0) to the tip (z -1). The shader fades along the length and towards the silhouette edge, so it reads as a
// glowing jet rather than a solid cone. One geometry for every engine; brightness is a per-engine uniform.
const plumeGeo = (() => {
  const cone = (r: number, len: number, layer: number) => {
    const g = new THREE.ConeGeometry(r, len, 16, 4, true);
    g.rotateX(-Math.PI / 2); g.translate(0, 0, -len / 2);
    g.setAttribute('layer', new THREE.Float32BufferAttribute(new Array(g.getAttribute('position').count).fill(layer), 1));
    return g;
  };
  return mergeGeometries([cone(0.42, 0.62, 0), cone(1, 1, 1)])!;
})();
/** shared clock for the exhaust shimmer (battleView advances it) */
export const plumeClock = { value: 0 };
const PLUME_VS = `attribute float layer; varying float vT; varying float vL; varying float vE; varying float vSeed;
void main() { vT = 1.0 - uv.y; vL = layer; vSeed = modelMatrix[3][0] * 0.13 + modelMatrix[3][2] * 0.07;
  vec4 mv = modelViewMatrix * vec4(position, 1.0); vec3 n = normalize(normalMatrix * normal);
  vE = abs(dot(n, normalize(-mv.xyz))); gl_Position = projectionMatrix * mv; }`;
const PLUME_FS = `uniform vec3 uColor; uniform vec3 uCore; uniform float uI; uniform float uTime; uniform float uWob;
varying float vT; varying float vL; varying float vE; varying float vSeed;
void main() {
  float core = 1.0 - step(0.5, vL);
  float fall = mix(pow(max(0.0, 1.0 - vT), 1.5), pow(max(0.0, 1.0 - vT), 2.4), core);
  float edge = mix(pow(vE, 1.2), pow(vE, 0.45), core);
  float shim = 1.0 - uWob + uWob * (0.5 + 0.5 * sin(uTime * 37.0 + vT * 21.0 + vSeed));
  vec3 col = mix(uColor, mix(uCore, uColor, clamp(vT * 1.3, 0.0, 1.0)), core);
  float a = fall * edge * shim * uI * mix(0.75, 1.6, core) * smoothstep(0.0, 0.06, vT + 0.02);
  gl_FragColor = vec4(col, min(a, 1.0));
}`;
/** maker exhaust character (limited: same team hue, different core and length) */
const EXHAUST: Record<number, { core: number; len: number; wob: number }> = {
  [TINT.helios]: { core: 0xf0f8ff, len: 1.15, wob: 0.06 }, [TINT.ceres]: { core: 0xf4eaff, len: 1.0, wob: 0.04 },
  [TINT.bastion]: { core: 0xfff2dc, len: 0.85, wob: 0.08 }, [TINT.rust]: { core: 0xffd0a0, len: 0.9, wob: 0.22 },
  [TINT.cobalt]: { core: 0xe8f0ff, len: 0.9, wob: 0.12 }, [TINT.old]: { core: 0xfff0c0, len: 0.8, wob: 0.16 },
};
function plumeMat(color: THREE.Color, tint: number | undefined): THREE.ShaderMaterial {
  const ex = (tint !== undefined && EXHAUST[tint]) || { core: 0xf4fbff, len: 1, wob: 0.08 };
  const mt = new THREE.ShaderMaterial({
    uniforms: { uColor: { value: color.clone() }, uCore: { value: new THREE.Color(ex.core) }, uI: { value: 1 }, uTime: plumeClock, uWob: { value: ex.wob } },
    vertexShader: PLUME_VS, fragmentShader: PLUME_FS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
  mt.userData.len = ex.len;
  return mt;
}
const lightGeo = new THREE.SphereGeometry(0.3, 6, 4);

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
  const bbex = cls.id === BBEX_CLASS;
  const mb = loadout.mesh ?? (bbex ? { base: 'bbex', scale: 1 } : undefined);
  const xd = mb ? designExtra(mb.base, cls.length, team) : undefined;
  const m = bbex ? matsBbex() : matsTint(team, xd?.tint);
  const key = xd ? `${mb!.base}@${mb!.scale}:${team}` : `${cls.id}:${team}`;
  let cached = geoCache.get(key);
  if (!cached) {
    // new hull classes reuse a base silhouette at their own length, widened/narrowed
    const al = !xd && Object.hasOwn(MESH_ALIAS, cls.id) ? MESH_ALIAS[cls.id] : undefined;
    const d = xd ?? design(al ? { ...cls, id: al[0] } : cls, team);
    const parts: Parts = { hull: [], dark: [], trim: [], accent: [], light: [], engines: [] };
    d.build(parts, cls.length);
    if (xd && mb!.scale !== 1) {
      const k = mb!.scale;
      for (const g of [...parts.hull, ...parts.dark, ...parts.trim, ...parts.accent]) g.scale(k, k, k);
      for (const e of parts.engines) { e.x *= k; e.y *= k; e.z *= k; e.r *= k; }
      for (const l of parts.light) l.multiplyScalar(k);
    }
    if (al) {
      const k = al[1];
      for (const g of [...parts.hull, ...parts.dark, ...parts.trim, ...parts.accent]) g.scale(k, k, 1);
      for (const e of parts.engines) { e.x *= k; e.y *= k; e.r *= k; }
      for (const l of parts.light) { l.x *= k; l.y *= k; }
    }
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
    if (f) { const mesh = new THREE.Mesh(f, mat); mesh.castShadow = false; mesh.userData.proc = 'hull'; front.add(mesh); }
    if (r) { const mesh = new THREE.Mesh(r, mat); mesh.userData.proc = 'hull'; rear.add(mesh); }
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
    if (bbex) {
      // flush mounts on their own fairings (no pedestals); ventral mounts hang upside-down
      let node: THREE.Object3D = root;
      if (md.pos[1] < -1) { const holder = new THREE.Group(); holder.position.copy(root.position); holder.scale.y = -1; root.position.set(0, 0, 0); holder.add(root); node = holder; }
      (md.pos[2] >= 0 ? front : rear).add(node);
      turrets.push(t);
      continue;
    }
    // pedestal for raised mounts so nothing floats
    peds[md.pos[2] >= 0 ? 0 : 1].push(cyl(WEAPONS[md.weapon].caliber * 0.6 + 0.3, WEAPONS[md.weapon].caliber * 0.7 + 0.4, 3, md.pos[0], md.pos[1] - 2, md.pos[2]));
    (md.pos[2] >= 0 ? front : rear).add(t.root);
    turrets.push(t);
  }
  for (const [i, half] of [front, rear].entries()) if (peds[i].length) { const p = new THREE.Mesh(mergeAll(peds[i]), m.dark); p.userData.proc = 'ped'; p.userData.own = true; half.add(p); }

  const engines: ShipModel['engines'] = [];
  if (parts.engines.length) { const n = new THREE.Mesh(mergeAll(parts.engines.map(e => cyl(e.r * 1.1, e.r * 1.35, e.r * 1.6, e.x, e.y, e.z + e.r * 0.6, 'z', 14))), m.trim); n.userData.proc = 'engine'; n.userData.own = true; rear.add(n); }
  addEngines(rear, parts.engines, m, engines, xd?.tint);
  const lights: THREE.Mesh[] = [];
  addLights(front, rear, parts.light, m, lights);
  const sm: ShipModel = { root, bank, front, rear, turrets, engines, lights, hullMats, length: cls.length * (xd ? mb!.scale : 1), model: null };
  // external model: drawn from data alone (HullDef.mesh.model / VariantDef.model); until it is loaded —
  // or if it never loads — the procedural hull above stands in, so the ship is always visible
  const mid = mb?.model;
  if (mid && modelsEnabled()) {
    const L = cls.length * (mb!.scale ?? 1);
    const t = modelReady(mid, L);
    if (t) applyModel(sm, t, m);
    else if (t === null) sm.model = { id: mid, state: 'fallback' };
    else {
      sm.model = { id: mid, state: 'loading' };
      loadModel(mid, L).then(tp => {
        if (!tp) { sm.model = { id: mid, state: 'fallback' }; return; }
        // a ship that already broke apart keeps the look it died with
        if (sm.front.parent === sm.bank && sm.rear.parent === sm.bank) applyModel(sm, tp, m);
      }, () => { sm.model = { id: mid, state: 'fallback' }; });
    }
  }
  return sm;
}

/** free what a ship model owns (its pedestal / nozzle geometry); hull, turret and model geometry is
 *  shared between ships and stays cached */
export function disposeShip(sm: ShipModel) {
  sm.root.removeFromParent();
  for (const half of [sm.front, sm.rear]) half.traverse(o => { if (o.userData.own) (o as THREE.Mesh).geometry.dispose(); if (o.userData.ownMat) ((o as THREE.Mesh).material as THREE.Material).dispose(); });
}

function addEngines(rear: THREE.Group, list: { x: number; y: number; z: number; r: number }[], m: Mats, out: ShipModel['engines'], tint?: number) {
  for (const e of list) {
    const glow = new THREE.Mesh(glowGeo, m.engine);
    glow.position.set(e.x, e.y, e.z - 0.25); glow.rotation.y = Math.PI; glow.scale.setScalar(e.r); glow.userData.proc = 'engine';
    rear.add(glow);
    const pm = plumeMat(m.plume.color, tint);
    const plume = new THREE.Mesh(plumeGeo, pm);
    plume.position.set(e.x, e.y, e.z - 0.3);
    plume.scale.set(e.r * 0.95, e.r * 0.95, e.r * 6); plume.userData.proc = 'engine'; plume.userData.ownMat = true;
    rear.add(plume);
    out.push({ glow, plume, base: e.r, len: pm.userData.len as number, cur: 0.5 });
  }
}
function addLights(front: THREE.Group, rear: THREE.Group, list: THREE.Vector3[], m: Mats, out: THREE.Mesh[]) {
  for (const p of list) { const l = new THREE.Mesh(lightGeo, m.light); l.position.copy(p); l.userData.proc = 'light'; (p.z >= 0 ? front : rear).add(l); out.push(l); }
}

/** replace the procedural hull with a loaded model template (turrets stay: they sit on the data
 *  hardpoints, which the validator matched to the model's hp_ markers) */
function applyModel(sm: ShipModel, t: ModelTemplate, m: Mats) {
  const replaceEngines = t.engines.length > 0, replaceLights = t.lights.length > 0;
  for (const half of [sm.front, sm.rear]) for (const o of [...half.children]) {
    const k = o.userData.proc;
    if (k === 'hull' || k === 'ped' || (k === 'engine' && replaceEngines) || (k === 'light' && replaceLights)) { half.remove(o); if (o.userData.own) (o as THREE.Mesh).geometry.dispose(); }
  }
  const mat = (p: ModelTemplate['hi']['front'][number]) => p.slot ? m[p.slot] : p.mat!;
  const meshes = (parts: ModelTemplate['hi']['front']) => { const g = new THREE.Group(); for (const p of parts) g.add(new THREE.Mesh(p.geo, mat(p))); return g; };
  for (const [half, hi, lo] of [[sm.front, t.hi.front, t.lo?.front], [sm.rear, t.hi.rear, t.lo?.rear]] as const) {
    if (lo) { const lod = new THREE.LOD(); lod.addLevel(meshes(hi), 0); lod.addLevel(meshes(lo), t.lodDistance); lod.userData.proc = 'model'; half.add(lod); }
    else { const g = meshes(hi); g.userData.proc = 'model'; half.add(g); }
  }
  if (replaceEngines) { sm.engines.length = 0; addEngines(sm.rear, t.engines, m, sm.engines); }
  if (replaceLights) { sm.lights.length = 0; addLights(sm.front, sm.rear, t.lights, m, sm.lights); }
  sm.length = t.length;
  sm.model = { id: t.id, state: 'model' };
}

export function factionColor(team: 0 | 1): number { return STYLE[team].accent; }
export function engineColor(team: 0 | 1): number { return STYLE[team].engine; }

/** P17.3: the raw hull parts of a content silhouette at its class length (unscaled, no materials) —
 *  used by tests/p17-hulls.test.ts to check that every hardpoint sits on the hull surface */
export function hullParts(base: string, L: number): { hull: THREE.BufferGeometry[]; dark: THREE.BufferGeometry[]; trim: THREE.BufferGeometry[]; accent: THREE.BufferGeometry[]; light: THREE.Vector3[]; engines: { x: number; y: number; z: number; r: number }[] } | undefined {
  const d = designExtra(base, L, 0);
  if (!d) return undefined;
  const parts: Parts = { hull: [], dark: [], trim: [], accent: [], light: [], engines: [] };
  d.build(parts, L);
  return parts;
}

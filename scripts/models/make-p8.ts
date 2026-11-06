// Reproducible authoring source for the P8 ships. 1 unit = game unit; +Z is the bow.
// Run: npx vite-node scripts/models/make-p8.ts && npm run models:hash -- --write
import fs from 'node:fs';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { writeGlb, type GlbMarker, type GlbMaterial } from './glb';
import { PATHFINDER_HP, LANCET_HP, QUARRY_HP, MERIDIAN_HP, VIGIL_HP } from '../../src/content/packs/growth/p8';

const MAT = {
  hull: { name: 'sid_hull', color: [0.75, 0.78, 0.82], metal: 0.5, rough: 0.5 },
  dark: { name: 'sid_dark', color: [0.2, 0.22, 0.26], metal: 0.6, rough: 0.7 },
  trim: { name: 'sid_trim', color: [0.55, 0.6, 0.68], metal: 0.8, rough: 0.35 },
  accent: { name: 'sid_accent', color: [0.3, 0.8, 1], metal: 0, rough: 1 },
  glass: { name: 'bridge_glass', color: [0.035, 0.1, 0.15], metal: 0.35, rough: 0.2, emissive: [0.015, 0.06, 0.09] },
  cargo: { name: 'industrial_ochre', color: [0.68, 0.32, 0.065], metal: 0.35, rough: 0.68 },
} satisfies Record<string, GlbMaterial>;
type MaterialKey = keyof typeof MAT;
type Bag = Record<MaterialKey, THREE.BufferGeometry[]>;
const bag = (): Bag => ({ hull: [], dark: [], trim: [], accent: [], glass: [], cargo: [] });
const box = (w: number, h: number, d: number, x: number, y: number, z: number) => new THREE.BoxGeometry(w, h, d).translate(x, y, z);
function cylinder(rt: number, rb: number, h: number, x: number, y: number, z: number, axis: 'y' | 'z' = 'y', segments = 12) {
  const g = new THREE.CylinderGeometry(rt, rb, h, segments);
  if (axis === 'z') g.rotateX(Math.PI / 2);
  return g.translate(x, y, z);
}
/** Symmetric plan [z, half-width]; bevel is kept within the supplied outer bounds. */
function plan(stations: [number, number][], y0: number, y1: number, bevel = 0.1) {
  const b = Math.min(bevel, (y1 - y0) * 0.3);
  const pts = stations.map(([z, w]) => [Math.sign(z) * Math.max(0, Math.abs(z) - b), Math.max(0.035, w - b)]);
  const shape = new THREE.Shape();
  pts.forEach(([z, w], i) => i ? shape.lineTo(w, z) : shape.moveTo(w, z));
  for (let i = pts.length - 1; i >= 0; i--) shape.lineTo(-pts[i][1], pts[i][0]);
  const g = new THREE.ExtrudeGeometry(shape, { depth: Math.max(0.01, y1 - y0 - 2 * b), bevelEnabled: b > 0, bevelThickness: b, bevelSize: b, bevelSegments: 1 });
  g.rotateX(Math.PI / 2); g.translate(0, y1 - b, 0); return g;
}
/** Side elevation [z,y] with a centered width. */
function side(points: [number, number][], width: number, bevel = 0.06) {
  const b = Math.min(bevel, width * 0.2);
  const s = new THREE.Shape(); points.forEach(([z, y], i) => i ? s.lineTo(z, y) : s.moveTo(z, y));
  const g = new THREE.ExtrudeGeometry(s, { depth: width - 2 * b, bevelEnabled: b > 0, bevelThickness: b, bevelSize: b, bevelSegments: 1 });
  g.rotateY(-Math.PI / 2); g.translate(width / 2 - b, 0, 0); return g;
}

function pathfinder(): { b: Bag; markers: GlbMarker[] } {
  const b = bag();
  // A long, low armored keel and a raised forecastle give this small patrol craft a readable bow.
  b.dark.push(plan([[-7.1, 1.20], [-5.8, 1.72], [-2.8, 1.94], [0, 1.88], [3.9, 1.38], [6.25, 0.70], [7.35, 0.08]], -0.92, 0.15, 0.12));
  b.hull.push(plan([[-6.55, 1.55], [-4.7, 1.91], [-1.9, 2.02], [0.9, 1.79], [4.1, 1.22], [6.35, 0.63], [7.28, 0.08]], -0.12, 0.76, 0.12));
  b.trim.push(plan([[0.1, 1.32], [3.2, 1.15], [5.6, 0.62], [6.75, 0.12]], 0.73, 0.84, 0.035));
  // Layered armored shoulders, with inset maintenance panels instead of surface noise.
  for (const s of [-1, 1]) {
    const shoulder = side([[-5.55, 0.05], [0.5, 0.05], [3.65, 0.33], [3.35, 0.62], [-3.9, 0.65], [-5.55, 0.45]], 0.22, 0.035);
    shoulder.translate(s * 1.64, 0, 0); b.trim.push(shoulder);
    b.dark.push(box(0.11, 0.11, 2.5, s * 1.44, 0.8, -3.55));
    b.hull.push(box(0.42, 0.24, 1.55, s * 1.55, 0.68, -1.25));
    b.trim.push(cylinder(0.40, 0.46, 0.38, s * 1.55, 0.99, -1.25, 'y', 12));
    // Compact twin drive pods and visible, recessed nozzle lips.
    b.hull.push(box(0.95, 1.08, 2.6, s * 1.05, -0.05, -5.65));
    b.trim.push(cylinder(0.53, 0.48, 0.34, s * 1.05, -0.10, -7.17, 'z', 16));
    b.dark.push(cylinder(0.38, 0.38, 0.02, s * 1.05, -0.10, -7.345, 'z', 16));
    b.accent.push(box(0.08, 0.07, 1.35, s * 1.21, 0.86, 3.0));
  }
  // Flat weapon seats: the actual guns are supplied by the game's fitting system.
  b.trim.push(cylinder(0.45, 0.53, 0.42, 0, 1.04, 3.7, 'y', 16));
  b.trim.push(cylinder(0.38, 0.44, 0.55, 0, 1.145, -4.45, 'y', 12));
  // Low, faceted command citadel with a narrow, continuous observation slit.
  b.hull.push(side([[-2.6, 0.75], [1.35, 0.75], [0.70, 1.76], [-0.30, 2.12], [-2.35, 1.88]], 1.75, 0.08));
  b.glass.push(box(1.34, 0.19, 0.055, 0, 1.70, 0.73));
  b.trim.push(plan([[-2.28, 0.65], [-0.46, 0.75], [0.28, 0.48]], 1.94, 2.08, 0.045));
  b.dark.push(box(0.42, 0.20, 0.75, 0, 2.19, -1.36));
  b.accent.push(box(0.70, 0.06, 0.07, 0, 2.31, -1.35));
  const markers: GlbMarker[] = [
    ...PATHFINDER_HP.map(p => ({ name: `hp_${p.id}`, pos: p.pos })),
    { name: 'engine_1', pos: [1.05, -0.10, -7.35], scale: 0.38 },
    { name: 'engine_2', pos: [-1.05, -0.10, -7.35], scale: 0.38 },
    { name: 'light_1', pos: [1.91, 0.55, -3.2] }, { name: 'light_2', pos: [-1.91, 0.55, -3.2] },
  ];
  return { b, markers };
}

function lancet(): { b: Bag; markers: GlbMarker[] } {
  const b = bag();
  // Long, fine entrance, broad shoulders and a nearly flush launch deck: a missile ship first.
  b.dark.push(plan([[-13.2, 2.10], [-10.8, 3.15], [-5, 3.35], [1, 3.15], [7, 2.45], [11.6, 1.10], [13.2, 0.12]], -1.35, 0.25, 0.16));
  b.hull.push(plan([[-12.65, 2.4], [-9.7, 3.25], [-4.6, 3.35], [2.5, 2.95], [7.6, 2.10], [11.6, 0.95], [13.05, 0.12]], 0.18, 1.55, 0.16));
  b.trim.push(plan([[5.2, 1.75], [9.6, 1.36], [12.4, 0.32]], 1.51, 1.66, 0.05));
  b.dark.push(box(5.45, 0.30, 8.5, 0, 1.62, 1));
  // Four fitted missiles occupy these four armored wells. The engine draws their launch boxes.
  for (const p of LANCET_HP.filter(p => p.type === 'missile')) {
    b.trim.push(box(2.35, 0.22, 3.55, p.pos[0], 1.88, p.pos[2]));
    b.dark.push(box(2.13, 0.12, 3.24, p.pos[0], 2.05, p.pos[2]));
  }
  b.trim.push(cylinder(1.45, 1.65, 1.0, 0, 2.0, 8.3, 'y', 20));
  b.hull.push(side([[-9.15, 1.5], [-3.65, 1.5], [-4.2, 3.25], [-5.35, 4.1], [-8.65, 3.65]], 2.9, 0.12));
  b.glass.push(box(2.1, 0.22, 0.08, 0, 3.1, -4.18));
  b.trim.push(box(2.5, 0.18, 2.4, 0, 4.0, -6.65));
  b.dark.push(box(1.0, 0.38, 0.8, 0, 4.25, -7));
  b.accent.push(box(0.95, 0.07, 0.12, 0, 4.48, -6.9));
  for (const s of [-1, 1]) {
    b.trim.push(side([[-10.7, -0.2], [2.9, -0.2], [6.4, 0.4], [5.6, 0.85], [-9.2, 0.9], [-10.7, 0.5]], 0.28, 0.04).translate(s * 2.8, 0, 0));
    b.hull.push(box(1.05, 0.75, 2.4, s * 2.65, 1.5, -7.7));
    b.trim.push(cylinder(0.52, 0.62, 0.38, s * 2.65, 2.06, -7.7, 'y', 12));
    b.dark.push(box(0.24, 0.14, 3.2, s * 2.35, 1.65, -3.4));
    b.accent.push(box(0.12, 0.08, 2.8, s * 2.15, 1.66, 5.7));
  }
  b.dark.push(box(5.3, 1.9, 2.6, 0, -0.25, -11.45));
  for (const x of [-1.7, 0, 1.7]) {
    b.trim.push(cylinder(0.72, 0.62, 0.55, x, -0.25, -12.9, 'z', 16));
    b.dark.push(cylinder(0.53, 0.53, 0.04, x, -0.25, -13.18, 'z', 16));
  }
  return { b, markers: [
    ...LANCET_HP.map(p => ({ name: `hp_${p.id}`, pos: p.pos })),
    ...[-1.7, 0, 1.7].map((x, i) => ({ name: `engine_${i + 1}`, pos: [x, -0.25, -13.2] as [number, number, number], scale: 0.52 })),
    { name: 'light_1', pos: [3.3, 0.8, -8.3] }, { name: 'light_2', pos: [-3.3, 0.8, -8.3] },
  ] };
}

function quarry(): { b: Bag; markers: GlbMarker[] } {
  const b = bag();
  // Working end is a pair of heavy, open-set booms; the gap exposes the ore intake.
  b.dark.push(plan([[-19.5, 2.55], [-16.7, 3.8], [-8.0, 4.0], [-1.0, 3.45], [2.7, 2.55]], -1.8, 0.2, 0.18));
  b.hull.push(plan([[-19.0, 2.65], [-15.5, 3.8], [-7.0, 3.8], [-0.2, 3.25], [3.0, 2.25]], 0.05, 1.35, 0.17));
  b.dark.push(box(2.2, 1.4, 22.0, 0, -0.75, 3.4)); // conveyor and intake well
  for (const s of [-1, 1]) {
    b.hull.push(box(1.35, 1.7, 18.0, s * 3.1, 0.0, 9.2));
    b.trim.push(box(1.5, 0.25, 17.2, s * 3.1, 0.97, 9.1));
    b.dark.push(box(0.22, 0.22, 14, s * 3.1, 1.16, 8.9));
    // Tool collars and replaceable cutter drums at the ends of the load-bearing booms.
    b.trim.push(cylinder(1.05, 1.05, 2.25, s * 3.1, 0.05, 17.9, 'z', 12));
    b.dark.push(cylinder(0.98, 0.98, 0.28, s * 3.1, 0.05, 19.15, 'z', 12));
    b.trim.push(cylinder(0.45, 0.68, 0.20, s * 3.1, 0.05, 19.31, 'z', 12));
    for (let i = 0; i < 8; i++) {
      const angle = i * Math.PI / 4;
      b.trim.push(box(0.27, 0.24, 0.35, 0, 0, 0).rotateZ(angle).translate(s * 3.1 + Math.cos(angle) * 0.83, 0.05 + Math.sin(angle) * 0.83, 19.28));
    }
    b.cargo.push(box(1.18, 0.16, 2.1, s * 3.1, 1.23, 14.3));
    // Raised ore hoppers and protective retaining ribs.
    b.hull.push(box(2.6, 2.4, 8.5, s * 1.56, 2.02, -6.7));
    b.trim.push(box(0.18, 2.65, 8.5, s * 2.8, 2.02, -6.7));
    for (const z of [-10.2, -6.7, -3.2]) b.dark.push(box(2.55, 0.13, 0.18, s * 1.56, 3.29, z));
    b.cargo.push(box(1.5, 0.08, 0.5, s * 1.55, 3.31, -6.7));
    b.hull.push(box(0.95, 1.25, 1.9, s * 3.65, 2.2, -9));
    b.trim.push(cylinder(0.5, 0.58, 0.55, s * 3.65, 2.825, -9, 'y', 12));
  }
  b.trim.push(box(6.4, 0.5, 0.8, 0, 0.7, 4.2)); // cross brace, leaving the intake visible
  b.cargo.push(box(1.7, 0.14, 3.6, 0, 0.02, 10.4));
  b.hull.push(side([[-17.2, 1.2], [-11.4, 1.2], [-12.3, 3.15], [-14, 3.75], [-17.2, 3.35]], 2.6, 0.1));
  b.glass.push(box(1.9, 0.25, 0.08, 0, 2.95, -12.35));
  b.accent.push(box(1.4, 0.08, 0.15, 0, 3.7, -14.8));
  b.dark.push(box(6, 2.8, 3, 0, -0.35, -17.75));
  for (const s of [-1, 1]) {
    b.trim.push(cylinder(0.95, 0.9, 0.6, s * 1.8, -0.35, -19.15, 'z', 16));
    b.dark.push(cylinder(0.7, 0.7, 0.04, s * 1.8, -0.35, -19.46, 'z', 16));
  }
  return { b, markers: [
    ...QUARRY_HP.map(p => ({ name: `hp_${p.id}`, pos: p.pos })),
    { name: 'engine_1', pos: [1.8, -0.35, -19.5], scale: 0.7 }, { name: 'engine_2', pos: [-1.8, -0.35, -19.5], scale: 0.7 },
    { name: 'light_1', pos: [3.8, 1.4, 14] }, { name: 'light_2', pos: [-3.8, 1.4, 14] },
  ] };
}

function meridian(): { b: Bag; markers: GlbMarker[] } {
  const b = bag();
  // A transport spine and end frames support six independent, rectangular cargo cassettes.
  b.dark.push(box(2.2, 2.4, 54, 0, -0.35, 0));
  for (const s of [-1, 1]) {
    b.trim.push(box(0.55, 0.65, 49, s * 6.2, -0.65, 0));
    for (const z of [-14.5, 0, 14.5]) {
      b.hull.push(box(5.0, 3.5, 12.4, s * 3.35, 0.65, z));
      // Hinged latches and end bands express removable modules at game camera distances.
      for (const dz of [-5.8, 5.8]) b.trim.push(box(5.15, 3.65, 0.42, s * 3.35, 0.65, z + dz));
      for (const dz of [-3.5, 0, 3.5]) b.dark.push(box(4.65, 0.12, 0.18, s * 3.35, 2.47, z + dz));
      b.cargo.push(box(2.7, 0.08, 1.1, s * 3.35, 2.48, z));
    }
    for (const z of [-21.5, -7.25, 7.25, 21.5]) b.trim.push(box(12.9, 0.48, 0.55, 0, -1.20, z));
    for (const z of [-21.5, 21.5]) {
      b.hull.push(box(1.2, 2.0, 2.0, s * 5.15, 3.0, z));
      b.trim.push(cylinder(0.55, 0.65, 1.0, s * 5.15, 4.0, z, 'y', 12));
    }
  }
  b.hull.push(plan([[21, 4.5], [26, 4.4], [31, 2.9], [34, 0.55]], -1.7, 2.3, 0.18));
  b.hull.push(side([[24.0, 2.2], [31.0, 2.2], [29.8, 4.2], [27.5, 4.8], [24.0, 4.0]], 4.0, 0.12));
  b.glass.push(box(3.1, 0.35, 0.10, 0, 3.75, 29.9));
  b.accent.push(box(2.0, 0.10, 0.15, 0, 4.8, 27));
  b.dark.push(box(10.0, 4.5, 9.0, 0, -0.1, -29.1));
  b.hull.push(box(10.6, 1.1, 5.5, 0, 2.3, -28));
  for (const x of [-3.1, 0, 3.1]) {
    b.trim.push(cylinder(1.25, 1.05, 0.75, x, -0.15, -33.6, 'z', 16));
    b.dark.push(cylinder(0.90, 0.90, 0.04, x, -0.15, -33.98, 'z', 16));
  }
  return { b, markers: [
    ...MERIDIAN_HP.map(p => ({ name: `hp_${p.id}`, pos: p.pos })),
    ...[-3.1, 0, 3.1].map((x, i) => ({ name: `engine_${i + 1}`, pos: [x, -0.15, -34] as [number, number, number], scale: 0.9 })),
    { name: 'light_1', pos: [6.4, 0, 21.5] }, { name: 'light_2', pos: [-6.4, 0, 21.5] },
  ] };
}

function vigil(): { b: Bag; markers: GlbMarker[] } {
  const b = bag();
  // The cruiser has a long armored wedge, a stepped citadel, and separated bow/stern gun decks.
  b.dark.push(plan([[-17.6, 2.7], [-14.5, 3.8], [-7, 4.35], [2, 4.15], [10, 3.25], [15.5, 1.55], [17.6, 0.12]], -1.8, 0.35, 0.18));
  b.hull.push(plan([[-17.1, 2.8], [-13.7, 3.9], [-7, 4.25], [3, 4.05], [10.7, 3.1], [15.5, 1.4], [17.4, 0.12]], 0.2, 1.9, 0.18));
  b.hull.push(plan([[-13.2, 2.8], [-9, 3.2], [3, 3.15], [9.8, 2.4], [14.0, 1.1]], 1.8, 2.35, 0.1));
  for (const z of [10.5, -10]) b.trim.push(cylinder(1.6, 1.8, 1.1, 0, 2.6, z, 'y', 20));
  b.hull.push(side([[-6.8, 2.3], [3.6, 2.3], [2.3, 4.2], [0.6, 5.1], [-4.8, 5.1], [-6.8, 4.35]], 3.6, 0.12));
  b.glass.push(box(2.9, 0.28, 0.09, 0, 4.0, 2.33));
  b.trim.push(plan([[-4.8, 1.45], [-0.2, 1.5], [1.2, 0.85]], 5.0, 5.22, 0.06));
  b.dark.push(box(1.15, 0.45, 1.2, 0, 5.43, -2.3));
  b.accent.push(box(1.3, 0.08, 0.15, 0, 5.70, -2.3));
  for (const s of [-1, 1]) {
    b.trim.push(side([[-14, -0.1], [4.5, -0.1], [11.5, 0.55], [10.1, 1.15], [-11.5, 1.2], [-14, 0.7]], 0.34, 0.05).translate(s * 3.55, 0, 0));
    b.hull.push(box(1.4, 0.8, 2.8, s * 3.15, 2.0, -1));
    b.trim.push(cylinder(0.65, 0.75, 0.5, s * 3.15, 2.4, -1, 'y', 16));
    b.hull.push(box(1.1, 0.75, 2.1, s * 3.1, 1.95, 7));
    b.trim.push(cylinder(0.5, 0.58, 0.45, s * 3.1, 2.325, 7, 'y', 12));
    b.dark.push(box(0.24, 0.15, 4.3, s * 2.6, 2.4, -7.0));
    b.accent.push(box(0.1, 0.08, 4.2, s * 2.2, 2.4, 9.5));
  }
  b.dark.push(box(6.5, 2.7, 3.0, 0, -0.2, -15.9));
  for (const x of [-2.15, 0, 2.15]) {
    b.trim.push(cylinder(1.05, 0.95, 0.6, x, -0.2, -17.25, 'z', 16));
    b.dark.push(cylinder(0.8, 0.8, 0.04, x, -0.2, -17.56, 'z', 16));
  }
  return { b, markers: [
    ...VIGIL_HP.map(p => ({ name: `hp_${p.id}`, pos: p.pos })),
    ...[-2.15, 0, 2.15].map((x, i) => ({ name: `engine_${i + 1}`, pos: [x, -0.2, -17.6] as [number, number, number], scale: 0.8 })),
    { name: 'light_1', pos: [4.0, 1.1, -8] }, { name: 'light_2', pos: [-4.0, 1.1, -8] },
  ] };
}

function save(id: string, { b, markers }: { b: Bag; markers: GlbMarker[] }) {
  const clean = (g: THREE.BufferGeometry) => {
    const n = g.index ? g.toNonIndexed() : g;
    for (const k of Object.keys(n.attributes)) if (k !== 'position' && k !== 'normal') n.deleteAttribute(k);
    n.clearGroups(); return n;
  };
  const parts = (Object.keys(b) as MaterialKey[]).filter(k => b[k].length).map(k => ({ mat: MAT[k], geo: mergeGeometries(b[k].map(clean))! }));
  const bytes = writeGlb(id, parts, markers, 'siderarium P8 production ship authoring');
  fs.mkdirSync('public/assets/content/models', { recursive: true });
  fs.writeFileSync(`public/assets/content/models/${id}.glb`, bytes);
  const tris = parts.reduce((n, p) => n + p.geo.getAttribute('position').count / 3, 0);
  console.log(`${id}: ${(bytes.length / 1024).toFixed(1)} KiB, ${tris} triangles`);
}

save('patrol_pathfinder', pathfinder());
save('destroyer_lancet', lancet());
save('miner_quarry', quarry());
save('hauler_meridian', meridian());
save('cruiser_vigil', vigil());

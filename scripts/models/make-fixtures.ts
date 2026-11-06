// Generates the model-loader TEST fixtures (public/assets/content/models/fixtures/*.glb) — a warship
// and an industrial ship following the model standard (src/content/modelSpec.ts): +z bow, origin at
// the hull centre, 1 unit = 1 game unit, hp_/engine_/light_ markers, sid_* team materials.
// These are loader fixtures, not final art.  Run: npx vite-node scripts/models/make-fixtures.ts
// then: npm run models:hash -- --write
import fs from 'node:fs';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { writeGlb, type GlbMaterial, type GlbMarker } from './glb';
import { TESTBED_DD_HP, TESTBED_HAULER_HP } from '../../src/content/packs/modeltest';

const OUT = 'public/assets/content/models/fixtures';
const M: Record<string, GlbMaterial> = {
  hull: { name: 'sid_hull', color: [0.75, 0.78, 0.82], metal: 0.5, rough: 0.5 },
  dark: { name: 'sid_dark', color: [0.2, 0.22, 0.26], metal: 0.6, rough: 0.7 },
  trim: { name: 'sid_trim', color: [0.55, 0.6, 0.68], metal: 0.8, rough: 0.35 },
  accent: { name: 'sid_accent', color: [0.3, 0.8, 1], metal: 0, rough: 1, emissive: [0.3, 0.8, 1] },
  glass: { name: 'glass', color: [0.08, 0.15, 0.22], metal: 0.2, rough: 0.1, emissive: [0.45, 0.75, 1] },
  cargo: { name: 'cargo_paint', color: [0.86, 0.55, 0.17], metal: 0.3, rough: 0.6 },
};
type Bag = Record<keyof typeof M, THREE.BufferGeometry[]>;
const bag = (): Bag => ({ hull: [], dark: [], trim: [], accent: [], glass: [], cargo: [] });
const clean = (g: THREE.BufferGeometry) => { const n = g.index ? g.toNonIndexed() : g; for (const k of Object.keys(n.attributes)) if (k !== 'position' && k !== 'normal') n.deleteAttribute(k); n.clearGroups(); return n; };

const box = (w: number, h: number, d: number, x: number, y: number, z: number) => new THREE.BoxGeometry(w, h, d).translate(x, y, z);
function cyl(r0: number, r1: number, h: number, x: number, y: number, z: number, axis: 'y' | 'z', seg: number) {
  const g = new THREE.CylinderGeometry(r0, r1, h, seg); if (axis === 'z') g.rotateX(Math.PI / 2); return g.translate(x, y, z);
}
/** top-view plan [z, half-width][] extruded between y0 and y1 */
function plan(pts: [number, number][], y0: number, y1: number, bevel: number) {
  const h = y1 - y0, b = Math.min(bevel, h * 0.3);
  // the bevel grows the outline by b: inset it so the finished part keeps the drawn plan
  pts = pts.map(([z, w]) => [Math.sign(z) * Math.max(0, Math.abs(z) - b), Math.max(0.05, w - b)]);
  const s = new THREE.Shape();
  pts.forEach(([z, w], i) => i ? s.lineTo(w, z) : s.moveTo(w, z));
  for (let i = pts.length - 1; i >= 0; i--) s.lineTo(-pts[i][1], pts[i][0]);
  const g = new THREE.ExtrudeGeometry(s, { depth: Math.max(0.05, h - 2 * b), bevelEnabled: b > 0, bevelThickness: b, bevelSize: b, bevelSegments: 2 });
  g.rotateX(Math.PI / 2); g.translate(0, y1 - b, 0); return g;
}
/** side profile [z, y][] extruded across x (width w, centred) */
function side(pts: [number, number][], w: number, bevel: number) {
  const s = new THREE.Shape(); pts.forEach(([z, y], i) => i ? s.lineTo(z, y) : s.moveTo(z, y));
  const b = Math.min(bevel, w * 0.2);
  const g = new THREE.ExtrudeGeometry(s, { depth: w - 2 * b, bevelEnabled: b > 0, bevelThickness: b, bevelSize: b, bevelSegments: 2 });
  g.rotateY(-Math.PI / 2); g.translate(w / 2 - b, 0, 0); return g;
}

function destroyer(lod: boolean): { b: Bag; mk: GlbMarker[] } {
  const b = bag(), seg = lod ? 6 : 24, bev = lod ? 0 : 0.25;
  b.dark.push(plan([[-13.2, 2.6], [-9, 3.3], [0, 3.5], [6, 2.8], [10.5, 1.6], [13.2, 0.35]], -1.8, 0.2, bev));
  b.hull.push(plan([[-12.6, 2.4], [-9, 3.0], [0, 3.2], [6, 2.5], [10.5, 1.3], [12.8, 0.3]], 0.2, 1.6, bev));
  b.hull.push(plan([[3.5, 2.0], [8, 1.8], [10.8, 0.9]], 1.5, 2.0, bev));                    // forecastle
  for (const p of TESTBED_DD_HP) {
    if (p.size === 'M') b.trim.push(cyl(1.5, 1.7, 1.6, p.pos[0], p.pos[1] - 0.85, p.pos[2], 'y', seg));       // barbettes
    else if (p.type === 'pd') b.trim.push(cyl(0.6, 0.75, 1.0, p.pos[0], p.pos[1] - 0.5, p.pos[2], 'y', seg));
  }
  for (const s of [1, -1]) b.dark.push(box(1.3, 1.35, 2.8, s * 3.25, 1.075, 2));               // sponsons (sp1/sp2 at y 1.8)
  b.hull.push(side([[-3.2, 1.6], [3.0, 1.6], [2.2, 3.4], [0.6, 4.3], [-2.6, 4.3], [-3.2, 3.6]], 2.8, bev));   // bridge
  b.glass.push(box(2.5, 0.35, 0.3, 0, 3.75, 1.95));
  b.trim.push(cyl(0.18, 0.22, 3.0, 0, 5.8, -1.2, 'y', lod ? 5 : 8));                           // mast
  if (!lod) { b.trim.push(box(2.4, 0.12, 0.12, 0, 6.6, -1.2)); b.dark.push(box(1.2, 0.5, 0.15, 0, 7.0, -1.2)); }
  b.dark.push(box(4.6, 2.6, 3.0, 0, -0.3, -11.6));                                             // engine block
  for (const s of [1, -1]) {
    b.trim.push(cyl(1.05, 0.95, 4, s * 1.6, -0.3, -11.2, 'z', seg));                           // nacelles
    b.hull.push(box(0.2, 1.8, 2.4, s * 1.2, 2.3, -11));                                         // fins
    if (!lod) { b.dark.push(box(0.5, 0.25, 1.6, s * 1.9, 1.7, -2.5)); b.dark.push(box(0.4, 0.3, 0.9, s * 1.4, 1.75, 4.6)); b.accent.push(box(0.12, 0.06, 3.2, s * 0.9, 2.03, 8.2)); }
  }
  b.accent.push(box(4.7, 0.25, 0.25, 0, 1.05, -10.15));
  b.accent.push(box(2.9, 0.12, 2.0, 0, 4.36, -1.0));
  const mk: GlbMarker[] = [
    ...TESTBED_DD_HP.map(p => ({ name: `hp_${p.id}`, pos: p.pos })),
    { name: 'engine_1', pos: [1.6, -0.3, -13.2], scale: 0.8 }, { name: 'engine_2', pos: [-1.6, -0.3, -13.2], scale: 0.8 },
    { name: 'light_1', pos: [0, 7.3, -1.2] }, { name: 'light_2', pos: [3.9, 0.6, 2] }, { name: 'light_3', pos: [-3.9, 0.6, 2] },
  ];
  return { b, mk };
}

function hauler(): { b: Bag; mk: GlbMarker[] } {
  const b = bag(), seg = 18;
  b.dark.push(box(2.4, 2.4, 34, 0, 0, -1));                                                    // spine
  for (let z = -16; z <= 14; z += 5) b.trim.push(box(8.6, 0.4, 0.4, 0, 0, z));                // ribs
  for (const zc of [-11.5, -1.5, 8.5]) for (const s of [1, -1]) {
    b.cargo.push(cyl(2.4, 2.4, 9.2, s * 3.2, 0, zc, 'z', seg));                                // tanks
    for (const e of [-4.7, 4.7]) b.trim.push(cyl(2.5, 2.5, 0.35, s * 3.2, 0, zc + e, 'z', seg));
  }
  b.hull.push(plan([[14.6, 3.6], [19.5, 3.5], [23.5, 2.2], [25, 0.8]], -2.6, 2.6, 0.3));         // command module
  b.hull.push(box(5, 1.6, 4, 0, 3.3, 18));
  b.glass.push(box(3.2, 0.5, 0.5, 0, 1.9, 23.0));
  b.glass.push(box(4.6, 0.4, 0.2, 0, 3.4, 20.05));
  for (const p of TESTBED_HAULER_HP) {
    b.trim.push(box(1.0, p.pos[1] - 2.3, 1.0, p.pos[0], (p.pos[1] + 2.3) / 2 - 0.1, p.pos[2])); // pylon
    b.dark.push(cyl(0.6, 0.7, 0.3, p.pos[0], p.pos[1] - 0.15, p.pos[2], 'y', 12));
    b.trim.push(box(Math.abs(p.pos[0]) - 1.2, 0.5, 0.6, Math.sign(p.pos[0]) * (Math.abs(p.pos[0]) / 2 + 0.6), 2.3, p.pos[2]));
  }
  b.dark.push(box(9, 6, 6, 0, 0, -21));                                                       // engine block
  for (const x of [-2.8, 0, 2.8]) b.trim.push(cyl(1.1, 1.3, 1.2, x, 0, -24.4, 'z', seg));
  for (const s of [1, -1]) b.trim.push(box(0.15, 4, 4.6, s * 4.7, 0, -20.8));                 // radiators
  b.accent.push(box(7.5, 0.3, 0.3, 0, 2.7, 15.2));
  b.accent.push(box(9.1, 0.3, 0.3, 0, 3.05, -18.2));
  const mk: GlbMarker[] = [
    ...TESTBED_HAULER_HP.map(p => ({ name: `hp_${p.id}`, pos: p.pos })),
    ...[-2.8, 0, 2.8].map((x, i) => ({ name: `engine_${i + 1}`, pos: [x, 0, -25] as [number, number, number], scale: 1 })),
    { name: 'light_1', pos: [3.7, 0, 21] }, { name: 'light_2', pos: [-3.7, 0, 21] }, { name: 'light_3', pos: [0, 4.3, 18] },
  ];
  return { b, mk };
}

function save(name: string, file: string, { b, mk }: { b: Bag; mk: GlbMarker[] }) {
  const parts = (Object.keys(b) as (keyof Bag)[]).filter(k => b[k].length).map(k => ({ mat: M[k], geo: mergeGeometries(b[k].map(clean))! }));
  const bytes = writeGlb(name, parts, mk);
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(`${OUT}/${file}`, bytes);
  const tris = parts.reduce((a, p) => a + p.geo.getAttribute('position').count / 3, 0);
  console.log(`${file}: ${(bytes.length / 1024).toFixed(0)} KB, ${tris} triangles`);
}
save('testbed_destroyer', 'testbed_destroyer.glb', destroyer(false));
save('testbed_destroyer_lod', 'testbed_destroyer_lod.glb', destroyer(true));
save('testbed_hauler', 'testbed_hauler.glb', hauler());

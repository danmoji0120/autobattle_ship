// BB-EX — procedural hull and exclusive turrets.
//
// A slender blade of a light cruiser: twin prows with the DCP-Ω emitter between them, a raised
// dorsal spine with the funnel bays, swept strakes like folded wings and a broken halo ring around
// the stern. White armour, black understructure, violet light. Built from code like every other hull
// (src/render/shipMesh.ts), in the ship-local frame: +x port, +y up, +z bow.
import * as THREE from 'three';
import type { MountDef } from '../../sim/data/ships';
import { BBEX_MOUNTS, BBEX_WEAPON } from '../../sim/bbex/data';

export interface Helpers {
  slab(profile: [number, number][], L: number, W: number, t0: number, t1: number, y0: number, h: number, bevel?: number): THREE.BufferGeometry;
  box(w: number, h: number, d: number, x: number, y: number, z: number): THREE.BufferGeometry;
  cyl(rt: number, rb: number, h: number, x: number, y: number, z: number, axis?: 'y' | 'z', seg?: number): THREE.BufferGeometry;
}
export interface PartsLike { hull: THREE.BufferGeometry[]; dark: THREE.BufferGeometry[]; trim: THREE.BufferGeometry[]; accent: THREE.BufferGeometry[]; light: THREE.Vector3[]; engines: { x: number; y: number; z: number; r: number }[] }

export const BBEX_COLORS = { hull: 0xeeeaf6, dark: 0x16121f, trim: 0x7a55c8, accent: 0xb46bff, engine: 0xc9a0ff, light: 0xe6c8ff, gun: 0x2a2436, hot: 0xf2dcff };

/** a flat plate: polygon in the xz plane (x, z), extruded from y0 up by h. Mirrored copies keep their winding. */
function plate(pts: [number, number][], y0: number, h: number, bevel = 0.08): THREE.BufferGeometry {
  // signed area decides the winding; ExtrudeGeometry wants a counter-clockwise shape
  let area = 0;
  for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; area += a[0] * b[1] - b[0] * a[1]; }
  const p = area < 0 ? pts.slice().reverse() : pts;
  const sh = new THREE.Shape();
  p.forEach(([x, z], i) => (i ? sh.lineTo(x, z) : sh.moveTo(x, z)));
  sh.closePath();
  const b = Math.min(bevel, h * 0.3);
  const g = new THREE.ExtrudeGeometry(sh, { depth: Math.max(0.02, h - b * 2), bevelEnabled: b > 0, bevelThickness: b, bevelSize: b, bevelSegments: 1 });
  g.rotateX(Math.PI / 2);            // shape y → +z, extrusion → −y
  g.translate(0, y0 + h - b, 0);
  return g;
}
const mirror = (pts: [number, number][]): [number, number][] => pts.map(([x, z]) => [-x, z]);

const PROFILE: [number, number][] = [[-0.5, 0.5], [-0.42, 0.82], [-0.2, 1], [0.06, 0.9], [0.24, 0.66], [0.33, 0.52]];
const W = 5.3;
const hw = (t: number): number => {
  for (let i = 0; i < PROFILE.length - 1; i++) { const [t0, w0] = PROFILE[i], [t1, w1] = PROFILE[i + 1]; if (t >= t0 && t <= t1) return (w0 + (w1 - w0) * (t - t0) / (t1 - t0)) * W; }
  return (t < PROFILE[0][0] ? PROFILE[0][1] : PROFILE[PROFILE.length - 1][1]) * W;
};

export function bbexDesign(L: number, h: Helpers): { profile: [number, number][]; W: number; build: (p: PartsLike) => void } {
  return {
    profile: PROFILE, W, build: (p) => {
      const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
      // ── main body: white armour over a black keel
      p.hull.push(h.slab(PROFILE, L, W, -0.5, 0, -1.5, 3.0, 0.5), h.slab(PROFILE, L, W, 0, 0.33, -1.5, 3.0, 0.5));
      p.dark.push(h.slab(PROFILE.map(([t, w]) => [t, w * 0.72]) as [number, number][], L, W, -0.47, 0.3, -2.9, 1.6, 0.4));
      p.dark.push(h.slab(PROFILE.map(([t, w]) => [t, w * 1.03]) as [number, number][], L, W, -0.44, 0.26, -0.35, 0.5, 0.1));   // waist seam
      // ── twin prows: two long tines, the emitter trench between them
      for (const s of [1, -1]) {
        const tine: [number, number][] = [[1.05, 12.6], [2.75, 12.6], [2.3, 17.4], [1.55, 22.6], [1.05, 21.2]];
        p.hull.push(plate(s > 0 ? tine : mirror(tine), -0.9, 2.3, 0.3));
        const under: [number, number][] = [[1.0, 12.4], [2.2, 12.4], [1.7, 19.6], [1.0, 19.2]];
        p.dark.push(plate(s > 0 ? under : mirror(under), -2.0, 1.2, 0.2));
        // glowing inner rails of the emitter
        p.accent.push(h.box(0.1, 0.55, 8.4, s * 1.0, 0.4, 16.8), h.box(0.1, 0.16, 7.4, s * 1.0, -0.5, 16.4));
        // focusing vanes along the tines
        for (let k = 0; k < 4; k++) p.trim.push(h.box(0.5, 1.5, 0.22, s * 1.25, 0.4, 13.6 + k * 1.9));
      }
      p.dark.push(h.box(2.0, 1.6, 6.5, 0, -0.5, 15.2));                              // trench floor / accelerator block
      p.dark.push(h.cyl(1.05, 1.05, 3.2, 0, 0.4, 12.4, 'z', 16));                    // breech
      p.accent.push(h.cyl(0.62, 0.62, 3.3, 0, 0.4, 12.4, 'z', 12));
      // ── dorsal spine and bridge
      const spine = PROFILE.map(([t, w]) => [t, w * 0.4]) as [number, number][];
      p.hull.push(h.slab(spine, L, W, -0.44, 0, 1.3, 1.5, 0.35), h.slab(spine, L, W, 0, 0.24, 1.3, 1.5, 0.35));
      p.hull.push(plate([[-1.0, 1.0], [1.0, 1.0], [0.7, 5.4], [-0.7, 5.4]], 2.7, 1.1, 0.3));   // bridge
      p.dark.push(h.box(1.5, 0.35, 2.6, 0, 3.55, 3.4));                               // bridge glazing
      p.accent.push(h.box(1.56, 0.1, 2.0, 0, 3.6, 3.6));
      // crown fin
      const fin = new THREE.BufferGeometry();
      {
        const sh = new THREE.Shape(); sh.moveTo(1.0, 2.7); sh.lineTo(-3.4, 2.7); sh.lineTo(-7.6, 7.4); sh.lineTo(-6.0, 7.2); sh.lineTo(-1.6, 3.9); sh.closePath();
        const g = new THREE.ExtrudeGeometry(sh, { depth: 0.24, bevelEnabled: true, bevelThickness: 0.06, bevelSize: 0.06, bevelSegments: 1 });
        g.rotateY(-Math.PI / 2); g.translate(0.12, 0, 0);                              // shape x → ship z
        fin.copy(g);
      }
      p.hull.push(fin);
      p.accent.push(h.box(0.3, 0.1, 5.2, 0, 2.86, -4.2));
      // ── funnel bays along the spine (six a side)
      for (let k = 0; k < 6; k++) for (const s of [1, -1]) {
        p.dark.push(h.box(1.5, 0.5, 1.15, s * 2.75, 1.62, -6 - k * 1.55));
        p.accent.push(h.box(0.9, 0.08, 0.16, s * 2.75, 1.9, -6 - k * 1.55));
      }
      // ── strakes: swept plates like folded wings, an upper pair and a lower pair
      const upper: [number, number][] = [[4.2, 7.5], [5.2, 3.5], [9.6, -7.5], [11.4, -18.5], [8.6, -15.2], [5.6, -6.5], [4.4, -1.5]];
      const lower: [number, number][] = [[3.6, 3.0], [7.2, -8.0], [8.4, -16.0], [6.0, -12.5], [4.0, -4.0]];
      for (const s of [1, -1]) {
        const up = plate(s > 0 ? upper : mirror(upper), 0.15, 0.34, 0.1); up.rotateZ(s * 0.13); p.hull.push(up);
        const lo = plate(s > 0 ? lower : mirror(lower), -1.25, 0.3, 0.1); lo.rotateZ(-s * 0.3); lo.translate(0, -0.3, 0); p.dark.push(lo);
        // leading-edge light
        const edge: [number, number][] = [[5.25, 3.3], [5.55, 3.3], [9.95, -7.6], [9.65, -7.6]];
        const eg = plate(s > 0 ? edge : mirror(edge), 0.42, 0.14, 0); eg.rotateZ(s * 0.13); p.accent.push(eg);
        // strake-tip engine pod
        p.dark.push(h.cyl(0.85, 1.05, 5.2, s * 9.2, 1.42, -15.6, 'z', 12));
        p.trim.push(h.cyl(1.12, 1.12, 0.3, s * 9.2, 1.42, -13.4, 'z', 12));
      }
      // ── stern block, halo ring
      p.dark.push(h.box(W * 1.16, 2.9, 4.2, 0, 0.0, -L * 0.5 - 0.6));
      p.trim.push(h.box(W * 1.22, 0.3, 0.5, 0, 1.5, -L * 0.5 + 1.2), h.box(W * 1.22, 0.3, 0.5, 0, -1.5, -L * 0.5 + 1.2));
      for (const [a0, len] of [[0.42, 2.3], [3.56, 2.3]] as const) {
        const ring = new THREE.TorusGeometry(8.6, 0.22, 6, 40, len); ring.rotateZ(a0); ring.translate(0, 0.9, -11.5); p.accent.push(ring);
        const cage = new THREE.TorusGeometry(9.05, 0.16, 6, 40, len); cage.rotateZ(a0); cage.translate(0, 0.9, -11.5); p.trim.push(cage);
      }
      for (const s of [1, -1]) p.trim.push(h.box(0.3, 0.3, 1.2, s * 8.3, 3.0, -11.7), h.box(0.3, 0.3, 1.2, s * 8.3, -1.2, -11.7));
      // ── ventral fin and keel light
      p.dark.push(plate([[-0.14, -14], [0.14, -14], [0.14, 2], [-0.14, 2]], -5.2, 2.4, 0.05));
      p.accent.push(h.box(0.12, 0.12, 22, 0, -2.95, -2));
      // ── fairings so that flank and ventral mounts sit on something
      for (const m of BBEX_MOUNTS) {
        const [x, y, z] = m.mount.pos;
        const edge = hw(z / L);
        if (Math.abs(x) > edge - 0.4 && Math.abs(y) < 1.5) {
          const inner = Math.max(0, edge - 1.2), wdt = Math.abs(x) - inner + 0.5;
          p.hull.push(h.box(wdt, 0.9, 2.2, Math.sign(x) * (inner + wdt / 2), y - 0.55, z));
        }
        if (y > 1.9 && Math.abs(x) > 1.2 && Math.abs(x) < 4) p.hull.push(h.cyl(m.size === 'L' ? 1.7 : 0.8, m.size === 'L' ? 2.1 : 1.0, 1.1, x, y - 0.7, z, 'y', 14));
      }
      p.light.push(V(0, 7.6, -7.4), V(11.2, 1.5, -18.2), V(-11.2, 1.5, -18.2), V(1.3, 1.6, 22.3), V(-1.3, 1.6, 22.3), V(0, -5.3, -6));
      p.engines.push({ x: 0, y: 0.1, z: -L * 0.5 - 2.9, r: 1.55 }, { x: 3.3, y: 0, z: -L * 0.5 - 2.9, r: 1.0 }, { x: -3.3, y: 0, z: -L * 0.5 - 2.9, r: 1.0 }, { x: 9.2, y: 1.42, z: -18.4, r: 0.72 }, { x: -9.2, y: 1.42, z: -18.4, r: 0.72 });
    },
  };
}

type Add = (g: THREE.BufferGeometry, mat: 'hull' | 'dark' | 'trim' | 'accent' | 'gun', part?: 'root' | 'barrels') => void;

/** exclusive turret models. Returns whether the mount traverses and where the barrel group sits (null = fixed). */
export function bbexTurret(md: MountDef, add: Add, h: Helpers): { rotates: boolean; barrels: [number, number, number] | null } | null {
  switch (md.weapon) {
    case BBEX_WEAPON.dcp: {
      // focusing rings and the phase crystal: the bore itself is the gap between the prows
      for (let k = 0; k < 4; k++) { const r = new THREE.TorusGeometry(1.45 - k * 0.14, 0.11, 6, 20); r.translate(0, 0, -3.6 + k * 2.3); add(r, 'accent'); }
      const c = new THREE.OctahedronGeometry(0.75, 0); c.scale(1, 1, 2.3); c.translate(0, 0, -4.6); add(c, 'accent');
      add(h.cyl(1.7, 1.7, 0.5, 0, 0, -5.4, 'z', 16), 'trim');
      return { rotates: false, barrels: null };
    }
    case BBEX_WEAPON.lance: {
      // low wedge housing, twin rails with a burning slit between them
      const sh = new THREE.Shape(); sh.moveTo(-1.5, -1.6); sh.lineTo(1.5, -1.6); sh.lineTo(1.15, 1.9); sh.lineTo(0, 2.5); sh.lineTo(-1.15, 1.9); sh.closePath();
      const g = new THREE.ExtrudeGeometry(sh, { depth: 0.7, bevelEnabled: true, bevelThickness: 0.18, bevelSize: 0.18, bevelSegments: 1 });
      g.rotateX(Math.PI / 2); g.translate(0, 0.75, 0); add(g, 'hull');
      add(h.cyl(1.55, 1.75, 0.5, 0, -0.2, 0, 'y', 14), 'dark');
      for (const x of [-0.42, 0.42]) add(h.box(0.26, 0.5, 8.4, x, 0, 4.2), 'gun', 'barrels');
      add(h.box(0.3, 0.16, 8.0, 0, 0, 4.2), 'accent', 'barrels');
      for (let k = 0; k < 3; k++) add(h.box(1.3, 0.72, 0.22, 0, 0, 2 + k * 2.4), 'trim', 'barrels');
      return { rotates: true, barrels: [0, 0.42, 1.2] };
    }
    case BBEX_WEAPON.edge: {
      add(h.cyl(0.7, 0.85, 0.45, 0, -0.1, 0, 'y', 10), 'dark');
      add(h.box(0.9, 0.5, 1.5, 0, 0.3, 0), 'hull');
      add(h.box(0.22, 0.7, 2.6, 0, 0, 1.3), 'gun', 'barrels');
      add(h.box(0.3, 0.2, 2.5, 0, 0, 1.4), 'accent', 'barrels');
      return { rotates: true, barrels: [0, 0.34, 0.5] };
    }
    case BBEX_WEAPON.stinger: {
      add(new THREE.SphereGeometry(0.55, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), 'hull');
      add(h.cyl(0.62, 0.7, 0.2, 0, 0, 0, 'y', 10), 'dark');
      for (const x of [-0.17, 0.17]) add(h.cyl(0.07, 0.09, 1.5, x, 0, 0.75, 'z', 6), 'gun', 'barrels');
      add(h.box(0.5, 0.1, 0.12, 0, 0, 1.45), 'accent', 'barrels');
      return { rotates: true, barrels: [0, 0.3, 0.2] };
    }
    case BBEX_WEAPON.seraph: {
      add(h.box(2.1, 0.34, 2.2, 0, -0.05, 0), 'dark');
      for (const x of [-0.5, 0.5]) for (const z of [-0.5, 0.5]) { add(h.box(0.78, 0.1, 0.78, x, 0.16, z), 'trim'); add(h.box(0.3, 0.06, 0.3, x, 0.23, z), 'accent'); }
      return { rotates: false, barrels: null };
    }
    case BBEX_WEAPON.rain: {
      add(h.cyl(0.42, 0.5, 0.16, 0, 0, 0, 'y', 10), 'dark');
      add(new THREE.SphereGeometry(0.3, 8, 5, 0, Math.PI * 2, 0, Math.PI / 2), 'accent');
      return { rotates: false, barrels: null };
    }
  }
  return null;
}

/** one FNL-EX funnel (nose +z): a split blade around a phase core, with a tail emitter */
export function funnelGeometry(): { body: THREE.BufferGeometry; dark: THREE.BufferGeometry; glow: THREE.BufferGeometry } {
  const mk = (pts: [number, number][], y0: number, hgt: number) => plate(pts, y0, hgt, 0.05);
  const blade: [number, number][] = [[0.25, -4.2], [1.5, -3.0], [1.15, 1.2], [0.25, 6.2]];
  const bodyParts = [mk(blade, -0.32, 0.64), mk(mirror(blade), -0.32, 0.64)];
  const finU = mk([[-0.07, -4.0], [0.07, -4.0], [0.07, 0.6], [-0.07, 0.6]], 0.2, 1.5);
  const finD = mk([[-0.07, -3.6], [0.07, -3.6], [0.07, 0.0], [-0.07, 0.0]], -1.3, 1.1);
  const darkParts = [new THREE.BoxGeometry(0.5, 0.5, 6.4).translate(0, 0, -0.4), finU, finD];
  const core = new THREE.OctahedronGeometry(0.42, 0); core.scale(1, 1, 3.2); core.translate(0, 0, 1.6);
  const tail = new THREE.CylinderGeometry(0.34, 0.2, 0.5, 8); tail.rotateX(Math.PI / 2); tail.translate(0, 0, -4.4);
  const strip1 = new THREE.BoxGeometry(0.08, 0.1, 5.4).translate(0.95, 0.34, -0.6), strip2 = new THREE.BoxGeometry(0.08, 0.1, 5.4).translate(-0.95, 0.34, -0.6);
  return { body: merge(bodyParts), dark: merge(darkParts), glow: merge([core, tail, strip1, strip2]) };
}

function merge(gs: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const parts = gs.map(g => (g.index ? g.toNonIndexed() : g));
  let n = 0; for (const g of parts) n += g.getAttribute('position').count;
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3);
  let o = 0;
  for (const g of parts) {
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    pos.set(g.getAttribute('position').array as Float32Array, o * 3); nor.set(g.getAttribute('normal').array as Float32Array, o * 3);
    o += g.getAttribute('position').count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3)); out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  return out;
}

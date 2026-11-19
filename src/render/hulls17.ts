// P17.3 hull silhouettes. Each base is its own construction (hull sections, armour plates, engine
// arrangement, superstructure, sensors, weapon foundations) — not a scaled or recoloured copy of
// another hull. Built in absolute ship-local units (+x port, +y up, +z bow) at the class length;
// the content hulls that use them have mesh.scale 1, so hardpoint positions in the hull data are
// the same coordinates (tests/p17-hulls.test.ts checks every turret sits on the hull).
//
// Maker families share a tint and a construction style, so a product line reads as one maker:
//  연합 방위조선     — standard military: stacked decks, belt armour, tidy superstructure
//  헬리오스 조병창   — high technology: long blades, spinal weapons, clean light lines
//  세레스 공업       — energy systems: exposed reactor rings, crystal spines, pale hull
//  바스티온 중공업   — heavy armour: wedges, spaced plates, casemates
//  러스트포트 자유조선 / 해적 개조업체 — asymmetric, bolted-on armour and containers, open frames
//  코발트 양산공창   — cheap mass production: boxes, flat plates, few lights
//  구 제국 군수창    — old designs: cylinders, ribs, tall old bridges
import * as THREE from 'three';

type G = THREE.BufferGeometry;
export type Profile = [number, number][];
export interface Parts { hull: G[]; dark: G[]; trim: G[]; accent: G[]; light: THREE.Vector3[]; engines: { x: number; y: number; z: number; r: number }[] }
export interface Kit {
  slab: (profile: Profile, L: number, W: number, t0: number, t1: number, y0: number, h: number, bevel?: number) => G;
  box: (w: number, h: number, d: number, x: number, y: number, z: number) => G;
  cyl: (rt: number, rb: number, h: number, x: number, y: number, z: number, axis?: 'y' | 'z', seg?: number) => G;
}
export interface Design17 { profile: Profile; W: number; build: (p: Parts, L: number) => void; /** maker hull tint (multiplies the team hull colour) */ tint?: number }

/** maker tints (subtle: the team colour still reads first) */
export const TINT = {
  union: 0xffffff, helios: 0xe8f0ff, ceres: 0xf6f3ea, bastion: 0xc8c4bc, rust: 0xc8a890, cobalt: 0xb8c6d4, old: 0xd8ccb0, guild: 0xe8e0d0,
} as const;

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

export function design17(base: string, L: number, K: Kit): Design17 | undefined {
  const { slab, box, cyl } = K;
  /** hull body split at midships (the halves separate when the ship breaks up) */
  const body = (p: G[], prof: Profile, W: number, y0: number, h: number, t0 = -0.5, t1 = 0.5, len = L) => {
    if (t0 < 0 && t1 > 0) p.push(slab(prof, len, W, t0, 0, y0, h), slab(prof, len, W, 0, t1, y0, h));
    else p.push(slab(prof, len, W, t0, t1, y0, h));
  };
  const torus = (R: number, r: number, x: number, y: number, z: number, axis: 'x' | 'y' | 'z' = 'z', seg = 24): G => {
    const g = new THREE.TorusGeometry(R, r, 8, seg);
    if (axis === 'y') g.rotateX(Math.PI / 2); else if (axis === 'x') g.rotateY(Math.PI / 2);
    g.translate(x, y, z); return g;
  };
  const scaleW = (prof: Profile, k: number): Profile => prof.map(([t, w]) => [t, w * k]);
  /** a pair of mirrored parts (port + starboard) */
  const pair = (out: G[], f: (s: number) => G) => { out.push(f(1), f(-1)); };
  /** accent light strips along both sides */
  const strips = (p: Parts, x: number, y: number, z: number, len: number) => pair(p.accent, s => box(0.12, 0.18, len, x * s, y, z));
  /** VLS cell grid (cells are trim plates with an accent lid) */
  const cells = (p: Parts, x: number, y: number, z: number, nx: number, nz: number, c = 0.9) => {
    for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) {
      const cx = x + (i - (nx - 1) / 2) * c * 1.15, cz = z + (j - (nz - 1) / 2) * c * 1.15;
      p.trim.push(box(c, 0.25, c, cx, y, cz));
      if ((i + j) % 2 === 0) p.accent.push(box(c * 0.5, 0.06, c * 0.12, cx, y + 0.14, cz));
    }
  };
  /** stepped bridge tower: levels of shrinking boxes; returns the top y */
  const tower = (p: Parts, x: number, y: number, z: number, w: number, d: number, levels: number, lh = 1.2): number => {
    let yy = y;
    for (let i = 0; i < levels; i++) { const k = 1 - i * 0.22; p.hull.push(box(w * k, lh, d * k, x, yy + lh / 2, z - i * d * 0.06)); yy += lh; }
    p.accent.push(box(w * (1 - (levels - 1) * 0.22) * 0.9, 0.18, 0.12, x, yy - lh * 0.45, z + d * (1 - (levels - 1) * 0.22) / 2 - (levels - 1) * d * 0.06 + 0.02));
    return yy;
  };
  const mast = (p: Parts, x: number, y: number, z: number, h: number, dish = 0) => {
    p.dark.push(cyl(0.12, 0.2, h, x, y + h / 2, z, 'y', 6));
    if (dish) p.trim.push(cyl(dish, dish * 0.6, 0.2, x, y + h * 0.8, z, 'y', 14));
    p.light.push(V(x, y + h + 0.2, z));
  };
  /** cylindrical engine pod with intake ring; engine nozzle at its stern */
  const pod = (p: Parts, x: number, y: number, z: number, r: number, len: number, eng = true) => {
    p.dark.push(cyl(r, r, len, x, y, z, 'z', 14));
    p.trim.push(cyl(r * 1.08, r * 1.08, len * 0.12, x, y, z + len * 0.42, 'z', 14));
    p.accent.push(cyl(r * 1.1, r * 1.1, 0.12, x, y, z - len * 0.2, 'z', 14));
    if (eng) p.engines.push({ x, y, z: z - len / 2 - 0.3, r: r * 0.85 });
  };
  /** spaced armour plates hung on the side (plates stand off the hull) */
  const plates = (p: Parts, x: number, y: number, z0: number, z1: number, n: number, h: number, t = 0.35) => {
    const step = (z1 - z0) / n;
    for (let i = 0; i < n; i++) pair(i % 2 ? p.hull : p.trim, s => box(t, h, step * 0.92, x * s, y, z0 + step * (i + 0.5)));
  };
  /** barrel of an integrated (spinal) gun */
  const spinal = (p: Parts, y: number, z0: number, len: number, r: number) => {
    p.dark.push(cyl(r * 1.4, r * 1.6, len * 0.3, 0, y, z0 + len * 0.15, 'z', 14));
    p.trim.push(cyl(r, r * 1.1, len, 0, y, z0 + len / 2, 'z', 14));
    for (let k = 0; k < 4; k++) p.accent.push(cyl(r * 1.25, r * 1.25, 0.25, 0, y, z0 + len * (0.35 + k * 0.17), 'z', 14));
  };
  const hangar = (p: Parts, x: number, y: number, z: number, w: number, h: number, d: number) => {
    p.hull.push(box(w, h, d, x, y, z));
    p.dark.push(box(w * 0.8, h * 0.7, 0.3, x, y - h * 0.08, z + d / 2 + 0.05));
    p.accent.push(box(w * 0.82, 0.1, 0.12, x, y + h * 0.3, z + d / 2 + 0.16));
  };

  switch (base) {
    // ═══════════════════════════════════════════════════════════════ corvettes (L 14)
    case 'p17_cv_militia': {   // 코발트: flat arrowhead plate, slab cabin, one bolted fuel tank, single fin
      const pr: Profile = [[-0.5, 0.9], [-0.3, 1], [0.5, 0.18]];
      return { profile: pr, W: 2.6, tint: TINT.cobalt, build: p => {
        body(p.hull, pr, 2.6, -0.6, 1.2);
        p.hull.push(box(1.1, 0.7, 2.4, 0, 0.95, -1.4));
        p.dark.push(cyl(0.45, 0.45, 4.2, 2.35, -0.1, -2.2, 'z', 10), box(0.15, 1.5, 1.8, 0, 1.35, -5.6));
        p.trim.push(box(4.6, 0.12, 1.4, 0, -0.55, -5.4));
        p.accent.push(box(0.9, 0.12, 0.1, 0, 1.15, -0.2));
        p.light.push(V(2.3, 0, -5.8), V(-2.3, 0, -5.8));
        p.engines.push({ x: 0.7, y: 0, z: -7.4, r: 0.6 }, { x: -0.7, y: 0, z: -7.4, r: 0.6 });
      } };
    }
    case 'p17_cv_blackwing': { // 러스트포트: forked bow — two torpedo prongs, hunched cockpit, oversized engines
      const pr: Profile = [[-0.5, 0.8], [-0.25, 1], [0.1, 0.7]];
      return { profile: pr, W: 2.4, tint: TINT.rust, build: p => {
        body(p.hull, pr, 2.4, -0.6, 1.3, -0.5, 0.1);
        pair(p.hull, s => box(0.9, 0.9, 8, 1.45 * s, 0.05, 3.6));
        pair(p.dark, s => cyl(0.36, 0.36, 1.2, 1.45 * s, 0.05, 7.9, 'z', 10));
        pair(p.accent, s => cyl(0.25, 0.25, 0.1, 1.45 * s, 0.05, 8.55, 'z', 10));
        p.hull.push(box(1.1, 0.7, 2.2, 0.2, 1.0, -1.6));
        p.dark.push(box(0.9, 0.3, 1.2, 0.2, 1.45, -1.3));
        pair(p.trim, s => box(0.2, 1.6, 2.2, 1.2 * s, 0.9, -5.6));
        p.light.push(V(1.45, 0.6, 7.9), V(-1.45, 0.6, 7.9));
        pair(p.dark, s => cyl(0.8, 0.9, 3, 1.05 * s, 0, -6.2, 'z', 12));
        p.engines.push({ x: 1.05, y: 0, z: -7.9, r: 0.8 }, { x: -1.05, y: 0, z: -7.9, r: 0.8 });
      } };
    }
    case 'p17_cv_spark': {     // 세레스: needle hull through an exposed drive ring, crystal fins
      const pr: Profile = [[-0.5, 0.5], [-0.2, 0.8], [0.2, 0.6], [0.5, 0.05]];
      return { profile: pr, W: 1.6, tint: TINT.ceres, build: p => {
        body(p.hull, pr, 1.6, -0.5, 1.1);
        p.trim.push(torus(2.4, 0.32, 0, 0.05, -4.2, 'z', 28));
        pair(p.dark, s => box(0.2, 0.2, 2.6, 1.3 * s, 0.05, -4.2));
        p.dark.push(box(0.2, 2.6, 0.2, 0, 0.05, -4.2));
        p.accent.push(torus(2.4, 0.1, 0, 0.05, -4.2, 'z', 28));
        pair(p.accent, s => box(0.08, 0.9, 2.4, 0.5 * s, 0.9, 1.2));
        p.hull.push(box(0.8, 0.5, 2.6, 0, 0.85, 0.6));
        p.light.push(V(0, 0.05, 7.1), V(2.4, 0.05, -4.2), V(-2.4, 0.05, -4.2));
        p.engines.push({ x: 0, y: 0.05, z: -7.3, r: 0.75 });
      } };
    }
    case 'p17_cv_hornet': {    // 헬리오스: trimaran — centre blade and two missile outriggers on struts
      const pr: Profile = [[-0.5, 0.6], [-0.2, 1], [0.3, 0.7], [0.5, 0.12]];
      return { profile: pr, W: 1.5, tint: TINT.helios, build: p => {
        body(p.hull, pr, 1.5, -0.5, 1.2);
        pair(p.trim, s => box(2.4, 0.2, 1.4, 1.6 * s, 0.1, -1.5));
        pair(p.hull, s => box(0.9, 0.8, 7.5, 2.9 * s, 0.1, -1.0));
        pair(p.dark, s => box(0.7, 0.2, 2.8, 2.9 * s, 0.6, 0.6));
        pair(p.accent, s => box(0.06, 0.12, 6, 3.36 * s, 0.1, -1.2));
        p.hull.push(box(0.9, 0.55, 2.4, 0, 0.95, 1.2));
        p.dark.push(box(0.7, 0.2, 1.0, 0, 1.3, 1.5));
        p.light.push(V(2.9, 0.6, 2.8), V(-2.9, 0.6, 2.8));
        p.engines.push({ x: 0, y: 0.1, z: -7.3, r: 0.7 }, { x: 2.9, y: 0.1, z: -5.0, r: 0.45 }, { x: -2.9, y: 0.1, z: -5.0, r: 0.45 });
      } };
    }
    case 'p17_cv_relic': {     // 구 제국: tube hull wrapped in exposed ribs, tall old conning tower
      return { profile: [[-0.5, 1], [0.5, 1]], W: 1.1, tint: TINT.old, build: p => {
        p.hull.push(cyl(1.1, 1.1, 8, 0, 0, -1.5, 'z', 12), cyl(0.3, 1.1, 3.2, 0, 0, 4.1, 'z', 12));
        for (let i = 0; i < 6; i++) p.trim.push(torus(1.2, 0.12, 0, 0, -5 + i * 1.4, 'z', 14));
        p.hull.push(box(0.9, 1.4, 1.6, 0, 1.6, -0.6));
        p.dark.push(box(1.1, 0.25, 0.4, 0, 2.2, 0.15), cyl(0.08, 0.08, 1.6, 0, 3.1, -0.9, 'y', 6));
        p.dark.push(cyl(1.25, 1.25, 1.2, 0, 0, -6.1, 'z', 12));
        p.light.push(V(0, 3.9, -0.9));
        p.engines.push({ x: 0, y: 0, z: -7.0, r: 0.9 });
      } };
    }
    // ═══════════════════════════════════════════════════════════════ frigates (L 20)
    case 'p17_ff_mirage': {    // 상인 길드: lens-shaped saucer bow with an antenna crown, slim aft boom
      return { profile: [[-0.5, 0.3], [0.5, 0.3]], W: 1.4, tint: TINT.guild, build: p => {
        p.hull.push(cyl(4.2, 4.6, 1.0, 0, 0, 4.5, 'y', 20), cyl(3.0, 4.2, 0.6, 0, 0.8, 4.5, 'y', 20));
        p.dark.push(cyl(4.7, 4.7, 0.25, 0, -0.55, 4.5, 'y', 20));
        p.accent.push(torus(4.4, 0.08, 0, 0.1, 4.5, 'y', 32));
        p.hull.push(box(1.6, 1.2, 9, 0, 0, -4.5));
        p.trim.push(cyl(1.2, 1.2, 0.3, 0, 1.25, 4.5, 'y', 12));
        for (let i = 0; i < 6; i++) { const a = i / 6 * Math.PI * 2; p.dark.push(cyl(0.06, 0.06, 2.2, Math.cos(a) * 2.2, 2.1, 4.5 + Math.sin(a) * 2.2, 'y', 5)); }
        p.light.push(V(0, 3.3, 4.5), V(4.4, 0.1, 4.5), V(-4.4, 0.1, 4.5));
        pair(p.dark, s => cyl(0.6, 0.6, 3, 1.2 * s, 0, -8.2, 'z', 10));
        p.engines.push({ x: 1.2, y: 0, z: -10.0, r: 0.55 }, { x: -1.2, y: 0, z: -10.0, r: 0.55 });
      } };
    }
    case 'p17_ff_shieldwall': { // 바스티온: plough of spaced bow armour, low casemate hull
      const pr: Profile = [[-0.5, 0.85], [-0.2, 1], [0.3, 1], [0.5, 0.7]];
      return { profile: pr, W: 3.2, tint: TINT.bastion, build: p => {
        body(p.hull, pr, 3.2, -1.0, 2.0);
        const plough: Profile = [[-0.5, 1.1], [0.5, 0.5]];
        p.trim.push(slab(plough, 4, 3.4, -0.5, 0.5, -1.4, 2.8).translate(0, 0, 8.2));
        pair(p.dark, s => box(0.4, 2.2, 3, 3.5 * s, 0, 5.5));
        plates(p, 3.45, 0.1, -8, 3, 4, 1.6);
        p.hull.push(box(2.2, 1.0, 3.2, 0, 1.5, -3.2));
        p.dark.push(box(1.6, 0.4, 1.2, 0, 2.2, -3.0));
        p.light.push(V(0, 2.5, -3.4), V(3.4, 0.6, -8.4), V(-3.4, 0.6, -8.4));
        p.dark.push(box(5.2, 1.8, 1.6, 0, 0, -10.4));
        p.engines.push({ x: 1.5, y: 0, z: -11.4, r: 0.75 }, { x: -1.5, y: 0, z: -11.4, r: 0.75 });
      } };
    }
    case 'p17_ff_lantern': {   // 연합: compact capsule hull, twin side engine nacelles, clear lantern bridge
      const pr: Profile = [[-0.5, 0.75], [-0.3, 1], [0.25, 0.95], [0.5, 0.3]];
      return { profile: pr, W: 2.4, tint: TINT.union, build: p => {
        body(p.hull, pr, 2.4, -0.9, 1.8);
        body(p.hull, scaleW(pr, 0.6), 2.4, 0.9, 0.8, -0.35, 0.3);
        pair(p.trim, s => box(1.6, 0.3, 2.4, 2.6 * s, 0, -5));
        pair(p.dark, s => cyl(0.75, 0.75, 6, 3.6 * s, 0, -6.2, 'z', 12));
        pair(p.accent, s => cyl(0.8, 0.8, 0.15, 3.6 * s, 0, -4.0, 'z', 12));
        p.hull.push(box(1.3, 0.9, 2.0, 0, 2.15, -1.2));
        p.accent.push(box(1.2, 0.3, 0.1, 0, 2.3, -0.18));
        strips(p, 2.2, 0, -1, 9);
        p.light.push(V(0, 2.8, -1.4), V(3.6, 0.8, -6), V(-3.6, 0.8, -6));
        p.engines.push({ x: 3.6, y: 0, z: -9.4, r: 0.65 }, { x: -3.6, y: 0, z: -9.4, r: 0.65 }, { x: 0, y: 0, z: -10.4, r: 0.6 });
      } };
    }
    case 'p17_ff_scrap': {     // 해적 개조: asymmetric — a container welded to port, bridge offset to starboard
      const pr: Profile = [[-0.5, 0.8], [-0.2, 1], [0.4, 0.8], [0.5, 0.4]];
      return { profile: pr, W: 2.2, tint: TINT.rust, build: p => {
        body(p.hull, pr, 2.2, -0.9, 1.7);
        p.trim.push(box(2.0, 2.0, 7.5, 3.3, -0.1, -1.0));
        p.dark.push(box(0.6, 0.4, 1.6, 2.4, 0.4, 0.5), box(0.6, 0.4, 1.6, 2.4, 0.4, -3.0));
        p.hull.push(box(1.2, 1.4, 2.4, -1.4, 1.5, -3.4));
        p.dark.push(box(1.3, 0.3, 0.6, -1.4, 2.3, -2.5), box(2.6, 0.3, 0.6, -2.4, 0.3, 3.5));
        p.trim.push(box(0.4, 1.8, 3.4, -2.6, 0, 1.0));
        p.light.push(V(-1.4, 2.6, -3.6), V(4.3, 1.0, -4.6));
        p.engines.push({ x: 0.8, y: 0, z: -10.4, r: 0.7 }, { x: -0.8, y: 0, z: -10.4, r: 0.7 }, { x: 3.3, y: 0, z: -5.0, r: 0.6 });
      } };
    }
    // ═══════════════════════════════════════════════════════════════ destroyers (L 24)
    case 'p17_dd_hedgehog': {  // 연합: narrow hull with spiked PD sponson ring and a twin-mast radar crown
      const pr: Profile = [[-0.5, 0.6], [-0.25, 0.95], [0.25, 0.9], [0.5, 0.15]];
      return { profile: pr, W: 2.9, tint: TINT.union, build: p => {
        body(p.hull, pr, 2.9, -1.1, 2.0);
        for (const z of [-7, -3.5, 0, 3.5, 7]) pair(p.dark, s => box(1.4, 0.6, 1.4, 3.1 * s, 0.4, z));
        p.hull.push(box(1.8, 1.4, 4.4, 0, 1.6, -1.0));
        mast(p, 0.5, 2.3, -1.2, 4.0, 1.2); mast(p, -0.5, 2.3, -1.6, 3.2);
        strips(p, 2.7, -0.4, 0, 14);
        p.light.push(V(3.1, 1.0, 7), V(-3.1, 1.0, 7));
        p.dark.push(box(4.4, 1.8, 1.8, 0, -0.1, -12.6));
        p.engines.push({ x: 1.2, y: 0, z: -13.7, r: 0.85 }, { x: -1.2, y: 0, z: -13.7, r: 0.85 });
      } };
    }
    case 'p17_dd_hammerhead': { // 바스티온: hammer — a broad armoured bow block on a short thick hull
      const pr: Profile = [[-0.5, 0.75], [-0.3, 0.9], [0.2, 0.85], [0.5, 0.75]];
      return { profile: pr, W: 3.4, tint: TINT.bastion, build: p => {
        body(p.hull, pr, 3.4, -1.4, 2.6);
        p.trim.push(box(9.6, 2.6, 3.4, 0, 0.1, 10.2), box(9.0, 0.4, 2.8, 0, 1.6, 10.1));
        pair(p.dark, s => box(0.6, 2.2, 3.6, 4.9 * s, 0.1, 10.2));
        p.accent.push(box(8.4, 0.2, 0.1, 0, 0.6, 11.95));
        plates(p, 3.55, 0.1, -10, 6, 4, 1.8);
        p.hull.push(box(2.6, 1.4, 3.2, 0, 1.9, -4.5));
        p.dark.push(box(2.0, 0.5, 1.4, 0, 2.85, -4.2));
        p.light.push(V(4.8, 1.4, 10.2), V(-4.8, 1.4, 10.2), V(0, 3.2, -4.4));
        p.dark.push(box(5.8, 2.4, 2.2, 0, -0.1, -12.8));
        p.engines.push({ x: 1.8, y: 0, z: -14.1, r: 1.0 }, { x: -1.8, y: 0, z: -14.1, r: 1.0 });
      } };
    }
    case 'p17_dd_scavenger': { // 러스트포트: twin hulls with an open salvage cradle between, crane on top
      return { profile: [[-0.5, 1], [0.5, 1]], W: 1.2, tint: TINT.rust, build: p => {
        const side: Profile = [[-0.5, 0.8], [-0.3, 1], [0.35, 1], [0.5, 0.4]];
        for (const s of [1, -1]) { const g = slab(side, L, 1.2, -0.5, 0, -1.0, 1.9); g.translate(2.6 * s, 0, 0); p.hull.push(g); const h = slab(side, L, 1.2, 0, 0.5, -1.0, 1.9); h.translate(2.6 * s, 0, 0); p.hull.push(h); }
        for (const z of [-6, -1, 4]) p.dark.push(box(5.4, 0.5, 0.8, 0, 0.6, z));
        p.trim.push(box(3.6, 0.3, 9, 0, -0.9, -1));
        p.dark.push(box(0.5, 3.6, 0.5, 2.6, 2.4, -6.5), box(0.4, 0.4, 7.5, 2.6, 4.0, -3.0));
        p.accent.push(box(0.9, 0.9, 0.9, 2.6, 3.4, 0.6));
        p.hull.push(box(1.6, 1.4, 2.6, -2.6, 1.6, -7.0));
        p.light.push(V(-2.6, 2.6, -7.2), V(2.6, 4.4, 0.6));
        p.engines.push({ x: 2.6, y: 0, z: -12.4, r: 0.9 }, { x: -2.6, y: 0, z: -12.4, r: 0.9 });
      } };
    }
    case 'p17_dd_spindle': {   // 헬리오스: long spindle around a spinal coil that runs out past the bow
      const pr: Profile = [[-0.5, 0.5], [-0.25, 1], [0.15, 0.9], [0.5, 0.3]];
      return { profile: pr, W: 2.0, tint: TINT.helios, build: p => {
        body(p.hull, pr, 2.0, -0.9, 1.8);
        spinal(p, 0, 4, 12, 0.45);
        pair(p.trim, s => box(1.4, 0.18, 6, 1.9 * s, 0.2, -6.5));
        pair(p.dark, s => box(0.18, 1.4, 4, 2.5 * s, 0.6, -7.5));
        p.hull.push(box(1.3, 0.9, 3.4, 0, 1.35, -3.0));
        p.accent.push(box(0.1, 0.12, 14, 0, 0.92, -1.5));
        strips(p, 1.6, 0.4, -2, 8);
        p.light.push(V(0, 0, 16.2), V(2.5, 1.4, -9.4), V(-2.5, 1.4, -9.4));
        p.engines.push({ x: 0.9, y: 0, z: -12.6, r: 0.8 }, { x: -0.9, y: 0, z: -12.6, r: 0.8 });
      } };
    }
    case 'p17_dd_tempest': {   // 코발트: modular blocks — three stacked box sections, exposed cell rack, flat bridge
      return { profile: [[-0.5, 1], [0.5, 1]], W: 2.4, tint: TINT.cobalt, build: p => {
        p.hull.push(box(4.4, 2.2, 7, 0, 0, 7.5), box(4.8, 2.4, 8, 0, 0, 0), box(4.4, 2.2, 7, 0, 0, -7.5));
        p.trim.push(slab([[-0.5, 1], [0.5, 0.2]], 3, 2.2, -0.5, 0.5, -1.1, 2.2).translate(0, 0, 12.5));
        p.dark.push(box(4.9, 0.3, 0.4, 0, 0.6, 3.8), box(4.9, 0.3, 0.4, 0, 0.6, -3.8));
        cells(p, 0, 1.35, 0.2, 2, 3, 0.95);
        p.hull.push(box(2.4, 1.0, 2.2, 0, 1.7, -7.8));
        p.light.push(V(0, 2.4, -7.8));
        p.engines.push({ x: 1.3, y: 0, z: -11.3, r: 0.8 }, { x: -1.3, y: 0, z: -11.3, r: 0.8 });
      } };
    }
    case 'p17_dd_forge': {     // 바르카·연합 합작: military-industrial — exposed gantry, fabricator drum, armed decks
      const pr: Profile = [[-0.5, 0.9], [-0.1, 1], [0.35, 0.95], [0.5, 0.55]];
      return { profile: pr, W: 3.2, tint: TINT.guild, build: p => {
        body(p.hull, pr, 3.2, -1.2, 2.0);
        for (const z of [-5, 2]) { pair(p.trim, s => box(0.5, 4.4, 0.5, 2.8 * s, 3.0, z)); p.trim.push(box(6.1, 0.5, 0.5, 0, 5.0, z)); }
        pair(p.trim, s => box(0.5, 0.5, 7.5, 2.8 * s, 5.0, -1.5));
        p.dark.push(cyl(1.4, 1.4, 5, 0, 2.2, -1.5, 'z', 14), box(1.4, 1.4, 1.4, 0, 4.0, 0.2));
        p.accent.push(box(0.8, 0.8, 0.8, 0, 3.0, 0.2), box(6.4, 0.15, 0.15, 0, 0.9, 9.5));
        p.hull.push(box(1.8, 1.2, 2.6, 0, 1.4, -9.0));
        p.light.push(V(2.8, 5.4, 2), V(-2.8, 5.4, -5), V(0, 2.2, -9.2));
        p.dark.push(box(5.2, 2.0, 2.0, 0, -0.2, -13));
        p.engines.push({ x: 1.6, y: 0, z: -14.2, r: 0.85 }, { x: -1.6, y: 0, z: -14.2, r: 0.85 });
      } };
    }
    // ═══════════════════════════════════════════════════════════════ light cruisers (L 32)
    case 'p17_cl_longbow': {   // 세레스: very long thin hull, spinal rail outrunning the bow, dorsal capacitor bank
      const pr: Profile = [[-0.5, 0.55], [-0.3, 1], [0.3, 0.75], [0.5, 0.2]];
      return { profile: pr, W: 2.6, tint: TINT.ceres, build: p => {
        body(p.hull, pr, 2.6, -1.2, 2.2);
        spinal(p, 0.2, 6, 18, 0.6);
        for (let i = 0; i < 5; i++) p.trim.push(box(2.0, 0.5, 1.4, 0, 1.25, -6 + i * 1.9));
        p.accent.push(box(0.15, 0.6, 9, 0, 1.4, -2.2));
        p.hull.push(box(1.8, 1.2, 3.6, 0, 1.6, -11));
        mast(p, 0, 2.2, -11.6, 2.4, 0.8);
        pair(p.dark, s => box(0.2, 2.2, 4, 2.4 * s, 0.3, -13.5));
        p.light.push(V(0, 0.2, 24.3), V(2.4, 1.4, -15.4), V(-2.4, 1.4, -15.4));
        p.engines.push({ x: 1.0, y: 0, z: -16.6, r: 0.9 }, { x: -1.0, y: 0, z: -16.6, r: 0.9 });
      } };
    }
    case 'p17_cl_siren': {     // 상인 길드: twin booms joined fore and aft, a jamming dish array slung between
      return { profile: [[-0.5, 1], [0.5, 1]], W: 1.2, tint: TINT.guild, build: p => {
        const bm: Profile = [[-0.5, 0.8], [-0.35, 1], [0.35, 1], [0.5, 0.3]];
        for (const s of [1, -1]) for (const [a, b] of [[-0.5, 0], [0, 0.5]] as const) { const g = slab(bm, L, 1.2, a, b, -1.0, 2.0); g.translate(3.4 * s, 0, 0); p.hull.push(g); }
        p.hull.push(box(8.0, 1.6, 4.0, 0, 0.2, 10.5), box(8.0, 1.6, 4.0, 0, 0.2, -11));
        p.trim.push(cyl(2.6, 1.4, 0.6, 0, 0.3, 0, 'y', 20), cyl(1.8, 1.0, 0.5, 0, 0.3, -5.5, 'y', 16));
        p.dark.push(cyl(0.2, 0.2, 2.4, 0, 0.0, 0, 'y', 6), box(5.6, 0.3, 0.3, 0, 0, 0));
        p.accent.push(cyl(0.5, 0.5, 0.2, 0, 0.7, 0, 'y', 10), cyl(0.4, 0.4, 0.2, 0, 0.65, -5.5, 'y', 10));
        p.hull.push(box(2.6, 1.3, 3.0, 0, 1.65, 10.5));
        mast(p, 0, 2.3, 10.2, 2.6);
        p.light.push(V(3.4, 1.2, 15.6), V(-3.4, 1.2, 15.6));
        p.engines.push({ x: 3.4, y: 0, z: -16.4, r: 0.85 }, { x: -3.4, y: 0, z: -16.4, r: 0.85 });
      } };
    }
    case 'p17_cl_warden': {    // 연합: classic stepped light cruiser — raised fore and aft gun decks, central tower
      const pr: Profile = [[-0.5, 0.7], [-0.35, 1], [0.15, 0.95], [0.38, 0.6], [0.5, 0.12]];
      return { profile: pr, W: 3.6, tint: TINT.union, build: p => {
        body(p.hull, pr, 3.6, -1.4, 2.6);
        body(p.hull, scaleW(pr, 0.7), 3.6, 1.2, 1.0, -0.42, 0.34);
        body(p.dark, scaleW(pr, 0.78), 3.6, -2.4, 1.0, -0.46, 0.4);
        tower(p, 0, 2.2, -1.5, 2.6, 4.4, 3, 1.1);
        mast(p, 0, 5.5, -2.4, 2.8, 0.9);
        strips(p, 3.45, 0.2, -1, 18);
        p.light.push(V(3.4, 0.6, -14), V(-3.4, 0.6, -14));
        p.dark.push(box(5.6, 2.4, 2.4, 0, -0.4, -16.8));
        p.engines.push({ x: 1.6, y: -0.3, z: -18.2, r: 1.0 }, { x: -1.6, y: -0.3, z: -18.2, r: 1.0 });
      } };
    }
    case 'p17_cl_ironside': {  // 구 제국: casemate sides with gun ports, tall pagoda bridge, single huge funnel-like stack
      const pr: Profile = [[-0.5, 0.9], [-0.4, 1], [0.3, 1], [0.5, 0.5]];
      return { profile: pr, W: 3.4, tint: TINT.old, build: p => {
        body(p.hull, pr, 3.4, -1.6, 2.6);
        for (let i = 0; i < 5; i++) pair(p.trim, s => box(0.8, 1.2, 2.4, 3.45 * s, 0.1, -9 + i * 4));
        for (let i = 0; i < 5; i++) pair(p.dark, s => box(0.3, 0.5, 0.9, 3.9 * s, 0.1, -9 + i * 4));
        const top = tower(p, 0, 1.0, 1.5, 3.0, 4.0, 4, 1.2);
        p.dark.push(box(3.6, 0.3, 1.0, 0, top - 0.6, 1.7), cyl(0.9, 1.1, 3.2, 0, 2.6, -4.5, 'y', 12));
        p.light.push(V(0, top + 0.3, 1.2), V(0, 4.3, -4.5));
        p.dark.push(box(6.2, 2.6, 2.4, 0, -0.3, -17));
        p.engines.push({ x: 1.6, y: -0.3, z: -18.4, r: 1.1 }, { x: -1.6, y: -0.3, z: -18.4, r: 1.1 });
      } };
    }
    // ═══════════════════════════════════════════════════════════════ cruisers (L 38)
    case 'p17_ca_nova': {      // 연합 에너지: hull pierced by a glowing reactor ring amidships, beam galleries
      const pr: Profile = [[-0.5, 0.7], [-0.3, 1], [0.2, 0.9], [0.4, 0.55], [0.5, 0.15]];
      return { profile: pr, W: 4.4, tint: TINT.ceres, build: p => {
        body(p.hull, pr, 4.4, -1.8, 3.2);
        p.trim.push(torus(6.4, 0.7, 0, 0, -3, 'z', 36));
        p.accent.push(torus(6.4, 0.25, 0, 0, -2.3, 'z', 36), torus(6.4, 0.25, 0, 0, -3.7, 'z', 36));
        for (let i = 0; i < 4; i++) { const a = Math.PI / 4 + i * Math.PI / 2; p.dark.push(box(0.5, 0.5, 1.2, Math.cos(a) * 5.0, Math.sin(a) * 5.0, -3)); }
        body(p.hull, scaleW(pr, 0.6), 4.4, 1.4, 1.2, -0.4, 0.32);
        tower(p, 0, 2.6, -9, 2.6, 4.0, 2, 1.2);
        strips(p, 4.2, 0, 6, 14);
        p.light.push(V(0, 6.6, -3), V(0, -6.6, -3), V(0, 5.3, -9.4));
        p.dark.push(box(6.8, 3, 2.8, 0, -0.2, -20));
        p.engines.push({ x: 2.2, y: -0.2, z: -21.6, r: 1.2 }, { x: -2.2, y: -0.2, z: -21.6, r: 1.2 });
      } };
    }
    case 'p17_ca_swarm': {     // 해적 개조: missile barge — open spine with external missile container racks, asymmetric bridge
      return { profile: [[-0.5, 1], [0.5, 1]], W: 1.6, tint: TINT.rust, build: p => {
        p.dark.push(box(2.6, 2.2, L * 0.92, 0, 0, -0.5));
        for (let i = 0; i < 4; i++) for (const s of [1, -1]) {
          const z = 11 - i * 7;
          p.hull.push(box(3.0, 2.4, 5.6, 3.1 * s, 0.4, z));
          p.trim.push(box(2.6, 0.3, 5.0, 3.1 * s, 1.75, z));
          p.accent.push(box(0.1, 0.25, 4.6, (3.1 + 1.55) * s, 0.4, z));
        }
        p.hull.push(slab([[-0.5, 1], [0.5, 0.3]], 6, 2.4, -0.5, 0.5, -1.2, 2.4).translate(0, 0, 18.5));
        p.hull.push(box(2.0, 2.6, 3.4, -1.6, 2.4, -14.5));
        p.dark.push(box(2.4, 0.4, 1.0, -1.6, 3.9, -13.5), box(0.6, 3.6, 0.6, 1.2, 2.2, -15.2));
        p.light.push(V(-1.6, 4.2, -14.8), V(1.2, 4.2, -15.2));
        p.dark.push(box(5.4, 3.0, 2.6, 0, 0, -19.6));
        for (const x of [-1.6, 1.6]) p.engines.push({ x, y: 0, z: -21.0, r: 1.15 });
      } };
    }
    case 'p17_ca_aegis': {     // 헬리오스: tall faceted superstructure carrying four phased-array faces
      const pr: Profile = [[-0.5, 0.65], [-0.3, 1], [0.25, 0.92], [0.5, 0.2]];
      return { profile: pr, W: 4.0, tint: TINT.helios, build: p => {
        body(p.hull, pr, 4.0, -1.8, 3.0);
        p.hull.push(box(4.4, 2.4, 9, 0, 2.4, -1.5), box(3.4, 2.2, 6.6, 0, 4.7, -1.8));
        for (const [x, z, ry] of [[0, 1.6, 0], [0, -5.2, Math.PI], [1.8, -1.8, Math.PI / 2], [-1.8, -1.8, -Math.PI / 2]] as const) {
          const g = new THREE.BoxGeometry(2.6, 2.0, 0.2); g.rotateX(-0.25); g.rotateY(ry); g.translate(x, 4.8, z); p.accent.push(g);
        }
        mast(p, 0, 5.8, -2, 3.0);
        cells(p, 0, 1.35, 9, 2, 2, 1.0); cells(p, 0, 1.35, -10.5, 2, 2, 1.0);
        strips(p, 3.9, 0, 0, 20);
        p.light.push(V(3.9, 0.6, -15), V(-3.9, 0.6, -15));
        p.dark.push(box(6, 3, 2.6, 0, -0.3, -20));
        p.engines.push({ x: 1.8, y: -0.3, z: -21.5, r: 1.15 }, { x: -1.8, y: -0.3, z: -21.5, r: 1.15 });
      } };
    }
    case 'p17_ca_hydra': {     // 세레스 실험작: three separate hulls on a frame, each with its own drive (expensive, fragile)
      return { profile: [[-0.5, 1], [0.5, 1]], W: 1.2, tint: TINT.ceres, build: p => {
        const hp: Profile = [[-0.5, 0.6], [-0.3, 1], [0.3, 0.8], [0.5, 0.15]];
        const at: [number, number][] = [[0, 1.6], [4.2, -1.2], [-4.2, -1.2]];
        for (const [x, y] of at) for (const [a, b] of [[-0.5, 0], [0, 0.5]] as const) { const g = slab(hp, L * (x ? 0.82 : 1), 1.4, a, b, -0.9, 1.8); g.translate(x, y, x ? -2 : 0); p.hull.push(g); }
        for (const z of [-8, 2, 10]) { p.trim.push(box(9.2, 0.4, 0.8, 0, -0.6, z), box(0.4, 3.4, 0.8, 0, 0.2, z)); }
        p.accent.push(torus(4.6, 0.12, 0, 0.2, 2, 'z', 30));
        p.hull.push(box(1.6, 1.0, 3.2, 0, 3.0, -2));
        p.light.push(V(0, 3.8, -2), V(4.2, 0.4, 13), V(-4.2, 0.4, 13));
        for (const [x, y] of at) p.engines.push({ x, y: y + 0.0, z: x ? -18.0 : -19.4, r: 0.85 });
      } };
    }
    // ═══════════════════════════════════════════════════════════════ battlecruisers (L 54)
    case 'p17_bc_breaker': {   // 바스티온: siege — a massive armoured prow wedge, three heavy barbettes, belt plates
      const pr: Profile = [[-0.5, 0.75], [-0.35, 0.95], [0.1, 1], [0.32, 0.9], [0.5, 0.45]];
      return { profile: pr, W: 6.0, tint: TINT.bastion, build: p => {
        body(p.hull, pr, 6.0, -2.6, 4.2);
        body(p.hull, scaleW(pr, 0.68), 6.0, 1.6, 1.6, -0.4, 0.3);
        p.trim.push(slab([[-0.5, 1.15], [0.5, 0.35]], 12, 6.0, -0.5, 0.5, -3.0, 5.2).translate(0, 0, 25));
        plates(p, 6.3, -0.4, -22, 14, 6, 3.0, 0.5);
        for (const z of [16, 7, -17]) p.dark.push(cyl(2.6, 3.0, 1.2, 0, 3.4, z, 'y', 16));
        tower(p, 0, 3.2, -4, 4.4, 6.5, 3, 1.5);
        mast(p, 0, 7.7, -5.2, 4.0, 1.1);
        p.light.push(V(6.4, 1.2, -24), V(-6.4, 1.2, -24));
        p.dark.push(box(10, 4, 3.4, 0, -0.4, -28.4));
        for (const x of [-3.2, 0, 3.2]) p.engines.push({ x, y: -0.4, z: -30.4, r: 1.5 });
      } };
    }
    case 'p17_bc_falchion': {  // 헬리오스: fast blade hull, two long outboard engine pods on swept pylons
      const pr: Profile = [[-0.5, 0.55], [-0.3, 1], [0.1, 0.8], [0.5, 0.08]];
      return { profile: pr, W: 4.6, tint: TINT.helios, build: p => {
        body(p.hull, pr, 4.6, -1.8, 3.0);
        body(p.hull, scaleW(pr, 0.55), 4.6, 1.2, 1.2, -0.42, 0.2);
        pair(p.trim, s => box(5.2, 0.4, 5.0, 5.2 * s, 0.3, -15));
        for (const s of [1, -1]) pod(p, 8.4 * s, 0.3, -14, 1.6, 20);
        pair(p.accent, s => box(0.1, 0.2, 26, 4.4 * s, 0.4, 0));
        tower(p, 0, 2.4, -10, 2.8, 5.2, 2, 1.3);
        p.light.push(V(8.4, 2.0, -5), V(-8.4, 2.0, -5), V(0, 5.4, -10.4));
        p.dark.push(box(4.6, 2.4, 2.4, 0, -0.3, -28));
        p.engines.push({ x: 0, y: -0.3, z: -29.4, r: 1.3 });
      } };
    }
    case 'p17_bc_corsair': {   // 러스트포트: rebuilt hull — offset bridge, slab armour bolted unevenly, outrigger gun deck
      const pr: Profile = [[-0.5, 0.8], [-0.3, 1], [0.25, 0.9], [0.5, 0.3]];
      return { profile: pr, W: 5.2, tint: TINT.rust, build: p => {
        body(p.hull, pr, 5.2, -2.2, 3.8);
        p.trim.push(box(1.0, 3.4, 12, 5.6, 0, 6), box(1.0, 2.6, 8, -5.5, 0.4, -8), box(0.8, 2.0, 7, 5.5, 0.2, -12));
        p.hull.push(box(7.0, 1.0, 9, -7.5, 0.8, 3));
        p.dark.push(box(0.8, 3.6, 0.8, -6.5, -0.6, 6), box(0.8, 3.6, 0.8, -6.5, -0.6, 0));
        p.hull.push(box(3.6, 2.4, 6, 2.4, 2.8, -9), box(2.6, 1.6, 4, 2.4, 4.8, -9.4));
        p.dark.push(box(3.2, 0.4, 1.2, 2.4, 5.7, -8.2), cyl(0.15, 0.15, 4, -1.2, 3.6, -11, 'y', 6));
        p.light.push(V(2.4, 6.2, -9.4), V(-10.8, 1.6, 3), V(-1.2, 5.8, -11));
        p.dark.push(box(9.6, 3.6, 3.2, 0, -0.4, -28.4));
        p.dark.push(cyl(1.0, 1.1, 5, 6.0, 0.6, -15.8, 'z', 12)); // bolted-on booster pod
        p.engines.push({ x: 2.6, y: -0.4, z: -30.2, r: 1.4 }, { x: -2.6, y: -0.4, z: -30.2, r: 1.4 }, { x: 6.0, y: 0.6, z: -18.6, r: 0.9 });
      } };
    }
    case 'p17_bc_monitor': {   // 바스티온: low flat monitor around one enormous spinal cannon, almost no superstructure
      const pr: Profile = [[-0.5, 0.85], [-0.2, 1], [0.3, 0.95], [0.5, 0.55]];
      return { profile: pr, W: 7.0, tint: TINT.bastion, build: p => {
        body(p.hull, pr, 7.0, -2.0, 2.8);
        spinal(p, 0.6, 2, 34, 1.6);
        p.trim.push(box(5.6, 2.2, 16, 0, 1.0, 4));
        plates(p, 7.2, -0.6, -24, 22, 6, 2.2, 0.5);
        p.hull.push(box(3.4, 1.4, 4.4, 0, 1.5, -16));
        p.dark.push(box(2.6, 0.5, 1.6, 0, 2.45, -15.6));
        p.light.push(V(0, 0.6, 36.2), V(7, 0.6, -24), V(-7, 0.6, -24));
        p.dark.push(box(12.6, 3.2, 3.2, 0, -0.6, -28.4));
        for (const x of [-4.6, -1.6, 1.6, 4.6]) p.engines.push({ x, y: -0.6, z: -30.2, r: 1.3 });
      } };
    }
    // ═══════════════════════════════════════════════════════════════ battleships (L 64)
    case 'p17_bb_solaris': {   // 세레스 기함: twin reactor rings in tandem, crystal spine, pale stepped hull
      const pr: Profile = [[-0.5, 0.65], [-0.35, 1], [0.15, 0.95], [0.4, 0.5], [0.5, 0.15]];
      return { profile: pr, W: 6.8, tint: TINT.ceres, build: p => {
        body(p.hull, pr, 6.8, -3.0, 5.0);
        body(p.hull, scaleW(pr, 0.6), 6.8, 2.0, 1.8, -0.42, 0.36);
        for (const z of [-8, -18]) { p.trim.push(torus(9.6, 0.9, 0, 0.5, z, 'z', 40)); p.accent.push(torus(9.6, 0.32, 0, 0.5, z + 0.9, 'z', 40)); }
        p.accent.push(box(0.6, 1.4, 34, 0, 4.4, 2));
        for (let i = 0; i < 6; i++) p.trim.push(box(1.0, 1.0 + (i % 2) * 0.8, 1.2, 0, 4.8 + (i % 2) * 0.4, 16 - i * 5.5));
        tower(p, 0, 3.8, -2, 4.6, 7, 3, 1.4);
        p.light.push(V(0, 10.1, -8), V(0, 10.1, -18), V(9.6, 0.5, -8), V(-9.6, 0.5, -8));
        p.dark.push(box(11, 5, 4, 0, -0.5, -33.4));
        for (const x of [-3.6, 0, 3.6]) p.engines.push({ x, y: -0.5, z: -35.6, r: 1.8 });
      } };
    }
    case 'p17_bb_hulk': {      // 해적: patched hulk — scaffolding, stacked containers, mismatched turret decks
      const pr: Profile = [[-0.5, 0.9], [-0.25, 1], [0.3, 0.95], [0.5, 0.6]];
      return { profile: pr, W: 7.2, tint: TINT.rust, build: p => {
        body(p.hull, pr, 7.2, -3.2, 5.0);
        for (let i = 0; i < 5; i++) pair(i % 2 ? p.trim : p.hull, s => box(1.4, 2.4 + (i % 3) * 0.6, 7 + i % 2, 7.6 * s, -0.4 + i * 0.1, -24 + i * 11));
        for (const [x, z] of [[-3, 18], [3.6, 6], [-2.4, -6]]) p.trim.push(box(4.4, 2.0, 7, x, 2.8, z));
        for (let i = 0; i < 4; i++) { p.dark.push(box(0.35, 6, 0.35, 5.6, 4.2, -14 + i * 4)); p.dark.push(box(0.35, 0.35, 12, 5.6, 7.1, -8)); }
        p.hull.push(box(5, 3.2, 8, -1.2, 3.6, -16), box(3.4, 2.4, 5, -1.2, 6.4, -16.6));
        p.light.push(V(-1.2, 8.1, -16.6), V(5.6, 7.5, -14), V(7.6, 1.6, 20));
        p.dark.push(box(12, 5, 3.6, 0, -0.6, -33.4));
        p.engines.push({ x: 3.8, y: -0.6, z: -35.4, r: 1.9 }, { x: -3.8, y: -0.6, z: -35.4, r: 1.7 }, { x: 0, y: 1.2, z: -35.4, r: 1.2 });
      } };
    }
    case 'p17_bb_bastion': {   // 바스티온: ziggurat — three armour tiers, five barbettes, armoured citadel
      const pr: Profile = [[-0.5, 0.8], [-0.4, 1], [0.2, 1], [0.42, 0.7], [0.5, 0.35]];
      return { profile: pr, W: 8.0, tint: TINT.bastion, build: p => {
        body(p.hull, pr, 8.0, -3.6, 5.4);
        body(p.trim, scaleW(pr, 0.78), 8.0, 1.8, 1.8, -0.44, 0.4);
        body(p.hull, scaleW(pr, 0.56), 8.0, 3.6, 1.6, -0.36, 0.28);
        plates(p, 8.3, -1.0, -28, 22, 7, 3.6, 0.6);
        for (const z of [24, 15, -22]) p.dark.push(cyl(3.0, 3.4, 1.4, 0, 4.3, z, 'y', 16));
        for (const z of [8, -14]) p.dark.push(cyl(3.0, 3.4, 1.4, 0, 6.0, z, 'y', 16));
        const top = tower(p, 0, 5.2, -3, 5.6, 9, 3, 1.6);
        mast(p, 0, top, -4.6, 4.0, 1.4);
        p.light.push(V(8.3, 1.0, -30), V(-8.3, 1.0, -30));
        p.dark.push(box(14, 5.4, 3.6, 0, -0.6, -33.6));
        for (const x of [-4.8, -1.6, 1.6, 4.8]) p.engines.push({ x, y: -0.6, z: -35.8, r: 1.6 });
      } };
    }
    case 'p17_bb_vanguard': {  // 연합: split hull — two armoured hulls joined by a bridge deck and an open keel truss
      return { profile: [[-0.5, 1], [0.5, 1]], W: 2, tint: TINT.union, build: p => {
        const hp: Profile = [[-0.5, 0.7], [-0.3, 1], [0.25, 0.95], [0.5, 0.25]];
        for (const s of [1, -1]) for (const [a, b] of [[-0.5, 0], [0, 0.5]] as const) { const g = slab(hp, L, 3.2, a, b, -2.6, 4.4); g.translate(5.8 * s, 0, 0); p.hull.push(g); }
        p.hull.push(box(8.6, 2.0, 30, 0, 0.8, -2));
        for (const z of [-24, -14, 14, 22]) p.dark.push(box(8.6, 0.6, 0.8, 0, -2.0, z));
        p.dark.push(box(0.6, 0.6, 44, 0, -2.2, 0));
        tower(p, 0, 1.8, -4, 5.0, 8, 3, 1.5);
        mast(p, 0, 6.3, -5.4, 4.2, 1.2);
        for (const s of [1, -1]) p.accent.push(box(0.12, 0.25, 40, (5.8 + 3.1) * s, 0.2, 0));
        p.light.push(V(5.8, 2.3, 30), V(-5.8, 2.3, 30), V(0, 10.7, -5.4));
        for (const s of [1, -1]) { p.dark.push(box(5.4, 4, 3, 5.8 * s, -0.4, -33.2)); p.engines.push({ x: 4.6 * s, y: -0.4, z: -35, r: 1.3 }, { x: 7.0 * s, y: -0.4, z: -35, r: 1.3 }); }
      } };
    }
    // ═══════════════════════════════════════════════════════════════ dreadnoughts (L 92)
    case 'p17_dn_citadel': {   // 철갑 사령부: moving fortress — four stepped tiers, nine barbettes, castle keep
      const pr: Profile = [[-0.5, 0.85], [-0.38, 1], [0.25, 1], [0.42, 0.75], [0.5, 0.4]];
      return { profile: pr, W: 11, tint: TINT.bastion, build: p => {
        body(p.hull, pr, 11, -5, 7);
        body(p.trim, scaleW(pr, 0.82), 11, 2.0, 2.0, -0.45, 0.42);
        body(p.hull, scaleW(pr, 0.64), 11, 4.0, 2.0, -0.4, 0.34);
        body(p.trim, scaleW(pr, 0.44), 11, 6.0, 1.6, -0.3, 0.2);
        plates(p, 11.4, -1.2, -42, 34, 9, 5, 0.8);
        for (const z of [36, 26]) p.dark.push(cyl(3.6, 4.0, 1.6, 0, 5.0, z, 'y', 18));
        for (const z of [16, -32]) p.dark.push(cyl(3.6, 4.0, 1.6, 0, 7.0, z, 'y', 18));
        for (const s of [1, -1]) for (const z of [6, -12]) p.dark.push(cyl(2.6, 3.0, 1.2, 6.4 * s, 4.8, z, 'y', 16));
        p.dark.push(cyl(3.6, 4.0, 1.6, 0, 8.5, -22, 'y', 18));
        const top = tower(p, 0, 7.6, -3, 7, 10, 3, 1.8);
        mast(p, 2, top, -4.8, 5, 1.6); mast(p, -2, top, -5.2, 3.6);
        p.light.push(V(11, 1.4, -44), V(-11, 1.4, -44), V(0, 1.4, 46));
        p.dark.push(box(19, 8, 5, 0, -1, -48.4));
        for (const [x, y] of [[-6, 1], [-2, 1], [2, 1], [6, 1], [-4, -2.6], [4, -2.6]]) p.engines.push({ x, y, z: -51.2, r: 2.0 });
      } };
    }
    case 'p17_dn_leviathan': { // 헬리오스: elongated blade around a spinal lance, single drive ring, swept fins
      const pr: Profile = [[-0.5, 0.55], [-0.35, 1], [0.1, 0.85], [0.35, 0.45], [0.5, 0.08]];
      return { profile: pr, W: 8.0, tint: TINT.helios, build: p => {
        body(p.hull, pr, 8.0, -3.6, 6.0);
        body(p.hull, scaleW(pr, 0.55), 8.0, 2.4, 2.2, -0.42, 0.3);
        spinal(p, 0, 20, 36, 1.8);
        p.trim.push(torus(12, 1.1, 0, 0, -34, 'z', 40));
        p.accent.push(torus(12, 0.4, 0, 0, -33, 'z', 40));
        for (const a of [0, Math.PI / 2, Math.PI, Math.PI * 1.5]) p.dark.push(box(Math.abs(Math.cos(a)) * 8 + 0.6, Math.abs(Math.sin(a)) * 8 + 0.6, 1.2, Math.cos(a) * 7.6, Math.sin(a) * 7.6, -34));
        pair(p.trim, s => box(10, 0.5, 9, 9.6 * s, -1.0, -24));
        tower(p, 0, 4.6, -12, 4.6, 9, 3, 1.6);
        strips(p, 7.6, 0, -2, 50);
        p.light.push(V(0, 0, 56.4), V(12, 0, -34), V(-12, 0, -34), V(14.6, -1, -24), V(-14.6, -1, -24));
        p.dark.push(box(10, 6, 4, 0, -0.6, -47.4));
        for (const [x, y] of [[-3, 1.4], [3, 1.4], [-3, -2.4], [3, -2.4]]) p.engines.push({ x, y, z: -49.8, r: 2.0 });
      } };
    }
    case 'p17_dn_sovereign': { // 구 제국: obsolete giant — long round hull, ribbed, six open gun houses, tall pagoda mast
      return { profile: [[-0.5, 1], [0.5, 1]], W: 7, tint: TINT.old, build: p => {
        p.hull.push(cyl(7, 7, 56, 0, 0, -6, 'z', 18), cyl(2.5, 7, 22, 0, 0, 33, 'z', 18), cyl(7, 6, 10, 0, 0, -39, 'z', 18));
        for (let i = 0; i < 10; i++) p.trim.push(torus(7.3, 0.35, 0, 0, -38 + i * 7.5, 'z', 20));
        p.hull.push(box(8, 1.0, 60, 0, 6.6, -2));
        for (const z of [24, 14, 5, -17, -24, -31]) p.dark.push(box(5, 2.2, 5, 0, 8.2, z));
        const top = tower(p, 0, 7.1, -4, 6, 9, 5, 1.6);
        p.dark.push(box(7, 0.5, 2, 0, top - 1, -5), cyl(0.2, 0.3, 6, 0, top + 3, -6, 'y', 6));
        p.dark.push(cyl(1.6, 1.8, 6, 0, 10, -11, 'y', 12));
        p.light.push(V(0, top + 6, -6), V(7.4, 0, 30), V(-7.4, 0, 30));
        p.dark.push(box(14, 10, 4, 0, 0, -45));
        for (const [x, y] of [[-3.4, 2.6], [3.4, 2.6], [-3.4, -2.6], [3.4, -2.6]]) p.engines.push({ x, y, z: -47.6, r: 2.3 });
      } };
    }
    // ═══════════════════════════════════════════════════════════════ carriers (L 64; preview hulls)
    case 'p17_cv_hive': {      // 연합·길드: light carrier of honeycomb hangar blocks around a central spine, no flight deck
      return { profile: [[-0.5, 1], [0.5, 1]], W: 2, tint: TINT.guild, build: p => {
        p.dark.push(box(4, 3.4, L * 0.9, 0, 0, -1));
        for (let i = 0; i < 4; i++) for (const s of [1, -1]) {
          const z = 18 - i * 11;
          hangar(p, 5.2 * s, 1.0, z, 6.0, 4.6, 8.4);
          p.trim.push(box(6.2, 0.3, 8.6, 5.2 * s, 3.45, z));
        }
        p.hull.push(slab([[-0.5, 1], [0.5, 0.3]], 8, 3.4, -0.5, 0.5, -1.8, 3.6).translate(0, 0, 33));
        p.hull.push(box(3.2, 2.6, 6, 0, 3.0, -20));
        mast(p, 0, 4.3, -21, 3.6, 1.1);
        p.light.push(V(8.2, 3.6, 18), V(-8.2, 3.6, 18), V(8.2, 3.6, -15), V(-8.2, 3.6, -15));
        p.dark.push(box(9, 4, 3, 0, 0, -33.4));
        for (const x of [-2.6, 2.6]) p.engines.push({ x, y: 0, z: -35.4, r: 1.6 });
      } };
    }
    case 'p17_cv_ark': {       // 연합 정규 모함: wide angled flight deck over a deep hangar hull, twin islands
      const pr: Profile = [[-0.5, 0.8], [-0.35, 1], [0.3, 0.95], [0.5, 0.4]];
      return { profile: pr, W: 6.0, tint: TINT.union, build: p => {
        body(p.hull, pr, 6.0, -3.0, 5.0);
        const deck: Profile = [[-0.5, 0.9], [-0.2, 1.0], [0.35, 1.0], [0.5, 0.7]];
        const d = slab(deck, L * 1.08, 9.6, -0.5, 0.5, 2.0, 1.2, 0.2); p.hull.push(d);
        const ang = new THREE.BoxGeometry(6, 0.8, 22); ang.rotateY(0.18); ang.translate(-9.5, 2.6, 6); p.hull.push(ang);
        p.dark.push(box(16, 0.08, L * 0.95, 0, 3.24, 0));
        p.accent.push(box(0.4, 0.06, L * 0.9, 0, 3.3, 0), box(0.25, 0.06, 20, -9.6, 3.05, 6));
        for (let k = 0; k < 8; k++) p.trim.push(box(2.0, 0.05, 0.4, 0, 3.32, 26 - k * 2));
        for (const z of [-4, -18]) { p.hull.push(box(2.6, 4.4, 8, 10.6, 5.4, z)); p.dark.push(box(3.0, 0.8, 2.6, 10.6, 8.0, z + 1.6)); }
        mast(p, 10.6, 7.6, -5, 4, 1.2);
        p.light.push(V(10.6, 11.8, -5), V(0, 3.4, 34), V(10, 3.4, -33), V(-10, 3.4, -33));
        p.dark.push(box(10, 4.6, 3.4, 0, -0.6, -33.6));
        for (const x of [-3.2, 0, 3.2]) p.engines.push({ x, y: -0.6, z: -35.6, r: 1.6 });
      } };
    }
  }
  return undefined;
}

/** every P17 silhouette (content validator + tests) */
export { P17_MESH_BASES as P17_BASES } from '../content/meshBases';

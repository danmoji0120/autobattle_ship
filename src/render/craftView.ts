import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { World } from '../sim/world';
import { CRAFT_ST, CRAFT_TK, SLOT_BITS, type CraftPool } from '../sim/craft';
import { TrailBatch } from './effects';

/**
 * P16.4 strike craft rendering. Reads World.craft (the CraftPool) each frame and never writes to it; every
 * random choice here uses Math.random, so nothing seen on screen can change a battle's outcome or digest.
 *
 *  - three InstancedMeshes (fighter / torpedo bomber / interceptor) plus one for torpedoes still slung
 *    under bombers, so a bomber visibly drops its load when the sim's `ordL` flag clears
 *  - engine streaks and gun tracers in one additive TrailBatch: tracers come from a slot's gun cooldown
 *    being reset (a shot), coloured by what the sim says it shot at — ship (amber), craft (cyan),
 *    guided round (green)
 *  - launch / recovery / loss come from the slot state machine (and the sim's craft events)
 */

const ROLES = ['fighter', 'bomber', 'interceptor'] as const;
type Role = typeof ROLES[number];
const ROLE_IX: Record<Role, number> = { fighter: 0, bomber: 1, interceptor: 2 };

/** craft are tiny next to hulls: they grow with camera distance so a strike stays readable from orbit */
const BASE_SCALE = 1.6, FAR_K = 0.0032, MAX_BOOST = 5;

function deltaWing(span: number, len: number, z0: number, sweep = 1): THREE.BufferGeometry {
  const s = new THREE.Shape();
  s.moveTo(0, z0 + len); s.lineTo(span / 2, z0 + len * (1 - sweep)); s.lineTo(span / 2, z0); s.lineTo(-span / 2, z0); s.lineTo(-span / 2, z0 + len * (1 - sweep)); s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: 0.12, bevelEnabled: false });
  g.rotateX(Math.PI / 2);      // shape XY → XZ (nose +Z)
  g.translate(0, 0.06, 0);
  return g;
}
function body(r: number, len: number, z = 0, rTail = r * 0.8): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r * 0.25, rTail, len, 7);
  g.rotateX(Math.PI / 2); g.translate(0, 0, z);
  return g;
}
const nonIndexed = (gs: THREE.BufferGeometry[]) => mergeGeometries(gs.map(g => (g.index ? g.toNonIndexed() : g)).map(g => { g.deleteAttribute('uv'); return g; }))!;

/** silhouettes: fighter = dart with a delta wing; bomber = broad straight wing, twin booms; interceptor = needle with canards */
function craftGeometry(role: Role): THREE.BufferGeometry {
  if (role === 'fighter') return nonIndexed([body(0.42, 3.2, 0.2), deltaWing(2.8, 1.9, -1.3), (() => { const t = new THREE.BoxGeometry(0.08, 0.7, 0.7); t.translate(0, 0.4, -1.1); return t; })()]);
  if (role === 'bomber') {
    const wing = new THREE.BoxGeometry(4.6, 0.14, 0.9); wing.translate(0, 0.05, 0.1);
    const boomL = new THREE.BoxGeometry(0.22, 0.22, 2.6); boomL.translate(-0.9, 0.05, -1.0);
    const boomR = boomL.clone(); boomR.translate(1.8, 0, 0);
    const tail = new THREE.BoxGeometry(2.2, 0.1, 0.5); tail.translate(0, 0.1, -2.2);
    return nonIndexed([body(0.62, 3.0, 0.4, 0.55), wing, boomL, boomR, tail]);
  }
  const canard = new THREE.BoxGeometry(1.0, 0.06, 0.35); canard.translate(0, 0.05, 1.3);
  return nonIndexed([body(0.28, 4.0, 0.2, 0.3), deltaWing(1.7, 1.2, -1.9, 0.8), canard]);
}
function torpedoGeometry(): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(0.16, 0.16, 2.2, 6); g.rotateX(Math.PI / 2); g.translate(0, -0.45, 0.3);
  return g;
}

/** team tint (viewer's own/allied side vs hostile), slightly varied by role so mixed groups read apart */
const TINT: [number, number][] = [[0xb8d4f0, 0xf0b8a8], [0x9cc0e8, 0xe8a090], [0xd0e8ff, 0xffc8b8]];

interface Tracer { ax: number; ay: number; az: number; bx: number; by: number; bz: number; life: number; max: number; r: number; g: number; b: number; w: number }

export interface CraftFxHost {
  glow: { emit(p: THREE.Vector3 | { x: number; y: number; z: number }, o: { life: number; size: number; size1?: number; color: number; color1?: number; alpha?: number; vel?: THREE.Vector3 }): void };
  friendly(team: number): boolean;
}

export class CraftView {
  readonly group = new THREE.Group();
  readonly trails = new TrailBatch(5000);
  private meshes: THREE.InstancedMesh[] = [];
  private torps: THREE.InstancedMesh;
  private cap = 0;
  // per-slot memory of the last sampled sim state (display only)
  private pSt = new Uint8Array(0);
  private pCool = new Float64Array(0);
  private pOrd = new Uint8Array(0);
  private tracers: Tracer[] = [];
  private m = new THREE.Matrix4(); private q = new THREE.Quaternion(); private s = new THREE.Vector3(); private p = new THREE.Vector3();
  private fwd = new THREE.Vector3(); private up = new THREE.Vector3(0, 1, 0); private col = new THREE.Color();
  private camPos = new THREE.Vector3();
  /** visible airframes in the last frame (perf HUD / tests) */
  drawn = 0;
  /** gun shots seen so far (cooldown resets of airborne slots; tests / perf probes) */
  shots = 0;

  constructor(private host: CraftFxHost) {
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 0.35, roughness: 0.45, emissive: 0x202830, emissiveIntensity: 0.6 });
    for (const r of ROLES) {
      const im = new THREE.InstancedMesh(craftGeometry(r), mat, 16);
      im.count = 0; im.frustumCulled = false;
      this.meshes.push(im); this.group.add(im);
    }
    this.torps = new THREE.InstancedMesh(torpedoGeometry(), new THREE.MeshStandardMaterial({ color: 0x585c60, metalness: 0.6, roughness: 0.4, emissive: 0x301818 }), 16);
    this.torps.count = 0; this.torps.frustumCulled = false;
    this.group.add(this.torps, this.trails.mesh);
  }

  /** grow the instance buffers to the pool's slot count (pools only grow) */
  private ensure(n: number) {
    if (n <= this.cap) return;
    const cap = Math.max(64, 1 << Math.ceil(Math.log2(n)));
    for (let k = 0; k < this.meshes.length; k++) {
      const old = this.meshes[k];
      const im = new THREE.InstancedMesh(old.geometry, old.material, cap);
      im.count = 0; im.frustumCulled = false;
      im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
      this.group.remove(old); old.dispose(); this.group.add(im); this.meshes[k] = im;
    }
    const ot = this.torps;
    this.torps = new THREE.InstancedMesh(ot.geometry, ot.material, cap); this.torps.count = 0; this.torps.frustumCulled = false;
    this.group.remove(ot); ot.dispose(); this.group.add(this.torps);
    const st = new Uint8Array(cap), cool = new Float64Array(cap), ord = new Uint8Array(cap);
    st.set(this.pSt); cool.set(this.pCool); ord.set(this.pOrd);
    this.pSt = st; this.pCool = cool; this.pOrd = ord;
    this.cap = cap;
  }

  /** tracer from craft slot i to what the sim says it is shooting at */
  private shot(w: World, c: CraftPool, i: number, x: number, y: number, z: number) {
    const sq = c.squads[c.sq[i]];
    let bx: number, by: number, bz: number, r: number, g: number, b: number, wd = 0.35, kind: 'ship' | 'craft' | 'mun';
    if (c.tk[i] === CRAFT_TK.CRAFT) {
      const j = c.tgt[i] % SLOT_BITS;
      bx = c.px[j]; by = c.py[j]; bz = c.pz[j]; r = 0.9; g = 2.6; b = 3.2; kind = 'craft';
    } else if (c.tk[i] === CRAFT_TK.MUN) {
      const mu = w.munitionById.get(c.tgt[i]);
      if (!mu) return;
      bx = mu.pos.x; by = mu.pos.y; bz = mu.pos.z; r = 1.2; g = 3.2; b = 1.0; kind = 'mun';
    } else {
      const t = w.shipById.get(sq.tgtShip);
      if (!t) return;
      const k = t.radius * 0.5;
      bx = t.pos.x + (Math.random() - 0.5) * k; by = t.pos.y + Math.random() * k * 0.5; bz = t.pos.z + (Math.random() - 0.5) * k;
      r = 3.2; g = 1.8; b = 0.6; wd = 0.45; kind = 'ship';
    }
    // a short burst: the visible tracer covers the first part of the path, the rest is implied by the impact
    const dx = bx - x, dy = by - y, dz = bz - z;
    const f = kind === 'ship' ? 0.85 : 1;
    this.tracers.push({ ax: x, ay: y, az: z, bx: x + dx * f, by: y + dy * f, bz: z + dz * f, life: 0.09, max: 0.09, r, g, b, w: wd });
    if (this.tracers.length > 1500) this.tracers.splice(0, this.tracers.length - 1500);
    if (kind === 'craft' && Math.random() < 0.35) this.host.glow.emit({ x: bx, y: by, z: bz }, { life: 0.08, size: 1.6, size1: 0.8, color: 0x9ff0ff, alpha: 0.9 });
  }

  frame(w: World, alpha: number, realDt: number, cam: THREE.Camera, render: boolean) {
    const c = w.craft;
    this.trails.begin(cam);
    if (!c) { for (const im of this.meshes) im.count = 0; this.torps.count = 0; this.trails.end(); this.drawn = 0; return; }
    const n = c.st.length;
    this.ensure(n);
    this.camPos.setFromMatrixPosition(cam.matrixWorld);
    const cnt = [0, 0, 0];
    let tc = 0;
    const back = (1 - alpha) * w.dt;
    for (let i = 0; i < n; i++) {
      const st = c.st[i], pst = this.pSt[i];
      const sq = c.squads[c.sq[i]];
      if (!sq) continue;
      const x = c.px[i] - c.vx[i] * back, y = c.py[i] - c.vy[i] * back, z = c.pz[i] - c.vz[i] * back;
      if (pst === CRAFT_ST.OUT && st === CRAFT_ST.OUT) {
        if (c.cool[i] > this.pCool[i] + 1e-9) { this.shots++; this.shot(w, c, i, x, y, z); }
        if (this.pOrd[i] && !c.ordL[i]) {
          // torpedo released (the munition itself is drawn by the guided-round trails)
          this.host.glow.emit({ x, y: y - 0.6, z }, { life: 0.25, size: 3.5, size1: 7, color: this.host.friendly(sq.team) ? 0x80b0ff : 0xff70c0, alpha: 1.2 });
        }
      } else if (pst === CRAFT_ST.OUT && st === CRAFT_ST.PREP && c.hp[i] > 0) {
        // recovered aboard: a small landing light on the deck
        this.host.glow.emit({ x: sq.ship.pos.x, y: sq.ship.pos.y + 3, z: sq.ship.pos.z }, { life: 0.4, size: 3, size1: 1, color: 0x90e0ff, alpha: 0.8 });
      }
      this.pSt[i] = st; this.pCool[i] = c.cool[i]; this.pOrd[i] = c.ordL[i];
      if (st !== CRAFT_ST.OUT || !render) continue;
      const role = ROLE_IX[sq.cs.role] ?? 0;
      const im = this.meshes[role];
      const k = cnt[role]++;
      const vx = c.vx[i], vy = c.vy[i], vz = c.vz[i];
      const sp = Math.hypot(vx, vy, vz) || 1;
      this.fwd.set(vx / sp, vy / sp, vz / sp);
      this.m.lookAt(this.fwd, this.p.set(0, 0, 0), this.up);   // +Z of the model along the velocity
      this.q.setFromRotationMatrix(this.m);
      this.p.set(x, y, z);
      const dist = this.p.distanceTo(this.camPos);
      const sc = BASE_SCALE * Math.min(MAX_BOOST, Math.max(1, dist * FAR_K));
      this.s.set(sc, sc, sc);
      this.m.compose(this.p, this.q, this.s);
      im.setMatrixAt(k, this.m);
      const fr = this.host.friendly(sq.team);
      im.setColorAt(k, this.col.setHex(TINT[role][fr ? 0 : 1]));
      if (role === 1 && c.ordL[i]) this.torps.setMatrixAt(tc++, this.m);
      // engine streak
      const L = 0.1 * sc;
      const er = fr ? 0.7 : 2.6, eg = fr ? 1.4 : 1.0, eb = fr ? 3.0 : 0.6;
      this.trails.seg(x - vx * L * 0.12, y - vy * L * 0.12, z - vz * L * 0.12, x - this.fwd.x * sc * 1.2, y - this.fwd.y * sc * 1.2, z - this.fwd.z * sc * 1.2, 0.05 * sc, 0.35 * sc, er, eg, eb, 0, 0.8);
    }
    let total = 0;
    for (let r = 0; r < 3; r++) {
      const im = this.meshes[r];
      im.count = cnt[r]; total += cnt[r];
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
    }
    this.torps.count = tc; this.torps.instanceMatrix.needsUpdate = true;
    this.drawn = total;
    for (let t = this.tracers.length - 1; t >= 0; t--) {
      const tr = this.tracers[t];
      tr.life -= realDt;
      if (tr.life <= 0) { this.tracers.splice(t, 1); continue; }
      const a = tr.life / tr.max;
      if (render) this.trails.seg(tr.ax, tr.ay, tr.az, tr.bx, tr.by, tr.bz, tr.w * 0.6, tr.w, tr.r, tr.g, tr.b, a * 0.4, a);
    }
    this.trails.end();
  }

  /** sim craft events (launch / shot down / left) — visual only */
  launch(pos: THREE.Vector3, team: number) {
    this.host.glow.emit(pos, { life: 0.3, size: 4, size1: 1.5, color: this.host.friendly(team) ? 0xa0d8ff : 0xffb090, alpha: 1 });
  }
  down(pos: THREE.Vector3, team: number) {
    this.host.glow.emit(pos, { life: 0.45, size: 3, size1: 9, color: 0xffa040, color1: 0x401000, alpha: 1.4, vel: new THREE.Vector3(0, -6, 0) });
    if (Math.random() < 0.6) this.host.glow.emit(pos, { life: 0.9, size: 1.5, size1: 0.5, color: this.host.friendly(team) ? 0x80a0ff : 0xff8060, alpha: 1, vel: new THREE.Vector3((Math.random() - 0.5) * 30, -20, (Math.random() - 0.5) * 30) });
  }

  dispose() {
    for (const im of this.meshes) { im.geometry.dispose(); im.dispose(); }
    this.torps.geometry.dispose(); this.torps.dispose();
  }
}

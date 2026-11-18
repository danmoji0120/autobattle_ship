// P16.1 strike craft (battle rules ≥ 3): the light-craft pool. docs/P16_0_FIGHTERS_CARRIERS.md §6–§8
//
// A kind 'craft' weapon on a mount launches a squadron (Squad = ship + mount) of light craft. Craft are not
// Ships: they live in flat typed arrays (one fixed slot per complement place), are decided per squadron a
// few times a second, and steer / fire per craft every tick. Their guns are resolved instantly (no munition
// objects); a bomber's ordnance is an ordinary Munition, so ship point defence, guidance and hull rules apply
// to it unchanged. Ship point defence engages craft through pdPick / pdShoot. Craft never count for the
// outcome or a side's value.
//
// The pool exists only when a rules ≥ 3 battle has a craft mount (World.craft is null otherwise and none of
// this runs), and it draws from the battle rng only after the ships have fired, in a fixed order.
import { Vec3, localToWorld } from './math';
import { WEAPONS, type WeaponDef, type CraftStats } from './data/weapons';
import type { Ship, Mount } from './types';
import type { AirFx } from './fleet';
import type { World } from './world';

/** slot states */
const HANGAR = 0, PREP = 1, OUT = 2, LOST = 3, GONE = 4;
/** read-only views for the renderer / HUD (P16.4): slot states, target kinds, uid → slot */
export const CRAFT_ST = { HANGAR, PREP, OUT, LOST, GONE } as const;
/** flight modes */
const APPROACH = 0, EXTEND = 1, RETURN = 2;
/** squadron tasks: CAP (cover the carrier), STRIKE (enemy ships), AIR (intercept craft / guided rounds near the
 *  carrier), ESCORT (cover a friendly ship that enemy craft are going for) */
const CAP = 0, STRIKE = 1, AIR = 2, ESCORT = 3;
export const TASK_NAME = ['직위 엄호', '공격', '요격', '호위'] as const;
/** P16.3 air control: squadrons one carrier can direct on missions at once without control modules (the rest fly CAP) */
export const BASE_CONTROL = 3;
/** CAP squadrons engage enemy craft that come this close to their carrier */
const CAP_R = 650;
/** craft target kinds */
const T_NONE = 0, T_CRAFT = 1, T_MUN = 2;
export const CRAFT_TK = { NONE: T_NONE, CRAFT: T_CRAFT, MUN: T_MUN } as const;
const THINK = 0.3;
export const SLOT_BITS = 65536;
/** uniform grid (x/z plane) used for craft-vs-craft and point-defence queries */
const CELL = 250, GN = 64, GHALF = CELL * GN / 2;

/** P16.3: one carrier's air control — its squadrons decide together and at most `control` of them take a mission */
export interface Wing {
  ship: Ship;
  squads: Squad[];
  think: number;
  /** squadrons that may hold a mission (STRIKE / AIR / ESCORT) at once */
  control: number;
}

export interface Squad {
  idx: number;
  ship: Ship;
  mount: Mount;
  team: number;
  /** effective craft numbers: the weapon's CraftStats with the carrier's aviation modules applied (ShipFx.air) */
  cs: CraftStats;
  /** the weapon's own numbers */
  base: CraftStats;
  wing: Wing;
  /** the gun as World.applyHit sees it (null: no gun) */
  gun: WeaponDef | null;
  /** anti-ship ordnance (null: none) */
  ord: WeaponDef | null;
  first: number;
  spares: number;
  launchT: number;
  think: number;
  task: number;
  /** ship the squadron strikes (STRIKE), -1 none */
  tgtShip: number;
  /** friendly ship the squadron covers (ESCORT), -1 none */
  guard: number;
  /** mission priority of the last decision (air control keeps the highest `control` missions) */
  prio: number;
  /** CAP: enemy craft are inside the carrier's CAP radius */
  capThreat: boolean;
  /** P16.4 (display only): the last decision wanted a mission but the air-control limit kept it on CAP */
  heldNow: boolean;
  /** guided rounds an interceptor squadron may go after (AIR) */
  muns: number[];
  /** an enemy is within reach: launch */
  engaged: boolean;
  /** the carrier is gone (dying / destroyed): no launches or recoveries; craft in the air leave after their sortie */
  orphan: boolean;
  /** the carrier escaped or its side left: everything is gone */
  done: boolean;
  ax: number; ay: number; az: number;
  stats: { launched: number; lost: number; recovered: number; left: number; ordFired: number; /** decisions per task (TASK_NAME order) */ tasks: number[]; /** missions demoted to CAP by the control limit */ held: number };
}

/** P16.3: a squadron's effective numbers on a carrier with aviation modules (ShipFx.air) and officer air effects:
 *  hangar extension adds airframes, maintenance multiplies spares and the turnaround. Shared by the battle pool
 *  and the combat rating (world/combatRating.ts). */
export function effectiveCraft(base: CraftStats, air?: AirFx, ofx?: Record<string, number>): CraftStats {
  const airTurn = ofx?.airTurn ?? 0;
  if (!air && !airTurn) return base;
  const turn = (air?.turnaround ?? 1) * (airTurn ? 1 - airTurn : 1);
  return { ...base, n: base.n + Math.max(0, Math.round(air?.complement ?? 0)), spares: Math.round(base.spares * (air?.spares ?? 1)), turnaround: base.turnaround * turn };
}
/** squadrons a carrier directs on missions at once */
export const wingControl = (air?: AirFx, ofx?: Record<string, number>) => BASE_CONTROL + Math.max(0, Math.round(air?.control ?? 0)) + Math.round(ofx?.airCtl ?? 0);

/** rough sustained damage per second of one squadron (commander stand-off weighting only) */
export function craftFirepower(cs: CraftStats): number {
  let d = cs.gun ? cs.gun.damage / Math.max(0.05, cs.gun.reload) * 0.5 : 0;
  const o = cs.ordnance ? WEAPONS[cs.ordnance] : undefined;
  if (o) d += o.damage / (cs.sortie * 0.5 + cs.turnaround);
  return d * cs.n;
}

const tv = new Vec3(), tv2 = new Vec3(), tv3 = new Vec3();

export class CraftPool {
  readonly squads: Squad[] = [];
  readonly wings: Wing[] = [];
  n = 0;
  px = new Float64Array(0); py = new Float64Array(0); pz = new Float64Array(0);
  vx = new Float64Array(0); vy = new Float64Array(0); vz = new Float64Array(0);
  hp = new Float64Array(0);
  /** PREP: seconds to ready; OUT: sortie time left */
  timer = new Float64Array(0);
  cool = new Float64Array(0);
  /** per-craft retarget / manoeuvre timer */
  rt = new Float64Array(0);
  st = new Uint8Array(0);
  mode = new Uint8Array(0);
  ordL = new Uint8Array(0);
  tk = new Uint8Array(0);
  tgt = new Int32Array(0);
  sq = new Int32Array(0);
  uid = new Int32Array(0);
  gen = new Int32Array(0);
  // grid of flying craft (rebuilt at the end of every update)
  private cellStart = new Int32Array(GN * GN + 1);
  private cellItems = new Int32Array(0);
  private cellOf = new Int32Array(0);
  /** a craft's position / velocity handed to point defence */
  readonly pos = new Vec3();
  readonly vel = new Vec3();
  /** score of the last pdPick */
  pickScore = 0;
  /** craft shot down by ship point defence, per side */
  pdKills: number[] = [];

  constructor(private w: World) {}

  // ------------------------------------------------------------ setup
  /** give every craft mount of this ship a squadron */
  addShip(s: Ship) {
    // P16.3 aviation modules (ShipFx.air): hangar extension adds airframes per H slot, maintenance shortens the
    // turnaround and adds spares, air control raises how many squadrons take missions. Officer air effects
    // (ofx.airCtl / airTurn) are an extension point: no officer skill grants them yet.
    const air = s.air, ox = s.ofx;
    let wing: Wing | null = null;
    for (const m of s.mounts) {
      const base = m.weapon.kind === 'craft' ? m.weapon.craft : undefined;
      if (!base || base.n <= 0) continue;
      const cs = effectiveCraft(base, air, ox);
      if (!wing) { wing = { ship: s, squads: [], think: 0.05 + (this.wings.length % 10) * 0.025, control: wingControl(air, ox) }; this.wings.push(wing); }
      const first = this.n;
      this.grow(first + cs.n);
      const gun: WeaponDef | null = cs.gun ? { ...m.weapon, kind: 'shell', damage: cs.gun.damage, pen: cs.gun.pen, range: cs.gun.range, reload: cs.gun.reload, salvo: 1 } : null;
      const ord = cs.ordnance ? WEAPONS[cs.ordnance] ?? null : null;
      const idx = this.squads.length;
      this.squads.push({
        idx, ship: s, mount: m, team: s.team, cs, base, wing, gun, ord, first, spares: cs.spares, launchT: 0,
        think: 0, task: CAP, tgtShip: -1, guard: -1, prio: 0, capThreat: false, heldNow: false, muns: [], engaged: false, orphan: false, done: false,
        ax: s.pos.x, ay: s.pos.y, az: s.pos.z, stats: { launched: 0, lost: 0, recovered: 0, left: 0, ordFired: 0, tasks: [0, 0, 0, 0], held: 0 },
      });
      wing.squads.push(this.squads[idx]);
      for (let i = first; i < first + cs.n; i++) { this.st[i] = HANGAR; this.sq[i] = idx; this.ordL[i] = 1; this.uid[i] = -1; }
      this.n = first + cs.n;
    }
  }

  private grow(size: number) {
    if (size <= this.st.length) return;
    const cap = Math.max(size, this.st.length * 2, 64);
    if (cap > SLOT_BITS) throw new Error('craft pool: too many craft');
    const f = (a: Float64Array) => { const b = new Float64Array(cap); b.set(a); return b; };
    const u = (a: Uint8Array) => { const b = new Uint8Array(cap); b.set(a); return b; };
    const i32 = (a: Int32Array) => { const b = new Int32Array(cap); b.set(a); return b; };
    this.px = f(this.px); this.py = f(this.py); this.pz = f(this.pz); this.vx = f(this.vx); this.vy = f(this.vy); this.vz = f(this.vz);
    this.hp = f(this.hp); this.timer = f(this.timer); this.cool = f(this.cool); this.rt = f(this.rt);
    this.st = u(this.st); this.mode = u(this.mode); this.ordL = u(this.ordL); this.tk = u(this.tk);
    this.tgt = i32(this.tgt); this.sq = i32(this.sq); this.uid = i32(this.uid); this.gen = i32(this.gen);
    this.cellItems = new Int32Array(cap); this.cellOf = new Int32Array(cap);
  }

  // ------------------------------------------------------------ queries
  alive(uid: number): boolean { const i = uid % SLOT_BITS; return uid >= 0 && i < this.n && this.uid[i] === uid && this.st[i] === OUT; }
  /** position / velocity of a live craft into this.pos / this.vel */
  load(uid: number): boolean {
    if (!this.alive(uid)) return false;
    const i = uid % SLOT_BITS;
    this.pos.set(this.px[i], this.py[i], this.pz[i]); this.vel.set(this.vx[i], this.vy[i], this.vz[i]);
    return true;
  }
  /** craft in the air (optionally of one side) */
  flying(team?: number): number { let c = 0; for (let i = 0; i < this.n; i++) if (this.st[i] === OUT && (team === undefined || this.squads[this.sq[i]].team === team)) c++; return c; }
  /** slots in a given state (tests / harness) */
  count(state: 'hangar' | 'prep' | 'out' | 'lost' | 'gone'): number {
    const k = { hangar: HANGAR, prep: PREP, out: OUT, lost: LOST, gone: GONE }[state];
    let c = 0; for (let i = 0; i < this.n; i++) if (this.st[i] === k) c++; return c;
  }

  // ------------------------------------------------------------ tick
  update() {
    const w = this.w, dt = w.dt;
    // air control: a carrier's squadrons decide together (≈3 Hz), then the control limit picks the missions
    for (const wg of this.wings) {
      wg.think -= dt;
      if (wg.think > 0) continue;
      wg.think += THINK;
      let live = false;
      for (const sq of wg.squads) if (!sq.done) { this.think(sq); live = true; }
      if (live) this.assign(wg);
    }
    for (const sq of this.squads) if (!sq.done) this.hangar(sq, dt);
    for (let i = 0; i < this.n; i++) if (this.st[i] === OUT) this.fly(i, dt);
    this.buildGrid();
  }

  /** squadron decision (≈3 Hz): carrier state, task, strike target, launch permission */
  private think(sq: Squad) {
    const w = this.w, c = sq.ship, cs = sq.cs;
    if (c.state === 'escaped' || w.sides[sq.team]?.out) { this.dropAll(sq); return; }
    if (c.state !== 'alive' && !sq.orphan) {
      // the carrier is lost: craft aboard go with it, craft in the air fight on for their sortie, then leave
      sq.orphan = true;
      for (let i = sq.first; i < sq.first + cs.n; i++) if (this.st[i] !== OUT) this.st[i] = GONE;
    }
    if (!sq.orphan) { sq.ax = c.pos.x; sq.ay = c.pos.y; sq.az = c.pos.z; }
    const R = cs.radius;
    let air = 0;
    sq.muns.length = 0;
    if (cs.role !== 'bomber') {
      air = this.enemyCraftNear(sq.team, sq.ax, sq.az, R * 0.6);
      if (cs.role === 'interceptor') {
        const r2 = (R * 0.6) ** 2;
        for (const mu of w.munitions) {
          if (mu.dead || mu.kind === 'shell' || !w.hostile(sq.team, mu.team)) continue;
          const dx = mu.pos.x - sq.ax, dz = mu.pos.z - sq.az;
          if (dx * dx + dz * dz <= r2) sq.muns.push(mu.id);
        }
      }
    }
    sq.guard = -1; sq.prio = 0;
    sq.capThreat = cs.role !== 'bomber' && this.enemyCraftNear(sq.team, sq.ax, sq.az, CAP_R) > 0;
    const threat = air + sq.muns.length;
    if (cs.role !== 'bomber' && threat > 0) { sq.task = AIR; sq.tgtShip = -1; sq.prio = 4 + Math.min(3, threat / 4); return; }
    // fighters and interceptors cover a friendly ship that enemy craft are going for
    if (cs.role !== 'bomber' && !sq.orphan) {
      const g = this.threatenedFriend(sq, R);
      if (g >= 0) { sq.task = ESCORT; sq.guard = g; sq.tgtShip = -1; sq.prio = 3; return; }
    }
    if (cs.role === 'interceptor') { sq.task = CAP; sq.tgtShip = -1; return; }
    sq.tgtShip = this.pickShip(sq, R);
    if (sq.tgtShip < 0) { sq.task = CAP; return; }
    sq.task = STRIKE;
    const t = w.shipById.get(sq.tgtShip)!;
    sq.prio = cs.role === 'bomber' ? (t.role === 'line' ? 2.5 : 2) : 1;
  }

  /** P16.3 air control: the `control` highest-priority missions stand, the rest fly CAP. A lost carrier
   *  directs nothing: its orphaned squadrons keep their own decisions. Then launch permission. */
  private assign(wg: Wing) {
    const ctl = wg.ship.state === 'alive';
    if (ctl) {
      const missions = wg.squads.filter(sq => !sq.done && !sq.orphan && sq.task !== CAP).sort((a, b) => b.prio - a.prio || a.idx - b.idx);
      for (const sq of wg.squads) sq.heldNow = false;
      for (let k = wg.control; k < missions.length; k++) { const sq = missions[k]; sq.task = CAP; sq.tgtShip = -1; sq.guard = -1; sq.stats.held++; sq.heldNow = true; }
    }
    for (const sq of wg.squads) {
      if (sq.done) continue;
      sq.stats.tasks[sq.task]++;
      sq.engaged = sq.task !== CAP || sq.capThreat || this.enemyShipWithin(sq, sq.cs.radius * 1.1);
    }
  }

  /** a friendly ship (not the carrier) inside the operating radius that enemy craft are attacking: the most valuable */
  private threatenedFriend(sq: Squad, R: number): number {
    const w = this.w, R2 = R * R;
    let best = -1, bv = 0;
    for (const f of w.ships) {
      if (f === sq.ship || f.team !== sq.team || f.state !== 'alive') continue;
      const dx = f.pos.x - sq.ax, dz = f.pos.z - sq.az;
      if (dx * dx + dz * dz > R2 || f.value <= bv) continue;
      if (this.enemyCraftNear(sq.team, f.pos.x, f.pos.z, 700) > 0) { bv = f.value; best = f.id; }
    }
    return best;
  }

  private pickShip(sq: Squad, R: number): number {
    const w = this.w, bomber = sq.cs.role === 'bomber';
    const R2 = R * R;
    const near = (t: Ship) => { const dx = t.pos.x - sq.ax, dy = t.pos.y - sq.ay, dz = t.pos.z - sq.az; return dx * dx + dy * dy + dz * dz; };
    // the commander's target first (the carrier's own target), when in reach and worth this squadron's weapons
    if (!sq.orphan) {
      const pri = w.shipById.get(sq.ship.ai.targetId);
      if (pri && pri.state === 'alive' && w.hostile(sq.team, pri.team) && near(pri) <= R2 && !(bomber && pri.role === 'raider')) return pri.id;
    } else {
      const cur = w.shipById.get(sq.tgtShip);
      if (cur && cur.state === 'alive' && near(cur) <= R2 * 1.4) return cur.id;
    }
    let best = -1, bs = 0;
    for (const t of w.ships) {
      if (t.state !== 'alive' || !w.hostile(sq.team, t.team)) continue;
      const d2 = near(t);
      if (d2 > R2) continue;
      const k = bomber ? (t.role === 'line' ? 3 : t.role === 'escort' ? 1.2 : 0.3) : (t.role === 'raider' ? 1.5 : t.role === 'escort' ? 1.3 : 1);
      const sc = k * (1 + t.value / 600) / (Math.sqrt(d2) + 400);
      if (sc > bs) { bs = sc; best = t.id; }
    }
    return best;
  }

  private enemyShipWithin(sq: Squad, R: number): boolean {
    const w = this.w, R2 = R * R;
    for (const t of w.ships) {
      if (t.state !== 'alive' || !w.hostile(sq.team, t.team)) continue;
      const dx = t.pos.x - sq.ax, dy = t.pos.y - sq.ay, dz = t.pos.z - sq.az;
      if (dx * dx + dy * dy + dz * dz <= R2) return true;
    }
    return false;
  }

  /** readying, re-arming and launching */
  private hangar(sq: Squad, dt: number) {
    const cs = sq.cs, c = sq.ship;
    let free = -1;
    for (let i = sq.first; i < sq.first + cs.n; i++) {
      if (this.st[i] === PREP) { this.timer[i] -= dt; if (this.timer[i] <= 0) { this.st[i] = HANGAR; this.ordL[i] = 1; } }
      if (free < 0 && this.st[i] === HANGAR) free = i;
    }
    // a disabled mount (critical hit) neither launches nor recovers
    if (sq.orphan || c.state !== 'alive' || sq.mount.disabled > 0) return;
    if (sq.launchT > 0) sq.launchT -= dt;
    if (!sq.engaged || free < 0 || sq.launchT > 0) return;
    sq.launchT = cs.launch;
    this.launch(free, sq);
  }

  private launch(i: number, sq: Squad) {
    const c = sq.ship, cs = sq.cs, m = sq.mount;
    const p = localToWorld({ x: m.def.pos[0], y: m.def.pos[1], z: m.def.pos[2] }, c.pos, c.yaw, c.pitch, tv);
    // leave along the carrier's heading, climbing out to the mount's side
    const out = localToWorld(m.facingLocal, tv3.set(0, 0, 0), c.yaw, c.pitch, tv2);
    let dx = c.fwd.x * 0.7 + out.x * 0.5, dy = 0.35, dz = c.fwd.z * 0.7 + out.z * 0.5;
    const l = Math.hypot(dx, dy, dz) || 1; dx /= l; dy /= l; dz /= l;
    const v0 = cs.speed * 0.6;
    this.px[i] = p.x; this.py[i] = p.y; this.pz[i] = p.z;
    this.vx[i] = dx * v0 + c.vel.x; this.vy[i] = dy * v0 + c.vel.y; this.vz[i] = dz * v0 + c.vel.z;
    this.hp[i] = cs.hp; this.timer[i] = cs.sortie; this.cool[i] = cs.gun ? cs.gun.reload * ((i - sq.first) % 4) * 0.25 : 0;
    this.rt[i] = 0; this.mode[i] = APPROACH; this.tk[i] = T_NONE; this.tgt[i] = -1;
    this.st[i] = OUT;
    this.gen[i]++;
    this.uid[i] = this.gen[i] * SLOT_BITS + i;
    sq.stats.launched++;
    this.w.events.push({ t: 'craftLaunch', ship: c.id, mount: m.index, pos: p.clone() });
  }

  // ------------------------------------------------------------ flight
  private fly(i: number, dt: number) {
    const w = this.w, sq = this.squads[this.sq[i]], cs = sq.cs, c = sq.ship;
    this.timer[i] -= dt;
    this.cool[i] -= dt;
    if (this.timer[i] <= 0 && this.mode[i] !== RETURN) this.mode[i] = RETURN;
    // bombers go back to re-arm once their ordnance is away
    if (sq.ord && !this.ordL[i] && this.mode[i] !== RETURN) this.mode[i] = RETURN;
    if (this.mode[i] === RETURN && sq.orphan) { this.leave(i, sq); return; }
    const x = this.px[i], y = this.py[i], z = this.pz[i];
    let gx = 0, gy = 0, gz = 0, speed = cs.speed;
    if (this.mode[i] === RETURN) {
      gx = c.pos.x; gy = c.pos.y; gz = c.pos.z;
      const d = Math.hypot(gx - x, gy - y, gz - z);
      if (d < c.radius + c.halfLen + 25) {
        if (sq.mount.disabled <= 0) { this.recover(i, sq); return; }
        // the deck is out of action: hold close by
        const a = w.time * 0.6 + (i - sq.first) * 2.4;
        gx += Math.cos(a) * (c.halfLen + 60); gz += Math.sin(a) * (c.halfLen + 60); gy += 30;
      }
      if (d < 300) speed = Math.max(cs.speed * 0.5, Math.min(cs.speed, d));
    } else if (sq.task === AIR || sq.task === ESCORT || (sq.task === CAP && sq.capThreat) || this.tk[i] !== T_NONE) {
      // air combat: each craft follows its own target (craft, or for interceptors a guided round)
      this.rt[i] -= dt;
      if (this.rt[i] <= 0 || !this.validAir(i)) { this.pickAir(i, sq); this.rt[i] = 0.6; }
      if (this.tk[i] === T_CRAFT) {
        const j = this.tgt[i] % SLOT_BITS;
        const d = Math.hypot(this.px[j] - x, this.py[j] - y, this.pz[j] - z);
        const lead = d / (cs.speed * 1.6);
        gx = this.px[j] + this.vx[j] * lead; gy = this.py[j] + this.vy[j] * lead; gz = this.pz[j] + this.vz[j] * lead;
        if (sq.gun && d < sq.gun.range && this.cool[i] <= 0 && this.aligned(i, this.px[j] - x, this.py[j] - y, this.pz[j] - z, d, 0.3)) this.gunCraft(i, sq, j, d);
      } else if (this.tk[i] === T_MUN) {
        const mu = w.munitionById.get(this.tgt[i])!;
        const d = Math.hypot(mu.pos.x - x, mu.pos.y - y, mu.pos.z - z);
        const lead = d / (cs.speed * 1.6);
        gx = mu.pos.x + mu.vel.x * lead; gy = mu.pos.y + mu.vel.y * lead; gz = mu.pos.z + mu.vel.z * lead;
        if (sq.gun && d < sq.gun.range && this.cool[i] <= 0 && this.aligned(i, mu.pos.x - x, mu.pos.y - y, mu.pos.z - z, d, 0.35)) this.gunMunition(i, sq, mu.id, d);
      } else { this.orbit(i, sq); gx = tv.x; gy = tv.y; gz = tv.z; }
    } else if (sq.task === STRIKE && w.shipById.get(sq.tgtShip)?.state === 'alive') {
      const t = w.shipById.get(sq.tgtShip)!;
      const ex = t.pos.x - x, ey = t.pos.y - y, ez = t.pos.z - z;
      const d = Math.hypot(ex, ey, ez);
      if (this.mode[i] === EXTEND) {
        // run out past the target, then come round again
        this.rt[i] -= dt;
        const l = Math.hypot(this.vx[i], this.vy[i], this.vz[i]) || 1;
        gx = x + this.vx[i] / l * 200 - ex / (d || 1) * 80; gy = y + 20; gz = z + this.vz[i] / l * 200 - ez / (d || 1) * 80;
        if (this.rt[i] <= 0) this.mode[i] = APPROACH;
      } else {
        // approach from a spread of bearings so a squadron does not fly in single file
        const k = i - sq.first, a = k * 2.39996, off = d > 350 ? 60 + (k % 4) * 25 : 0;
        gx = t.pos.x + t.vel.x * (d / cs.speed) * 0.5 + Math.cos(a) * off;
        gy = t.pos.y + ((k % 3) - 1) * off * 0.4;
        gz = t.pos.z + t.vel.z * (d / cs.speed) * 0.5 + Math.sin(a) * off;
        if (sq.gun && d < sq.gun.range && this.cool[i] <= 0 && this.aligned(i, ex, ey, ez, d, 0.35)) this.gunShip(i, sq, t, d, ex, ey, ez);
        if (sq.ord && this.ordL[i] && d < sq.ord.range * 0.55 && this.aligned(i, ex, ey, ez, d, 0.5)) this.dropOrdnance(i, sq, t, ex, ey, ez, d);
        if (this.st[i] !== OUT) return;
        if (d < t.radius + t.halfLen * 0.5 + 40) { this.mode[i] = EXTEND; this.rt[i] = 2.2; }
      }
    } else {
      this.orbit(i, sq); gx = tv.x; gy = tv.y; gz = tv.z;
    }
    // operating radius: never beyond it from the carrier
    if (!sq.orphan && this.mode[i] !== RETURN) {
      const ax = x - sq.ax, az = z - sq.az;
      if (ax * ax + az * az > (cs.radius * 1.1) ** 2) { gx = sq.ax; gy = sq.ay; gz = sq.az; this.tk[i] = T_NONE; }
    }
    this.steer(i, gx - x, gy - y, gz - z, cs.agility * dt, speed, dt);
  }

  private orbit(i: number, sq: Squad) {
    const k = i - sq.first;
    // CAP circles the carrier; an escort circles the ship it covers
    const g = sq.task === ESCORT ? this.w.shipById.get(sq.guard) : undefined;
    const c = g && g.state === 'alive' ? g : sq.ship;
    const cx = c === sq.ship ? sq.ax : c.pos.x, cy = c === sq.ship ? sq.ay : c.pos.y, cz = c === sq.ship ? sq.az : c.pos.z;
    const r = c.radius * 4 + 140 + (k % 3) * 30;
    const a = this.w.time * 0.35 + k * 2.39996;
    tv.set(cx + Math.cos(a) * r, cy + 40 + (k % 3) * 15, cz + Math.sin(a) * r);
  }

  /** turn toward (dx,dy,dz) by at most maxTurn radians and move */
  private steer(i: number, dx: number, dy: number, dz: number, maxTurn: number, speed: number, dt: number) {
    let vx = this.vx[i], vy = this.vy[i], vz = this.vz[i];
    const sp = Math.hypot(vx, vy, vz) || 1;
    vx /= sp; vy /= sp; vz /= sp;
    const dl = Math.hypot(dx, dy, dz);
    if (dl > 1e-6) {
      dx /= dl; dy /= dl; dz /= dl;
      const cos = Math.max(-1, Math.min(1, vx * dx + vy * dy + vz * dz));
      const ang = Math.acos(cos);
      if (ang <= maxTurn) { vx = dx; vy = dy; vz = dz; }
      else if (ang > 1e-6) {
        const s = Math.sin(ang), t = maxTurn / ang;
        const w1 = Math.sin((1 - t) * ang) / s, w2 = Math.sin(t * ang) / s;
        vx = vx * w1 + dx * w2; vy = vy * w1 + dy * w2; vz = vz * w1 + dz * w2;
        const l = Math.hypot(vx, vy, vz) || 1; vx /= l; vy /= l; vz /= l;
      }
    }
    // accelerate / slow toward the wanted speed
    const ns = sp + Math.max(-speed * 0.8 * dt, Math.min(speed * 0.8 * dt, speed - sp));
    this.vx[i] = vx * ns; this.vy[i] = vy * ns; this.vz[i] = vz * ns;
    this.px[i] += this.vx[i] * dt; this.py[i] += this.vy[i] * dt; this.pz[i] += this.vz[i] * dt;
  }

  private aligned(i: number, dx: number, dy: number, dz: number, d: number, cone: number): boolean {
    const sp = Math.hypot(this.vx[i], this.vy[i], this.vz[i]);
    if (sp < 1e-6 || d < 1e-6) return false;
    return (this.vx[i] * dx + this.vy[i] * dy + this.vz[i] * dz) / (sp * d) >= Math.cos(cone);
  }

  private validAir(i: number): boolean {
    if (this.tk[i] === T_CRAFT) return this.alive(this.tgt[i]);
    if (this.tk[i] === T_MUN) { const mu = this.w.munitionById.get(this.tgt[i]); return !!mu && !mu.dead; }
    return false;
  }

  /** nearest enemy craft near this one (fighters, interceptors); interceptors also take guided rounds */
  private pickAir(i: number, sq: Squad) {
    const w = this.w, x = this.px[i], z = this.pz[i];
    this.tk[i] = T_NONE; this.tgt[i] = -1;
    if (sq.task === STRIKE || (sq.task === CAP && !sq.capThreat)) return;
    // CAP fights only over its carrier, an escort only near the ship it covers
    const g = sq.task === ESCORT ? w.shipById.get(sq.guard) : undefined;
    const zone = sq.task === CAP ? { x: sq.ax, z: sq.az, r2: (CAP_R * 1.3) ** 2 } : g && g.state === 'alive' ? { x: g.pos.x, z: g.pos.z, r2: 1000 * 1000 } : null;
    let best = -1, bd = 900 * 900;
    this.eachNear(x, z, 900, j => {
      const o = this.squads[this.sq[j]];
      if (!w.hostile(sq.team, o.team)) return;
      if (zone && (this.px[j] - zone.x) ** 2 + (this.pz[j] - zone.z) ** 2 > zone.r2) return;
      const dx = this.px[j] - x, dy = this.py[j] - this.py[i], dz = this.pz[j] - z;
      let d2 = dx * dx + dy * dy + dz * dz;
      // interceptors go for bombers carrying ordnance first
      if (sq.cs.role === 'interceptor' && o.ord && this.ordL[j]) d2 *= 0.4;
      if (d2 < bd) { bd = d2; best = j; }
    });
    if (best >= 0) { this.tk[i] = T_CRAFT; this.tgt[i] = this.uid[best]; return; }
    if (sq.cs.role === 'interceptor' && sq.task === AIR) {
      let bm = -1, bdm = Infinity;
      for (const id of sq.muns) {
        const mu = w.munitionById.get(id);
        if (!mu || mu.dead) continue;
        const d2 = (mu.pos.x - x) ** 2 + (mu.pos.y - this.py[i]) ** 2 + (mu.pos.z - z) ** 2;
        if (d2 < bdm) { bdm = d2; bm = id; }
      }
      if (bm >= 0) { this.tk[i] = T_MUN; this.tgt[i] = bm; }
    }
  }

  // ------------------------------------------------------------ weapons
  /** instant gun hit on a ship: through the ordinary hit rules (armour facing, penetration, structure, crits) */
  private gunShip(i: number, sq: Squad, t: Ship, d: number, ex: number, ey: number, ez: number) {
    const w = this.w, g = sq.gun!;
    this.cool[i] = g.reload;
    const size = t.role === 'raider' ? 0.6 : t.role === 'escort' ? 0.85 : 1;
    const p = Math.max(0.15, 0.9 - 0.45 * d / g.range) * size * (1 - Math.min(0.5, t.evasion ?? 0));
    if (!w.rng.chance(p)) return;
    const dir = tv2.set(ex / d, ey / d, ez / d);
    w.applyHit(t, g, sq.ship.id, tv3.set(t.pos.x - dir.x * t.radius, t.pos.y - dir.y * t.radius, t.pos.z - dir.z * t.radius), dir, 'craft');
  }

  private gunCraft(i: number, sq: Squad, j: number, d: number) {
    const w = this.w, g = sq.gun!, o = this.squads[this.sq[j]];
    this.cool[i] = g.reload;
    const p = 0.55 * (1 - 0.5 * d / g.range) / (1 + o.cs.agility * 0.3);
    if (!w.rng.chance(p)) return;
    this.hp[j] -= g.damage;
    if (this.hp[j] <= 0) this.down(j, sq.ship.id);
  }

  private gunMunition(i: number, sq: Squad, id: number, d: number) {
    const w = this.w, g = sq.gun!;
    this.cool[i] = g.reload;
    const mu = w.munitionById.get(id)!;
    if (!w.rng.chance(0.5 * (1 - 0.5 * d / g.range))) return;
    mu.hp--;
    if (mu.hp <= 0 && !mu.dead) {
      mu.dead = true;
      sq.ship.stats.intercepts++;
      w.events.push({ t: 'intercept', pos: mu.pos.clone(), kind: mu.kind, by: sq.ship.id });
    }
  }

  private dropOrdnance(i: number, sq: Squad, t: Ship, ex: number, ey: number, ez: number, d: number) {
    this.ordL[i] = 0;
    sq.stats.ordFired++;
    tv.set(this.px[i], this.py[i], this.pz[i]);
    tv2.set(ex / d, ey / d, ez / d);
    this.w.craftMunition(sq.ship, sq.mount, sq.ord!, tv, tv2, t.id);
  }

  // ------------------------------------------------------------ point defence (ship → craft)
  /** best craft for a ship's point-defence mount: -1 when none in range and arc. Score in the scale of
   *  World.chooseMountTarget's munition score (−distance + threat). */
  pdPick(s: Ship, muzzle: Vec3, range: number, inArc: (p: Vec3) => boolean): number {
    const w = this.w;
    let best = -1, bs = -Infinity;
    const r2 = range * range;
    this.eachNear(muzzle.x, muzzle.z, range, j => {
      const o = this.squads[this.sq[j]];
      if (!w.hostile(s.team, o.team)) return;
      const dx = this.px[j] - muzzle.x, dy = this.py[j] - muzzle.y, dz = this.pz[j] - muzzle.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > r2) return;
      const d = Math.sqrt(d2);
      let sc = -d;
      if (o.ord && this.ordL[j]) sc += 150;
      if (o.tgtShip === s.id) sc += 100;
      if (sc <= bs) return;
      if (!inArc(this.pos.set(this.px[j], this.py[j], this.pz[j]))) return;
      bs = sc; best = j;
    });
    this.pickScore = bs;
    return best >= 0 ? this.uid[best] : -1;
  }

  /** one point-defence shot at a craft (hit chance falls with the craft's agility) */
  pdShoot(s: Ship, m: Mount, muzzle: Vec3, uid: number) {
    const w = this.w, j = uid % SLOT_BITS, o = this.squads[this.sq[j]];
    let chance = (m.weapon.pdChance ?? 0.05) * 2.4 * s.pdBonus / (1 + o.cs.agility * 0.25);
    if (s.jamUntil !== undefined && s.jamUntil > w.time) chance *= 0.55;
    const hit = w.rng.chance(chance);
    const to = new Vec3(this.px[j], this.py[j], this.pz[j]);
    if (!hit) to.add(new Vec3(w.rng.range(-6, 6), w.rng.range(-6, 6), w.rng.range(-6, 6)));
    w.events.push({ t: 'pd', ship: s.id, mount: m.index, from: muzzle.clone(), to, hit });
    if (!hit) return;
    this.hp[j] -= m.weapon.damage;
    if (this.hp[j] <= 0) { this.pdKills[s.team] = (this.pdKills[s.team] ?? 0) + 1; this.down(j, s.id); }
  }

  // ------------------------------------------------------------ losses, recovery, leaving
  private down(j: number, by: number) {
    const sq = this.squads[this.sq[j]];
    this.st[j] = LOST;
    sq.stats.lost++;
    this.w.events.push({ t: 'craftDown', team: sq.team, pos: new Vec3(this.px[j], this.py[j], this.pz[j]), by });
    // a spare airframe is readied in the hangar (per battle only)
    if (!sq.orphan && sq.ship.state === 'alive' && sq.spares > 0) { sq.spares--; this.st[j] = PREP; this.timer[j] = sq.cs.turnaround; }
  }

  private recover(i: number, sq: Squad) {
    this.st[i] = PREP; this.timer[i] = sq.cs.turnaround; sq.stats.recovered++;
  }

  private leave(i: number, sq: Squad) {
    this.st[i] = GONE; sq.stats.left++;
    this.w.events.push({ t: 'craftLeave', ship: sq.ship.id, pos: new Vec3(this.px[i], this.py[i], this.pz[i]) });
  }

  /** the carrier escaped or its side left the battle: its squadron goes with it */
  private dropAll(sq: Squad) {
    for (let i = sq.first; i < sq.first + sq.cs.n; i++) { if (this.st[i] === OUT) this.leave(i, sq); else this.st[i] = GONE; }
    sq.done = true;
  }

  /** P16.4 (display only): a squadron's airframes by state — airborne, on deck (ready or re-arming), lost, spares left */
  squadCounts(sq: Squad): { out: number; deck: number; lost: number; spares: number } {
    let out = 0, deck = 0;
    for (let i = sq.first; i < sq.first + sq.cs.n; i++) { const s = this.st[i]; if (s === OUT) out++; else if (s === HANGAR || s === PREP) deck++; }
    return { out, deck, lost: sq.stats.lost, spares: sq.spares };
  }

  // ------------------------------------------------------------ grid
  private buildGrid() {
    const cs = this.cellStart;
    cs.fill(0);
    for (let i = 0; i < this.n; i++) {
      if (this.st[i] !== OUT) { this.cellOf[i] = -1; continue; }
      const c = this.cellIdx(this.px[i], this.pz[i]);
      this.cellOf[i] = c; cs[c + 1]++;
    }
    for (let c = 0; c < GN * GN; c++) cs[c + 1] += cs[c];
    const fill = this.cellStartTmp ??= new Int32Array(GN * GN);
    fill.set(cs.subarray(0, GN * GN));
    for (let i = 0; i < this.n; i++) { const c = this.cellOf[i]; if (c >= 0) this.cellItems[fill[c]++] = i; }
  }
  private cellStartTmp: Int32Array | null = null;
  private cellIdx(x: number, z: number): number {
    const cx = Math.max(0, Math.min(GN - 1, Math.floor((x + GHALF) / CELL)));
    const cz = Math.max(0, Math.min(GN - 1, Math.floor((z + GHALF) / CELL)));
    return cz * GN + cx;
  }
  /** every flying craft in the grid cells within r of (x, z) (callers check the exact distance) */
  private eachNear(x: number, z: number, r: number, fn: (j: number) => void) {
    const x0 = Math.max(0, Math.floor((x - r + GHALF) / CELL)), x1 = Math.min(GN - 1, Math.floor((x + r + GHALF) / CELL));
    const z0 = Math.max(0, Math.floor((z - r + GHALF) / CELL)), z1 = Math.min(GN - 1, Math.floor((z + r + GHALF) / CELL));
    const cs = this.cellStart, it = this.cellItems;
    for (let cz = z0; cz <= z1; cz++) for (let cx = x0; cx <= x1; cx++) {
      const c = cz * GN + cx;
      for (let k = cs[c]; k < cs[c + 1]; k++) { const j = it[k]; if (this.st[j] === OUT) fn(j); }
    }
  }
  private enemyCraftNear(team: number, x: number, z: number, r: number): number {
    let n = 0; const r2 = r * r;
    this.eachNear(x, z, r, j => {
      if (!this.w.hostile(team, this.squads[this.sq[j]].team)) return;
      const dx = this.px[j] - x, dz = this.pz[j] - z;
      if (dx * dx + dz * dz <= r2) n++;
    });
    return n;
  }

  /** state folded into World.digest */
  digest(mix: (v: number) => void) {
    let out = 0;
    for (let i = 0; i < this.n; i++) {
      mix(this.st[i]);
      if (this.st[i] === OUT) { out++; mix(this.px[i]); mix(this.py[i]); mix(this.pz[i]); mix(this.hp[i]); }
    }
    for (const sq of this.squads) mix(sq.spares);
    mix(out);
  }
}


// P17.3 weapon-mechanism effects (sim/mech17.ts events). Display only: it reads the battle and its events and
// never writes to either; all randomness here is Math.random (the battle's own RNG is never touched), so a
// replay looks the same in outcome whatever this draws. Pooled particle / trail / ring systems of the battle
// view are reused — nothing here allocates meshes.
import * as THREE from 'three';
import { WEAPONS } from '../sim/data/weapons';
import { localToWorld, Vec3 } from '../sim/math';
import type { Munition, SimEvent } from '../sim/types';
import type { World } from '../sim/world';
import type { ParticleSystem, Shockwaves, FlashLights, Debris } from './effects';

/** what the effects need from the battle view */
export interface Mech17Host {
  readonly glow: ParticleSystem; readonly smoke: ParticleSystem; readonly rings: Shockwaves; readonly flashes: FlashLights; readonly debris: Debris;
  beam(a: THREE.Vector3, b: THREE.Vector3, life: number, w: number, color: number): void;
  shake(p: THREE.Vector3, amount: number, range?: number): void;
  audio: { play(name: string, pos: THREE.Vector3 | null, vol?: number, rate?: number): void } | null;
  /** drawn distance from a mount point to its muzzle (P17.3.1; 0 = unknown) */
  muzzleLen(ship: number, mount: number): number;
}

const V = (v: { x: number; y: number; z: number }) => new THREE.Vector3(v.x, v.y, v.z);
const rnd = (k = 1) => new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(2 * k);
const colOf = (weapon: string, d = 0xffd090) => WEAPONS[weapon]?.vis?.color ?? d;

interface Charge { ship: number; mount: number; t0: number; dur: number; col: number; ring: number }
/** a held beam (P17.3.1): last pulse, so the beam's end can be drawn when the pulses stop */
interface Held { from: THREE.Vector3; to: THREE.Vector3; last: number; tick: number; wid: number; col: number }
/** one hop of a chain arc, drawn after the hop before it (P17.3.1: the jumps read in order) */
interface Hop { at: number; a: THREE.Vector3; b: THREE.Vector3; col: number; n: number }

export class Mech17Fx {
  private charges: Charge[] = [];
  private held = new Map<string, Held>();
  private hops: Hop[] = [];
  private lastHop: { to: THREE.Vector3; at: number; n: number } | null = null;
  private clock = 0;
  private ringAt = new Map<number, number>();
  private tmp = new Vec3();
  /** the muzzle of a mount: the drawn barrel end along `dir` from the sim's mount point */
  private muzzle(ship: number, mount: number, p: THREE.Vector3, dir: THREE.Vector3, fallback = 0): THREE.Vector3 {
    const l = this.h.muzzleLen(ship, mount);
    return p.addScaledVector(dir, l > 0.3 ? l : fallback);
  }
  constructor(private h: Mech17Host, private world: () => World | null) {}

  /** a P17.3 event (returns false for any other event) */
  handle(e: SimEvent): boolean {
    const h = this.h;
    switch (e.t) {
      case 'split': {
        // the container opens: flash, ring, two shell halves, a cone of sparks — one per child
        const p = V(e.pos), d = V(e.dir);
        h.glow.emit(p, { life: 0.22, size: 24, size1: 40, color: 0xfff0d0, alpha: 1.4 });
        h.rings.spawn(p, 34, 0.45, 0xffc890, d);
        h.flashes.flash(p, 55, 320, 0.25, 0xffc080);
        for (let i = 0; i < e.n; i++) h.glow.emit(p, { life: 0.35 + Math.random() * 0.25, size: 3, size1: 0.8, color: 0xffe2b0, color1: 0xff6020, vel: d.clone().multiplyScalar(120).add(rnd(70)), drag: 3 });
        const side = new THREE.Vector3().crossVectors(d, new THREE.Vector3(0, 1, 0)).normalize();
        for (const s of [-1, 1]) h.debris.spawn(p, side.clone().multiplyScalar(40 * s).addScaledVector(d, 60).add(rnd(10)), 1.4, 4, 0.6);
        h.smoke.emit(p, { life: 2.2, size: 6, size1: 20, color: 0x5a5450, alpha: 0.35, drag: 1 });
        h.audio?.play('missile', p, 0.9, 0.7);
        h.shake(p, 0.25, 900);
        return true;
      }
      case 'stage': {
        // booster drop: the spent stage tumbles back trailing smoke, the sprint motor lights hot white
        const p = V(e.pos), d = V(e.dir);
        h.debris.spawn(p, d.clone().multiplyScalar(-40).add(rnd(15)), 0.8, 3, 0.8);
        h.glow.emit(p, { life: 0.18, size: 10, size1: 16, color: 0xffffff, alpha: 1.3 });
        h.rings.spawn(p, 9, 0.25, 0xfff2d8, d);   // second-stage ignition: a tight ring at the nozzle
        for (let i = 0; i < 6; i++) h.smoke.emit(p, { life: 1.6, size: 2, size1: 7, color: 0x8a8480, alpha: 0.3, vel: d.clone().multiplyScalar(-25).add(rnd(12)), drag: 1.2 });
        return true;
      }
      case 'decoy': {
        // flares: bright sparkles shed around the missile (the decoys themselves fly like it, see trails)
        const p = V(e.pos);
        for (let i = 0; i < e.n * 4; i++) h.glow.emit(p, { life: 0.5 + Math.random() * 0.6, size: 3.5, size1: 1, color: 0xfff6d0, color1: 0xff8040, vel: rnd(45), drag: 1.5 });
        h.flashes.flash(p, 18, 120, 0.15, 0xfff0c0);
        h.rings.spawn(p, 12, 0.3, 0xd8c8ff);
        return true;
      }
      case 'charge': {
        this.charges.push({ ship: e.ship, mount: e.mount, t0: this.world()?.time ?? 0, dur: e.dur, col: colOf(e.weapon, 0x9ad8ff), ring: 0 });
        return true;
      }
      case 'chain': {
        // P17.3.1: the hops of one discharge arrive in one sim tick; each later hop (it starts where the last one
        // ended) is queued a beat after it, so the arc visibly jumps ship to ship in order
        const a = V(e.from), b = V(e.to), col = colOf(e.weapon, 0xa0b8ff);
        const chained = this.lastHop && this.lastHop.to.distanceToSquared(a) < 1 && this.clock - this.lastHop.at < 0.6;
        const n = chained ? this.lastHop!.n + 1 : 0;
        const at = this.clock + n * 0.09;
        this.lastHop = { to: b.clone(), at, n };
        if (n === 0) this.arc(a, b, col, 0); else this.hops.push({ at, a, b, col, n });
        return true;
      }
      case 'burst': {
        // a plasma sphere the size of the blast, a ring on its rim, then cooling gas
        const p = V(e.pos), r = e.radius, col = colOf(e.weapon, 0x60ffd0);
        const mine = WEAPONS[e.weapon]?.mech?.mine;
        h.glow.emit(p, { life: 0.3, size: r * 0.7, size1: r * 1.5, color: mine ? 0xffe0c0 : 0xe0fff6, alpha: 1.4 });
        h.glow.emit(p, { life: 0.7, size: r * 0.9, size1: r * 1.2, color: mine ? 0xff6030 : col, color1: 0x103020, alpha: 0.8 });
        h.rings.spawn(p, r * 1.1, 0.5, mine ? 0xff9050 : col);
        h.flashes.flash(p, 30 + r * 0.6, 120 + r * 3, 0.3, mine ? 0xff9050 : col);
        for (let i = 0; i < 10; i++) h.glow.emit(p, { life: 0.5 + Math.random() * 0.5, size: r * 0.12, size1: r * 0.03, color: col, color1: 0x002010, vel: rnd(r * 1.6), drag: 2 });
        h.smoke.emit(p, { life: 3, size: r * 0.4, size1: r * 1.1, color: 0x2a3230, alpha: 0.35, drag: 0.6 });
        h.audio?.play(r >= 80 ? 'hitheavy' : 'hit', p, r >= 80 ? 0.9 : 0.5, 0.7);
        if (r >= 80) h.shake(p, 0.6, 1200);
        return true;
      }
      case 'flak': {
        // a dark burst cloud with a ring of fragments the size of the kill radius
        const p = V(e.pos), r = e.radius;
        h.smoke.emit(p, { life: 1.8, size: r * 0.25, size1: r * 0.8, color: 0x26221e, alpha: 0.55, drag: 1.4 });
        h.glow.emit(p, { life: 0.1, size: r * 0.35, size1: r * 0.6, color: 0xffd8a0, alpha: 1 });
        for (let i = 0; i < 8; i++) h.glow.emit(p, { life: 0.25, size: 1.6, size1: 0.4, color: 0xffc070, vel: rnd(r * 3), drag: 3 });
        if (Math.random() < 0.15) h.audio?.play('pd', p, 0.3, 0.6);
        return true;
      }
      case 'mineArm': {
        // the mine stops at its lay point: a ring the size of its trigger radius shows the danger area
        const p = V(e.pos);
        h.rings.spawn(p, 14, 0.4, 0xff4040);
        h.glow.emit(p, { life: 0.3, size: 6, size1: 2, color: 0xff5050, alpha: 1.2 });
        return true;
      }
      case 'beam': {
        // one pulse of a held beam: a thick core and halo from the muzzle along the turret line; molten sparks
        // where it bites. The beam is remembered so its end (pulses stop) fades out instead of blinking off.
        const b = V(e.to), w = WEAPONS[e.weapon], col = colOf(e.weapon, 0xff70d0);
        const dir = b.clone().sub(V(e.from)).normalize();
        const a = this.muzzle(e.ship, e.mount, V(e.from), dir);
        const tick = w?.mech?.sustain?.tick ?? 0.25;
        const wid = w?.vis?.wid ?? 1, life = tick * 1.4;
        const key = e.ship + ':' + e.mount, first = !this.held.has(key);
        this.held.set(key, { from: a.clone(), to: b.clone(), last: this.world()?.time ?? 0, tick, wid, col });
        // sustain: the core flickers a little each pulse, the emitter glow stays lit
        const f = 0.85 + Math.random() * 0.3;
        h.beam(a, b, life, wid * f, col);
        h.beam(a.clone(), b.clone(), life * 0.8, wid * 0.4 * f, 0xffffff);
        h.glow.emit(a, { life: life, size: wid * 3, size1: wid * 2, color: col, alpha: 1 });
        if (first) { h.glow.emit(a, { life: 0.25, size: wid * 8, size1: wid * 3, color: 0xffffff, alpha: 1.3 }); h.rings.spawn(a, wid * 6, 0.3, col, dir); }
        if (e.hit) {
          h.glow.emit(b, { life: 0.2, size: wid * 5, size1: wid * 8, color: 0xfff0f8, alpha: 1.2 });
          for (let i = 0; i < 3; i++) h.glow.emit(b, { life: 0.4 + Math.random() * 0.4, size: 1.4 + wid, size1: 0.3, color: 0xffb070, color1: 0x601000, vel: rnd(40), drag: 2 });
          if (Math.random() < 0.3) h.smoke.emit(b, { life: 2, size: wid * 3, size1: wid * 9, color: 0x302a28, alpha: 0.35, drag: 0.8 });
        }
        return true;
      }
      case 'fire': {
        // a charged shot leaves: the charge ends, the muzzle flares (the beam itself is the default weapon effect)
        const i = this.charges.findIndex(c => c.ship === e.ship && c.mount === e.mount);
        if (i >= 0) {
          const c = this.charges[i]; this.charges.splice(i, 1);
          const p = this.muzzle(e.ship, e.mount, V(e.pos), V(e.dir), 3);
          h.glow.emit(p, { life: 0.3, size: 26, size1: 8, color: 0xffffff, alpha: 1.6 });
          h.rings.spawn(p, 18, 0.35, c.col, V(e.dir));
          h.flashes.flash(p, 70, 300, 0.3, c.col);
          h.shake(p, 0.7, 1300);
        }
        return false;
      }
    }
    return false;
  }

  /** a jagged arc: a bright core over a wider halo, re-jittered per segment; `n` = hop index (later hops thinner) */
  private arc(a: THREE.Vector3, b: THREE.Vector3, col: number, n: number) {
    const h = this.h, seg = 7, len = a.distanceTo(b), k = Math.pow(0.8, n);
    let prev = a.clone();
    for (let i = 1; i <= seg; i++) {
      const p = a.clone().lerp(b, i / seg);
      if (i < seg) p.add(rnd(len * 0.05));
      h.beam(prev.clone(), p.clone(), 0.2, 0.9 * k, 0xffffff);
      h.beam(prev.clone(), p.clone(), 0.28, 2.2 * k, col);
      prev = p;
    }
    h.glow.emit(a, { life: 0.12, size: 6 * k, size1: 2, color: 0xffffff, alpha: 1.1 });
    h.glow.emit(b, { life: 0.25, size: 10 * k, size1: 18 * k, color: col, alpha: 1.2 });
    if (Math.random() < 0.5) h.audio?.play('rail', b, 0.35 * k, 1.6 + n * 0.1);
  }

  /** per frame: charge build-up on charging mounts, queued arc hops, the end of held beams */
  frame() {
    const w = this.world(); if (!w) return;
    this.clock = performance.now() / 1000;
    for (let i = this.charges.length - 1; i >= 0; i--) {
      const c = this.charges[i];
      const s = w.shipById.get(c.ship), m = s?.mounts[c.mount];
      const k = (w.time - c.t0) / c.dur;
      if (!s || !m || s.state !== 'alive' || k > 1.3 || m.chargeAt === undefined && k > 0.05) { this.charges.splice(i, 1); continue; }
      const p = localToWorld({ x: m.def.pos[0], y: m.def.pos[1], z: m.def.pos[2] }, s.pos, s.yaw, s.pitch, this.tmp);
      const aim = V(m.aim);
      const mp = this.muzzle(c.ship, c.mount, V(p), aim, 3 + m.weapon.caliber * 2);
      const kk = Math.min(1, k), cal = m.weapon.caliber;
      // build-up: the muzzle orb grows and brightens, particles are pulled in faster as the charge fills,
      // contracting rings mark each quarter, and the last moments flicker white
      this.h.glow.emit(mp, { life: 0.06, size: 2 + kk * 10 * cal * 0.5, size1: 1 + kk * 6, color: kk > 0.85 && Math.random() < 0.5 ? 0xffffff : c.col, alpha: 0.6 + kk });
      if (Math.random() < 0.4 + kk * 0.5) {
        const off = rnd(10 + 6 * cal);
        this.h.glow.emit(mp.clone().add(off), { life: 0.3, size: 1.2, size1: 0.3, color: c.col, vel: off.multiplyScalar(-3.3 * (1 + kk)), drag: 0 });
      }
      const q = Math.floor(kk * 4);
      if (q > c.ring && q < 4) { c.ring = q; this.h.rings.spawn(mp, (4 + cal * 3) * (1.4 - kk * 0.6), 0.25, c.col, aim); }
    }
    for (let i = this.hops.length - 1; i >= 0; i--) {
      const hp = this.hops[i];
      if (this.clock < hp.at) continue;
      this.arc(hp.a, hp.b, hp.col, hp.n); this.hops.splice(i, 1);
    }
    for (const [key, b] of this.held) {
      if (w.time - b.last < b.tick * 2.2) continue;
      // the beam is released: a thinning afterimage and the emitter cooling down
      this.h.beam(b.from.clone(), b.to.clone(), 0.35, b.wid * 0.5, b.col);
      this.h.glow.emit(b.from, { life: 0.6, size: b.wid * 3, size1: b.wid * 0.5, color: b.col, color1: 0x200010, alpha: 0.8 });
      this.held.delete(key);
    }
  }

  /** trail style of a P17.3 round (container, child, decoy, mine, sprint stage) — null keeps the ordinary missile trail */
  trail(m: Munition): { col: [number, number, number]; wmul: number; max: number } | null {
    // decoys: thin, pale violet and short so a watching player can tell them from warheads (point defence cannot)
    if (m.decoy) return { col: [1.6, 1.4, 2.6], wmul: 0.35, max: 8 };
    if (m.sub !== undefined) return { col: [2.6, 1.8, 0.9], wmul: 0.45, max: 12 };
    if (m.mine !== undefined) return { col: [2.6, 0.5, 0.4], wmul: 0.8, max: 10 };
    if (m.staged) return { col: [3.0, 2.8, 2.2], wmul: 1.2, max: 36 };
    // a container (mother) round: a heavy, long smoke-orange trail — one big body before it opens
    if (m.weapon.mech?.split) return { col: [2.4, 1.3, 0.6], wmul: 1.9, max: 44 };
    return null;
  }
  /** per-frame extras of a live round: a container's body glow, a decoy's flicker, a mine's state */
  munition(m: Munition, at: THREE.Vector3, time: number) {
    const h = this.h;
    if (m.weapon.mech?.split && !m.done) { if (Math.random() < 0.5) h.glow.emit(at, { life: 0.05, size: 7, size1: 5, color: 0xffd8a0, alpha: 1 }); return; }
    if (m.decoy) { if (Math.random() < 0.5) h.glow.emit(at, { life: 0.05, size: 2.5 + Math.random() * 2, size1: 1, color: 0xe8dcff, alpha: 1 }); return; }
    if (m.mine === undefined) return;
    const x = m.weapon.mech?.mine;
    if (m.mine === 0) { if (Math.random() < 0.4) h.glow.emit(at, { life: 0.05, size: 3, size1: 2, color: 0xffa060, alpha: 1 }); return; }
    const armed = m.age >= (m.armAt ?? 0);
    // waiting mine: green blink while arming; once armed a red blink and a slow pulse ring the size of its trigger radius
    if (Math.sin(time * (armed ? 6 : 3) + m.id) > 0.6) h.glow.emit(at, { life: 0.05, size: 4, size1: 3, color: armed ? 0xff3030 : 0x40ff60, alpha: 1.3 });
    if (armed && x && time - (this.ringAt.get(m.id) ?? -9) > 1.6) {
      if (this.ringAt.size > 256) this.ringAt.clear();
      this.ringAt.set(m.id, time); h.rings.spawn(at, x.trigger, 1.2, 0xff3030);
    }
  }
  /** is the round a container's child (for a smaller intercept pop) */
  static child(m: Munition | undefined): boolean { return !!m && (m.sub !== undefined || !!m.decoy); }
}

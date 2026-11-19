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
}

const V = (v: { x: number; y: number; z: number }) => new THREE.Vector3(v.x, v.y, v.z);
const rnd = (k = 1) => new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(2 * k);
const colOf = (weapon: string, d = 0xffd090) => WEAPONS[weapon]?.vis?.color ?? d;

interface Charge { ship: number; mount: number; t0: number; dur: number; col: number }

export class Mech17Fx {
  private charges: Charge[] = [];
  private tmp = new Vec3();
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
        for (let i = 0; i < 6; i++) h.smoke.emit(p, { life: 1.6, size: 2, size1: 7, color: 0x8a8480, alpha: 0.3, vel: d.clone().multiplyScalar(-25).add(rnd(12)), drag: 1.2 });
        return true;
      }
      case 'decoy': {
        // flares: bright sparkles shed around the missile (the decoys themselves fly like it, see trails)
        const p = V(e.pos);
        for (let i = 0; i < e.n * 4; i++) h.glow.emit(p, { life: 0.5 + Math.random() * 0.6, size: 3.5, size1: 1, color: 0xfff6d0, color1: 0xff8040, vel: rnd(45), drag: 1.5 });
        h.flashes.flash(p, 18, 120, 0.15, 0xfff0c0);
        return true;
      }
      case 'charge': {
        this.charges.push({ ship: e.ship, mount: e.mount, t0: this.world()?.time ?? 0, dur: e.dur, col: colOf(e.weapon, 0x9ad8ff) });
        return true;
      }
      case 'chain': {
        // a jagged arc: a bright core over a wider halo, re-jittered per segment
        const a = V(e.from), b = V(e.to), col = colOf(e.weapon, 0xa0b8ff);
        const seg = 7, len = a.distanceTo(b);
        let prev = a.clone();
        for (let i = 1; i <= seg; i++) {
          const p = a.clone().lerp(b, i / seg);
          if (i < seg) p.add(rnd(len * 0.05));
          h.beam(prev.clone(), p.clone(), 0.2, 0.9, 0xffffff);
          h.beam(prev.clone(), p.clone(), 0.28, 2.2, col);
          prev = p;
        }
        h.glow.emit(b, { life: 0.25, size: 10, size1: 18, color: col, alpha: 1.2 });
        if (Math.random() < 0.5) h.audio?.play('rail', b, 0.35, 1.6);
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
        const p = V(e.pos);
        h.rings.spawn(p, 14, 0.4, 0xff4040);
        h.glow.emit(p, { life: 0.3, size: 6, size1: 2, color: 0xff5050, alpha: 1.2 });
        return true;
      }
      case 'beam': {
        // one pulse of a held beam: a thick core and halo along the turret line; molten sparks where it bites
        const a = V(e.from), b = V(e.to), w = WEAPONS[e.weapon], col = colOf(e.weapon, 0xff70d0);
        const wid = w?.vis?.wid ?? 1, life = (w?.mech?.sustain?.tick ?? 0.25) * 1.4;
        h.beam(a, b, life, wid, col);
        h.beam(a.clone(), b.clone(), life * 0.8, wid * 0.4, 0xffffff);
        h.glow.emit(a, { life: life, size: wid * 3, size1: wid * 2, color: col, alpha: 1 });
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
          const p = V(e.pos);
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

  /** per frame: charge glow on the mounts that are charging */
  frame() {
    const w = this.world(); if (!w) return;
    for (let i = this.charges.length - 1; i >= 0; i--) {
      const c = this.charges[i];
      const s = w.shipById.get(c.ship), m = s?.mounts[c.mount];
      const k = (w.time - c.t0) / c.dur;
      if (!s || !m || s.state !== 'alive' || k > 1.3 || m.chargeAt === undefined && k > 0.05) { this.charges.splice(i, 1); continue; }
      const p = localToWorld({ x: m.def.pos[0], y: m.def.pos[1], z: m.def.pos[2] }, s.pos, s.yaw, s.pitch, this.tmp);
      const mp = V(p).addScaledVector(V(m.aim), 3 + m.weapon.caliber * 2);
      const kk = Math.min(1, k);
      this.h.glow.emit(mp, { life: 0.06, size: 2 + kk * 10 * m.weapon.caliber * 0.5, size1: 1 + kk * 6, color: c.col, alpha: 0.6 + kk });
      // particles drawn in toward the muzzle
      if (Math.random() < 0.6) {
        const off = rnd(10 + 6 * m.weapon.caliber);
        this.h.glow.emit(mp.clone().add(off), { life: 0.3, size: 1.2, size1: 0.3, color: c.col, vel: off.multiplyScalar(-3.3), drag: 0 });
      }
    }
  }

  /** trail style of a P17.3 round (child, decoy, mine) — null keeps the ordinary missile trail */
  trail(m: Munition): { col: [number, number, number]; wmul: number; max: number } | null {
    if (m.sub !== undefined) return { col: [2.6, 1.8, 0.9], wmul: 0.45, max: 12 };
    if (m.mine !== undefined) return { col: [2.6, 0.5, 0.4], wmul: 0.8, max: 10 };
    if (m.staged) return { col: [3.0, 2.8, 2.2], wmul: 1.2, max: 36 };
    return null;
  }
  /** per-frame extras of a live round: a laid mine blinks */
  munition(m: Munition, at: THREE.Vector3, time: number) {
    if (m.mine === 1 && Math.sin(time * 6 + m.id) > 0.6) this.h.glow.emit(at, { life: 0.05, size: 4, size1: 3, color: m.age >= (m.armAt ?? 0) ? 0xff3030 : 0x40ff60, alpha: 1.3 });
  }
}

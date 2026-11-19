// P17.3 weapon mechanisms (WeaponDef.mech). Each one changes what a round physically does in the battle;
// only weapons that carry `mech` reach this file, so every older weapon and every recorded battle without
// them runs exactly as before. All randomness here is the battle's own (World.rng): a replay of the same
// seed and orders makes the same splits, decoys, arcs and bursts. Visuals: render/mech17Fx.ts.
import { Vec3, UP, clamp, localToWorld, angleBetween, worldDirToLocal } from './math';
import { WEAPONS, type WeaponDef } from './data/weapons';
import type { Munition, Mount, Ship } from './types';
import type { World } from './world';

const tA = new Vec3(), tB = new Vec3();

/** a copy of `w` for a derived hit (arc jump, blast falloff, beam pulse): damage scaled, no mechanism */
function scaled(w: WeaponDef, k: number): WeaponDef { return { ...w, damage: w.damage * k, mech: undefined }; }

function push(world: World, mu: Munition) { world.munitions.push(mu); world.munitionById.set(mu.id, mu); }

/** enemy ships (of `team`) alive within r of p */
function near(world: World, team: number, p: Vec3, r: number): Ship[] {
  const out: Ship[] = [];
  for (const s of world.ships) if (s.state === 'alive' && world.hostile(team, s.team) && s.pos.distTo(p) <= r + s.radius) out.push(s);
  return out;
}

// ─────────────────────────────────────────────────────────────── launch
/** at launch (fireMunition): stage / time-on-target / mine set-up on the new round */
export function mechLaunch(world: World, s: Ship, m: Mount, mu: Munition) {
  const x = mu.weapon.mech!;
  if (x.stage) mu.staged = false;
  if (x.tot) {
    // the first round of the salvo plans one arrival time for all of them; each round leaves on its own bearing
    const t = world.shipById.get(mu.targetId);
    if (t && (m.salvoLeft === mu.weapon.salvo - 1 || m.totAt === undefined || m.totAt < world.time)) {
      const d = t.pos.distTo(mu.pos);
      m.totAt = world.time + d / mu.weapon.speed + mu.weapon.salvo * mu.weapon.salvoGap + x.tot.slack;
    }
    mu.tot = m.totAt;
    const k = mu.weapon.salvo - 1 - m.salvoLeft;                     // 0 … salvo-1
    const side = tA.crossVectors(mu.vel.clone().normalize(), UP).normalize();
    const sgn = (k % 2 ? -1 : 1) * (1 + (k >> 1));
    mu.vel.addScaled(side, sgn * x.tot.fan).addScaled(UP, (k % 3 - 1) * x.tot.fan * 0.5);
  }
  if (x.mine) {
    // lay point: a barrier on the target's track, outside its point-defence umbrella — ahead of it if it is
    // moving, otherwise between it and this ship (where it must come to fight)
    const t = world.shipById.get(mu.targetId);
    let p = t ? t.pos.clone().addScaled(t.vel, 8) : mu.pos.clone().addScaled(s.fwd, mu.weapon.range * 0.6);
    if (t && p.distTo(t.pos) < 480) p = t.pos.clone().addScaled(tB.subVectors(s.pos, t.pos).normalize(), Math.min(480, t.pos.distTo(s.pos) * 0.5));
    p.x += world.rng.range(-60, 60); p.z += world.rng.range(-60, 60); p.y += world.rng.range(-15, 15);
    const off = tB.subVectors(p, mu.pos);
    if (off.length() > mu.weapon.range) p.copy(mu.pos).addScaled(off.normalize(), mu.weapon.range);
    mu.minePt = p; mu.mine = 0; mu.targetId = -1;
    mu.life = mu.weapon.range / mu.weapon.speed * 2 + x.mine.life;
  }
}

// ─────────────────────────────────────────────────────────────── in flight
/** before guidance each tick. Returns true when the round is handled here (mine) or gone (split). */
export function mechFlight(world: World, mu: Munition): boolean {
  const x = mu.weapon.mech!, dt = world.dt;
  if (x.mine) return mineStep(world, mu);
  const t = world.shipById.get(mu.targetId);
  const d = t && t.state === 'alive' ? t.pos.distTo(mu.pos) : Infinity;
  if (x.split && !mu.done && (d <= x.split.at || mu.life < 1.2)) { split(world, mu); return true; }
  if (x.decoy && !mu.done && d <= x.decoy.at) {
    mu.done = true;
    for (let i = 0; i < x.decoy.n; i++) {
      const v = mu.vel.clone().add(new Vec3(world.rng.range(-35, 35), world.rng.range(-20, 20), world.rng.range(-35, 35)));
      push(world, { id: world.nextId++, kind: mu.kind, team: mu.team, ownerId: mu.ownerId, weapon: mu.weapon, pos: mu.pos.clone(), prevPos: mu.pos.clone(), vel: v, life: x.decoy.life, targetId: mu.targetId, hp: 1, age: mu.age, dead: false, decoy: true, done: true });
    }
    world.events.push({ t: 'decoy', pos: mu.pos.clone(), n: x.decoy.n });
  }
  if (x.stage && mu.staged === false && d <= x.stage.at) {
    mu.staged = true;
    world.events.push({ t: 'stage', pos: mu.pos.clone(), dir: mu.vel.clone().normalize(), weapon: mu.weapon.id });
  }
  void dt;
  return false;
}

/** top speed of a round this tick (guide()): cruise stage, time-on-target pacing */
export function mechSpeed(world: World, mu: Munition, vmax: number): number {
  const x = mu.weapon.mech!;
  if (x.stage && mu.staged === false) return vmax * x.stage.cruise;
  if (mu.tot !== undefined) {
    const t = world.shipById.get(mu.targetId);
    if (t && t.state === 'alive') {
      const left = mu.tot - world.time;
      return clamp(t.pos.distTo(mu.pos) / Math.max(left, 0.15), vmax * 0.4, vmax);
    }
  }
  return vmax;
}
/** turn multiplier of a round (sprint stage) */
export function mechTurn(mu: Munition): number { return mu.staged ? mu.weapon.mech!.stage!.turn : 1; }

/** the container opens: `n` child munitions, each its own round (own target, guidance, point-defence hit points) */
function split(world: World, mu: Munition) {
  const sp = mu.weapon.mech!.split!;
  const cw = WEAPONS[sp.child];
  mu.dead = true; mu.done = true;
  if (!cw) return;
  const t = world.shipById.get(mu.targetId);
  const pool = t && t.state === 'alive' ? near(world, mu.team, t.pos, sp.radius) : near(world, mu.team, mu.pos, sp.radius);
  if (t && t.state === 'alive' && !pool.includes(t)) pool.unshift(t);
  const dir = mu.vel.clone().normalize();
  const side = new Vec3().crossVectors(dir, UP).normalize();
  const up = new Vec3().crossVectors(side, dir).normalize();
  const speed = Math.max(mu.vel.length(), cw.speed * 0.6);
  for (let i = 0; i < sp.n; i++) {
    // the main target takes about half; the rest spread over the ships around it
    const tgt = pool.length ? (i % 2 === 0 && t && t.state === 'alive' ? t : pool[world.rng.int(pool.length)]) : undefined;
    const a = world.rng.range(0, Math.PI * 2), r = sp.cone * Math.sqrt(world.rng.range(0, 1));
    const v = dir.clone().addScaled(side, Math.cos(a) * r).addScaled(up, Math.sin(a) * r).normalize().scale(speed * world.rng.range(0.85, 1.05));
    push(world, {
      id: world.nextId++, kind: cw.kind === 'torpedo' ? 'torpedo' : 'missile', team: mu.team, ownerId: mu.ownerId, weapon: cw,
      pos: mu.pos.clone(), prevPos: mu.pos.clone(), vel: v, life: cw.range / cw.speed * 1.25, targetId: tgt ? tgt.id : -1,
      hp: cw.munitionHp ?? 1, age: 0.6, dead: false, sub: mu.id, ...(mu.gm ? { gm: mu.gm } : {}),
    });
  }
  world.events.push({ t: 'split', pos: mu.pos.clone(), dir, n: sp.n, weapon: mu.weapon.id });
}

function mineStep(world: World, mu: Munition): boolean {
  const x = mu.weapon.mech!.mine!;
  if (mu.mine === 0) {
    const to = tA.subVectors(mu.minePt!, mu.pos);
    const d = to.length();
    if (d < 12 || mu.age > mu.weapon.range / mu.weapon.speed * 1.6) {
      mu.mine = 1; mu.vel.set(0, 0, 0); mu.armAt = mu.age + x.arm; mu.life = Math.min(mu.life, x.life + x.arm);
      world.events.push({ t: 'mineArm', pos: mu.pos.clone() });
    } else {
      // short boost out of the tube, then straight to the lay point, braking on arrival
      const v = Math.min(mu.weapon.speed, d * 1.5 + 10);
      mu.vel.copy(to.scale(1 / d)).scale(v);
    }
  }
  return true;
}
/** is this mine armed (may it go off)? */
export function mineArmed(mu: Munition): boolean { return mu.mine === 1 && mu.age >= (mu.armAt ?? Infinity); }

// ─────────────────────────────────────────────────────────────── effect
/** an area burst (plasma burst, mine): every enemy ship within `radius` takes the weapon's damage with falloff */
export function blast(world: World, mu: Munition, at: Vec3, radius: number) {
  const w = mu.weapon;
  world.events.push({ t: 'burst', pos: at.clone(), radius, weapon: w.id });
  for (const s of near(world, mu.team, at, radius)) {
    const d = Math.max(0, s.pos.distTo(at) - s.radius);
    const k = clamp(1 - d / radius, 0.25, 1);
    const dir = tB.subVectors(s.pos, at); const n = dir.length();
    const hd = n > 1e-3 ? dir.scale(1 / n).clone() : mu.vel.clone().normalize();
    const hp = at.clone().addScaled(hd, Math.max(0, n - s.radius));
    world.applyHit(s, scaled(w, k), mu.ownerId, hp, hd, 'shell');
  }
}

/** chain arc after a direct hit on `first` */
export function chainArc(world: World, mu: Munition, first: Ship, at: Vec3) {
  const c = mu.weapon.mech!.chain!;
  const seen = new Set<number>([first.id]);
  let from = at.clone(), cur = first, k = 1;
  for (let j = 0; j < c.n; j++) {
    let best: Ship | undefined, bd = c.radius;
    for (const s of world.ships) {
      if (s.state !== 'alive' || seen.has(s.id) || !world.hostile(mu.team, s.team)) continue;
      const d = s.pos.distTo(cur.pos) - s.radius;
      if (d < bd) { bd = d; best = s; }
    }
    if (!best) break;
    k *= c.falloff; seen.add(best.id);
    const dir = tA.subVectors(best.pos, cur.pos).normalize().clone();
    const to = best.pos.clone().addScaled(dir, -best.radius * 0.8);
    world.events.push({ t: 'chain', from, to: to.clone(), weapon: mu.weapon.id });
    world.applyHit(best, scaled(mu.weapon, k), mu.ownerId, to, dir, 'shell');
    from = to; cur = best;
  }
}

/** proximity flak: the burst at `at` may kill every enemy round within its radius (the tracked one is
 *  resolved by the ordinary point-defence roll); returns how many it killed */
export function flakBurst(world: World, s: Ship, w: WeaponDef, at: Vec3, skip: Munition): number {
  const f = w.mech!.flak!;
  let kills = 0;
  for (const o of world.munitions) {
    if (o === skip || o.dead || o.kind === 'shell' || !world.hostile(s.team, o.team)) continue;
    if (o.ghost !== undefined && o.age < o.ghost) continue;
    if (o.pos.distTo(at) > f.radius) continue;
    if (!world.rng.chance(f.p * (o.kind === 'torpedo' ? 0.5 : 1) * (o.staged ? 0.6 : 1))) continue;
    o.hp--;
    if (o.hp <= 0) { o.dead = true; kills++; s.stats.intercepts++; world.events.push({ t: 'intercept', pos: o.pos.clone(), kind: o.kind, by: s.id }); }
  }
  world.events.push({ t: 'flak', pos: at.clone(), radius: f.radius, kills });
  return kills;
}

// ─────────────────────────────────────────────────────────────── mounts
/** charged shot: true while the mount is still charging (it must not fire yet) */
export function chargeHold(world: World, s: Ship, m: Mount): boolean {
  const c = m.weapon.mech!.charge!;
  if (m.chargeAt === undefined) {
    m.chargeAt = world.time + c.time;
    world.events.push({ t: 'charge', ship: s.id, mount: m.index, dur: c.time, weapon: m.weapon.id });
    return true;
  }
  if (world.time < m.chargeAt) return true;
  m.chargeAt = undefined;
  return false;
}

/** sustained beam: one pulse while the beam is held (the mount keeps tracking its target) */
export function beamPulse(world: World, s: Ship, m: Mount, muzzle: Vec3) {
  const w = m.weapon, b = w.mech!.sustain!;
  if (m.beamUntil === undefined) return;
  if (world.time >= m.beamUntil) { m.beamUntil = undefined; return; }
  m.beamTick = (m.beamTick ?? 0) - world.dt;
  if (m.beamTick > 0) return;
  m.beamTick = b.tick;
  const t = world.shipById.get(m.targetId);
  if (!t || t.state !== 'alive') { m.beamUntil = undefined; return; }
  // the beam follows the turret: it lands where the mount points, so a slow turret loses a fast target
  const dist = muzzle.distTo(t.pos);
  if (dist > w.range * 1.05) { m.beamUntil = undefined; return; }
  const local = worldDirToLocal(tA.subVectors(t.pos, muzzle).normalize(), s.yaw, s.pitch, tB);
  if (angleBetween(local, m.facingLocal) > m.def.arc * Math.PI / 180) { m.beamUntil = undefined; return; }
  const err = angleBetween(m.aim, tA);
  const reach = Math.atan2(t.radius + 2, dist);
  const hit = err < reach && world.rng.chance(clamp(1 - w.spread * dist / (t.radius + 4) / Math.max(0.3, s.gunnery), 0.15, 0.97));
  const to = hit ? t.pos.clone().addScaled(tA, -t.radius * 0.7) : muzzle.clone().addScaled(m.aim, dist);
  world.events.push({ t: 'beam', ship: s.id, mount: m.index, from: muzzle.clone(), to: to.clone(), hit, weapon: w.id });
  if (hit) world.applyHit(t, scaled(w, 1), s.id, to, m.aim.clone(), 'shell');
}
export function beamStart(world: World, s: Ship, m: Mount) {
  m.beamUntil = world.time + m.weapon.mech!.sustain!.time; m.beamTick = 0;
  s.stats.shots++;
  void localToWorld;
}

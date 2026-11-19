// P16.7 combat repair (any battle rules; presence-gated). A kind 'repair' mount on a support (R) hardpoint works
// on one friendly ship every `reload` seconds within `range` and its arc. It never fires, never hits an enemy and
// draws no random numbers: a battle without a repair mount never reaches this file (World.repairOn stays false),
// so recorded battles replay exactly as before. docs/P16_7_REPAIR_SHIPS_DESIGN.md §4.
//
// Emergency repair, not maintenance:
//   - hull: at most REPAIR_RULES.cap of a target's maximum hull per battle from repair ships, and at most
//     REPAIR_RULES.total together with its own commanding officer's emergency repair (B-1 regen); and only while
//     the target has not been hit for REPAIR_RULES.noHit seconds (focused fire beats repair);
//   - damage control: every cycle cuts a share of the remaining fire / engine / bridge / weapon-disabled time
//     (a timer is shortened, never erased at once);
//   - only 'alive' ships: a ship that is going down (dying) or gone cannot be repaired;
//   - several rigs on one ship: diminishing returns (REPAIR_RULES.dim), at most maxRepairers at once;
//   - a ship carrying repair rigs repairs others at supportMul (no endless mutual repair), never itself.
// The rest of the damage waits for real repair after the battle (field repair ship or a station).
import { Vec3, clamp, localToWorld, worldDirToLocal, angleBetween } from './math';
import type { World } from './world';
import type { Mount, Ship } from './types';

export const REPAIR_RULES = {
  /** hull share of a target's maximum a battle's repair ships may restore */
  cap: 0.15,
  /** hull share repair ships and the target's own officer emergency repair (B-1) may restore together */
  total: 0.25,
  /** seconds since the target's last hull hit before hull repair works */
  noHit: 3,
  /** a repairer counts as working on a target for this long after its last cycle there */
  window: 6,
  /** efficiency of the 1st, 2nd, 3rd repairer working on the same target */
  dim: [1, 0.5, 0.25],
  maxRepairers: 3,
  /** efficiency on a target that itself carries repair rigs */
  supportMul: 0.25,
  /** enemy guns' target score multiplier for a ship carrying repair rigs (priority target) */
  threatMul: 1.6,
};

const tA = new Vec3(), tB = new Vec3(), tC = new Vec3();

/** other repairers that worked on this target recently */
function busy(w: World, t: Ship, self: number): number {
  let n = 0;
  if (t.rpBy) for (const r of t.rpBy) if (r.id !== self && w.time - r.t <= REPAIR_RULES.window) n++;
  return n;
}
/** hull this target may still receive from repair ships now (0 while under fire or out of budget) */
export function hullRoom(w: World, t: Ship): number {
  if (w.time - (t.hitAt ?? -99) <= REPAIR_RULES.noHit) return 0;
  const rp = t.rpHeal ?? 0;
  return Math.max(0, Math.min(t.maxHp - t.hp, t.maxHp * REPAIR_RULES.cap - rp, t.maxHp * REPAIR_RULES.total - rp - (t.ofHeal ?? 0)));
}
function critNeed(t: Ship): number {
  let n = (t.crit.fire > 0 ? 0.5 : 0) + (t.crit.engine > 0 ? 0.3 : 0) + (t.crit.bridge > 0 ? 0.25 : 0);
  for (const m of t.mounts) if (m.disabled > 0) n += 0.1;
  return n;
}

/** pick the friendly ship this rig works on next (null: nothing to do in reach) */
function chooseTarget(w: World, s: Ship, m: Mount, muzzle: Vec3): Ship | null {
  const arc = m.def.arc * Math.PI / 180;
  let best: Ship | null = null, bestScore = 0;
  for (const t of w.ships) {
    if (t === s || t.team !== s.team || t.state !== 'alive') continue;
    const d = muzzle.distTo(t.pos);
    if (d > m.weapon.range) continue;
    const n = busy(w, t, s.id);
    if (n >= REPAIR_RULES.maxRepairers) continue;
    const room = hullRoom(w, t);
    const need = (room > 0 ? Math.min(1 - t.hp / t.maxHp, 0.6) : 0) + critNeed(t);
    if (need <= 0.005) continue;
    tB.subVectors(t.pos, muzzle).normalize();
    if (angleBetween(worldDirToLocal(tB, s.yaw, s.pitch, tC), m.facingLocal) > arc) continue;
    const eff = REPAIR_RULES.dim[n] * (t.rep ? REPAIR_RULES.supportMul : 1);
    const score = need * eff * (1 + t.value / 1500) * (t.id === m.targetId ? 1.1 : 1) - d / m.weapon.range * 0.02;
    if (score > bestScore) { bestScore = score; best = t; }
  }
  return best;
}

/** one tick of a repair mount (called from World.updateWeapons for kind 'repair', mount not disabled) */
export function updateRepairMount(w: World, s: Ship, m: Mount) {
  m.cooldown -= w.dt;
  if (m.cooldown > 0) return;
  const muzzle = localToWorld({ x: m.def.pos[0], y: m.def.pos[1], z: m.def.pos[2] }, s.pos, s.yaw, s.pitch, tA);
  const t = chooseTarget(w, s, m, muzzle);
  if (!t) { m.targetId = -1; m.cooldown = 0.5; return; }
  const r = m.weapon.repair!;
  const n = busy(w, t, s.id);
  const eff = REPAIR_RULES.dim[n] * (t.rep ? REPAIR_RULES.supportMul : 1);
  // hull (emergency budget)
  const h = Math.min(hullRoom(w, t), t.maxHp * r.hull * eff);
  if (h > 0) { t.hp += h; t.rpHeal = (t.rpHeal ?? 0) + h; s.rpDone = (s.rpDone ?? 0) + h; }
  // damage control: shorten what is burning / broken
  const k = clamp(r.crit * eff, 0, 0.9);
  let cut = 0;
  if (t.crit.fire > 0) { cut += t.crit.fire * k; t.crit.fire -= t.crit.fire * k; }
  if (t.crit.engine > 0) { cut += t.crit.engine * k; t.crit.engine -= t.crit.engine * k; }
  if (t.crit.bridge > 0) { cut += t.crit.bridge * k; t.crit.bridge -= t.crit.bridge * k; }
  for (const x of t.mounts) if (x.disabled > 0) { cut += x.disabled * k; x.disabled -= x.disabled * k; }
  s.rpCut = (s.rpCut ?? 0) + cut;
  // record who works here (diminishing returns for the next repairer)
  const by = (t.rpBy ??= []);
  const mine = by.find(x => x.id === s.id);
  if (mine) mine.t = w.time; else by.push({ id: s.id, t: w.time });
  if (by.length > 6) t.rpBy = by.filter(x => w.time - x.t <= REPAIR_RULES.window);
  m.targetId = t.id; m.targetIsMunition = false; m.lastFire = w.time;
  m.cooldown = m.weapon.reload;
  s.repTarget = t.id;
  // aim the rig at its patient (visual only)
  m.aim.subVectors(t.pos, muzzle).normalize();
  w.events.push({ t: 'repair', ship: s.id, mount: m.index, target: t.id, hull: h, cut, from: muzzle.clone(), to: t.pos.clone() });
}

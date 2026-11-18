// B-3 combat rating: how much a ship really counts in a fight, estimated from the battle engine's own data
// (mounted weapons and their damage, penetration, rate of fire and spread; hull points, armour, shields and
// evasion; fitting and research multipliers; the commander's gunnery and officer effects), without running a
// battle. Used for territory military strength (sovereignty.ts) instead of the bare hull class value.
//
//   offence  = Σ mounts  dps × expected penetration × expected hit chance   (averaged over reference targets)
//   defence  = (hull + shield) / expected share of incoming damage that lands (averaged over reference weapons)
//   rating   = K · √(offence · defence)       (Lanchester: a side's strength is the product; per ship the root)
//
// The reference targets / weapons are the standard warships (frigate, destroyer, cruiser, battleship), so a gun
// that cannot penetrate cruiser armour or a hull that every gun penetrates is valued as it fares in battle.
// K is fixed so that a standard heavy cruiser (세이버급, 'multi', average captain) rates 140 — the old scale, so the
// territory thresholds keep their meaning.
//
// The estimate is then corrected per class / loadout by CALIB, measured in real battles (scripts/b3/rating-calibrate.ts:
// a squadron of each loadout fights four reference opponents — heavy cruiser, AA destroyer, battleship, patrol
// frigate — and the opponent count that makes the fight even gives its battle rating; geometric mean over the four).
// Custom (Fitting V2) mounts use the class average correction. Validation: scripts/b3/rating-duels.ts.
import { SHIP_CLASSES, type LoadoutDef, type ShipClassDef } from '../sim/data/ships';
import { WEAPONS, isCraft, isShipGun, type WeaponDef } from '../sim/data/weapons';
import type { ShipFx } from '../sim/fleet';
import { effectiveCraft } from '../sim/craft';
import type { CraftStats } from '../sim/data/weapons';

const REF = ['frigate', 'destroyer', 'cruiser', 'battleship'] as const;
/** the battle engine's penetration rule (world.ts applyHit), as an expectation */
export function penMul(pen: number, armor: number): number {
  const r = pen / Math.max(1, armor);
  if (r >= 1) return 1;
  const p = Math.pow(r, 1.6);
  return r < 0.55 ? 0.75 * 0.06 + 0.25 * p : p;
}
/** chance a shot lands on a target of this radius at a typical engagement distance (the engine's targeting estimate) */
function hitP(w: WeaponDef, t: ShipClassDef): number {
  if (w.kind === 'pd') return 1;
  const d = Math.min(w.range, 1100) * 0.6;
  let p = Math.min(1, Math.max(0.05, (t.radius + 3) / (d * Math.max(w.spread, 0.004) * 3 + 1)));
  // guided munitions meet point defence; small agile craft dodge them (engine suitability rules)
  if (w.kind === 'missile' || w.kind === 'torpedo') p = t.role === 'raider' ? 0.15 : t.role === 'escort' && w.kind === 'torpedo' ? 0.6 : 0.8;
  return p;
}
const dps = (w: WeaponDef) => w.damage * w.salvo / w.reload;

interface Ref { cls: ShipClassDef; side: number; pd: number; weapons: { w: WeaponDef; share: number }[] }
/** share of guided munitions a ship's own point defence stops (engine: PD guns shoot missiles / torpedoes first) */
const pdStop = (pdDps: number) => Math.min(0.85, pdDps / 160);
const pdOf = (lo: LoadoutDef, mul = 1) => lo.mounts.reduce((a, m) => { const w = WEAPONS[m.weapon]; return a + (w?.kind === 'pd' ? dps(w) : 0); }, 0) * mul;
let refs: Ref[] | null = null;
function refSet(): Ref[] {
  if (refs) return refs;
  refs = REF.filter(id => SHIP_CLASSES[id]?.loadouts.length).map(id => {
    const cls = SHIP_CLASSES[id], lo = cls.loadouts[0];
    const ws = lo.mounts.map(m => WEAPONS[m.weapon]).filter(w => isShipGun(w));
    const tot = ws.reduce((a, w) => a + dps(w), 0) || 1;
    return { cls, side: cls.armor.side, pd: pdOf(lo), weapons: ws.map(w => ({ w, share: dps(w) / tot })) };
  });
  return refs;
}

/** P16.3 carrier rating: share of a squadron's airframes still flying over a fight (point defence and enemy
 *  fighters), and the share of the time a craft gun is on a target (the rest is transit / turning).
 *  P16.5 calibration against the equal-cost battles (scripts/p16/equal-cost.ts, docs/P16_5_AIR_BALANCE.md §5):
 *  craft guns landed ≈ 9 dps for two fighter squadrons (gun time 0.5 had them at ≈ 110), so the gun time is
 *  0.05; air-dropped torpedoes are stopped by point defence ≈ 40 % of the time (coordinated runs, two hits to
 *  kill), not by the ship-munition pdStop; interceptors never strike ships (CAP / intercept only). */
const CRAFT_SURV = 0.7, CRAFT_GUN_TIME = 0.05, CRAFT_GUN_HIT = 0.7, AIR_ORD_STOP = 0.4;
/** expected damage per second a squadron lands on the reference ships: guns (penetration vs side armour) and
 *  ordnance (one round per sortie cycle) */
function craftOff(cs: CraftStats, R: Ref[]): number {
  if (cs.role === 'interceptor') return 0;
  let per = 0;
  if (cs.gun) { const g = cs.gun; per += g.damage / Math.max(0.05, g.reload) * CRAFT_GUN_TIME * CRAFT_GUN_HIT * R.reduce((a, t) => a + penMul(g.pen, t.side), 0) / R.length; }
  const o = cs.ordnance ? WEAPONS[cs.ordnance] : undefined;
  if (o) per += o.damage * o.salvo / (cs.sortie * 0.5 + cs.turnaround) * (1 - AIR_ORD_STOP) * R.reduce((a, t) => a + penMul(o.pen, t.side), 0) / R.length;
  return per * cs.n * CRAFT_SURV;
}
/** does this loadout launch strike craft */
export const hasCraft = (lo: LoadoutDef) => lo.mounts.some(m => isCraft(WEAPONS[m.weapon]));

export interface RatingIn {
  cls: ShipClassDef; lo: LoadoutDef; fx?: ShipFx;
  /** commander judgement 0..1 (the engine's gunnery = 0.75 + 0.4 × skill) and officer battle effects */
  skill?: number; spec?: string; ofx?: Record<string, number>;
}
export interface Rating { off: number; def: number; cr: number }

function raw(i: RatingIn): { off: number; def: number } {
  const { cls, lo, fx = {} } = i, o = (k: string) => i.ofx?.[k] ?? 0;
  const gunnery = (0.75 + 0.4 * (i.skill ?? 0.5) + (i.spec === 'gunnery' ? 0.22 : 0)) * (fx.accMul ?? 1) * (1 + o('acc'));
  const R = refSet();
  let off = 0;
  for (const m of lo.mounts) {
    const w = WEAPONS[m.weapon]; if (!w) continue;
    if (isCraft(w)) { if (w.craft) off += craftOff(effectiveCraft(w.craft, fx.air, i.ofx), R); continue; }   // P16.3 carrier rating
    const fm = w.family ? fx.fam?.[w.family] : undefined;
    const rate = dps(w) * (fm?.dmg ?? 1) / ((fx.reloadMul ?? 1) * (fm?.reload ?? 1) * (w.kind === 'pd' ? 1 : 1 - o('rof')));
    if (w.kind === 'pd') { off += rate * 0.15 * (fx.pdMul ?? 1); continue; }   // point defence mostly shoots munitions
    const guided = w.kind === 'missile' || w.kind === 'torpedo';
    const vs = R.reduce((a, t) => a + penMul(w.pen * (1 + o('pen')), t.side) * hitP(w, t.cls) * (guided ? 1 - pdStop(t.pd) : 1), 0) / R.length;
    off += rate * vs * (w.kind === 'shell' ? gunnery : 1);
  }
  const hp = cls.hp * (lo.hpMul ?? 1) * (fx.hpMul ?? 1) * (1 + o('hp'));
  const armor = cls.armor.side * (lo.armorMul ?? 1) * (fx.armorMul ?? 1) * (1 + o('armor'));
  const shield = hp * (fx.shield ?? 0);
  // share of the reference fleets' fire that lands and gets through this hull
  const myPd = pdStop(pdOf(lo, (fx.pdMul ?? 1) * (1 + o('pd'))));
  const take = R.reduce((a, r) => a + r.weapons.reduce((b, x) => b + x.share * penMul(x.w.pen, armor) * hitP(x.w, cls) * (x.w.kind === 'missile' || x.w.kind === 'torpedo' ? 1 - myPd : 1), 0), 0) / R.length;
  const def = (hp + shield) / Math.max(0.03, take) / (1 - Math.min(0.5, fx.evasion ?? 0));
  return { off, def };
}
/** battle rating / model rating, measured (8 seeds × 4 opponents, scripts/b3/rating-calibrate.ts) */
export const CALIB: Record<string, number> = {"corvette:torp":1.178,"corvette:gun":0.674,"frigate:patrol":1.155,"frigate:aa":0.201,"frigate:missile":1.071,"destroyer:aa":0.975,"destroyer:strike":0.903,"light_cruiser:gun":0.884,"light_cruiser:missile":1.305,"light_cruiser:laser":0.689,"cruiser:multi":0.994,"cruiser:missile":1.557,"cruiser:gun":0.691,"battlecruiser:heavy":0.933,"battlecruiser:rail":0.928,"battlecruiser:lance":1.08,"battleship:std":0.778,"battleship:rail":0.873,"battleship:fortress":1.18,"dreadnought:std":1.005,"dreadnought:lance":1.153};
const avg: Record<string, number> = {};
/** measured correction for a class / loadout; the class average for custom fittings; 1 for classes never measured */
export function calibOf(classId: string, loadoutId?: string): number {
  const k = CALIB[`${classId}:${loadoutId}`]; if (k !== undefined) return k;
  if (avg[classId] === undefined) { const l = Object.entries(CALIB).filter(([x]) => x.startsWith(classId + ':')).map(([, v]) => v); avg[classId] = l.length ? Math.exp(l.reduce((a, v) => a + Math.log(v), 0) / l.length) : 1; }
  return avg[classId];
}
let K = 0;
export function rate(i: RatingIn): Rating {
  if (!K) { const c = SHIP_CLASSES.cruiser; const r = raw({ cls: c, lo: c.loadouts[0] }); K = 140 / Math.sqrt(r.off * r.def); }
  const r = raw(i);
  return { ...r, cr: K * Math.sqrt(r.off * r.def) };
}
/** rating of a class / loadout as built (no fitting effects, average captain) */
export function rateClass(classId: string, loadoutId?: string, skill = 0.5): number {
  const cls = SHIP_CLASSES[classId]; if (!cls?.loadouts.length) return 0;
  const lo = cls.loadouts.find(l => l.id === loadoutId) ?? cls.loadouts[0];
  return rate({ cls, lo, skill }).cr * calibOf(classId, lo.id);
}

/** P16.3/P16.5 light battle resolution (world/sim.ts quickResolve): a ship's strength-model value relative to its
 *  class as built, when the ship or its class carries strike craft — its loadout as fitted (other / fewer / extra
 *  squadrons, a gun swapped for a wing) with its aviation modules, against the class's standard loadout, clamped
 *  to 0.3..1.6. Only the air part of the fitting effects counts (ShipFx.air, officer airTurn): hull, armour and
 *  gunnery effects are not in any other ship's strength-model value either. 1 for every ship without strike
 *  craft (their values are unchanged). */
export function airValueMul(cls: ShipClassDef, lo: LoadoutDef, fx?: ShipFx, ofx?: Record<string, number>): number {
  const std = cls.loadouts[0];
  if (!std || (!hasCraft(lo) && !hasCraft(std))) return 1;
  const ref = rate({ cls, lo: std }).cr;
  const airFx: ShipFx | undefined = fx?.air ? { air: fx.air } : undefined;
  const airOfx = ofx?.airTurn ? { airTurn: ofx.airTurn } : undefined;
  return ref > 0 ? Math.max(0.3, Math.min(1.6, rate({ cls, lo, fx: airFx, ofx: airOfx }).cr / ref)) : 1;
}

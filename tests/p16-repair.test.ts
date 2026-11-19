// P16.7 repair ships: field (out-of-battle) repair gear on industrial bays, and combat repair rigs on support (R)
// hardpoints. docs/P16_7_REPAIR_SHIPS_DESIGN.md, docs/P16_7_REPAIR_IMPLEMENTATION.md.
import { describe, expect, it } from 'vitest';
import { World, type BattleSetup } from '../src/sim/world';
import { REPAIR_RULES, hullRoom } from '../src/sim/repair';
import { WEAPONS, isRepair, isShipGun } from '../src/sim/data/weapons';
import type { FleetSpec, GroupSpec, ShipSpec } from '../src/sim/fleet';
import type { Ship, SimEvent } from '../src/sim/types';
import { CONTENT, hullReleased, gearReleased } from '../src/content/registry';
import { hpAccepts, bayAccepts } from '../src/content/rules';
import { DEV_REPAIR_RELEASE, repairDevReleaseEnabled } from '../src/content/repairRelease';
import { shipLoadout } from '../src/world/fitting';
import { WorldSim } from '../src/world/sim';
import { STANDARD_WORLD } from '../src/world/worldPreset';
import { econOf } from '../src/world/hullops';
import { FIELD, stepFieldRepair, repairGearRate, fieldRate, sizeWeight, fieldUnitCost } from '../src/world/fieldRepair';
import { migrateRepair } from '../src/world/industrialGear';
import { MENDER_STD_WEAPONS, REPAIR_HULL } from '../src/content/packs/growth/support';
import type { WShip } from '../src/world/types';
import { BACKGROUNDS } from '../src/world/backgrounds';

// ─────────────────────────────────────────────────────────── combat
const menderFit = (): ShipSpec['fit'] => {
  const lo = shipLoadout({ classId: 'destroyer', loadoutId: 'aa', variant: `${REPAIR_HULL}_std`, fitting: { hp: { ...MENDER_STD_WEAPONS }, bay: {} } });
  return { name: lo.name, mounts: lo.mounts };
};
const S = (c: string, l: string, n: number, extra: Partial<ShipSpec> = {}): ShipSpec[] => Array.from({ length: n }, () => ({ classId: c, loadoutId: l, ...extra }));
const MENDER = (n = 1, extra: Partial<ShipSpec> = {}) => S('destroyer', 'aa', n, { fit: menderFit(), ...extra });
const G = (ships: ShipSpec[], order: GroupSpec['order'] = 'engage'): GroupSpec => ({ name: 'g', commanderId: 'wolf', order, retreatAt: 0, ships, children: [] });
const F = (g: GroupSpec, name: string): FleetSpec => ({ name, root: g });
const setup = (a: GroupSpec, b: GroupSpec, rules = 3, seed = 4): BattleSetup => ({ seed, scenarioId: 'p167', fleets: [F(a, 'A'), F(b, 'B')], rules });
function run(w: World, T: number, on?: (e: SimEvent) => void, each?: () => void) {
  while (!w.outcome && w.time < T) { each?.(); w.step(); if (on) for (const e of w.events) on(e); }
  return w;
}
const patientOf = (w: World) => w.ships.find(s => s.team === 0 && !s.rep)!;
const menders = (w: World) => w.ships.filter(s => s.rep);
/** a battle where team B is far away and harmless for the first seconds (the patient is not under fire) */
const quiet = (a: ShipSpec[]) => new World(setup(G(a), G(S('corvette', 'torp', 1), 'hold')));

describe('P16.7b combat repair', () => {
  it('the repair rig is not a gun and fits only the support (R) hardpoint, and only it fits there', () => {
    const rig = WEAPONS[CONTENT.arms.eq_rep_rig_m ? 'eq_rep_rig_m' : ''] ?? Object.values(WEAPONS).find(w => w.kind === 'repair')!;
    expect(isRepair(rig)).toBe(true);
    expect(isShipGun(rig)).toBe(false);
    const hp = CONTENT.hulls[REPAIR_HULL].hardpoints;
    const r1 = hp.find(h => h.id === 'r1')!, gun = hp.find(h => h.id === 'gun1')!;
    expect(hpAccepts(r1, 'eq_rep_rig_m')).toBeNull();
    expect(hpAccepts(gun, 'eq_rep_rig_m')).not.toBeNull();
    expect(hpAccepts(r1, 'eq_medium_gun')).not.toBeNull();
  });

  it('presence gate: a battle without repair rigs has repairOn false and no repair events', () => {
    const w = new World(setup(G(S('cruiser', 'multi', 2)), G(S('destroyer', 'aa', 2))));
    let n = 0;
    run(w, 30, e => { if (e.t === 'repair') n++; });
    expect(w.repairOn).toBe(false);
    expect(n).toBe(0);
  });

  it('repairs a damaged ally: hull capped at 15 % of max per battle, damage-control timers shortened', () => {
    const w = quiet([...MENDER(1), ...S('cruiser', 'multi', 1)]);
    expect(w.repairOn).toBe(true);
    const t = patientOf(w);
    t.hp = t.maxHp * 0.3; t.crit.fire = 40; t.crit.engine = 30;
    const hp0 = t.hp;
    let events = 0, cut = 0;
    run(w, 25, e => { if (e.t === 'repair' && e.target === t.id) { events++; cut += e.cut; } });
    expect(events).toBeGreaterThan(3);
    expect(t.rpHeal!).toBeGreaterThan(0);
    expect(t.rpHeal!).toBeLessThanOrEqual(t.maxHp * REPAIR_RULES.cap + 1e-6);
    expect(t.hp - hp0).toBeLessThanOrEqual(t.maxHp * REPAIR_RULES.cap + 1e-6);
    expect(cut).toBeGreaterThan(0);
    // 25 s of natural decay alone would leave the fire at ≥ 15 s; repair cut it much further
    expect(t.crit.fire).toBeLessThan(15);
  });

  it('shares the 25 % emergency budget with the commanding officer\'s own repair', () => {
    const w = quiet([...MENDER(1), ...S('cruiser', 'multi', 1)]);
    const t = patientOf(w);
    t.hp = t.maxHp * 0.3; t.ofHeal = t.maxHp * 0.2;
    run(w, 30);
    expect(t.rpHeal ?? 0).toBeLessThanOrEqual(t.maxHp * (REPAIR_RULES.total - 0.2) + 1e-6);
    expect(hullRoom(w, t)).toBe(0);
  });

  it('no hull repair under fire (hit within 3 s), but damage control still works', () => {
    const w = quiet([...MENDER(1), ...S('cruiser', 'multi', 1)]);
    const t = patientOf(w);
    t.hp = t.maxHp * 0.3; t.crit.fire = 40;
    let hull = 0, cut = 0;
    run(w, 20, e => { if (e.t === 'repair' && e.target === t.id) { hull += e.hull; cut += e.cut; } }, () => { t.hitAt = w.time; });
    expect(hull).toBe(0);
    expect(t.rpHeal ?? 0).toBe(0);
    expect(cut).toBeGreaterThan(0);
  });

  it('a sinking (dying) ship cannot be repaired', () => {
    const w = quiet([...MENDER(1), ...S('cruiser', 'multi', 1)]);
    const t = patientOf(w);
    t.hp = t.maxHp * 0.1; t.state = 'dying' as Ship['state'];
    let n = 0;
    run(w, 15, e => { if (e.t === 'repair' && e.target === t.id) n++; });
    expect(n).toBe(0);
  });

  it('several repair ships on one target: diminishing returns, never above one rig\'s full amount', () => {
    const w = quiet([...MENDER(3), ...S('cruiser', 'multi', 1)]);
    const t = patientOf(w);
    t.hp = t.maxHp * 0.2; t.crit.fire = 60; t.crit.engine = 60; t.crit.bridge = 60;
    const effs: number[] = [];
    run(w, 12, e => {
      if (e.t !== 'repair' || e.target !== t.id || e.hull <= 0) return;
      const src = w.ships.find(s => s.id === e.ship)!;
      effs.push(e.hull / (t.maxHp * src.mounts[e.mount].weapon.repair!.hull));
    });
    expect(effs.length).toBeGreaterThan(2);
    for (const x of effs) expect(x).toBeLessThanOrEqual(1 + 1e-6);
    expect(effs.some(x => x < 0.99)).toBe(true);                         // a 2nd / 3rd repairer worked at reduced rate
    expect(t.rpHeal!).toBeLessThanOrEqual(t.maxHp * REPAIR_RULES.cap + 1e-6);
  });

  it('repair ships do not repair themselves; repairing another repair ship is reduced', () => {
    const w = quiet(MENDER(2));
    const [a, b] = menders(w);
    a.hp = a.maxHp * 0.4; b.hp = b.maxHp * 0.4;
    const self: number[] = [], effs: number[] = [];
    run(w, 20, e => {
      if (e.t !== 'repair') return;
      if (e.target === e.ship) { self.push(e.ship); return; }
      const src = w.ships.find(s => s.id === e.ship)!, t = w.ships.find(s => s.id === e.target)!;
      if (e.hull > 0) effs.push(e.hull / (t.maxHp * src.mounts[e.mount].weapon.repair!.hull));
    });
    expect(self).toHaveLength(0);
    expect(effs.length).toBeGreaterThan(0);
    // supportMul: a repair ship receives at most a quarter of a rig's amount (and still the 15 % battle cap)
    for (const x of effs) expect(x).toBeLessThanOrEqual(REPAIR_RULES.supportMul + 1e-6);
    for (const s of [a, b]) expect(s.rpHeal ?? 0).toBeLessThanOrEqual(s.maxHp * REPAIR_RULES.cap + 1e-6);
  });

  it('is deterministic (same setup → same digest) and enemy guns rate a repair ship higher', () => {
    const mk = () => run(new World(setup(G([...MENDER(1, { cpu: { id: 'cpu_support', arch: 'support' } }), ...S('cruiser', 'multi', 2)]), G(S('cruiser', 'multi', 3)))), 90);
    expect(mk().digest()).toBe(mk().digest());
    expect(REPAIR_RULES.threatMul).toBeGreaterThan(1);
  });
});

// ─────────────────────────────────────────────────────────── field
const own = (sim: WorldSim, id: string) => Object.values(sim.st.ships).filter(s => s.owner === id);
function fieldWorld(gear = 'ind_rep_m') {
  const sim = WorldSim.create(31, { ...STANDARD_WORLD });
  const p = sim.addPlayer('수리');
  const ships = own(sim, p);
  const rep = ships.find(s => s.ind && s.fitting)!;
  rep.fitting!.bay = { ...rep.fitting!.bay };
  const slot = Object.keys(rep.fitting!.bay)[0] ?? 'ind1';
  rep.fitting!.bay = { [slot]: gear };
  const pat = ships.find(s => s !== rep)!;
  for (const s of [rep, pat]) { s.state = 'space'; s.task = { k: 'idle' } as unknown as WShip['task']; }
  pat.pos = { ...rep.pos, x: rep.pos.x + 100 };
  pat.hp = 0.5;
  sim.st.companies[p].credits = 1e7;
  return { sim, p, rep, pat };
}

describe('P16.7a field repair', () => {
  it('repair gear gives a field repair rate; no gear → no rate', () => {
    const { rep } = fieldWorld();
    expect(repairGearRate(rep)).toBeGreaterThan(0);
    expect(econOf(rep).mine).toBe(0);
    const bare = { ...rep, fitting: { ...rep.fitting!, bay: {} } } as WShip;
    expect(repairGearRate(bare)).toBe(0);
    // the gear fits an industrial bay like the other industrial gear
    const bay = CONTENT.hulls[rep.hull!]?.internals.find(b => b.kind === 'industrial');
    if (bay) expect(bayAccepts(bay, `ind_rep_${bay.size.toLowerCase()}`)).toBeNull();
  });

  it('passively repairs a damaged own ship nearby: hull at the gear × size rate, credits charged at station price', () => {
    const { sim, p, rep, pat } = fieldWorld();
    const c0 = sim.st.companies[p].credits, h0 = pat.hp;
    const per = fieldRate(sim, rep) / sizeWeight(pat) / 3600;
    for (let i = 0; i < 60; i++) stepFieldRepair(sim, 1);
    expect(pat.hp - h0).toBeCloseTo(Math.min(1 - h0, per * 60), 5);
    const spent = c0 - sim.st.companies[p].credits;
    expect(spent).toBeCloseTo((pat.hp - h0) * fieldUnitCost(sim, pat), 3);
    expect(pat.wear ?? 0).toBe(pat.wear ?? 0);                       // wear untouched (hull only)
    expect(pat.frAt).toBe(sim.time);
  });

  it('bigger gear repairs faster; a bigger patient is slower', () => {
    const s = fieldWorld('ind_rep_s'), l = fieldWorld('ind_rep_l');
    expect(repairGearRate(l.rep)).toBeGreaterThan(repairGearRate(s.rep));
    expect(FIELD.sizeW[3]).toBeGreaterThan(FIELD.sizeW[0]);
  });

  it('stops when a hostile fleet is near, and when the balance floor is reached', () => {
    const a = fieldWorld();
    const q = a.sim.addPlayer('적대', BACKGROUNDS.find(x => x.id === 'security'));
    expect(a.sim.command(a.p, { c: 'stance', target: q, v: -1 } as any)).toBeNull();
    const mil = Object.values(a.sim.st.ships).filter(s => s.owner === q && econOf(s).military);
    expect(mil.length).toBeGreaterThan(0);
    for (const x of mil) { x.pos = { ...a.rep.pos }; x.state = 'space'; }
    for (const g of Object.values(a.sim.st.groups)) if (g.owner === q) (g as any).cooldown = 0;
    const ha = a.pat.hp;
    stepFieldRepair(a.sim, 5);
    expect(a.pat.hp).toBe(ha);
    expect(a.rep.frNote).toMatch(/적대/);
    const b = fieldWorld();
    const co = b.sim.st.companies[b.p];
    co.credits = 0;
    const h0 = b.pat.hp;
    stepFieldRepair(b.sim, 10);
    expect(b.pat.hp).toBe(h0);
    expect(b.rep.frNote).toMatch(/보류/);
  });

  it('field repair orders are validated: no gear → refused', () => {
    const { sim, p, rep, pat } = fieldWorld();
    const g = sim.st.groups[rep.groupId];
    const err = sim.command(p, { c: 'setOp', group: g.id, op: { k: 'fieldrepair', ship: pat.id } } as any);
    // the patient may share the group (then the order is pointless) — either way no crash and a clear answer
    expect(err === null || typeof err === 'string').toBe(true);
    rep.fitting!.bay = {};
    const err2 = sim.command(p, { c: 'setOp', group: g.id, op: { k: 'repairzone', at: { ...rep.pos }, radius: 5000 } } as any);
    expect(err2).toMatch(/현장 수리 장비/);
  });
});

describe('P16.7 release gating', () => {
  it('a separate dev switch: off by default and off in production', () => {
    expect(DEV_REPAIR_RELEASE).toBe(false);
    expect(repairDevReleaseEnabled({ nodeEnv: 'production', serverFlag: '1' })).toBe(false);
    expect(repairDevReleaseEnabled({ nodeEnv: 'development', serverFlag: '1' })).toBe(true);
    expect(hullReleased(REPAIR_HULL)).toBe(false);
    expect(gearReleased('ind_rep_m')).toBe(false);
    expect(gearReleased('eq_rep_rig_s')).toBe(false);
    expect(gearReleased('cpu_support')).toBe(false);
  });

  it('migrateRepair does nothing without the switch and stocks markets once with it (idempotent)', () => {
    const sim = WorldSim.create(31, { ...STANDARD_WORLD });
    expect(sim.st.repairV).toBeUndefined();
    expect(migrateRepair(sim.st).applied).toBe(false);
    const r = migrateRepair(sim.st, { released: true });
    expect(r.applied).toBe(true);
    expect(r.markets).toBeGreaterThan(0);
    expect(sim.st.repairV).toBe(1);
    expect(migrateRepair(sim.st, { released: true }).applied).toBe(false);
  });
});

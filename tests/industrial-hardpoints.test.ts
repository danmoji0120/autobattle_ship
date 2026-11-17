// Industrial hardpoints: mining / construction / salvage come from fitted gear (× the hull's design bonus),
// starters come fitted, new companies own no blueprints, and an old save converts without losing anything.
import { describe, expect, it } from 'vitest';
import { WorldSim } from '../src/world/sim';
import { STANDARD_WORLD } from '../src/world/worldPreset';
import { BACKGROUNDS, backgroundShips } from '../src/world/backgrounds';
import { econOf, gearEcon, canBuild } from '../src/world/hullops';
import { salvageRate } from '../src/world/salvage';
import { salvageOperatingStatus } from '../src/world/firstBusiness';
import { migrateIndustrial } from '../src/world/industrialGear';
import { census, compareCensus } from '../src/world/migrate';
import { fittingItems } from '../src/world/fitting';
import type { WShip } from '../src/world/types';

const own = (sim: WorldSim, id: string) => Object.values(sim.st.ships).filter(s => s.owner === id);
const ind = () => WorldSim.create(31, { ...STANDARD_WORLD });
const dock = (sim: WorldSim, s: WShip, station: string) => { s.state = 'docked'; s.task = { k: 'docked', station } as any; };

describe('industrial hardpoints', () => {
  it('a new standard world uses the rules and stocks the gear', () => {
    const sim = ind();
    expect(sim.st.indV).toBe(1);
    expect(sim.st.stations.astra.market?.ind_mine_s).toBeTruthy();
  });

  it('no gear → no work: a miner without its laser mines 0, a constructor without its rig cannot build', () => {
    const sim = ind();
    const p = sim.addPlayer('장비 없음');
    const m = own(sim, p).find(s => s.classId === 'miner')!;
    expect(econOf(m).mine).toBeGreaterThan(0);
    dock(sim, m, 'astra');
    expect(sim.command(p, { c: 'fit', ship: m.id, hp: m.fitting!.hp, bay: {} })).toBeNull();
    expect(econOf(m).mine).toBe(0);
    expect(sim.storage(sim.st.stations.astra, p).ind_mine_s).toBe(1);          // removed gear goes to storage
    expect(gearEcon('constructor_mk1', 'constructor_mk1_std', {})).toMatchObject({ build: 0, mine: 0 });
    expect(canBuild({ classId: 'constructor', hull: 'constructor_mk1', variant: 'constructor_mk1_std', ind: 1, fitting: { bay: {} } })).toBe(false);
    expect(canBuild({ classId: 'constructor', hull: 'constructor_mk1', variant: 'constructor_mk1_std', ind: 1, fitting: { bay: { ind1: 'ind_build_m' } } })).toBe(true);
  });

  it('the same gear works at a different efficiency on different hulls (design bonus)', () => {
    const r = (h: string) => gearEcon(h, `${h}_std`, { ind1: 'ind_mine_m' }).mine;
    expect(r('hauler_l')).toBeCloseTo(5);
    expect(r('miner_m')).toBeCloseTo(5 * 1.28);
    expect(r('miner_quarry')).toBeGreaterThan(r('hauler_l'));
    expect(r('miner_m')).not.toBeCloseTo(r('miner_quarry'));
  });

  it('swapping gear changes the actual work, immediately', () => {
    const sim = ind();
    const p = sim.addPlayer('교체');
    const m = own(sim, p).find(s => s.classId === 'miner')!;
    dock(sim, m, 'astra');
    const store = sim.storage(sim.st.stations.astra, p);
    store.ind_salv_s = 1; store.ind_build_s = 1;
    const mine0 = econOf(m).mine;
    expect(sim.command(p, { c: 'fit', ship: m.id, hp: m.fitting!.hp, bay: { ind1: 'ind_salv_s' } })).toBeNull();
    expect(econOf(m).mine).toBe(0);
    expect(econOf(m).salv).toBeGreaterThan(0);
    expect(salvageRate(sim, m, 'cargo')).toBeGreaterThan(0);
    expect(store.ind_mine_s).toBe(1);
    expect(sim.command(p, { c: 'fit', ship: m.id, hp: m.fitting!.hp, bay: { ind1: 'ind_build_s' } })).toBeNull();
    expect(canBuild(m)).toBe(true);
    expect(salvageRate(sim, m, 'cargo')).toBe(0);
    expect(sim.command(p, { c: 'fit', ship: m.id, hp: m.fitting!.hp, bay: { ind1: 'ind_mine_s' } })).toBeNull();
    expect(econOf(m).mine).toBeCloseTo(mine0);
    // gear outside the industrial bay is refused
    expect(sim.command(p, { c: 'fit', ship: m.id, hp: m.fitting!.hp, bay: { ind1: 'ind_mine_xl' } })).not.toBeNull();
  });

  it('every starter can do its first activity, and new companies own no blueprints', () => {
    const sim = ind();
    const def = sim.addPlayer('기본');
    const ds = own(sim, def);
    expect(ds.filter(s => s.classId === 'miner' && econOf(s).mine > 0)).toHaveLength(2);
    expect(Object.keys(sim.st.companies[def].blueprints ?? {})).toHaveLength(0);
    for (const b of BACKGROUNDS) {
      const id = sim.addPlayer(`배경 ${b.id}`, b.id);
      const ships = own(sim, id);
      expect(ships.length, b.id).toBe(backgroundShips(sim.st, b).reduce((a, s) => a + s.n, 0));
      expect(Object.keys(sim.st.companies[id].blueprints ?? {}), b.id).toHaveLength(0);
      const can = {
        mine: ships.some(s => econOf(s).mine > 0),
        salvage: ships.some(s => salvageRate(sim, s, 'cargo') > 0),
        haul: ships.some(s => econOf(s).cargo > 0),
        fight: ships.some(s => econOf(s).military),
      };
      const first = { miner: can.mine, salvager: can.salvage, raider: can.fight && can.salvage, hauler: can.haul, security: can.fight, veteran: can.fight }[b.id];
      expect(first, `${b.id} ${JSON.stringify(can)}`).toBe(true);
      // every industrial ship of a gear-dependent role came fitted
      for (const s of ships) if (s.ind && (s.classId === 'miner' || s.classId === 'constructor')) expect(Object.keys(s.fitting!.bay).some(k => k.startsWith('ind')), `${b.id} ${s.hull}`).toBe(true);
    }
  });

  it('the salvager start salvages with its rigs; without them it cannot', () => {
    const sim = ind();
    const me = sim.addPlayer('인양', 'salvager');
    sim.st.companies[me].milestones.push('first_salvage');
    const s0 = salvageOperatingStatus(sim.st, me);
    expect(s0.state).toBe('ok'); expect(s0.can).toEqual({ hull: true, cargo: true, equip: true, frag: true });
    const rigs = own(sim, me).filter(s => (econOf(s).salv ?? 0) > 0);
    expect(rigs.length).toBe(2);
    for (const r of rigs) { r.fitting = { ...r.fitting!, bay: {} }; r.fit = []; }
    expect(own(sim, me).every(s => salvageRate(sim, s, 'cargo') === 0 && salvageRate(sim, s, 'hull') === 0)).toBe(true);
    expect(salvageOperatingStatus(sim.st, me).can).toEqual({ hull: false, cargo: false, equip: false, frag: false });
  });

  it('an old save converts by explicit migration: ships, equipment and blueprints kept, gear recorded, idempotent', () => {
    const sim = WorldSim.create(32, { ...STANDARD_WORLD, industrial: undefined });
    expect(sim.st.indV).toBeUndefined();
    const p = sim.addPlayer('구 세이브');
    const co = sim.st.companies[p];
    co.blueprints = { miner_m: { n: 1 } as any };
    const before = census(sim.st);
    const ships0 = own(sim, p).map(s => ({ id: s.id, hull: s.hull, items: fittingItems(s.fitting) }));
    const mineBefore = Object.fromEntries(own(sim, p).map(s => [s.id, econOf(s).mine]));
    const r = migrateIndustrial(sim.st);
    expect(r.applied).toBe(true);
    expect(r.gear).toBeGreaterThan(0);
    expect(compareCensus(before, census(sim.st))).toEqual([]);
    expect(co.blueprints).toEqual({ miner_m: { n: 1 } });
    for (const x of ships0) {
      const s = sim.st.ships[x.id];
      expect(s.hull).toBe(x.hull);
      const now = fittingItems(s.fitting);
      for (const [k, n] of Object.entries(x.items)) expect(now[k]).toBe(n);
      expect(s.ind).toBe(1);
      expect(econOf(s).mine).toBeCloseTo(mineBefore[s.id]);       // the same mining after conversion
    }
    const n = sim.st.grants!.length;
    expect(migrateIndustrial(sim.st)).toMatchObject({ applied: true, ships: 0, gear: 0, markets: 0 });
    expect(sim.st.grants!.length).toBe(n);
  });
});

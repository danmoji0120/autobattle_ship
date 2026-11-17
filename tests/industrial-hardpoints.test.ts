// Industrial hardpoints: mining / construction / salvage come from fitted gear (× the hull's design bonus),
// starters come fitted, new companies own no blueprints, and an old save converts without losing anything.
import { describe, expect, it } from 'vitest';
import { WorldSim } from '../src/world/sim';
import { STANDARD_WORLD } from '../src/world/worldPreset';
import { BACKGROUNDS, backgroundShips } from '../src/world/backgrounds';
import { econOf, gearEcon, canBuild } from '../src/world/hullops';
import { salvageRate, workable, validateSalvage, NO_SALV_GEAR } from '../src/world/salvage';
import { qty } from '../src/world/types';
import { buildNeeds } from '../src/world/production';
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

/** a wreck (and, with `drop`, a jettisoned-cargo site) next to a ship, with one lot of every kind */
function siteNear(sim: WorldSim, s: WShip, drop = false) {
  const id = drop ? 'd_test' : 'w_test';
  const site: any = { id, name: '시험 잔해', eng: 'e', system: sim.sysOf(s.pos)?.id, pos: { ...s.pos }, created: sim.st.time, expires: sim.st.time + 9999, sources: [],
    lots: [{ id: 'l1', k: 'cargo', item: 'alloy', n: 20, owner: 'pirates' }, ...(drop ? [] : [{ id: 'l2', k: 'hull', item: 'metal', n: 20, owner: 'pirates' }, { id: 'l3', k: 'equip', item: 'eq_pd_gun', n: 2, owner: 'pirates' }])],
    initial: 20, taken: {}, seen: [s.owner] };
  if (drop) (sim.st.drops ??= {} as any)[id] = { ...site, owner: 'pirates', told: [] };
  else (sim.st.wrecks ??= {})[id] = site;
  return site;
}

describe('industrial hardpoints: salvage hull, no gear-free salvage, own-yard launch fitting', () => {
  it('the small salvage hull gets a salvage bonus; other hulls still salvage with a rig', () => {
    const r = (h: string, g = 'ind_salv_s') => gearEcon(h, `${h}_std`, { ind1: g }).salv ?? 0;
    expect(r('salvager_s')).toBeCloseTo(1.3);
    expect(r('hauler_mk1')).toBeCloseTo(1);
    expect(r('constructor_s')).toBeCloseTo(1);
    expect(r('salvager_s', 'ind_salv_m')).toBeCloseTo(1.6 * 1.3);      // M industrial bay: up to a medium rig
    expect(gearEcon('salvager_s', 'salvager_s_std', {})).toMatchObject({ mine: 0, build: 0 });
    expect(gearEcon('salvager_s', 'salvager_s_std', {}).salv ?? 0).toBe(0);
  });

  it('the salvager start brings the dedicated salvage ships, fitted', () => {
    const sim = ind();
    const me = sim.addPlayer('인양', 'salvager');
    const sv = own(sim, me).filter(s => s.hull === 'salvager_s');
    expect(sv).toHaveLength(2);
    for (const s of sv) { expect(s.fitting!.bay.ind1).toBe('ind_salv_s'); expect(econOf(s).salv).toBeCloseTo(1.3); }
    expect(own(sim, me).some(s => s.hull === 'hauler_mk1')).toBe(true);
  });

  it('warships need a salvage rig for wrecks too (no exception); loose jettisoned cargo needs none', () => {
    const sim = ind();
    const me = sim.addPlayer('경비', 'security');
    const war = own(sim, me).filter(s => econOf(s).military);
    expect(war.length).toBeGreaterThan(0);
    for (const s of war) {
      expect(s.ind).toBe(1);
      for (const k of ['cargo', 'equip', 'hull', 'frag'] as const) expect(salvageRate(sim, s, k), `${s.hull} ${k}`).toBe(0);
      expect(salvageRate(sim, s, 'cargo', true)).toBeGreaterThan(0);        // already separated cargo: a pickup
    }
    const wreck = siteNear(sim, war[0]), drop = siteNear(sim, war[0], true);
    // the automatic pickup and every order go through workable / validateSalvage: no wreck work without gear
    expect(workable(sim, war, wreck, false)).toBe(false);
    expect(workable(sim, war, drop, false)).toBe(true);
    expect(validateSalvage(sim, me, war, { k: 'recover', wreck: wreck.id } as any)).toBe(NO_SALV_GEAR);
    expect(validateSalvage(sim, me, war, { k: 'recover', wreck: drop.id } as any)).toBeNull();
    expect(validateSalvage(sim, me, war, { k: 'salvzone', at: war[0].pos, radius: 3000 } as any)).toBe(NO_SALV_GEAR);
    // the same rule for a civilian hull: gear on → works the wreck, gear off → only the loose cargo
    const sal = sim.addPlayer('인양', 'salvager');
    const sv = own(sim, sal).filter(s => s.hull === 'salvager_s');
    expect(workable(sim, sv, wreck, false)).toBe(true);
    for (const s of sv) { s.fitting = { ...s.fitting!, bay: {} }; s.fit = []; }
    expect(workable(sim, sv, wreck, false)).toBe(false);
    expect(workable(sim, sv, drop, false)).toBe(true);
  });

  it('own yard: hull only, standard with its industrial gear, or a saved preset — items from real storage', () => {
    const sim = ind();
    const p = sim.addPlayer('조선');
    const co = sim.st.companies[p]; co.credits = 1_000_000;
    const st = sim.st.stations.helios; st.owner = p; st.public = false;
    for (const k of ['power', 'power', 'yard_s', 'fitting']) st.modules.push({ kind: k, progress: 1, built: true, slot: st.modules.length + 1 } as any);
    co.blueprints = { bp_miner_mk1: { src: 'test', t: 0 } as any, bp_salvager_s: { src: 'test', t: 0 } as any };
    const store = sim.storage(st, p);
    const fill = (need: Record<string, number>) => { for (const [k, n] of Object.entries(need)) store[k] = (store[k] ?? 0) + n; };
    const build = (cmd: object) => sim.command(p, { c: 'buildShip', station: st.id, classId: 'miner', loadoutId: '', hull: 'miner_mk1', ...cmd } as any);
    const launched = () => own(sim, p).filter(s => s.hull === 'miner_mk1' && s.task.k === 'docked' && (s.task as any).station === st.id);
    const runUntil = (n: number) => { for (let i = 0; i < 4000 && launched().length < n; i++) sim.update(1); };
    const base = launched().length;
    // standard: the preset's weapons + the hull's standard mining laser — taken from storage, never created
    expect(build({ outfit: 'standard' })).toBeNull();
    const b1 = st.builds!.at(-1)!;
    expect(b1.bay).toEqual({ ind1: 'ind_mine_s' });
    expect(b1.started).toBe(false);
    expect(b1.why).toMatch(/부품 부족/);
    const need1 = buildNeeds(b1.classId, b1.loadoutId, b1.fit, b1);
    expect(need1.ind_mine_s).toBe(1); expect(need1.eq_pd_gun).toBe(2);
    fill(need1);
    sim.update(1);
    expect(b1.started).toBe(true);
    expect(qty(store, 'ind_mine_s')).toBe(0);
    runUntil(base + 1);
    const m1 = launched().find(s => s.fitting?.bay.ind1 === 'ind_mine_s')!;
    expect(m1).toBeTruthy(); expect(m1.ind).toBe(1); expect(econOf(m1).mine).toBeGreaterThan(0);
    // hull only: no weapons, no gear; nothing but hull parts consumed
    expect(build({ outfit: 'hull' })).toBeNull();
    const b2 = st.builds!.at(-1)!;
    const need2 = buildNeeds(b2.classId, b2.loadoutId, b2.fit, b2);
    expect(need2.eq_pd_gun).toBeUndefined(); expect(need2.ind_mine_s).toBeUndefined();
    fill(need2); runUntil(base + 2);
    const m2 = launched().find(s => s.id !== m1.id)!;
    expect(m2.fitting).toMatchObject({ hp: {}, bay: {} }); expect(econOf(m2).mine).toBe(0);
    // a saved company preset (one point-defence gun + a salvage rig instead of the laser)
    expect(sim.command(p, { c: 'savePreset', name: '인양 개조', variant: 'miner_mk1_std', hp: { hp01: 'eq_pd_gun' }, bay: { ind1: 'ind_salv_s' } } as any)).toBeNull();
    const fp = co.fitPresets!.find(x => x.name === '인양 개조')!;
    expect(build({ outfit: 'preset', fitPreset: 'nope' })).toMatch(/프리셋/);
    expect(build({ outfit: 'preset', fitPreset: fp.id })).toBeNull();
    const b3 = st.builds!.at(-1)!;
    const need3 = buildNeeds(b3.classId, b3.loadoutId, b3.fit, b3);
    expect(need3.ind_salv_s).toBe(1); expect(need3.eq_pd_gun).toBe(1);
    fill(need3); runUntil(base + 3);
    const m3 = launched().find(s => s.id !== m1.id && s.id !== m2.id)!;
    expect(m3.fitting).toMatchObject({ hp: { hp01: 'eq_pd_gun' }, bay: { ind1: 'ind_salv_s' } });
    expect(econOf(m3).mine).toBe(0); expect(econOf(m3).salv).toBeGreaterThan(0);
    expect(qty(store, 'ind_salv_s')).toBe(0);
  }, 120000);
});

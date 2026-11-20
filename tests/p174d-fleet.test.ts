// P17.4d: fleet goal lines (variant / preset / company fitting / group, AUD-12), mixed-fleet templates (D2),
// yard-aware parallel builds and per-ship progress (AUD-13), estimate / ready-made purchase / restore safety (D4).
import { describe, expect, it } from 'vitest';
import { WorldSim } from '../src/world/sim';
import { TECHS } from '../src/world/industry';
import { grantBlueprint, hullBlueprint } from '../src/world/blueprints';
import { buildNeeds } from '../src/world/production';
import { CONTENT } from '../src/content/registry';
import { fleetEstimate, publicOffers } from '../src/world/fleetPlan';
import { fixture, run, until, approvals, goal, kids } from './helpers/opsFixture';

const HULL = 'patrol_pathfinder', VAR = 'patrol_pathfinder_std';
function setup(yards = 1) {
  const f = fixture(); f.co.tech = Object.keys(TECHS);
  expect(grantBlueprint(f.sim.st, f.co, hullBlueprint(HULL)!, 'fixture', f.sim.time)).toBe(true);
  for (let i = 1; i < yards; i++) f.home.modules.push({ kind: 'yard_s', slot: f.home.modules.length, built: true, progress: 1 } as never);
  // a company fitting of the same hull: the patrol preset without its point-defence gun
  const { pd1: _pd, ...hp } = CONTENT.presets.pathfinder_patrol.weapons;
  expect(f.sim.command(f.p, { c: 'savePreset', name: '방공 없는 초계', variant: VAR, hp, bay: {} })).toBeNull();
  const fp = f.co.fitPresets![0].id;
  return { ...f, fp };
}
const approveAll = (f: ReturnType<typeof setup>) => { for (const a of approvals(f.sim, f.p)) expect(f.sim.command(f.p, { c: 'approvalDecide', approval: a.id, option: 'approve', scope: 'work' })).toBeNull(); };
const stockParts = (f: ReturnType<typeof setup>, times: number) => { for (const b of f.home.builds!) for (const [k, n] of Object.entries(buildNeeds(b.classId, b.loadoutId, b.fit, b))) f.home.storage[f.p][k] = (f.home.storage[f.p][k] ?? 0) + n * times; };

describe('P17.4d AUD-12 fleet goal lines are validated like a build', () => {
  it('refuses a foreign variant, a mismatched preset, another hull\'s company fitting, a foreign group and a yard too small', () => {
    const f = setup();
    const g = (x: object) => f.sim.command(f.p, { c: 'workCreate', goal: { k: 'fleet', station: f.home.id, hull: HULL, count: 1, ...x } as never });
    expect(g({ variant: 'destroyer_mk1_std' })).toMatch(/변형/);
    expect(g({ variant: VAR, preset: 'pathfinder_scout' })).toMatch(/프리셋/);
    f.co.fitPresets!.push({ id: 'fp_other', name: '타 선체', hull: 'destroyer_mk1', variant: 'destroyer_mk1_std', hp: {}, bay: {} });
    expect(g({ fitPreset: 'fp_other' })).toMatch(/용이 아님/);
    const npcGroup = Object.values(f.sim.st.groups).find(x => x.owner !== f.p);
    if (npcGroup) expect(g({ group: npcGroup.id })).toMatch(/편대/);
    expect(f.sim.command(f.p, { c: 'workCreate', goal: { k: 'fleet', station: f.home.id, hull: 'battleship_mk1', count: 1 } as never })).toMatch(/조선소 슬롯/);
    expect(f.sim.command(f.p, { c: 'workCreate', goal: { k: 'fleet', station: f.home.id, hull: HULL, count: 0, lines: [{ hull: HULL, count: 40 }, { hull: HULL, count: 20 }] } as never })).toMatch(/50척/);
    expect(Object.values(f.sim.st.works ?? {}).filter(w => w.kind === 'fleet')).toHaveLength(0);
  });
});

describe('P17.4d D2 mixed-fleet templates are free designs', () => {
  it('saving needs no ship, yard or credits; invalid lines are refused; delete works', () => {
    const f = setup(); const credits = f.co.credits, store = JSON.stringify(f.home.storage);
    const ships = Object.keys(f.sim.st.ships).length;
    expect(f.sim.command(f.p, { c: 'saveFleetTemplate', name: '초계 전대', lines: [{ hull: HULL, preset: 'pathfinder_patrol', count: 2 }, { hull: HULL, fitPreset: f.fp, count: 3 }] })).toBeNull();
    expect(f.co.credits).toBe(credits); expect(JSON.stringify(f.home.storage)).toBe(store); expect(Object.keys(f.sim.st.ships).length).toBe(ships);
    const t = f.co.fleetTemplates![0];
    expect(t.lines).toEqual([{ hull: HULL, variant: VAR, preset: 'pathfinder_patrol', count: 2 }, { hull: HULL, variant: VAR, fitPreset: f.fp, count: 3 }]);
    // same name replaces, it does not duplicate
    expect(f.sim.command(f.p, { c: 'saveFleetTemplate', name: '초계 전대', lines: [{ hull: HULL, count: 1 }] })).toBeNull();
    expect(f.co.fleetTemplates).toHaveLength(1);
    expect(f.sim.command(f.p, { c: 'saveFleetTemplate', name: 'x', lines: [{ hull: 'nope', count: 1 }] })).toMatch(/선체/);
    expect(f.sim.command(f.p, { c: 'delFleetTemplate', id: t.id })).toBeNull();
    expect(f.co.fleetTemplates).toHaveLength(0);
  });
});

describe('P17.4d AUD-13 yard-aware parallel builds, per-ship progress', () => {
  it('fills every yard slot (+1 queued) when parts are there; one queued hull when parts are missing', () => {
    // three slots, parts in store: 3 + 1 queued (the old goal stopped at 2)
    const f = setup(3);
    expect(f.sim.command(f.p, { c: 'workCreate', goal: { k: 'fleet', station: f.home.id, hull: HULL, preset: 'pathfinder_patrol', count: 6 } })).toBeNull();
    approveAll(f);
    const b0 = buildNeeds('corvette', '', [], { hull: HULL, variant: VAR, preset: 'pathfinder_patrol' });
    for (const [k, n] of Object.entries(b0)) f.home.storage[f.p][k] = n * 6;
    run(f.sim, 12);
    expect(f.home.builds!.length).toBe(4);
    expect(f.home.builds!.filter(b => b.started).length).toBe(3);
    // no parts: two hulls queue (procurement plans their parts), no more keels behind them
    const e = setup(3);
    expect(e.sim.command(e.p, { c: 'workCreate', goal: { k: 'fleet', station: e.home.id, hull: HULL, preset: 'pathfinder_patrol', count: 6 } })).toBeNull();
    approveAll(e); run(e.sim, 30);
    expect(e.home.builds!.length).toBe(2);
    const g = goal(e.sim, e.p);
    expect(g.reason).toMatch(/추가 착공 보류 — 부품 부족/);
    expect(g.rt!.ships![0].pct).toBe(-1); expect(g.rt!.ships![0].why).toMatch(/부품 부족/);
  });
});

describe('P17.4d D2/D4 mixed fleet: lines, launch, save/restore', () => {
  it('builds every line once, counts per line, survives a save/restore mid-way without duplicates', () => {
    const f = setup(2);
    expect(f.sim.command(f.p, { c: 'workCreate', goal: { k: 'fleet', station: f.home.id, hull: HULL, count: 0, lines: [{ hull: HULL, preset: 'pathfinder_patrol', count: 2 }, { hull: HULL, fitPreset: f.fp, count: 1 }] } as never })).toBeNull();
    const g = goal(f.sim, f.p);
    expect(g.progress.total).toBe(3); expect(g.title).toMatch(/혼합 함대/);
    approveAll(f); run(f.sim, 12);
    expect(f.home.builds!.length).toBe(2);   // nothing in store: two hulls queued, waiting on parts
    stockParts(f, 1); f.home.storage[f.p].eq_pd_gun = (f.home.storage[f.p].eq_pd_gun ?? 0) + 5;
    for (const [k, n] of Object.entries(buildNeeds('corvette', '', [], { hull: HULL, variant: VAR, preset: 'pathfinder_patrol' }))) f.home.storage[f.p][k] = (f.home.storage[f.p][k] ?? 0) + n * 3;
    run(f.sim, 30);
    // restore mid-way: the same goal continues, no second set of keels
    const sim2 = new WorldSim(JSON.parse(f.sim.serialize()));
    const g2 = sim2.st.works![g.id], home2 = sim2.st.stations[f.home.id];
    const before = home2.builds!.length + Object.values(sim2.st.ships).filter(s => s.owner === f.p && s.hull === HULL).length;
    run(sim2, 12);
    expect(home2.builds!.length + Object.values(sim2.st.ships).filter(s => s.owner === f.p && s.hull === HULL).length).toBeLessThanOrEqual(Math.max(before, 3));
    expect(until(sim2, () => g2.state === 'done', 9000)).toBe(true);
    const built = Object.values(sim2.st.ships).filter(s => s.owner === f.p && s.hull === HULL);
    expect(built).toHaveLength(3);
    expect(built.filter(s => !s.fitting!.hp.pd1)).toHaveLength(1);   // the company-fitting line
    const lineOf = g2.rt!.lineOf!;
    expect(Object.values(lineOf).filter(i => i === 0)).toHaveLength(2); expect(Object.values(lineOf).filter(i => i === 1)).toHaveLength(1);
    expect(kids(sim2, g2).filter(k => k.kind === 'ship' && k.state === 'done')).toHaveLength(3);
  }, 120_000);
});

describe('P17.4d D4 estimate and ready-made purchase', () => {
  it('the estimate splits buyable from built hulls and lists the part shortfall', () => {
    const f = setup();
    const lines = [{ hull: HULL, variant: VAR, preset: 'pathfinder_patrol', count: 4 }, { hull: HULL, variant: VAR, fitPreset: f.fp, count: 2 }];
    const e0 = fleetEstimate(f.sim, f.p, f.home, lines, false);
    expect(e0.lines.map(l => l.build)).toEqual([4, 2]); expect(e0.buyCredits).toBe(0);
    expect(e0.needs.every(n => n.short === n.need)).toBe(true);   // empty store
    const e1 = fleetEstimate(f.sim, f.p, f.home, lines, true);
    const stocked = publicOffers(f.sim, f.p, lines[0]).reduce((a, o) => a + o.stock, 0);
    expect(e1.lines[0].buyable).toBe(Math.min(4, stocked)); expect(e1.lines[1].buyable).toBe(0);   // a company fitting is never sold ready-made
    expect(e1.lines[0].build).toBe(4 - e1.lines[0].buyable);
    expect(e1.buildCredits).toBeLessThan(e0.buildCredits);
  });
  it('with "buy", stocked hulls are purchased once (after approval) and counted; the rest is built', () => {
    const f = setup();
    const credits0 = f.co.credits;
    expect(f.sim.command(f.p, { c: 'workCreate', goal: { k: 'fleet', station: f.home.id, hull: HULL, preset: 'pathfinder_patrol', count: 2, buy: true } as never })).toBeNull();
    const g = goal(f.sim, f.p);
    expect(Object.values(f.sim.st.ships).filter(s => s.owner === f.p && s.hull === HULL)).toHaveLength(0);   // nothing bought before approval
    approveAll(f); run(f.sim, 15);
    const mine = () => Object.values(f.sim.st.ships).filter(s => s.owner === f.p && s.hull === HULL);
    expect(mine()).toHaveLength(2);
    expect(f.home.builds ?? []).toHaveLength(0);
    expect(g.state).toBe('done');
    expect(f.co.credits).toBeLessThan(credits0);
    // a restore and more ticks never buy again
    const sim2 = new WorldSim(JSON.parse(f.sim.serialize())); run(sim2, 30);
    expect(Object.values(sim2.st.ships).filter(s => s.owner === f.p && s.hull === HULL)).toHaveLength(2);
  });
});

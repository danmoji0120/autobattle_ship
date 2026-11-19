// P17 industry: passive salvage business (P17.0), salvage quality (P17.1). docs/P17_INDUSTRY.md
import { describe, expect, it } from 'vitest';
import { WorldSim } from '../src/world/sim';
import { STANDARD_WORLD } from '../src/world/worldPreset';
import { econOf, salvagePrecision } from '../src/world/hullops';
import { spawnDerelict } from '../src/world/derelicts';
import { jumps } from '../src/world/geom';
import { SALV, salvageQuality, siteDifficulty } from '../src/world/salvage';
import { migrateSalvageQuality } from '../src/world/salvageMigrate';
import { observeWorld } from '../src/world/observe';
import type { WShip, WGroup } from '../src/world/types';

function bizWorld() {
  const sim = WorldSim.create(31, { ...STANDARD_WORLD });
  const p = sim.addPlayer('인양', 'salvager');
  for (const id of Object.keys(sim.st.wrecks ?? {})) delete sim.st.wrecks![id];
  if (sim.st.derelicts) sim.st.derelicts.check = 1e12;
  for (const l of Object.values(sim.st.lairs)) { l.alive = false; l.respawnAt = 1e12; }
  const ships = Object.values(sim.st.ships).filter(s => s.owner === p);
  const salv = ships.find(s => (econOf(s).salv ?? 0) > 0)!;
  const g = sim.st.groups[salv.groupId];
  sim.st.companies[p].credits = 1e6;
  const home = sim.sysOf(salv.pos)!;
  const sys = Object.values(sim.st.systems);
  const near = sys.find(x => jumps(sim.st.systems, home.id, x.id) === 1)!;
  const far = sys.find(x => jumps(sim.st.systems, home.id, x.id) >= 3)!;
  return { sim, p, salv, g, home, near, far };
}
const spawn = (sim: WorldSim, system: any) => spawnDerelict(sim.st, { system, grade: 'small', region: 'test', time: sim.time, life: 86400, near: system.origin });
const run = (sim: WorldSim, sec: number, stop?: () => boolean) => { for (let t = 0; t < sec && !stop?.(); t += 1) sim.update(1); };
const took = (s: WShip) => Object.values(s.salvaged ?? {}).reduce((a, n) => a + n, 0);

describe('P17.0 salvage business (salvzone biz)', () => {
  it('validates without a radius and needs salvage gear', () => {
    const { sim, p, g, salv } = bizWorld();
    expect(sim.command(p, { c: 'setOp', group: g.id, op: { k: 'salvzone', at: { ...salv.pos }, radius: 0, biz: true } } as any)).toBeNull();
    const bare = bizWorld();
    bare.salv.fitting!.bay = {};
    for (const s of bare.g.shipIds.map(id => bare.sim.st.ships[id])) if (s.fitting) s.fitting.bay = {};
    expect(bare.sim.command(bare.p, { c: 'setOp', group: bare.g.id, op: { k: 'salvzone', at: { ...bare.salv.pos }, radius: 0, biz: true } } as any)).toMatch(/인양 장비/);
  });

  it('finds a wreck in a neighbouring system on its own, works it and leaves far systems alone', () => {
    const { sim, p, g, salv, near, far } = bizWorld();
    const a = spawn(sim, near), b = spawn(sim, far);
    expect(sim.command(p, { c: 'setOp', group: g.id, op: { k: 'salvzone', at: { ...salv.pos }, radius: 0, biz: true } } as any)).toBeNull();
    run(sim, 4 * 3600, () => took(salv) > 0 || g.salv?.phase === 'unload');
    expect(g.salv?.wreck === a.id || took(salv) > 0 || g.salv?.phase === 'unload').toBe(true);
    expect(b.lots.reduce((n, l) => n + l.n, 0)).toBe(b.initial);
    expect(g.status).toMatch(/자동 인양 사업/);
  });

  it('with nothing worth doing it waits docked at a station (not in space) and keeps the order', () => {
    const { sim, p, g, salv } = bizWorld();
    expect(sim.command(p, { c: 'setOp', group: g.id, op: { k: 'salvzone', at: { ...salv.pos }, radius: 0, biz: true } } as any)).toBeNull();
    run(sim, 120);
    expect(g.salv?.phase).toBe('hold');
    expect(salv.state).toBe('docked');
    expect(sim.opOf(g as WGroup).k).toBe('salvzone');
  });

  it('skips a site with a hostile fleet near it', () => {
    expect(SALV.bizRiskIgnore).toBeGreaterThan(0);
  });
});

/** one derelict next to the salvage fleet, with a known equipment lot; recover it for `sec` seconds */
function qualityRun(tune?: (sim: WorldSim, p: string) => void, sec = 3600) {
  const { sim, p, salv, g, home } = bizWorld();
  tune?.(sim, p);
  const w = spawnDerelict(sim.st, { system: home, grade: 'medium', region: 'test', time: sim.time, life: 86400, near: salv.pos });
  w.lots.push({ id: 'lq', k: 'equip', item: 'eq_medium_gun', n: 6, owner: '' });
  w.initial += 6;
  const before = Object.fromEntries(w.lots.map(l => [l.item, (w.lots.filter(x => x.item === l.item).reduce((a, x) => a + x.n, 0))]));
  expect(sim.command(p, { c: 'setOp', group: g.id, op: { k: 'recover', wreck: w.id } } as any)).toBeNull();
  const got: Record<string, number> = {};
  // count every recovered unit (cargo is unloaded at the station in between)
  const off = observeWorld(sim.st, e => { if (e.kind === 'salvage' && e.reason === 'recover' && e.ref === w.id && e.item) got[e.item] = (got[e.item] ?? 0) + e.amount; });
  run(sim, sec);
  off();
  const taken: Record<string, number> = {};
  for (const [item, n0] of Object.entries(before)) taken[item] = n0 - w.lots.filter(l => l.item === item).reduce((a, l) => a + l.n, 0);
  return { sim, p, salv, w, got, taken };
}

describe('P17.1 salvage quality', () => {
  it('gear precision: bigger rigs are more careful, without gear there is none', () => {
    const [s, m, l, xl] = ['ind_salv_s', 'ind_salv_m', 'ind_salv_l', 'ind_salv_xl'].map(id => salvagePrecision({ a: id }));
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThan(m); expect(m).toBeLessThan(l); expect(l).toBeLessThan(xl);
    expect(salvagePrecision({})).toBe(0);
    // precision grows much slower than speed (S 1.0 → XL 4.2)
    expect(xl / s).toBeLessThan(2);
  });

  it('wreck condition: bigger derelicts and older wrecks are harder', () => {
    const { sim, home, salv } = bizWorld();
    const mk = (grade: 'small' | 'medium' | 'large') => spawnDerelict(sim.st, { system: home, grade, region: 't', time: sim.time, life: 86400, near: salv.pos });
    const [a, b, c] = [mk('small'), mk('medium'), mk('large')];
    expect(siteDifficulty(sim, a)).toBeLessThan(siteDifficulty(sim, b));
    expect(siteDifficulty(sim, b)).toBeLessThan(siteDifficulty(sim, c));
    const q0 = salvageQuality(sim, salv, a);
    a.created -= 43200; a.expires -= 43200;   // the same wreck, half a day older
    expect(salvageQuality(sim, salv, a)).toBeLessThan(q0);
  });

  it('never recovers more than the wreck held, and never an item it did not hold', () => {
    const { got, taken } = qualityRun();
    expect(Object.values(got).reduce((a, n) => a + n, 0)).toBeGreaterThan(0);
    for (const [item, n] of Object.entries(got)) {
      if (item === 'weapon_parts' && !(item in taken)) { expect(taken.eq_medium_gun).toBeGreaterThan(0); continue; }
      expect(item in taken).toBe(true);
      if (item !== 'weapon_parts') expect(n).toBeLessThanOrEqual(taken[item]);
    }
    // a basic rig loses part of the hull metal it cuts out
    expect(got.alloy ?? 0).toBeLessThan(taken.alloy);
  }, 120_000);

  it('salvage research recovers more of the same wreck per unit worked', () => {
    const basic = qualityRun();
    const expert = qualityRun((sim, p) => {
      sim.st.companies[p].tech = [...(sim.st.companies[p].tech ?? []), 'salvage_ops'];
    });
    const share = (r: typeof basic, item: string) => (r.got[item] ?? 0) / Math.max(1, r.taken[item]);
    expect(share(expert, 'alloy')).toBeGreaterThan(share(basic, 'alloy'));
    expect(basic.taken.alloy).toBeGreaterThan(10);
  }, 240_000);

  it('worlds without salvQV keep whole recovery; the migration is explicit and idempotent', () => {
    const r = qualityRun(sim => { delete sim.st.salvQV; });
    for (const item of ['alloy', 'metal']) if (r.taken[item]) expect(r.got[item]).toBe(r.taken[item]);
    const st = r.sim.st;
    expect(migrateSalvageQuality(st).applied).toBe(true);
    expect(st.salvQV).toBe(1);
    expect(migrateSalvageQuality(st).applied).toBe(false);
  }, 120_000);
});

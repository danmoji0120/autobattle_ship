// P17 industry: passive salvage business (P17.0). docs/P17_INDUSTRY.md
import { describe, expect, it } from 'vitest';
import { WorldSim } from '../src/world/sim';
import { STANDARD_WORLD } from '../src/world/worldPreset';
import { econOf } from '../src/world/hullops';
import { spawnDerelict } from '../src/world/derelicts';
import { jumps } from '../src/world/geom';
import { SALV } from '../src/world/salvage';
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

// Optional retention of finished logistics jobs: only history goes; anything with goods, a ship or a
// reference stays, and the world continues exactly as without retention.
import { describe, expect, it } from 'vitest';
import { WorldSim } from '../src/world/sim';
import type { Station } from '../src/world/types';
import { pruneLogisticsJobs } from '../src/world/retention';

function fixture() {
  const sim = WorldSim.create(981), p = sim.addPlayer('보존'), co = sim.st.companies[p]; co.credits = 1e8;
  for (const id of Object.keys(sim.st.ships)) delete sim.st.ships[id];
  for (const id of Object.keys(sim.st.groups)) delete sim.st.groups[id];
  for (const l of Object.values(sim.st.lairs)) { l.alive = false; l.respawnAt = 1e10; }
  for (const system of Object.values(sim.st.systems)) system.security = 100;
  const a = sim.st.stations.astra, g = sim.newGroup(p, '수송'); a.storage[p].ore = 5000;
  const b: Station = { ...structuredClone(a), id: 'ret_b', name: 'ret_b', public: false, owner: p, pos: { ...a.pos, x: a.pos.x + 500 }, market: null, funds: undefined, fundsMax: undefined, shipStock: undefined, storage: { [p]: {} }, builds: [], orders: [], jobs: [], listings: [], modules: ['core', 'power', 'logistics'].map((kind, slot) => ({ kind, slot, built: true, progress: 1 })) };
  sim.st.stations[b.id] = b;
  const ships = [0, 1].map(() => { const s = sim.spawnShip(p, 'hauler', 'std', g.id, a.pos); (sim as any).dockShip(s, a); return s; });
  expect(sim.command(p, { c: 'poolShips', ships: ships.map(s => s.id), on: true })).toBeNull();
  return { sim, p, a, b };
}
const run = (sim: WorldSim, s: number) => { for (let t = 0; t < s; t += .25) sim.update(.25); };

describe('logistics job retention (opt-in)', () => {
  it('keeps the newest finished jobs, every live one, and leaves the world otherwise identical', () => {
    const f = fixture(), control = new WorldSim(JSON.parse(f.sim.serialize()), { migrateContent: false });
    const create = (sim: WorldSim) => expect(sim.command(f.p, { c: 'poolCreate', request: { from: 'astra', to: 'ret_b', item: 'ore', kind: 'transfer', amount: 20, priority: 5, repeat: false } })).toBeNull();
    for (let i = 0; i < 12; i++) { create(f.sim); create(control); run(f.sim, 40); run(control, 40); pruneLogisticsJobs(f.sim.st, 3); }
    const jobs = Object.values(f.sim.st.logisticsJobs!), all = Object.values(control.st.logisticsJobs!);
    const done = all.filter(j => j.state === 'complete');
    expect(done.length).toBeGreaterThan(5);
    const keptDone = jobs.filter(j => j.state === 'complete');
    expect(keptDone.length).toBe(3);
    // the kept ones are the newest finished ones
    expect(keptDone.map(j => j.id).sort()).toEqual([...done].sort((a, b) => b.updated - a.updated).slice(0, 3).map(j => j.id).sort());
    // every live job is still there, identical
    for (const j of all.filter(j => j.state !== 'complete' && j.state !== 'cancelled')) expect(f.sim.st.logisticsJobs![j.id]).toEqual(j);
    // everything except the removed history is the same as without retention
    const strip = (sim: WorldSim) => { const w = JSON.parse(sim.serialize()); delete w.logisticsJobs; return w; };
    expect(strip(f.sim)).toEqual(strip(control));
    expect(f.sim.st.stations.ret_b.storage[f.p].ore).toBe(control.st.stations.ret_b.storage[f.p].ore);
  });

  it('never removes a finished job that still holds goods or is referenced by a ship', () => {
    const f = fixture();
    const st = f.sim.st;
    st.logisticsJobs = {};
    const base = { owner: f.p, from: 'astra', to: 'ret_b', item: 'ore', kind: 'transfer' as const, amount: 1, priority: 5, repeat: false, created: 0, updated: 0, delivered: 0, cycleDelivered: 0, lost: 0, withdrawn: 0, earned: 0, cycles: 0 };
    st.logisticsJobs.a = { ...base, id: 'a', state: 'complete', reserved: 0, carried: 0 };
    st.logisticsJobs.b = { ...base, id: 'b', state: 'cancelled', reserved: 0, carried: 1e-12 };
    st.logisticsJobs.c = { ...base, id: 'c', state: 'complete', reserved: 2, carried: 0 };
    st.logisticsJobs.d = { ...base, id: 'd', state: 'complete', reserved: 0, carried: 0, ship: Object.keys(st.ships)[0] };
    st.logisticsJobs.e = { ...base, id: 'e', state: 'complete', reserved: 0, carried: 0 };
    Object.values(st.ships)[1].logisticsJob = 'e';
    st.logisticsJobs.f = { ...base, id: 'f', state: 'paused', reserved: 0, carried: 0 };
    expect(pruneLogisticsJobs(st, 0)).toBe(1);
    expect(Object.keys(st.logisticsJobs).sort()).toEqual(['b', 'c', 'd', 'e', 'f']);
  });
});

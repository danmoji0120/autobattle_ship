import { describe, it, expect } from 'vitest';
import { addFoundationFreighter } from './helpers/foundation';
import { WorldSim } from '../src/world/sim';
import type { WGroup, Station } from '../src/world/types';
import { ECON } from '../src/world/data';

const run = (sim: WorldSim, seconds: number, dt = 0.25, each?: () => void) => { for (let t = 0; t < seconds; t += dt) { sim.update(dt); each?.(); } };
const groupNamed = (sim: WorldSim, owner: string, name: string) => Object.values(sim.st.groups).find(g => g.owner === owner && g.name === name) as WGroup;
const calm = (sim: WorldSim) => { for (const l of Object.values(sim.st.lairs)) { l.alive = false; l.respawnAt = 1e9; } for (const s of Object.values(sim.st.systems)) s.security = Math.max(s.security, 75); };

/** a PMC with its own working station near Astra */
function withStation(seed: number) {
  const sim = WorldSim.create(seed);
  const p = sim.addPlayer('채굴사');
  calm(sim);
  sim.st.companies[p].credits = 150000;
  expect(sim.command(p, { c: 'buyShip', station: 'astra', classId: 'constructor', loadoutId: 'std' })).toBeNull();
  const cg = Object.values(sim.st.groups).find(g => g.owner === p && g.shipIds.some(id => sim.st.ships[id].classId === 'constructor'))!;
  const a = sim.st.stations.astra.pos;
  expect(sim.command(p, { c: 'buy', station: 'astra', res: 'alloy', amount: 300 })).toBeNull(); // buy locally before loading the constructor
  addFoundationFreighter(sim, p, cg.id);
  expect(sim.command(p, { c: 'setOp', group: cg.id, op: { k: 'found', at: { x: a.x + 2600, y: 0, z: a.z + 2600 }, name: '제1 PMC 정거장' } })).toBeNull();
  run(sim, 200);
  const own = Object.values(sim.st.stations).find(s => s.owner === p) as Station;
  expect(own.modules.find(m => m.kind === 'core')!.built).toBe(true);
  return { sim, p, own, miners: groupNamed(sim, p, '제1 채굴반') };
}

/** running costs paid so far (c3 upkeep) — the only credit outflow when nothing is sold */
const paid = (sim: WorldSim, p: string) => sim.st.companies[p].upkeep?.total.paid ?? 0;

describe('mining unloading destination', () => {
  it('own station + store: ore goes into the PMC storage there, then the miners go back and repeat', () => {
    const { sim, p, own, miners } = withStation(11);
    const cr = sim.st.companies[p].credits, paid0 = paid(sim, p);
    expect(sim.command(p, { c: 'setOp', group: miners.id, op: { k: 'mine', field: 'kestrel', deliver: own.id, sell: false } })).toBeNull();
    let deliveries = 0, last = 0;
    run(sim, 1500, 0.25, () => { const v = own.storage[p]?.ore ?? 0; if (v > last + 1) deliveries++; last = v; });
    const cap = ECON.miner.cargo;
    expect(own.storage[p].ore).toBeGreaterThan(cap * 3);           // several full loads
    expect(deliveries).toBeGreaterThanOrEqual(4);                   // repeated round trips, not one
    expect(sim.st.companies[p].credits).toBeCloseTo(cr - (paid(sim, p) - paid0), 6); // nothing was sold (c3: running costs only)
    expect(sim.st.stations.astra.storage[p]?.ore ?? 0).toBe(0);     // and nothing went elsewhere
  });

  it('refuses to sell at a station without a market (no silent fallback)', () => {
    const { sim, p, own, miners } = withStation(12);
    expect(sim.command(p, { c: 'setOp', group: miners.id, op: { k: 'mine', field: 'kestrel', deliver: own.id, sell: true } })).toMatch(/시장/);
  });

  it('automatic destination + sale still works (the quick right-click order)', () => {
    const sim = WorldSim.create(13); calm(sim);
    const p = sim.addPlayer('자동');
    const g = groupNamed(sim, p, '제1 채굴반');
    const cr = sim.st.companies[p].credits;
    expect(sim.command(p, { c: 'setOp', group: g.id, op: { k: 'mine', field: 'kestrel', deliver: '', sell: true, auto: true } })).toBeNull();
    const op = g.op as any;
    expect(op.auto).toBe(true);
    expect(sim.st.stations[op.deliver].market).toBeTruthy();
    run(sim, 600);
    expect(sim.st.companies[p].credits).toBeGreaterThan(cr + 1000);
  });

  it('a vanished destination: warns, holds the ore, never sells it elsewhere; re-targeting resumes', () => {
    const { sim, p, own, miners } = withStation(14);
    expect(sim.command(p, { c: 'setOp', group: miners.id, op: { k: 'mine', field: 'kestrel', deliver: own.id, sell: false } })).toBeNull();
    run(sim, 60);
    delete sim.st.stations[own.id];
    const cr = sim.st.companies[p].credits, paid0 = paid(sim, p);
    const astraOre = sim.st.stations.astra.storage[p]?.ore ?? 0;
    run(sim, 500);
    expect(sim.st.companies[p].credits).toBeCloseTo(cr - (paid(sim, p) - paid0), 6);
    expect(sim.st.stations.astra.storage[p]?.ore ?? 0).toBe(astraOre);
    expect(miners.status).toMatch(/하역지 사용 불가/);
    expect(sim.st.events.filter(e => e.company === p && e.kind === 'warn' && e.text.includes('하역')).length).toBe(1); // one warning, not spam
    const held = miners.shipIds.reduce((a, id) => a + sim.st.ships[id].cargo.ore, 0);
    expect(held).toBeGreaterThan(0);
    // the player picks a new destination: the held ore is delivered there
    expect(sim.command(p, { c: 'setOp', group: miners.id, op: { k: 'mine', field: 'kestrel', deliver: 'astra', sell: false } })).toBeNull();
    run(sim, 300);
    expect(sim.st.stations.astra.storage[p].ore).toBeGreaterThan(astraOre + held * 0.9);
  });

  it('another system’s station is a valid destination (warp + gate routing)', () => {
    const sim = WorldSim.create(15); calm(sim);
    const p = sim.addPlayer('원정');
    const g = groupNamed(sim, p, '제1 채굴반');
    expect(sim.command(p, { c: 'setOp', group: g.id, op: { k: 'mine', field: 'kestrel', deliver: 'drakeout', sell: false } })).toBeNull();
    run(sim, 1500);
    expect(sim.st.stations.drakeout.storage[p]?.ore ?? 0).toBeGreaterThan(ECON.miner.cargo);
  });

  it('settings survive save / restore', () => {
    const sim = WorldSim.create(16);
    const p = sim.addPlayer('저장');
    const g = groupNamed(sim, p, '제1 채굴반');
    sim.command(p, { c: 'setOp', group: g.id, op: { k: 'mine', field: 'grey', deliver: '', sell: false, auto: true } });
    const back = new WorldSim(JSON.parse(JSON.stringify(sim.st)));
    expect(back.st.groups[g.id].op).toEqual(g.op);
  });
});

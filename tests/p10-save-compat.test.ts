// P10 save protection: existing (P9 / legacy) saves are never converted, and P10 state round-trips.
import { describe, expect, it } from 'vitest';
import { WorldSim } from '../src/world/sim';
import { newWorld } from '../src/world/worldgen';
import { startConflict } from '../src/world/factionEcon';

const run = (sim: WorldSim, sec: number) => { for (let i = 0; i < sec; i++) sim.tick(1); };
const quiet = (sim: WorldSim) => { (sim as any).ev = () => undefined; };

describe('P10 save compatibility', () => {
  it('a P9 save reloads and runs without gaining factions, fog, intel or new systems', () => {
    const sim = WorldSim.create(31);
    const p = sim.addPlayer('기존 회사');
    run(sim, 120);
    const save = sim.serialize();
    const again = new WorldSim(JSON.parse(save));
    run(again, 600);
    const st = again.st;
    expect(st.worldLayout).toBe('p9');
    expect(st.factions).toBeUndefined();
    expect(st.conflicts).toBeUndefined();
    expect(st.fog).toBeUndefined();
    expect(st.intel).toBeUndefined();
    expect(Object.keys(st.systems)).toHaveLength(22);
    expect(Object.values(st.fields).some(f => f.geo)).toBe(false);
    expect(Object.values(st.systems).some(s => s.faction || s.region)).toBe(false);
    expect(st.companies[p].standing).toBeUndefined();
  });

  it('a legacy five-system world stays legacy', () => {
    const sim = new WorldSim(newWorld(32));
    sim.addPlayer('구 회사'); run(sim, 60);
    const again = new WorldSim(JSON.parse(sim.serialize()));
    run(again, 300);
    expect(again.st.factions).toBeUndefined();
    expect(again.st.fog).toBeUndefined();
    expect(again.st.worldLayout).toBeUndefined();
  });

  it('P10 state (territory, factions, conflicts, intel, deposit depth) round-trips and continues identically', () => {
    const sim = WorldSim.create(33, { layout: 'p10' }); quiet(sim);
    const p = sim.addPlayer('탐사사');
    const g = sim.newGroup(p, '채굴');
    const f = sim.st.fields.p10_cradle_field;
    sim.spawnShip(p, 'miner', 'std', g.id, { x: f.pos.x + 300, y: 0, z: f.pos.z });
    run(sim, 3);
    expect(sim.command(p, { c: 'setOp', group: g.id, op: { k: 'mine', field: f.id, deliver: '', sell: false, auto: true } } as any)).toBeNull();
    startConflict(sim, sim.st, 'iron', 'guild', [['crossroads', 'rampart']]);
    run(sim, 400);
    const save = sim.serialize();
    const a = new WorldSim(JSON.parse(save)); quiet(a);
    expect(a.st.worldLayout).toBe('p10');
    expect(a.st.fog).toBe(1);
    expect(a.st.intel![p].fields[f.id].n).toBeGreaterThan(0);
    expect(a.st.fields[f.id].geo!.mined).toBe(sim.st.fields[f.id].geo!.mined);
    expect(Object.values(a.st.conflicts!).some(c => !c.ended)).toBe(true);
    // deterministic continuation from the save
    const b = new WorldSim(JSON.parse(save)); quiet(b);
    run(a, 300); run(b, 300);
    expect(a.serialize()).toBe(b.serialize());
  });
});

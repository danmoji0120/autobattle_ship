import { describe, it, expect } from 'vitest';
import { WorldSim } from '../src/world/sim';
import type { WGroup, Station } from '../src/world/types';
import { MODULES } from '../src/world/data';
import { planState } from '../src/world/construction';

const run = (sim: WorldSim, seconds: number, dt = 0.25, each?: () => void) => { for (let t = 0; t < seconds; t += dt) { sim.update(dt); each?.(); } };
const calm = (sim: WorldSim) => { for (const l of Object.values(sim.st.lairs)) { l.alive = false; l.respawnAt = 1e9; } for (const s of Object.values(sim.st.systems)) s.security = Math.max(s.security, 75); };
const groupNamed = (sim: WorldSim, owner: string, name: string) => Object.values(sim.st.groups).find(g => g.owner === owner && g.name === name) as WGroup;

function withStation(seed = 11) {
  const sim = WorldSim.create(seed);
  const p = sim.addPlayer('건설사');
  calm(sim);
  sim.st.companies[p].credits = 200000;
  expect(sim.command(p, { c: 'buyShip', station: 'astra', classId: 'constructor', loadoutId: 'std' })).toBeNull();
  const cg = Object.values(sim.st.groups).find(g => g.owner === p && g.shipIds.some(id => sim.st.ships[id].classId === 'constructor'))!;
  const a = sim.st.stations.astra.pos;
  expect(sim.command(p, { c: 'buy', station: 'astra', res: 'alloy', amount: 300 })).toBeNull(); // buy locally before loading the constructor
  expect(sim.command(p, { c: 'setOp', group: cg.id, op: { k: 'found', at: { x: a.x + 2600, y: 0, z: a.z + 2600 }, name: '건설 기지' } })).toBeNull();
  run(sim, 200);
  const own = Object.values(sim.st.stations).find(s => s.owner === p) as Station;
  expect(own.modules.find(m => m.kind === 'core')!.built).toBe(true);
  // the constructor goes home so only the station's own crew builds (deterministic timing)
  expect(sim.command(p, { c: 'setOp', group: cg.id, op: { k: 'idle' } })).toBeNull();
  return { sim, p, own, cg };
}
const plan = (st: Station, kind: string) => st.modules.find(m => m.kind === kind && !m.built);
/** every unit of every material is somewhere: free storage, reserved in a plan, or worked into a module */
const total = (st: Station, p: string) => {
  const out: Record<string, number> = {};
  for (const r of ['alloy', 'machinery', 'structure']) {
    out[r] = st.storage[p][r] ?? 0;
    for (const m of st.modules) out[r] += m.built ? (MODULES[m.kind].mats[r] ?? 0) * (m.kind === 'core' ? 0 : 1) : (m.reserved?.[r] ?? 0) + (m.used?.[r] ?? 0);
  }
  return out;
};

describe('station construction: plans, reservations, queue', () => {
  it('3,000 alloy but no structure is a structure shortage, not an alloy one; when it arrives it builds', () => {
    const { sim, p, own } = withStation();
    own.storage[p].alloy = 3000; own.storage[p].machinery = 20;
    expect(sim.command(p, { c: 'queueModule', station: own.id, kind: 'yard_s' })).toBeNull();
    const m = plan(own, 'yard_s')!;
    expect(m.reserved!.alloy).toBe(400);               // alloy is secured…
    expect(m.reserved!.machinery).toBe(12);
    expect(planState(own, m)).toBe('materials');        // …it waits for structure only
    const log = sim.st.events.filter(e => e.company === p).map(e => e.text).join('\n');
    expect(log).toMatch(/구조재 20 부족/);
    expect(log).not.toMatch(/합금 \d+ 부족/);
    own.storage[p].structure = 50;                        // structure arrives
    run(sim, 2);
    expect(planState(own, m)).toBe('building');
    run(sim, MODULES.yard_s.work / 0.5 + 10);
    expect(own.modules.some(x => x.kind === 'yard_s' && x.built)).toBe(true);
    expect(own.storage[p].alloy).toBeCloseTo(2600, 3);   // exactly 400 used
    expect(own.storage[p].structure).toBeCloseTo(30, 3);
    expect(own.storage[p].machinery).toBeCloseTo(8, 3);
  });

  it('a plan can be registered with no materials; credits are charged, it waits, then auto-starts when they arrive', () => {
    const { sim, p, own } = withStation();
    own.storage[p].alloy = 0; own.storage[p].crystal = 0;
    const cr = sim.st.companies[p].credits;
    expect(sim.command(p, { c: 'queueModule', station: own.id, kind: 'refinery' })).toBeNull();
    expect(sim.st.companies[p].credits).toBe(cr - MODULES.refinery.credits);
    const m = plan(own, 'refinery')!;
    run(sim, 30);
    expect(planState(own, m)).toBe('materials');
    expect(m.progress).toBe(0);
    own.storage[p].alloy = 150; run(sim, 1);
    expect(m.reserved!.alloy).toBe(150); expect(own.storage[p].alloy).toBe(0); // partial reservation, held aside
    own.storage[p].alloy = 500; run(sim, 1);
    expect(m.reserved!.alloy).toBeCloseTo(220 - (m.used!.alloy), 6);
    run(sim, MODULES.refinery.work / 0.5 + 5);
    expect(own.modules.some(x => x.kind === 'refinery' && x.built)).toBe(true);
  });

  it('credit and material shortfalls are reported separately', () => {
    const { sim, p, own } = withStation();
    sim.st.companies[p].credits = 1000;
    expect(sim.command(p, { c: 'queueModule', station: own.id, kind: 'yard_s' })).toMatch(/자금 부족 — 14,000 cr 더 필요/);
  });

  it('several plans never double-spend: queue order decides, reserved stock cannot buy ships or be sold', () => {
    const { sim, p, own } = withStation();
    own.storage[p].alloy = 500; own.storage[p].machinery = 6; own.storage[p].structure = 10;
    const before = total(own, p);
    for (const k of ['refinery', 'repair', 'warehouse']) expect(sim.command(p, { c: 'queueModule', station: own.id, kind: k })).toBeNull();
    const [a, b, c] = ['refinery', 'repair', 'warehouse'].map(k => plan(own, k)!);
    expect(a.reserved!.alloy).toBe(220); expect(b.reserved!.alloy).toBe(180); expect(c.reserved!.alloy).toBe(100);
    expect(own.storage[p].alloy).toBe(0);
    // nothing left to sell or to spend elsewhere
    expect(sim.command(p, { c: 'sell', station: own.id, res: 'alloy', amount: 100 })).not.toBeNull();
    for (let i = 0; i < 20; i++) { run(sim, 5); const t = total(own, p); for (const k of Object.keys(before)) expect(t[k]).toBeCloseTo(before[k], 4); }
    expect(planState(own, c)).toBe('materials');
    own.storage[p].alloy += 50;
    run(sim, 700);
    for (const k of ['refinery', 'repair', 'warehouse']) expect(own.modules.some(x => x.kind === k && x.built)).toBe(true);
    expect(total(own, p).alloy).toBeCloseTo(before.alloy + 50, 3);
  });

  it('pause keeps the reservation and stops work; resume continues; reorder changes who gets materials first', () => {
    const { sim, p, own } = withStation();
    own.storage[p].alloy = 0; own.storage[p].machinery = 6;
    sim.command(p, { c: 'queueModule', station: own.id, kind: 'refinery' });
    sim.command(p, { c: 'queueModule', station: own.id, kind: 'repair' });
    const a = plan(own, 'refinery')!, b = plan(own, 'repair')!;
    expect(sim.command(p, { c: 'planOp', station: own.id, plan: b.id!, op: 'up' })).toBeNull();
    own.storage[p].alloy = 180; run(sim, 1);
    expect(b.reserved!.alloy + b.used!.alloy).toBeCloseTo(180, 6); expect(a.reserved!.alloy ?? 0).toBe(0);  // repair is first now
    run(sim, 10);
    const prog = b.progress;
    expect(prog).toBeGreaterThan(0);
    expect(sim.command(p, { c: 'planOp', station: own.id, plan: b.id!, op: 'pause' })).toBeNull();
    own.storage[p].alloy = 100; run(sim, 20);
    expect(b.progress).toBe(prog);                                       // no work while paused
    expect(a.reserved!.alloy).toBe(100);                                 // the free alloy went to the next plan
    expect(sim.command(p, { c: 'planOp', station: own.id, plan: b.id!, op: 'resume' })).toBeNull();
    run(sim, 200);
    expect(own.modules.some(x => x.kind === 'repair' && x.built)).toBe(true);
  });

  it('cancel returns reserved materials and refunds credits (in full before work starts)', () => {
    const { sim, p, own } = withStation();
    own.storage[p].alloy = 100; own.storage[p].crystal = 0;
    const cr = sim.st.companies[p].credits;
    sim.command(p, { c: 'queueModule', station: own.id, kind: 'yard_s' });
    const m = plan(own, 'yard_s')!;
    expect(own.storage[p].alloy).toBe(0);
    expect(sim.command(p, { c: 'planOp', station: own.id, plan: m.id!, op: 'cancel' })).toBeNull();
    expect(own.storage[p].alloy).toBe(100);
    expect(sim.st.companies[p].credits).toBe(cr);
    expect(plan(own, 'yard_s')).toBeUndefined();
  });

  it('miners unloading at the station feed the waiting plan, which then builds itself', () => {
    const { sim, p, own } = withStation();
    own.storage[p].alloy = 0; own.storage[p].ore = 0;
    sim.command(p, { c: 'queueModule', station: own.id, kind: 'refinery' });
    own.storage[p].alloy = 220; run(sim, 240);                           // refinery first (bought alloy)
    expect(own.modules.some(x => x.kind === 'refinery' && x.built)).toBe(true);
    // now a plan with no alloy: only mined ore refined at this station (a standing production order) can pay for it
    own.storage[p].structure = 10;
    expect(sim.command(p, { c: 'queueModule', station: own.id, kind: 'warehouse' })).toBeNull();
    expect(sim.command(p, { c: 'prodOrder', station: own.id, recipe: 'alloy_direct', mode: 'stock', n: 500 })).toBeNull();
    const d = plan(own, 'warehouse')!;
    const miners = groupNamed(sim, p, '제1 채굴반');
    expect(sim.command(p, { c: 'setOp', group: miners.id, op: { k: 'mine', field: 'kestrel', deliver: own.id, sell: false } })).toBeNull();
    run(sim, 2500);
    expect(d.built).toBe(true);
    expect(own.modules.some(x => x.kind === 'warehouse' && x.built)).toBe(true);
  });

  it('plans, reservations and progress survive a restart', () => {
    const { sim, p, own } = withStation();
    own.storage[p].alloy = 300; own.storage[p].crystal = 0;
    sim.command(p, { c: 'queueModule', station: own.id, kind: 'refinery' });
    sim.command(p, { c: 'queueModule', station: own.id, kind: 'defense' });
    run(sim, 20);
    const sim2 = new WorldSim(JSON.parse(sim.serialize()));
    const o2 = sim2.st.stations[own.id];
    expect(o2.modules.map(m => [m.kind, m.id, m.progress, m.reserved?.alloy])).toEqual(own.modules.map(m => [m.kind, m.id, m.progress, m.reserved?.alloy]));
    run(sim2, 200);
    expect(o2.modules.some(x => x.kind === 'refinery' && x.built)).toBe(true);
    expect(planState(o2, plan(o2, 'defense')!)).toBe('materials');
  });

  it('old saves: an unbuilt module without plan data is migrated without losing paid progress', () => {
    const { sim, p, own } = withStation();
    own.modules.push({ kind: 'refinery', progress: 0.5, built: false, slot: 3 });
    own.storage[p].alloy = 1000;
    const sim2 = new WorldSim(JSON.parse(sim.serialize()));
    const m = plan(sim2.st.stations[own.id], 'refinery')!;
    expect(m.id).toBeTruthy();
    expect(m.used!.alloy).toBeCloseTo(110, 6);
    run(sim2, 2);
    expect(m.reserved!.alloy + m.used!.alloy).toBeCloseTo(220, 3);       // only the other half is taken
    expect(sim2.st.stations[own.id].storage[p].alloy).toBeCloseTo(1000 - 110, 3);
  });
});

// P12.5 automatic logistics: haulers work without routes or registration, yield to direct commands
// without losing cargo, and stay real ships (gates, docking, raids). §13 groups A–E.
import { describe, expect, it } from 'vitest';
import { WorldSim } from '../src/world/sim';
import { qty, cargoSum, type Station, type WShip } from '../src/world/types';
import { moduleMaterials } from '../src/world/stations';
import { recipeFor } from '../src/world/industry';
import { observeWorld } from '../src/world/observe';
import { poolMember, haulerAvailability } from '../src/world/haulers';
import { enableAutoLogistics } from '../src/world/logisticsMigrate';
import { legacyView } from '../src/server/sync';

function fixture(seed = 125, haulers = 3) {
  const sim = WorldSim.create(seed, { logistics: 'p125' }), p = sim.addPlayer('자동 물류'), co = sim.st.companies[p]; co.credits = 1e8;
  for (const id of Object.keys(sim.st.ships)) delete sim.st.ships[id];
  for (const id of Object.keys(sim.st.groups)) delete sim.st.groups[id];
  for (const l of Object.values(sim.st.lairs)) { l.alive = false; l.respawnAt = 1e10; }
  for (const sys of Object.values(sim.st.systems)) sys.security = 100;
  const a = sim.st.stations.astra; a.storage[p] = {};
  const make = (id: string, dx: number, modules: string[]): Station => ({ ...structuredClone(a), id, name: id, public: false, owner: p, pos: { ...a.pos, x: a.pos.x + dx }, market: null, funds: undefined, fundsMax: undefined, shipStock: undefined, storage: { [p]: {} }, modules: modules.map((kind, i) => ({ id: `${id}_${kind}`, kind, progress: 1, built: true, slot: i })) as any, orders: [], jobs: [], builds: [] });
  const dst = make('p125_dst', 650, ['core', 'power', 'refinery', 'logistics', 'yard_s']), b = make('p125_b', -500, ['core']), c = make('p125_c', 350, ['core']);
  for (const s of [dst, b, c]) sim.st.stations[s.id] = s;
  const group = sim.newGroup(p, '수송대');
  const ships = Array.from({ length: haulers }, () => { const s = sim.spawnShip(p, 'hauler', 'std', group.id, a.pos); (sim as any).dockShip(s, a); return s; });
  return { sim, p, co, a, b, c, dst, ships, group };
}
const run = (sim: WorldSim, seconds: number) => { for (let t = 0; t < seconds; t += .25) sim.update(.25); };
const until = (sim: WorldSim, condition: () => boolean, seconds = 1000) => { for (let t = 0; t < seconds && !condition(); t += .25) sim.update(.25); expect(condition()).toBe(true); };
const jobs = (sim: WorldSim) => Object.values(sim.st.logisticsJobs ?? {});
const live = (sim: WorldSim) => jobs(sim).filter(j => j.state !== 'complete' && j.state !== 'cancelled');
/** everything the company holds of an item: stations, holds, reservations, construction stock */
function holding(sim: WorldSim, p: string, item: string) {
  let n = 0;
  for (const st of Object.values(sim.st.stations)) n += qty(st.storage[p], item);
  for (const s of Object.values(sim.st.ships)) if (s.owner === p) n += qty(s.cargo, item);
  for (const j of jobs(sim)) if (j.owner === p && j.item === item) n += j.reserved;
  return n;
}

describe('P12.5 A — automatic dispatch', () => {
  it('A1–A3: a bought hauler works for construction with no route and no registration', () => {
    const f = fixture();
    expect(f.sim.st.logisticsV).toBe(1); expect(f.sim.st.opsV).toBe(1); expect(f.sim.st.combatV).toBe(2);
    expect(f.ships.every(s => poolMember(f.sim.st, s) && !s.logisticsPool)).toBe(true);
    expect(f.sim.command(f.p, { c: 'queueModule', station: f.dst.id, kind: 'warehouse' })).toBeNull();
    const plan = f.dst.modules.find(m => m.kind === 'warehouse')!;
    for (const [item, n] of Object.entries(moduleMaterials(plan))) f.b.storage[f.p][item] = n;
    until(f.sim, () => plan.built, 2000);
    expect(Object.keys(f.sim.st.logistics ?? {})).toHaveLength(0);
    expect(jobs(f.sim).filter(j => j.procurement).every(j => j.from === f.b.id && j.to === f.dst.id)).toBe(true);
    expect(jobs(f.sim).some(j => j.delivered > 0)).toBe(true);
  });
  it('A4: warships, miners, constructors and excluded ships are never dispatched', () => {
    const f = fixture(125, 1);
    const war = f.sim.spawnShip(f.p, 'destroyer', 'std', f.group.id, f.a.pos), miner = f.sim.spawnShip(f.p, 'miner', 'std', f.group.id, f.a.pos), cons = f.sim.spawnShip(f.p, 'constructor', 'std', f.group.id, f.a.pos);
    for (const s of [war, miner, cons]) expect(poolMember(f.sim.st, s)).toBe(false);
    expect(f.sim.command(f.p, { c: 'poolShips', ships: [f.ships[0].id], on: false })).toBeNull();
    expect(poolMember(f.sim.st, f.ships[0])).toBe(false);
    f.b.storage[f.p].ore = 50;
    expect(f.sim.command(f.p, { c: 'poolCreate', request: { from: f.b.id, to: f.dst.id, item: 'ore', kind: 'transfer', amount: 50, priority: 5, repeat: false } })).toBeNull();
    run(f.sim, 30);
    expect(jobs(f.sim).every(j => !j.ship)).toBe(true);
    expect([war, miner, cons, f.ships[0]].every(s => !s.logisticsJob)).toBe(true);
    expect(f.sim.command(f.p, { c: 'poolShips', ships: [f.ships[0].id], on: true })).toBeNull();
    until(f.sim, () => jobs(f.sim).some(j => j.ship === f.ships[0].id), 30);
  });
  it('A5: one ship per shipment and no double dispatch over repeated scans and a restore', () => {
    const f = fixture(125, 4);
    for (const st of [f.a, f.b, f.c]) st.storage[f.p].ore = 30;
    for (const st of [f.a, f.b, f.c]) expect(f.sim.command(f.p, { c: 'poolCreate', request: { from: st.id, to: f.dst.id, item: 'ore', kind: 'transfer', amount: 30, priority: 5, repeat: false } })).toBeNull();
    run(f.sim, 12);
    const assigned = jobs(f.sim).filter(j => j.ship).map(j => j.ship);
    expect(new Set(assigned).size).toBe(assigned.length);
    expect(f.ships.filter(s => s.logisticsJob).length).toBe(assigned.length);
    const restored = new WorldSim(JSON.parse(f.sim.serialize()), { migrateContent: false });
    for (let i = 0; i < 40; i++) restored.update(.25);
    const again = Object.values(restored.st.logisticsJobs!).filter(j => j.ship).map(j => j.ship);
    expect(new Set(again).size).toBe(again.length);
  });
  it('A6: waits when every hauler is busy and resumes when a ship becomes free', () => {
    const f = fixture(125, 1);
    f.b.storage[f.p].ore = 40;
    expect(f.sim.command(f.p, { c: 'setOp', group: f.group.id, op: { k: 'dock', station: f.a.id } })).toBeNull();
    expect(f.sim.command(f.p, { c: 'poolCreate', request: { from: f.b.id, to: f.dst.id, item: 'ore', kind: 'transfer', amount: 40, priority: 5, repeat: false } })).toBeNull();
    run(f.sim, 20);
    const j = jobs(f.sim)[0];
    expect(j.ship).toBeUndefined(); expect(j.code).toBe('ship');
    expect(haulerAvailability(f.sim, f.ships[0]).ok).toBe(false);
    expect(f.sim.command(f.p, { c: 'setOp', group: f.group.id, op: { k: 'idle' } })).toBeNull();
    until(f.sim, () => j.state === 'complete', 600);
    expect(qty(f.dst.storage[f.p], 'ore')).toBe(40);
  });
  it('A7: the global switch stops new dispatch; loaded shipments still finish', () => {
    const f = fixture(125, 2);
    f.b.storage[f.p].ore = 40; f.c.storage[f.p].ore = 40;
    expect(f.sim.command(f.p, { c: 'poolCreate', request: { from: f.b.id, to: f.dst.id, item: 'ore', kind: 'transfer', amount: 40, priority: 5, repeat: false } })).toBeNull();
    until(f.sim, () => jobs(f.sim)[0].carried > 0, 300);
    expect(f.sim.command(f.p, { c: 'autoLogistics', on: false })).toBeNull();
    expect(f.sim.command(f.p, { c: 'poolCreate', request: { from: f.c.id, to: f.dst.id, item: 'ore', kind: 'transfer', amount: 40, priority: 5, repeat: false } })).toBeNull();
    until(f.sim, () => jobs(f.sim)[0].state === 'complete', 600);
    run(f.sim, 20); expect(jobs(f.sim)[1].ship).toBeUndefined();
    expect(f.sim.command(f.p, { c: 'autoLogistics', on: true })).toBeNull();
    until(f.sim, () => jobs(f.sim)[1].state === 'complete', 600);
  });
});

describe('P12.5 B — production, construction, shipyard demand', () => {
  it('B1: production inputs arrive from two stations without double counting in-transit goods', () => {
    const f = fixture(), r = recipeFor(f.sim.st, 'alloy_direct')!;
    for (const [item, n] of Object.entries(r.in)) { f.b.storage[f.p][item] = Math.ceil(n / 2); f.c.storage[f.p][item] = n; }
    const before = Object.fromEntries(Object.keys(r.in).map(i => [i, holding(f.sim, f.p, i)]));
    expect(f.sim.command(f.p, { c: 'prodOrder', station: f.dst.id, recipe: r.id, mode: 'count', n: 1 })).toBeNull();
    for (let t = 0; t < 300 && (f.dst.orders ?? []).length; t++) {
      run(f.sim, 1);
      for (const item of Object.keys(r.in)) {
        const planned = live(f.sim).filter(j => j.item === item && j.to === f.dst.id).reduce((n, j) => n + j.amount - j.cycleDelivered, 0);
        expect(planned + qty(f.dst.storage[f.p], item)).toBeLessThanOrEqual(r.in[item] + 1e-6);
      }
    }
    expect(f.dst.orders ?? []).toHaveLength(0);
    for (const item of Object.keys(r.in)) expect(holding(f.sim, f.p, item)).toBeCloseTo(before[item] - r.in[item], 6);
  });
  it('B2: auto-buy stays off by default; nothing is bought and the shortage is reported', () => {
    const f = fixture(), r = recipeFor(f.sim.st, 'alloy_direct')!;
    const credits = f.co.credits;
    expect(f.sim.command(f.p, { c: 'prodOrder', station: f.dst.id, recipe: r.id, mode: 'count', n: 1 })).toBeNull();
    run(f.sim, 30);
    expect(f.co.procurement!.autoBuy).toBe(false); expect(f.co.credits).toBe(credits);
    expect(Object.values(f.sim.st.procurementPlans ?? {}).some(p => p.shortage > 0 && /자동 구매 꺼짐/.test(p.reason))).toBe(true);
  });
  it('B3: protected stock and reserved goods are never taken', () => {
    const f = fixture(), r = recipeFor(f.sim.st, 'alloy_direct')!, item = Object.keys(r.in)[0];
    f.b.storage[f.p][item] = r.in[item];
    expect(f.sim.command(f.p, { c: 'procPolicy', settings: { enabled: true, autoBuy: false, budget: 0, minCredits: 0, maxRisk: 100, protectStation: f.b.id, protectItem: item, protectAmount: r.in[item] } })).toBeNull();
    expect(f.sim.command(f.p, { c: 'prodOrder', station: f.dst.id, recipe: r.id, mode: 'count', n: 1 })).toBeNull();
    run(f.sim, 40);
    expect(qty(f.b.storage[f.p], item)).toBe(r.in[item]);
    expect(jobs(f.sim).filter(j => j.from === f.b.id && j.item === item)).toHaveLength(0);
  });
});

describe('P12.5 C — cargo preservation', () => {
  it('C1/C2: a direct command mid-transport holds the cargo; the same ship resumes when idle again', () => {
    const f = fixture(125, 1); f.b.storage[f.p].ore = 60;
    const total0 = holding(f.sim, f.p, 'ore');
    expect(f.sim.command(f.p, { c: 'poolCreate', request: { from: f.b.id, to: f.dst.id, item: 'ore', kind: 'transfer', amount: 60, priority: 5, repeat: false } })).toBeNull();
    const j = jobs(f.sim)[0], s = f.ships[0];
    until(f.sim, () => j.carried > 0 && s.state === 'space', 400);
    const carried = j.carried;
    expect(f.sim.command(f.p, { c: 'setOp', group: f.group.id, op: { k: 'dock', station: f.c.id } })).toBeNull();
    expect(j.state).toBe('paused'); expect(j.held?.ship).toBe(s.id); expect(j.carried).toBe(carried);
    expect(s.logisticsJob).toBeUndefined(); expect(qty(s.cargo, 'ore')).toBe(carried);
    until(f.sim, () => s.state === 'docked' && s.task.k === 'docked' && s.task.station === f.c.id, 400);
    expect(qty(s.cargo, 'ore')).toBe(carried); expect(holding(f.sim, f.p, 'ore')).toBeCloseTo(total0, 6);
    run(f.sim, 10); expect(j.held).toBeDefined();
    // a P12 return (or any idle order) frees the ship: the held shipment rejoins the same ship
    expect(f.sim.command(f.p, { c: 'setOp', group: f.group.id, op: { k: 'idle' } })).toBeNull();
    until(f.sim, () => j.state === 'complete', 900);
    expect(qty(f.dst.storage[f.p], 'ore')).toBe(60); expect(holding(f.sim, f.p, 'ore')).toBeCloseTo(total0, 6);
  });
  it('C3: cancelling a loaded shipment keeps the cargo aboard; it is stowed at the intended destination', () => {
    const f = fixture(125, 1); f.b.storage[f.p].ore = 30;
    const total0 = holding(f.sim, f.p, 'ore');
    expect(f.sim.command(f.p, { c: 'poolCreate', request: { from: f.b.id, to: f.dst.id, item: 'ore', kind: 'transfer', amount: 30, priority: 5, repeat: false } })).toBeNull();
    const j = jobs(f.sim)[0], s = f.ships[0];
    until(f.sim, () => j.carried > 0, 400);
    expect(f.sim.command(f.p, { c: 'poolControl', job: j.id, action: 'cancel' })).toBeNull();
    expect(j.state).toBe('cancelled'); expect(qty(s.cargo, 'ore')).toBe(30); expect(s.logisticsStow).toBe(f.dst.id);
    until(f.sim, () => qty(f.dst.storage[f.p], 'ore') === 30, 900);
    expect(jobs(f.sim).some(x => x.stow && x.state === 'complete')).toBe(true);
    expect(holding(f.sim, f.p, 'ore')).toBeCloseTo(total0, 6);
  });
  it('C4: a destroyed hauler records the loss and the remaining need is re-dispatched', () => {
    const f = fixture(125, 2); f.b.storage[f.p].ore = 120;
    const total0 = holding(f.sim, f.p, 'ore');
    expect(f.sim.command(f.p, { c: 'poolCreate', request: { from: f.b.id, to: f.dst.id, item: 'ore', kind: 'transfer', amount: 60, priority: 5, repeat: false } })).toBeNull();
    const j = jobs(f.sim)[0];
    until(f.sim, () => j.carried > 0 && f.sim.st.ships[j.ship!]?.state === 'space', 400);
    const lost = j.carried, victim = j.ship!;
    (f.sim as any).destroyShip ? (f.sim as any).destroyShip(f.sim.st.ships[victim]) : delete f.sim.st.ships[victim];
    if (f.sim.st.ships[victim]) delete f.sim.st.ships[victim];
    for (const g of Object.values(f.sim.st.groups)) g.shipIds = g.shipIds.filter(id => id !== victim);
    run(f.sim, 2);
    expect(j.lost).toBe(lost); expect(j.ship).toBeUndefined();
    until(f.sim, () => j.state === 'complete', 900);
    expect(qty(f.dst.storage[f.p], 'ore')).toBe(60);
    // conservation: start = end + destroyed
    expect(holding(f.sim, f.p, 'ore') + lost).toBeCloseTo(total0, 6);
  });
  it('C5: a full destination keeps the cargo aboard and resumes when space frees', () => {
    const f = fixture(125, 1); f.b.storage[f.p].ore = 30;
    const room = f.sim.intakeRoom(f.dst, f.p, 'ore', false);
    f.dst.storage[f.p].ore = Math.max(0, room - 10) + (f.dst.storage[f.p].ore ?? 0);
    expect(f.sim.command(f.p, { c: 'poolCreate', request: { from: f.b.id, to: f.dst.id, item: 'ore', kind: 'transfer', amount: 30, priority: 5, repeat: false } })).toBeNull();
    const j = jobs(f.sim)[0], s = f.ships[0];
    until(f.sim, () => j.code === 'storage', 900);
    expect(j.carried).toBe(20); expect(qty(s.cargo, 'ore')).toBe(20);
    f.dst.storage[f.p].ore = 0;
    until(f.sim, () => j.state === 'complete', 300);
    expect(qty(f.dst.storage[f.p], 'ore')).toBe(20);
  });
  it('C6: save/restore mid-transport and with a held shipment keeps every unit', () => {
    const f = fixture(125, 2); f.b.storage[f.p].ore = 60; f.c.storage[f.p].ore = 60;
    const total0 = holding(f.sim, f.p, 'ore');
    for (const st of [f.b, f.c]) expect(f.sim.command(f.p, { c: 'poolCreate', request: { from: st.id, to: f.dst.id, item: 'ore', kind: 'transfer', amount: 60, priority: 5, repeat: false } })).toBeNull();
    until(f.sim, () => jobs(f.sim).every(j => j.carried > 0), 600);
    const g2 = f.sim.newGroup(f.p, '분리'); expect(f.sim.command(f.p, { c: 'moveShip', ship: f.ships[1].id, group: g2.id } as any)).toBeNull();
    expect(f.sim.command(f.p, { c: 'setOp', group: g2.id, op: { k: 'dock', station: f.a.id } })).toBeNull();
    expect(jobs(f.sim).some(j => j.held)).toBe(true);
    const restored = new WorldSim(JSON.parse(f.sim.serialize()), { migrateContent: false });
    expect(holding(restored, f.p, 'ore')).toBeCloseTo(total0, 6);
    expect(restored.command(f.p, { c: 'setOp', group: g2.id, op: { k: 'idle' } })).toBeNull();
    until(restored, () => Object.values(restored.st.logisticsJobs!).every(j => j.state === 'complete'), 1500);
    expect(qty(restored.st.stations[f.dst.id].storage[f.p], 'ore')).toBe(120);
    expect(holding(restored, f.p, 'ore')).toBeCloseTo(total0, 6);
  });
  it('C7: conservation over a busy run — initial + production − consumption = final, loading creates nothing', () => {
    const f = fixture(125, 3), r = recipeFor(f.sim.st, 'alloy_direct')!;
    for (const [item, n] of Object.entries(r.in)) { f.b.storage[f.p][item] = n * 2; f.c.storage[f.p][item] = n * 2; }
    const items = [...new Set([...Object.keys(r.in), ...Object.keys(r.out)])], before = Object.fromEntries(items.map(i => [i, holding(f.sim, f.p, i)]));
    const flow: Record<string, number> = {};
    const stop = observeWorld(f.sim.st, e => { if (e.company !== f.p || !e.item) return; if (e.kind === 'consume') flow[e.item] = (flow[e.item] ?? 0) - e.amount; if (e.kind === 'produce') flow[e.item] = (flow[e.item] ?? 0) + e.amount; });
    expect(f.sim.command(f.p, { c: 'prodOrder', station: f.dst.id, recipe: r.id, mode: 'count', n: 3 })).toBeNull();
    for (let t = 0; t < 900 && (f.dst.orders ?? []).length; t++) {
      run(f.sim, 1);
      if (t === 60) expect(f.sim.command(f.p, { c: 'setOp', group: f.group.id, op: { k: 'dock', station: f.a.id } })).toBeNull();
      if (t === 120) expect(f.sim.command(f.p, { c: 'setOp', group: f.group.id, op: { k: 'idle' } })).toBeNull();
    }
    stop();
    expect(f.dst.orders ?? []).toHaveLength(0);
    for (const i of items) expect(holding(f.sim, f.p, i)).toBeCloseTo(before[i] + (flow[i] ?? 0), 5);
  }, 30000);
});

describe('P12.5 D — military', () => {
  it('D1: pirates raid a loaded hauler for real (P11 engagement); the hauler flees by the existing rule', () => {
    const f = fixture(125, 1); f.b.storage[f.p].ore = 60;
    expect(f.sim.command(f.p, { c: 'poolCreate', request: { from: f.b.id, to: f.dst.id, item: 'ore', kind: 'transfer', amount: 60, priority: 5, repeat: false } })).toBeNull();
    const j = jobs(f.sim)[0], s = f.ships[0];
    until(f.sim, () => j.carried > 0 && s.state === 'space', 400);
    const pg = f.sim.newGroup('pirates', '습격대');
    for (let k = 0; k < 3; k++) f.sim.spawnShip('pirates', 'corvette', 'std', pg.id, { x: s.pos.x + 600 + k * 30, y: 0, z: s.pos.z });
    let fled = false, fought = false;
    for (let t = 0; t < 240 && f.sim.st.ships[s.id]; t += .25) { f.sim.update(.25); fled ||= !!f.sim.st.groups[s.groupId]?.fleeing; fought ||= s.state === 'battle' || (f.sim.st.battleLog?.length ?? 0) > 0; }
    expect(fled || fought).toBe(true);
    // no invulnerability: either the hauler took damage / died, or it escaped into a station
    expect(!f.sim.st.ships[s.id] || s.hp < 1 || s.state === 'docked').toBe(true);
    if (!f.sim.st.ships[s.id]) { run(f.sim, 2); expect(j.lost).toBeGreaterThan(0); }
  });
  it('D2: a blockaded gate stops dispatch with a visible cause; lifting it resumes', () => {
    const f = fixture(125, 1);
    const home = f.sim.sysOf(f.a.pos)!;
    const far = Object.values(f.sim.st.stations).find(st => st.public && f.sim.sysOf(st.pos)?.id !== home.id && f.sim.canDock(st, f.p))!;
    far.storage[f.p] = { ore: 20 };
    // close every gate out of (and back into) the home system: no open jump path remains
    const gates = home.gates.flatMap(g => [g.id, g.exit]);
    f.sim.st.conflicts = { c1: { id: 'c1', a: 'x', b: 'y', gates, since: 0, lost: {} } as any };
    expect(f.sim.command(f.p, { c: 'poolCreate', request: { from: far.id, to: f.dst.id, item: 'ore', kind: 'transfer', amount: 20, priority: 5, repeat: false } })).toBeNull();
    run(f.sim, 20);
    const j = jobs(f.sim)[0];
    expect(j.ship).toBeUndefined(); expect(j.code).toBe('path'); expect(j.reason).toMatch(/점프 경로/);
    delete f.sim.st.conflicts;
    until(f.sim, () => j.state === 'complete', 3000);
    expect(qty(f.dst.storage[f.p], 'ore')).toBe(20);
  });
  it('D3: an escort (existing escort order) follows a hauler group carrying an automatic shipment', () => {
    const f = fixture(125, 1); f.b.storage[f.p].ore = 60;
    const eg = f.sim.newGroup(f.p, '호위대'); for (let k = 0; k < 2; k++) f.sim.spawnShip(f.p, 'frigate', 'std', eg.id, f.a.pos);
    expect(f.sim.command(f.p, { c: 'setOp', group: eg.id, op: { k: 'escort', group: f.group.id } })).toBeNull();
    expect(f.sim.command(f.p, { c: 'poolCreate', request: { from: f.b.id, to: f.dst.id, item: 'ore', kind: 'transfer', amount: 60, priority: 5, repeat: false } })).toBeNull();
    const j = jobs(f.sim)[0];
    expect(eg.shipIds.every(id => !f.sim.st.ships[id].logisticsJob)).toBe(true);
    let near = 0, samples = 0;
    for (let t = 0; t < 900 && j.state !== 'complete'; t += .25) {
      f.sim.update(.25);
      const h = f.sim.st.ships[f.ships[0].id];
      if (h.state === 'space' && t % 5 === 0) { samples++; if (eg.shipIds.some(id => { const e = f.sim.st.ships[id]; return e && Math.hypot(e.pos.x - h.pos.x, e.pos.z - h.pos.z) < 2500; })) near++; }
    }
    expect(j.state).toBe('complete'); expect(eg.shipIds.every(id => !f.sim.st.ships[id].logisticsJob)).toBe(true);
    expect(samples === 0 || near / samples > 0.5).toBe(true);
  });
  it('D4: P12 return takes priority, keeps cargo, and the shipment resumes after the return', () => {
    const f = fixture(125, 1); f.b.storage[f.p].ore = 60;
    f.group.commanderId = f.sim.newCommander(f.p, 2).id;
    expect(f.sim.command(f.p, { c: 'poolCreate', request: { from: f.b.id, to: f.dst.id, item: 'ore', kind: 'transfer', amount: 60, priority: 5, repeat: false } })).toBeNull();
    const j = jobs(f.sim)[0], s = f.ships[0];
    until(f.sim, () => j.carried > 0 && s.state === 'space', 400);
    const carried = j.carried;
    expect(f.sim.command(f.p, { c: 'setOp', group: f.group.id, op: { k: 'return' } })).toBeNull();
    expect(j.held?.ship).toBe(s.id);
    until(f.sim, () => f.group.op.k === 'idle', 900);
    expect(s.state).toBe('docked'); expect(qty(s.cargo, 'ore')).toBe(carried); expect(j.carried).toBe(carried);
    until(f.sim, () => j.state === 'complete', 900);
    expect(qty(f.dst.storage[f.p], 'ore')).toBe(60);
  });
  it('D5: a hostile PMC warship near a hauler makes it evade (logisticsV worlds only)', () => {
    const f = fixture(125, 1); f.b.storage[f.p].ore = 60;
    const q = f.sim.addPlayer('적대 PMC');
    f.sim.command(f.p, { c: 'stance', target: q, v: -1 } as any);
    expect(f.sim.command(f.p, { c: 'poolCreate', request: { from: f.b.id, to: f.dst.id, item: 'ore', kind: 'transfer', amount: 60, priority: 5, repeat: false } })).toBeNull();
    const j = jobs(f.sim)[0], s = f.ships[0];
    until(f.sim, () => j.carried > 0 && s.state === 'space', 400);
    const hg = f.sim.newGroup(q, '습격'); for (let k = 0; k < 3; k++) f.sim.spawnShip(q, 'destroyer', 'std', hg.id, { x: s.pos.x + 700, y: 0, z: s.pos.z + k * 40 });
    let fled = false; for (let t = 0; t < 20 && !fled; t += .25) { f.sim.update(.25); fled = !!f.group.fleeing || s.state === 'battle'; }
    expect(fled).toBe(true);
  });
});

describe('P12.5 E — saves, multiplayer, legacy', () => {
  it('E1: another company cannot exclude, control or see my haulers and shipments', () => {
    const f = fixture(125, 1); const q = f.sim.addPlayer('경쟁사');
    f.b.storage[f.p].ore = 20;
    expect(f.sim.command(f.p, { c: 'poolCreate', request: { from: f.b.id, to: f.dst.id, item: 'ore', kind: 'transfer', amount: 20, priority: 5, repeat: false } })).toBeNull();
    const j = jobs(f.sim)[0];
    expect(f.sim.command(q, { c: 'poolShips', ships: [f.ships[0].id], on: false })).not.toBeNull();
    expect(f.sim.command(q, { c: 'poolControl', job: j.id, action: 'cancel' })).not.toBeNull();
    run(f.sim, 10);
    const view = JSON.parse(JSON.stringify(legacyView(f.sim.st, { company: q }, f.sim.sysOf(f.ships[0].pos)!.id))) as any;
    expect(view.logisticsJobs?.[j.id]).toBeUndefined();
    const ship = view.ships[f.ships[0].id];
    expect(ship.logisticsJob).toBeUndefined(); expect(ship.logisticsExcluded).toBeUndefined(); expect(ship.cargo).toEqual({});
  });
  it('E2: direct haul orders and new routes are refused with a clear reason in P12.5 worlds', () => {
    const f = fixture(125, 1);
    const err = f.sim.command(f.p, { c: 'setOp', group: f.group.id, op: { k: 'haul', from: f.a.id, to: f.dst.id, res: 'ore' } });
    expect(err).toMatch(/자동 물류/);
    const err2 = f.sim.command(f.p, { c: 'putRoute', group: f.group.id, config: { name: 'x', from: f.a.id, to: f.dst.id, item: 'ore', mode: 'transfer', amount: 10, repeat: true } });
    expect(err2).toMatch(/자동 물류/);
  });
  it('E3: legacy worlds are unchanged — no automatic dispatch without registration', () => {
    const sim = WorldSim.create(125), p = sim.addPlayer('레거시');
    const a = sim.st.stations.astra, g = sim.newGroup(p, 'h'), s = sim.spawnShip(p, 'hauler', 'std', g.id, a.pos);
    expect(sim.st.logisticsV).toBeUndefined(); expect(poolMember(sim.st, s)).toBe(false);
    expect(sim.command(p, { c: 'autoLogistics', on: false })).not.toBeNull();
  });
  it('E4: conversion of a legacy save is idempotent and conserves every unit', () => {
    const sim = WorldSim.create(126), p = sim.addPlayer('변환'), co = sim.st.companies[p]; co.credits = 1e7;
    const a = sim.st.stations.astra; a.storage[p] = { ore: 500, alloy: 100 };
    const other = Object.values(sim.st.stations).find(st => st.public && st.id !== a.id && sim.canDock(st, p) && sim.sysOf(st.pos)?.id === sim.sysOf(a.pos)?.id)!;
    const g1 = sim.newGroup(p, '노선'), g2 = sim.newGroup(p, '반복판매'), g3 = sim.newGroup(p, '직접운송');
    const s1 = sim.spawnShip(p, 'hauler', 'std', g1.id, a.pos), s2 = sim.spawnShip(p, 'hauler', 'std', g2.id, a.pos), s3 = sim.spawnShip(p, 'hauler', 'std', g3.id, a.pos);
    for (const s of [s1, s2, s3]) (sim as any).dockShip(s, a);
    expect(sim.command(p, { c: 'putRoute', group: g1.id, config: { name: '단발', from: a.id, to: other.id, item: 'ore', mode: 'transfer', amount: 40, repeat: false } })).toBeNull();
    const sellable = Object.keys(other.market ?? {}).includes('ore');
    if (sellable) expect(sim.command(p, { c: 'putRoute', group: g2.id, config: { name: '판매', from: a.id, to: other.id, item: 'ore', mode: 'sell', amount: 40, repeat: true } })).toBeNull();
    expect(sim.command(p, { c: 'setOp', group: g3.id, op: { k: 'haul', from: a.id, to: other.id, res: 'alloy' } })).toBeNull();
    for (let i = 0; i < 400 && !(qty(s1.cargo, 'ore') > 0 && qty(s3.cargo, 'alloy') > 0); i++) sim.update(.25);
    expect(qty(s1.cargo, 'ore')).toBeGreaterThan(0); expect(qty(s3.cargo, 'alloy')).toBeGreaterThan(0);
    const copy = new WorldSim(JSON.parse(sim.serialize()), { migrateContent: false });
    const sum = (w: WorldSim, item: string) => holding(w, p, item);
    const before = { ore: sum(copy, 'ore'), alloy: sum(copy, 'alloy'), credits: copy.st.companies[p].credits, pos: Object.fromEntries([s1, s2, s3].map(s => [s.id, { ...copy.st.ships[s.id].pos }])) };
    const r1 = enableAutoLogistics(copy);
    expect(r1.already).toBe(false); expect(copy.st.logisticsV).toBe(1);
    expect(r1.routesConverted.length).toBe(1); expect(r1.manifestJobs.length).toBe(1);
    expect(r1.haulGroups.map(x => x.group)).toEqual([g3.id]);
    if (sellable) expect(r1.routesCompat.length).toBe(1);
    expect(sum(copy, 'ore')).toBe(before.ore); expect(sum(copy, 'alloy')).toBe(before.alloy); expect(copy.st.companies[p].credits).toBe(before.credits);
    for (const s of [s1, s2, s3]) expect(copy.st.ships[s.id].pos).toEqual(before.pos[s.id]);
    const snapshot = copy.serialize();
    const r2 = enableAutoLogistics(copy);
    expect(r2.already).toBe(true); expect(copy.serialize()).toBe(snapshot);
    // the converted world delivers the route cargo and the haul cargo without loss
    for (let i = 0; i < 6000 && live(copy).some(j => !j.stow || j.carried > 0); i++) copy.update(.25);
    expect(copy.st.ships[s3.id].cargo.alloy ?? 0).toBe(0);
    expect(sum(copy, 'alloy')).toBeCloseTo(before.alloy, 6);
    // the original legacy world is untouched by the conversion of its copy
    expect(sim.st.logisticsV).toBeUndefined(); expect(Object.keys(sim.st.logistics ?? {}).length).toBeGreaterThan(0);
  }, 30000);
});

void cargoSum; void ({} as WShip);

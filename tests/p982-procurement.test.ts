import { describe, expect, it } from 'vitest';
import { WorldSim } from '../src/world/sim';
import { qty, type Station } from '../src/world/types';
import { moduleMaterials } from '../src/world/stations';
import { recipeFor, TECHS } from '../src/world/industry';
import { buildNeeds, storageCap } from '../src/world/production';
import { planProcurement, defaultProcurementPolicy } from '../src/world/procurement';
import { observeWorld } from '../src/world/observe';
import { grantBlueprint, hullBlueprint } from '../src/world/blueprints';
import { dispatchPool } from '../src/world/autonomousLogistics';
import { GameServer, type Conn } from '../src/server/core';
import { TIER_BASE } from '../src/world/hullops';

function fixture() {
  const sim = WorldSim.create(982), p = sim.addPlayer('자율 조달'), co = sim.st.companies[p]; co.credits = 1e8;
  for (const id of Object.keys(sim.st.ships)) delete sim.st.ships[id];
  for (const id of Object.keys(sim.st.groups)) delete sim.st.groups[id];
  for (const l of Object.values(sim.st.lairs)) { l.alive = false; l.respawnAt = 1e10; }
  for (const sys of Object.values(sim.st.systems)) sys.security = 100;
  const a = sim.st.stations.astra; a.storage[p] = {};
  const make = (id: string, dx: number, modules: string[]): Station => ({ ...structuredClone(a), id, name: id, public: false, owner: p, pos: { ...a.pos, x: a.pos.x + dx }, market: null, funds: undefined, fundsMax: undefined, shipStock: undefined, storage: { [p]: {} }, builds: [], orders: [], jobs: [], listings: [], modules: modules.map((kind, slot) => ({ kind, slot, built: true, progress: 1 })) });
  const dst = make('proc_target', 650, ['core', 'power', 'refinery', 'logistics', 'yard_s']), b = make('proc_b', -500, ['core']), c = make('proc_c', 350, ['core']);
  for (const s of [dst, b, c]) sim.st.stations[s.id] = s;
  const group = sim.newGroup(p, '공용 수송');
  const ships = Array.from({ length: 3 }, () => { const s = sim.spawnShip(p, 'hauler', 'std', group.id, a.pos); (sim as any).dockShip(s, a); return s; });
  expect(sim.command(p, { c: 'poolShips', ships: ships.map(s => s.id), on: true })).toBeNull();
  return { sim, p, co, a, b, c, dst, ships };
}
const run = (sim: WorldSim, seconds: number) => { for (let t = 0; t < seconds; t += .25) sim.update(.25); };
const until = (sim: WorldSim, condition: () => boolean, seconds = 1000) => { for (let t = 0; t < seconds && !condition(); t += .25) sim.update(.25); expect(condition()).toBe(true); };

describe('P9.8.2 procurement planner', () => {
  it('automatically combines multiple company warehouses and completes construction', () => {
    const f = fixture(); expect(f.sim.command(f.p, { c: 'queueModule', station: f.dst.id, kind: 'warehouse' })).toBeNull();
    const plan = f.dst.modules.find(m => m.kind === 'warehouse')!, needs = moduleMaterials(plan);
    for (const [item, n] of Object.entries(needs)) { const x = Math.floor(n / 3); f.a.storage[f.p][item] = x; f.b.storage[f.p][item] = x; f.c.storage[f.p][item] = n - 2 * x; }
    const consumed: Record<string, number> = {}; const stop = observeWorld(f.sim.st, e => { if (e.kind === 'consume' && e.reason === 'facility_construction' && e.station === f.dst.id && e.item) consumed[e.item] = (consumed[e.item] ?? 0) + e.amount; });
    until(f.sim, () => plan.built, 1500); stop();
    const jobs = Object.values(f.sim.st.logisticsJobs ?? {}).filter(j => !!j.procurement);
    expect(jobs.length).toBeGreaterThanOrEqual(3); expect(new Set(jobs.map(j => j.from)).size).toBe(3);
    for (const [item, n] of Object.entries(needs)) expect(qty(f.a.storage[f.p], item) + qty(f.b.storage[f.p], item) + qty(f.c.storage[f.p], item) + qty(f.dst.storage[f.p], item) + f.ships.reduce((sum, s) => sum + qty(s.cargo, item), 0) + (consumed[item] ?? 0)).toBeCloseTo(n, 5);
  });
  it('supplies a real production order using its world-version recipe and finishes a batch', () => {
    const f = fixture(), r = recipeFor(f.sim.st, 'alloy_direct')!; for (const [item, n] of Object.entries(r.in)) f.a.storage[f.p][item] = n;
    expect(f.sim.command(f.p, { c: 'prodOrder', station: f.dst.id, recipe: r.id, mode: 'count', n: 1 })).toBeNull();
    until(f.sim, () => (f.dst.orders ?? []).length === 0, 1000); expect(qty(f.dst.storage[f.p], Object.keys(r.out)[0])).toBe(Object.values(r.out)[0]);
  });
  it('never buys without explicit consent and honors budget, item cap and minimum credits', () => {
    const f = fixture(), r = recipeFor(f.sim.st, 'alloy_direct')!, item = Object.keys(r.in)[0];
    expect(f.sim.command(f.p, { c: 'prodOrder', station: f.dst.id, recipe: r.id, mode: 'count', n: 1 })).toBeNull();
    const before = f.co.credits; run(f.sim, 20); expect(f.co.credits).toBe(before); expect(Object.values(f.sim.st.procurementPlans ?? {}).some(p => p.reason.includes('자동 구매 꺼짐'))).toBe(true);
    const price = f.sim.price(f.a, item, 'buy');
    expect(f.sim.command(f.p, { c: 'procPolicy', settings: { enabled: true, autoBuy: true, budget: price * 2, minCredits: before - price * 2, maxRisk: 100, priceItem: item, maxUnitPrice: price } })).toBeNull();
    const stock = f.a.market![item].stock; planProcurement(f.sim);
    expect(f.co.procurement!.spent).toBeGreaterThan(0); expect(f.co.procurement!.spent).toBeLessThanOrEqual(price * 2 + 1e-6); expect(f.co.credits).toBeGreaterThanOrEqual(before - price * 2 - 1e-6); expect(f.a.market![item].stock).toBeLessThan(stock);
  });
  it('preserves policy defaults and does not over-allocate the same stock across repeated scans', () => {
    const f = fixture(); expect(defaultProcurementPolicy().autoBuy).toBe(false);
    const r = recipeFor(f.sim.st, 'alloy_direct')!, item = Object.keys(r.in)[0]; f.a.storage[f.p][item] = 5;
    expect(f.sim.command(f.p, { c: 'prodOrder', station: f.dst.id, recipe: r.id, mode: 'count', n: 5 })).toBeNull();
    planProcurement(f.sim); const jobs = Object.values(f.sim.st.logisticsJobs ?? {}); expect(jobs.reduce((n, j) => n + j.amount, 0)).toBeLessThanOrEqual(5);
    for (let i = 0; i < 10; i++) planProcurement(f.sim); expect(Object.values(f.sim.st.logisticsJobs ?? {}).length).toBe(jobs.length);
    const restored = new WorldSim(JSON.parse(f.sim.serialize()), { migrateContent: false }); planProcurement(restored);
    expect(Object.values(restored.st.logisticsJobs ?? {}).length).toBe(jobs.length);
  });
  it('delivers the registered hull, preset and equipment needs and launches the real ship', () => {
    const f = fixture(); f.co.tech = Object.keys(TECHS);
    const hull = 'patrol_pathfinder'; expect(grantBlueprint(f.sim.st, f.co, hullBlueprint(hull)!, 'fixture', f.sim.time)).toBe(true);
    expect(f.sim.command(f.p, { c: 'buildShip', station: f.dst.id, classId: 'corvette', loadoutId: '', hull, variant: 'patrol_pathfinder_std', preset: 'pathfinder_patrol' })).toBeNull();
    const build = f.dst.builds![0]; expect(build.started).toBe(false);
    const needs = buildNeeds(build.classId, build.loadoutId, build.fit, build);
    for (const [item, n] of Object.entries(needs)) { f.a.storage[f.p][item] = Math.ceil(n / 2); f.b.storage[f.p][item] = Math.floor(n / 2); }
    until(f.sim, () => Object.values(f.sim.st.ships).some(s => s.owner === f.p && s.hull === hull), 5000);
    expect(f.dst.builds).toHaveLength(0);
    for (const [item, n] of Object.entries(needs)) expect(Object.values(f.sim.st.logisticsJobs ?? {}).filter(j => j.procurement && j.item === item).reduce((sum, j) => sum + j.delivered, 0)).toBeCloseTo(n, 5);
  }, 30000);
  it('purchases once through the real market, restores, physically delivers and produces', () => {
    const f = fixture(), r = recipeFor(f.sim.st, 'alloy_direct')!, price = f.sim.price(f.a, 'ore', 'buy');
    expect(f.sim.command(f.p, { c: 'prodOrder', station: f.dst.id, recipe: r.id, mode: 'count', n: 1 })).toBeNull();
    expect(f.sim.command(f.p, { c: 'procPolicy', settings: { enabled: true, autoBuy: true, budget: price * 60, minCredits: 0, maxRisk: 100, priceItem: 'ore', maxUnitPrice: price } })).toBeNull();
    const credits = f.co.credits, market = f.a.market!.ore.stock; planProcurement(f.sim);
    expect(f.co.procurement!.spent).toBeCloseTo(price * 60, 6); expect(credits - f.co.credits).toBeCloseTo(price * 60, 6); expect(market - f.a.market!.ore.stock).toBe(60);
    expect(qty(f.a.storage[f.p], 'ore')).toBe(60); expect(qty(f.dst.storage[f.p], 'ore')).toBe(0);
    const saved = new WorldSim(JSON.parse(f.sim.serialize()), { migrateContent: false }); planProcurement(saved);
    expect(saved.st.companies[f.p].procurement!.spent).toBeCloseTo(price * 60, 6); expect(Object.values(saved.st.logisticsJobs!).filter(j => j.procurement).length).toBe(1);
    until(saved, () => (saved.st.stations[f.dst.id].orders ?? []).length === 0, 1000);
    expect(qty(saved.st.stations[f.dst.id].storage[f.p], 'alloy')).toBe(14); expect(saved.st.companies[f.p].procurement!.spent).toBeCloseTo(price * 60, 6);
  });
  it('keeps protected stock, replans depleted sources, and never consumes another company’s goods', () => {
    const f = fixture(), q = f.sim.addPlayer('다른 회사'), r = recipeFor(f.sim.st, 'alloy_direct')!;
    f.a.storage[f.p].ore = 20; f.b.storage[f.p].ore = 40; f.c.storage[f.p].ore = 60; f.a.storage[q].ore = 500;
    expect(f.sim.command(f.p, { c: 'procPolicy', settings: { enabled: true, autoBuy: false, budget: 0, minCredits: 0, maxRisk: 100, protectStation: f.a.id, protectItem: 'ore', protectAmount: 20 } })).toBeNull();
    expect(f.sim.command(f.p, { c: 'prodOrder', station: f.dst.id, recipe: r.id, mode: 'count', n: 1 })).toBeNull(); planProcurement(f.sim);
    expect(Object.values(f.sim.st.logisticsJobs!).filter(j => j.procurement).every(j => j.from !== f.a.id)).toBe(true);
    f.c.storage[f.p].ore = 0; planProcurement(f.sim);
    const jobs = Object.values(f.sim.st.logisticsJobs!).filter(j => j.procurement && j.state !== 'cancelled');
    expect(jobs.reduce((n, j) => n + j.amount, 0)).toBeLessThanOrEqual(40); expect(qty(f.a.storage[q], 'ore')).toBe(500); expect(qty(f.a.storage[f.p], 'ore')).toBe(20);
  });
  it('cancels obsolete work on origin cancellation without deleting loaded cargo or refunding it remotely', () => {
    const f = fixture(); expect(f.sim.command(f.p, { c: 'queueModule', station: f.dst.id, kind: 'warehouse' })).toBeNull();
    const m = f.dst.modules.find(x => x.kind === 'warehouse')!; for (const [item, n] of Object.entries(moduleMaterials(m))) f.a.storage[f.p][item] = n;
    until(f.sim, () => Object.values(f.sim.st.logisticsJobs ?? {}).some(j => !!j.procurement && j.carried > 0), 30);
    const j = Object.values(f.sim.st.logisticsJobs!).find(x => !!x.procurement && x.carried > 0)!, ship = f.sim.st.ships[j.ship!], item = j.item, onShip = qty(ship.cargo, item);
    expect(f.sim.command(f.p, { c: 'planOp', station: f.dst.id, plan: m.id!, op: 'cancel' })).toBeNull(); planProcurement(f.sim);
    expect(j.state).toBe('cancelled'); expect(qty(ship.cargo, item)).toBe(onShip); expect(j.reserved).toBe(0);
    const restored = new WorldSim(JSON.parse(f.sim.serialize()), { migrateContent: false }); planProcurement(restored);
    expect(qty(restored.st.ships[ship.id].cargo, item)).toBe(onShip); expect(restored.st.logisticsJobs![j.id].state).toBe('cancelled');
  });
  it('holds a lost source reservation at its original location and explains why it cannot be returned', () => {
    const f = fixture(); expect(f.sim.command(f.p, { c: 'queueModule', station: f.dst.id, kind: 'warehouse' })).toBeNull();
    const m = f.dst.modules.find(x => x.kind === 'warehouse')!, needs = moduleMaterials(m); for (const [item, n] of Object.entries(needs)) f.b.storage[f.p][item] = n;
    planProcurement(f.sim); run(f.sim, 6); const j = Object.values(f.sim.st.logisticsJobs!).find(x => x.procurement && x.reserved > 0)!; expect(j).toBeTruthy();
    delete f.sim.st.stations[j.from]; planProcurement(f.sim);
    const p = f.sim.st.procurementPlans![j.procurement!]; expect(p.reason).toContain('출발지 소실'); expect(j.reserved).toBeGreaterThan(0);
    expect(f.sim.command(f.p, { c: 'planOp', station: f.dst.id, plan: m.id!, op: 'cancel' })).toBeNull(); planProcurement(f.sim);
    expect(j.reserved).toBeGreaterThan(0); expect(p.reason).toContain('출발지 소실');
  });
  it('shares scarce stock between two construction plans and a manual request without duplicating it', () => {
    const f = fixture(); f.a.storage[f.p].alloy = 50;
    expect(f.sim.command(f.p, { c: 'poolCreate', request: { from: f.a.id, to: f.c.id, item: 'alloy', kind: 'transfer', amount: 15, priority: 9, repeat: false } })).toBeNull();
    expect(f.sim.command(f.p, { c: 'queueModule', station: f.dst.id, kind: 'warehouse' })).toBeNull();
    expect(f.sim.command(f.p, { c: 'queueModule', station: f.b.id, kind: 'warehouse' })).toBeNull();
    planProcurement(f.sim);
    const jobs = Object.values(f.sim.st.logisticsJobs!).filter(j => j.item === 'alloy' && j.state !== 'cancelled');
    expect(jobs.reduce((n, j) => n + j.amount, 0)).toBeLessThanOrEqual(50);
    run(f.sim, 5);
    expect(qty(f.a.storage[f.p], 'alloy') + jobs.reduce((n, j) => n + j.reserved + j.carried + j.delivered, 0)).toBeCloseTo(50, 6);
    for (let i = 0; i < 4; i++) planProcurement(f.sim);
    expect(Object.values(f.sim.st.logisticsJobs!).filter(j => j.item === 'alloy' && j.state !== 'cancelled').reduce((n, j) => n + j.reserved + j.carried + Math.max(0, j.amount - j.cycleDelivered - j.reserved - j.carried), 0)).toBeLessThanOrEqual(50);
  });
  it('does not count a manual outbound claim as local supply for a production order', () => {
    const f = fixture();
    expect(f.sim.command(f.p, { c: 'poolCreate', request: { from: f.dst.id, to: f.c.id, item: 'ore', kind: 'transfer', amount: 20, priority: 9, repeat: false } })).toBeNull();
    expect(f.sim.command(f.p, { c: 'prodOrder', station: f.dst.id, recipe: 'alloy_direct', mode: 'count', n: 1 })).toBeNull();
    f.dst.storage[f.p].ore = 60; f.a.storage[f.p].ore = 20; planProcurement(f.sim);
    const plan = Object.values(f.sim.st.procurementPlans!).find(p => p.station === f.dst.id && p.item === 'ore')!;
    expect(plan.local).toBe(40); expect(plan.planned).toBe(20); dispatchPool(f.sim);
    until(f.sim, () => f.dst.orders!.length === 0, 1000); expect(qty(f.c.storage[f.p], 'ore')).toBe(20); expect(qty(f.dst.storage[f.p], 'alloy')).toBe(14);
  });
  it('does not allocate the same local stock to a second origin after a higher-priority outbound plan claims it', () => {
    const f = fixture(); f.b.modules.push({ kind: 'refinery', slot: 5, built: true, progress: 1 });
    expect(f.sim.command(f.p, { c: 'prodOrder', station: f.b.id, recipe: 'alloy_direct', mode: 'count', n: 1 })).toBeNull();
    expect(f.sim.command(f.p, { c: 'prodOrder', station: f.dst.id, recipe: 'alloy_direct', mode: 'count', n: 1 })).toBeNull();
    expect(f.sim.command(f.p, { c: 'procSource', station: f.dst.id, kind: 'production', source: f.dst.orders![0].id, enabled: true, priority: 9 })).toBeNull();
    f.b.storage[f.p].ore = 60; planProcurement(f.sim);
    const plans = Object.values(f.sim.st.procurementPlans!), local = plans.find(p => p.station === f.b.id && p.item === 'ore')!, remote = plans.find(p => p.station === f.dst.id && p.item === 'ore')!;
    expect(remote.planned).toBe(60); expect(local.local).toBe(0); expect(local.shortage).toBe(60);
  });
  it('supplies production without requiring an optional logistics centre and bounds repeat orders to one batch', () => {
    const f = fixture(); f.dst.modules = f.dst.modules.filter(m => m.kind !== 'logistics'); f.a.storage[f.p].ore = 600;
    expect(f.sim.command(f.p, { c: 'prodOrder', station: f.dst.id, recipe: 'alloy_direct', mode: 'stock', n: 1000 })).toBeNull();
    planProcurement(f.sim); for (let i = 0; i < 8; i++) planProcurement(f.sim);
    expect(Object.values(f.sim.st.logisticsJobs!).filter(j => j.procurement && j.state !== 'cancelled').reduce((n, j) => n + j.amount, 0)).toBe(60);
    until(f.sim, () => qty(f.dst.storage[f.p], 'alloy') >= 14, 1000);
    expect(Object.values(f.sim.st.logisticsJobs!).some(j => j.procurement && j.kind === 'transfer' && j.delivered > 0)).toBe(true);
  });
  it('keeps two companies’ stock, ships, allocations and policies isolated', () => {
    const f = fixture(), q = f.sim.addPlayer('회사 둘'), company = f.sim.st.companies[q]; company.credits = 1e8;
    const target: Station = { ...structuredClone(f.dst), id: 'second_company_target', owner: q, storage: { [q]: {} }, builds: [], orders: [], jobs: [], listings: [] };
    f.sim.st.stations[target.id] = target; const group = f.sim.newGroup(q, '다른 회사 수송');
    const ship = f.sim.spawnShip(q, 'hauler', 'std', group.id, f.a.pos); (f.sim as any).dockShip(ship, f.a);
    expect(f.sim.command(q, { c: 'poolShips', ships: [ship.id], on: true })).toBeNull(); f.a.storage[f.p].ore = 31; f.a.storage[q].ore = 27;
    expect(f.sim.command(f.p, { c: 'prodOrder', station: f.dst.id, recipe: 'alloy_direct', mode: 'count', n: 1 })).toBeNull();
    expect(f.sim.command(q, { c: 'prodOrder', station: target.id, recipe: 'alloy_direct', mode: 'count', n: 1 })).toBeNull();
    planProcurement(f.sim); const jobs = Object.values(f.sim.st.logisticsJobs!).filter(j => !!j.procurement && j.state !== 'cancelled');
    expect(jobs.filter(j => j.owner === f.p).reduce((n, j) => n + j.amount, 0)).toBe(31);
    expect(jobs.filter(j => j.owner === q).reduce((n, j) => n + j.amount, 0)).toBe(27);
    run(f.sim, 4); expect(jobs.every(j => !j.ship || f.sim.st.ships[j.ship].owner === j.owner)).toBe(true);
    expect(f.sim.command(q, { c: 'procSource', station: f.dst.id, kind: 'production', source: f.dst.orders![0].id, enabled: false })).not.toBeNull();
  });
  it('safely preserves loaded cargo and stops duplicate automation after a direct ship command', () => {
    const f = fixture(); expect(f.sim.command(f.p, { c: 'queueModule', station: f.dst.id, kind: 'warehouse' })).toBeNull();
    const m = f.dst.modules.find(x => x.kind === 'warehouse')!; for (const [item, n] of Object.entries(moduleMaterials(m))) f.a.storage[f.p][item] = n;
    until(f.sim, () => Object.values(f.sim.st.logisticsJobs ?? {}).some(j => !!j.procurement && j.carried > 0), 30);
    const j = Object.values(f.sim.st.logisticsJobs!).find(x => !!x.procurement && x.carried > 0)!, ship = f.sim.st.ships[j.ship!], original = qty(ship.cargo, j.item);
    expect(f.sim.command(f.p, { c: 'moveShip', ship: ship.id, group: ship.groupId })).toBeNull();
    expect(j.state).toBe('paused'); expect(qty(ship.cargo, j.item)).toBe(original); const count = Object.values(f.sim.st.logisticsJobs!).filter(x => x.procurement === j.procurement && x.state !== 'cancelled').length;
    for (let i = 0; i < 5; i++) planProcurement(f.sim);
    expect(Object.values(f.sim.st.logisticsJobs!).filter(x => x.procurement === j.procurement && x.state !== 'cancelled').length).toBe(count);
    expect(f.sim.st.procurementPlans![j.procurement!].reason).toContain('일시정지');
  });
  it('transports a fractional construction shortfall without rounding it away or fabricating stock', () => {
    const f = fixture(); expect(f.sim.command(f.p, { c: 'queueModule', station: f.dst.id, kind: 'warehouse' })).toBeNull();
    const m = f.dst.modules.find(x => x.kind === 'warehouse')!, needs = moduleMaterials(m), item = Object.keys(needs)[0];
    m.reserved = { ...needs, [item]: needs[item] - .5 }; f.a.storage[f.p][item] = .5;
    planProcurement(f.sim); const j = Object.values(f.sim.st.logisticsJobs!).find(x => x.procurement && x.item === item)!;
    expect(j.amount).toBeCloseTo(.5); until(f.sim, () => m.built, 1500); expect(j.delivered).toBeCloseTo(.5); expect(qty(f.a.storage[f.p], item)).toBe(0);
  });
  it('disables an origin immediately, returns reservations, and resumes only after re-enabling it', () => {
    const f = fixture(); f.a.storage[f.p].ore = 60;
    expect(f.sim.command(f.p, { c: 'prodOrder', station: f.dst.id, recipe: 'alloy_direct', mode: 'count', n: 1 })).toBeNull(); const o = f.dst.orders![0];
    planProcurement(f.sim); dispatchPool(f.sim); const old = Object.values(f.sim.st.logisticsJobs!).find(j => !!j.procurement)!; expect(old.reserved).toBe(60);
    expect(f.sim.command(f.p, { c: 'procSource', station: f.dst.id, kind: 'production', source: o.id, enabled: false })).toBeNull();
    expect(old.state).toBe('cancelled'); expect(old.reserved).toBe(0); for (let i = 0; i < 3; i++) planProcurement(f.sim);
    expect(Object.values(f.sim.st.logisticsJobs!).filter(j => !!j.procurement && j.state !== 'cancelled')).toHaveLength(0);
    expect(f.sim.command(f.p, { c: 'procSource', station: f.dst.id, kind: 'production', source: o.id, enabled: true, priority: 9 })).toBeNull();
    planProcurement(f.sim); expect(Object.values(f.sim.st.logisticsJobs!).some(j => !!j.procurement && j.state !== 'cancelled' && j.priority === 9)).toBe(true);
  });
  it('resumes an origin-paused shipment with its original loaded cargo and completes construction', () => {
    const f = fixture(); expect(f.sim.command(f.p, { c: 'queueModule', station: f.dst.id, kind: 'warehouse' })).toBeNull();
    const m = f.dst.modules.find(x => x.kind === 'warehouse')!; for (const [item, n] of Object.entries(moduleMaterials(m))) f.a.storage[f.p][item] = n;
    until(f.sim, () => Object.values(f.sim.st.logisticsJobs ?? {}).some(j => !!j.procurement && j.carried > 0), 30);
    const job = Object.values(f.sim.st.logisticsJobs!).find(j => !!j.procurement && j.carried > 0)!, ship = f.sim.st.ships[job.ship!], cargo = qty(ship.cargo, job.item), jobId = job.id;
    expect(f.sim.command(f.p, { c: 'procSource', station: f.dst.id, kind: 'construction', source: m.id!, enabled: false })).toBeNull();
    expect(job.state).toBe('paused'); expect(job.procurementSuspended).toBe(true); expect(f.sim.command(f.p, { c: 'poolControl', job: jobId, action: 'resume' })).toContain('원본 작업'); run(f.sim, 20);
    expect(job.state).toBe('paused'); expect(qty(ship.cargo, job.item)).toBe(cargo);
    const restored = new WorldSim(JSON.parse(f.sim.serialize()), { migrateContent: false });
    expect(restored.command(f.p, { c: 'procSource', station: f.dst.id, kind: 'construction', source: m.id!, enabled: true })).toBeNull();
    planProcurement(restored); expect(restored.st.logisticsJobs![jobId].state).toBe('active');
    until(restored, () => !!restored.st.stations[f.dst.id].modules.find(x => x.id === m.id)?.built, 1500);
    expect(restored.st.logisticsJobs![jobId].delivered).toBe(cargo);
  });
  it('waits with real cargo when a destination fills, then recovers and produces', () => {
    const f = fixture(); f.a.storage[f.p].ore = 60;
    expect(f.sim.command(f.p, { c: 'prodOrder', station: f.dst.id, recipe: 'alloy_direct', mode: 'count', n: 1 })).toBeNull();
    until(f.sim, () => Object.values(f.sim.st.logisticsJobs ?? {}).some(j => !!j.procurement && j.carried > 0), 30);
    const job = Object.values(f.sim.st.logisticsJobs!).find(j => !!j.procurement && j.carried > 0)!, ship = f.sim.st.ships[job.ship!], cargo = qty(ship.cargo, 'ore');
    f.dst.storage[f.p].crystal = storageCap(f.dst); until(f.sim, () => job.code === 'storage', 300);
    expect(qty(ship.cargo, 'ore')).toBe(cargo); expect(job.delivered).toBe(0);
    delete f.dst.storage[f.p].crystal; until(f.sim, () => f.dst.orders!.length === 0, 1000);
    expect(qty(f.dst.storage[f.p], 'alloy')).toBe(14); expect(job.delivered).toBe(60);
  });
  it('uses only the company-owned stock at an external private warehouse', () => {
    const f = fixture(), q = f.sim.addPlayer('외부 보관항 소유자'); f.b.owner = q; f.b.storage[f.p].ore = 60; f.b.storage[q] = { ore: 90 };
    expect(f.sim.command(f.p, { c: 'prodOrder', station: f.dst.id, recipe: 'alloy_direct', mode: 'count', n: 1 })).toBeNull();
    until(f.sim, () => f.dst.orders!.length === 0, 1000);
    expect(qty(f.b.storage[q], 'ore')).toBe(90); expect(qty(f.dst.storage[f.p], 'alloy')).toBe(14);
    expect(Object.values(f.sim.st.logisticsJobs!).some(j => j.procurement && j.from === f.b.id && j.delivered === 60)).toBe(true);
  });
  it('resumes already loaded cargo even if its external source becomes empty or disappears', () => {
    const f = fixture(), q = f.sim.addPlayer('외부 보관항 소유자'); f.b.owner = q; f.b.storage[f.p].ore = 60;
    expect(f.sim.command(f.p, { c: 'prodOrder', station: f.dst.id, recipe: 'alloy_direct', mode: 'count', n: 1 })).toBeNull(); const order = f.dst.orders![0];
    until(f.sim, () => Object.values(f.sim.st.logisticsJobs ?? {}).some(j => !!j.procurement && j.carried === 60), 300);
    const job = Object.values(f.sim.st.logisticsJobs!).find(j => !!j.procurement && j.carried === 60)!; expect(qty(f.b.storage[f.p], 'ore')).toBe(0);
    expect(f.sim.command(f.p, { c: 'procSource', station: f.dst.id, kind: 'production', source: order.id, enabled: false })).toBeNull();
    delete f.sim.st.stations[f.b.id];
    expect(f.sim.command(f.p, { c: 'procSource', station: f.dst.id, kind: 'production', source: order.id, enabled: true })).toBeNull();
    planProcurement(f.sim); expect(job.state).toBe('active');
    until(f.sim, () => f.dst.orders!.length === 0, 1000); expect(job.delivered).toBe(60); expect(job.lost).toBe(0); expect(qty(f.dst.storage[f.p], 'alloy')).toBe(14);
  });
  it('does not disclose another company’s procurement plans or policy in network snapshots', () => {
    const f = fixture(), other = f.sim.addPlayer('다른 회사'); f.a.storage[f.p].ore = 60;
    expect(f.sim.command(f.p, { c: 'prodOrder', station: f.dst.id, recipe: 'alloy_direct', mode: 'count', n: 1 })).toBeNull(); planProcurement(f.sim);
    const server = new GameServer({ v: 1, world: JSON.parse(f.sim.serialize()), auth: {} }, { singleplayer: false, snapInterval: 1 }); const sent: any[] = [];
    const conn = { company: other, send: (msg: any) => sent.push(msg), view: 'astra' } as unknown as Conn;
    (server as any).sendSnap(conn, (server as any).snapBase()); const state = sent[0].state;
    expect(Object.keys(state.procurementPlans)).toHaveLength(0); expect(state.companies[f.p].procurement).toBeUndefined(); expect(Object.keys(state.logisticsJobs)).toHaveLength(0);
  });
  it('transports the registered high-tier regional hull materials and starts the real build', () => {
    const f = fixture(); f.co.tech = Object.keys(TECHS); f.dst.size = 'XL';
    f.dst.modules = ['core', 'power', 'power', 'yard_xl', 'logistics', ...TIER_BASE[4].filter(k => k !== 'power')].map((kind, slot) => ({ kind, slot, built: true, progress: 1 }));
    const hull = 'dreadnought_mk1', preset = 'dreadnought_std'; expect(grantBlueprint(f.sim.st, f.co, hullBlueprint(hull)!, 'fixture', f.sim.time)).toBe(true);
    Object.assign(f.dst.storage[f.p], buildNeeds('dreadnought', 'std', [], { hull, variant: `${hull}_std`, preset }));
    f.a.storage[f.p].dense_alloy = 20; f.b.storage[f.p].singular_alloy = 40;
    expect(f.sim.command(f.p, { c: 'buildShip', station: f.dst.id, classId: 'dreadnought', loadoutId: 'std', hull, variant: `${hull}_std`, preset })).toBeNull();
    const b = f.dst.builds![0]; expect(b.started).toBe(false); expect(b.regionalMaterials).toEqual({ dense_alloy: 20, singular_alloy: 40 });
    const consumed: Record<string, number> = {}; const stop = observeWorld(f.sim.st, e => { if (e.kind === 'consume' && e.reason === 'ship_construction' && e.company === f.p && e.item) consumed[e.item] = (consumed[e.item] ?? 0) + e.amount; });
    until(f.sim, () => b.started, 1500); stop(); expect(consumed.dense_alloy).toBe(20); expect(consumed.singular_alloy).toBe(40);
    expect(qty(f.a.storage[f.p], 'dense_alloy')).toBe(0); expect(qty(f.b.storage[f.p], 'singular_alloy')).toBe(0);
  });
  it('records only destroyed cargo as lost and reassigns the remaining material from real stock', () => {
    const f = fixture(); f.a.storage[f.p].ore = 120;
    expect(f.sim.command(f.p, { c: 'prodOrder', station: f.dst.id, recipe: 'alloy_direct', mode: 'count', n: 1 })).toBeNull();
    until(f.sim, () => Object.values(f.sim.st.logisticsJobs ?? {}).some(j => !!j.procurement && j.carried > 0), 30);
    const job = Object.values(f.sim.st.logisticsJobs!).find(j => !!j.procurement && j.carried > 0)!, lost = job.carried; delete f.sim.st.ships[job.ship!];
    until(f.sim, () => f.dst.orders!.length === 0, 1000);
    expect(job.lost).toBe(lost); expect(job.delivered).toBe(60); expect(qty(f.a.storage[f.p], 'ore')).toBe(120 - lost - 60); expect(qty(f.dst.storage[f.p], 'alloy')).toBe(14);
  });
  it('excludes risky source systems until the player permits their route risk', () => {
    const f = fixture(), market = f.sim.st.stations.helios, sys = f.sim.sysOf(market.pos)!; expect(sys.id).not.toBe(f.sim.sysOf(f.dst.pos)!.id);
    sys.security = 0; market.storage[f.p].ore = 60;
    expect(f.sim.command(f.p, { c: 'procPolicy', settings: { enabled: true, autoBuy: false, budget: 0, minCredits: 0, maxRisk: 20 } })).toBeNull();
    expect(f.sim.command(f.p, { c: 'prodOrder', station: f.dst.id, recipe: 'alloy_direct', mode: 'count', n: 1 })).toBeNull(); planProcurement(f.sim);
    expect(Object.values(f.sim.st.logisticsJobs ?? {}).filter(j => !!j.procurement && j.state !== 'cancelled')).toHaveLength(0);
    expect(f.sim.command(f.p, { c: 'procPolicy', settings: { enabled: true, autoBuy: false, budget: 0, minCredits: 0, maxRisk: 100 } })).toBeNull(); planProcurement(f.sim);
    expect(Object.values(f.sim.st.logisticsJobs ?? {}).some(j => !!j.procurement && j.from === market.id && j.amount === 60)).toBe(true);
  });
});

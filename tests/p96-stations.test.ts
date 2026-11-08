import { describe, expect, it } from 'vitest';
import { WorldSim } from '../src/world/sim';
import { STATION_SIZES, facilityProblem, occupiedCapacity, stationBerths, moduleUnlocks } from '../src/world/stations';
import { stationPower, stepProduction, stepBuilds, storageCap } from '../src/world/production';
import { forecast, stepUpkeep } from '../src/world/upkeep';
import { qty } from '../src/world/types';
import { queueShortfall } from '../src/world/construction';
import { berthFits } from '../src/world/hullops';
import { secAt } from '../src/world/security';
import { observeWorld, type Observation } from '../src/world/observe';
import type { Size } from '../src/content/schema';
import type { ShipBuild } from '../src/world/types';

function fixture(size: Size = 'S') {
  const sim = WorldSim.create(961); (sim as any).npcSlow = () => {};
  for (const l of Object.values(sim.st.lairs)) { l.alive = false; l.respawnAt = 1e10; }
  const p = sim.addPlayer('시설 시험'), co = sim.st.companies[p]; co.credits = 1_000_000;
  const g = sim.newGroup(p, '공작반'), system = sim.st.systems.quiet;
  const at = { x: system.origin.x + 10000, y: 0, z: 0 };
  const ship = sim.spawnShip(p, 'constructor', 'std', g.id, at);
  const credits = co.credits;
  expect(sim.command(p, { c: 'setOp', group: g.id, op: { k: 'found', at, name: '시험 현장', size } })).toBeNull();
  expect(co.credits).toBe(credits - STATION_SIZES[size].credits);
  sim.update(.25);
  const st = Object.values(sim.st.stations).find(s => s.owner === p)!;
  expect(st).toBeTruthy();
  return { sim, p, co, st, g, ship, at };
}
function completeCore(f: ReturnType<typeof fixture>) {
  const m = f.st.modules[0]; m.built = true; m.progress = 1; delete m.reserved; delete m.used;
}
function built(f: ReturnType<typeof fixture>, kind: string) {
  const slot = Math.max(...f.st.modules.map(m => m.slot)) + 1;
  f.st.modules.push({ kind, slot, built: true, progress: 1 });
}

describe('P9.6 sized stations', () => {
  it.each(['S', 'M', 'L', 'XL'] as Size[])('creates %s with its exact paid foundation plan and capacity', size => {
    const f = fixture(size), spec = STATION_SIZES[size];
    expect(f.st.size).toBe(size); expect(queueShortfall(f.st)).toEqual(spec.mats);
    expect(f.st.modules[0].materials).toEqual(spec.mats); expect(f.st.modules[0].paid).toBe(spec.credits);
    expect(storageCap(f.st)).toBe(0); // a construction site is not a general warehouse
    completeCore(f);
    expect(storageCap(f.st)).toBe(spec.storage); expect(stationPower(f.st).supply).toBe(spec.power);
    expect(moduleUnlocks(f.st, 'core')).toContain(spec.storage.toLocaleString());
    expect(stationBerths(f.st)).toBe(spec.berths); expect(forecast(f.sim.st, f.co).station).toBe(spec.upkeep);
    for (let i = 0; i < spec.capacity; i++) expect(f.sim.command(f.p, { c: 'queueModule', station: f.st.id, kind: 'warehouse' })).toBeNull();
    expect(occupiedCapacity(f.st)).toBe(spec.capacity);
    expect(f.sim.command(f.p, { c: 'queueModule', station: f.st.id, kind: 'warehouse' })).toMatch(/용량|슬롯/);
  });

  it('changes foundation escrow by the price difference and refunds the actual paid amount exactly once', () => {
    const f = fixture('S'); // establish a second in-flight order away from the site
    const g = f.sim.newGroup(f.p, '변경 공작반'); f.sim.spawnShip(f.p, 'constructor', 'std', g.id, f.sim.st.stations.astra.pos);
    const target = { x: f.sim.st.systems.rime.origin.x + 10000, y: 0, z: 0 }, before = f.co.credits;
    expect(f.sim.command(f.p, { c: 'setOp', group: g.id, op: { k: 'found', at: target, name: '변경', size: 'S' } })).toBeNull();
    expect(f.sim.command(f.p, { c: 'setOp', group: g.id, op: { k: 'found', at: target, name: '변경', size: 'M' } })).toBeNull();
    expect(f.co.credits).toBe(before - STATION_SIZES.M.credits);
    expect(f.sim.command(f.p, { c: 'setOp', group: g.id, op: { k: 'found', at: target, name: '변경', size: 'S' } })).toBeNull();
    expect(f.co.credits).toBe(before - STATION_SIZES.S.credits);
    expect(f.sim.command(f.p, { c: 'setOp', group: g.id, op: { k: 'idle' } })).toBeNull();
    expect(f.co.credits).toBe(before); expect(f.co.foundingEscrow).toBeUndefined();
    expect(f.sim.command(f.p, { c: 'setOp', group: g.id, op: { k: 'found', at: target, name: '오류', size: '__proto__' as Size } })).toMatch(/규모/);
    expect(f.co.credits).toBe(before);
  });

  it('retains old stations and c0 as legacy and gates industrial tiers only on new stations', () => {
    const f = fixture('S'); completeCore(f);
    built(f, 'yard_s'); f.co.tech!.push('medium_hulls');
    expect(facilityProblem(f.st, 'yard_m')).toMatch(/규모/);
    expect(f.sim.command(f.p, { c: 'queueModule', station: f.st.id, kind: 'yard_m' })).toMatch(/규모/);
    delete f.st.size;
    expect(storageCap(f.st)).toBe(20_000); expect(facilityProblem(f.st, 'yard_m')).toBeNull();
    expect(stationBerths(f.st)).toBeUndefined(); expect(forecast(f.sim.st, f.co).station).toBe(0);
  });

  it('rejects inherited and malformed facility identifiers without altering credits or plans', () => {
    const f = fixture(); completeCore(f);
    const credits = f.co.credits, count = f.st.modules.length;
    for (const kind of ['constructor', '__proto__', 'toString', '', null]) {
      expect(f.sim.command(f.p, { c: 'queueModule', station: f.st.id, kind: kind as string })).toMatch(/건설 불가/);
      expect(f.co.credits).toBe(credits); expect(Number.isFinite(f.co.credits)).toBe(true);
      expect(f.st.modules).toHaveLength(count);
    }
  });

  it('defaults a new unsized founding command to S while leaving a saved legacy order unchanged', () => {
    const f = fixture('S'), group = f.sim.newGroup(f.p, '구형 클라이언트');
    const at = { ...f.sim.st.systems.rime.origin, x: f.sim.st.systems.rime.origin.x + 10000 };
    f.sim.spawnShip(f.p, 'constructor', 'std', group.id, at);
    expect(f.sim.command(f.p, { c: 'setOp', group: group.id, op: { k: 'found', at, name: '기본 규모' } })).toBeNull();
    expect(group.op.k === 'found' && group.op.size).toBe('S');
    f.sim.update(.25);
    expect(Object.values(f.sim.st.stations).find(st => st.name === '기본 규모')?.size).toBe('S');
  });

  it('limits power, resumes production, and never duplicates a batch held by a full warehouse', () => {
    const f = fixture(); completeCore(f); built(f, 'refinery'); built(f, 'refinery'); built(f, 'warehouse');
    const store = f.st.storage[f.p]; store.ore = 40;
    expect(f.sim.command(f.p, { c: 'prodOrder', station: f.st.id, recipe: 'metal', mode: 'count', n: 1 })).toBeNull();
    stepProduction(f.st, f.co, 0, f.sim.st);
    expect(qty(store, 'ore')).toBe(0); expect(f.st.jobs).toHaveLength(1);
    expect(stationPower(f.st).factor).toBeCloseTo(20 / 32);
    const job = f.st.jobs![0], left = job.left; stepProduction(f.st, f.co, 10, f.sim.st);
    expect(left - job.left).toBeCloseTo(10 * 20 / 32);
    built(f, 'power'); expect(stationPower(f.st).factor).toBe(1);
    store.ore = storageCap(f.st); stepProduction(f.st, f.co, 200, f.sim.st);
    expect(job.left).toBe(0); expect(qty(store, 'metal')).toBe(0); expect(f.st.jobs).toHaveLength(1);
    store.ore -= 20; stepProduction(f.st, f.co, .25, f.sim.st);
    expect(qty(store, 'metal')).toBe(20); expect(f.st.jobs).toHaveLength(0);
    stepProduction(f.st, f.co, 1, f.sim.st); expect(qty(store, 'metal')).toBe(20);
  });

  it('suspends instant support and defense on a brownout, then restores them when power is added', () => {
    const f = fixture(); completeCore(f); built(f, 'armory'); built(f, 'defense'); built(f, 'trade_hub');
    expect(stationPower(f.st).factor).toBeLessThan(1);
    expect(f.sim.shipFxOf(f.ship).magMul).toBe(1); expect(f.sim.hasExchange(f.st)).toBe(false);
    const insecure = secAt(f.sim.st, f.st.pos);
    built(f, 'power'); expect(stationPower(f.st).factor).toBe(1);
    expect(f.sim.shipFxOf(f.ship).magMul).toBe(1.5); expect(f.sim.hasExchange(f.st)).toBe(true);
    expect(secAt(f.sim.st, f.st.pos)).toBeGreaterThan(insecure);
    f.st.storage[f.p].alloy = 10;
    expect(f.sim.command(f.p, { c: 'list', station: f.st.id, item: 'alloy', qty: 10, price: 5 })).toBeNull();
    const hub = f.st.modules.find(m => m.kind === 'trade_hub')!;
    expect(f.sim.command(f.p, { c: 'removeModule', station: f.st.id, slot: hub.slot })).toMatch(/매물/);
  });

  it('charges only sized stations through the existing upkeep account', () => {
    const f = fixture(); completeCore(f);
    const prior = f.co.upkeep?.acc ?? 0, without = forecast(f.sim.st, f.co).perHour;
    const hourly = STATION_SIZES.S.upkeep; f.st.size = undefined;
    expect(without - forecast(f.sim.st, f.co).perHour).toBe(hourly);
    f.st.size = 'S'; f.sim.st.time += 1; stepUpkeep(f.sim.st, f.co, 1);
    expect(f.co.upkeep!.acc - prior).toBeGreaterThanOrEqual(hourly / 3600);
  });

  it('settles the station charge once and retains it over a save and restart', () => {
    const f = fixture(); completeCore(f);
    for (const [id, ship] of Object.entries(f.sim.st.ships)) if (ship.owner === f.p) delete f.sim.st.ships[id];
    const before = f.co.credits, accruedFleet = f.co.upkeep?.acc ?? 0;
    f.sim.st.time += 3600; stepUpkeep(f.sim.st, f.co, 3600);
    expect(before - f.co.credits).toBeCloseTo(STATION_SIZES.S.upkeep + accruedFleet, 6);
    const restored = new WorldSim(JSON.parse(f.sim.serialize()), { migrateContent: false });
    expect(restored.st.companies[f.p].credits).toBe(f.co.credits);
    expect(forecast(restored.st, restored.st.companies[f.p]).station).toBe(STATION_SIZES.S.upkeep);
  });

  it('recovers half the materials once, requires room, and rejects foreign demolition', () => {
    const f = fixture(); completeCore(f); built(f, 'warehouse');
    const slot = f.st.modules.at(-1)!.slot, store = f.st.storage[f.p], credits = f.co.credits;
    store.ore = STATION_SIZES.S.storage;
    expect(f.sim.command(f.p, { c: 'removeModule', station: f.st.id, slot })).toMatch(/공간/);
    expect(f.st.modules.some(m => m.slot === slot)).toBe(true);
    store.ore = 0;
    const other = f.sim.addPlayer('다른 회사');
    expect(f.sim.command(other, { c: 'removeModule', station: f.st.id, slot })).toMatch(/자사/);
    const observations: Observation[] = []; const unobserve = observeWorld(f.sim.st, event => observations.push(event));
    expect(f.sim.command(f.p, { c: 'removeModule', station: f.st.id, slot })).toBeNull();
    expect(qty(store, 'alloy')).toBe(60); expect(qty(store, 'structure')).toBe(5); expect(f.co.credits).toBe(credits);
    expect(f.sim.command(f.p, { c: 'removeModule', station: f.st.id, slot })).not.toBeNull();
    expect(qty(store, 'alloy')).toBe(60);
    expect(observations.filter(o => o.kind === 'produce' && o.reason === 'facility_demolition').map(o => [o.item, o.amount])).toEqual([['alloy', 60], ['structure', 5]]);
    unobserve();
  });

  it('snapshots the materials committed to each new facility and recovers half of that cost', () => {
    const f = fixture(); completeCore(f);
    expect(f.sim.command(f.p, { c: 'queueModule', station: f.st.id, kind: 'refinery' })).toBeNull();
    const facility = f.st.modules.find(m => m.kind === 'refinery')!;
    expect(facility.materials).toEqual({ alloy: 220 });
    // A facility built under an older cost still returns its own materials, not a later definition.
    facility.materials = { alloy: 100 }; facility.built = true; facility.progress = 1;
    expect(f.sim.command(f.p, { c: 'removeModule', station: f.st.id, slot: facility.slot })).toBeNull();
    expect(qty(f.st.storage[f.p], 'alloy')).toBe(50);
  });

  it('blocks berth overflow without moving or deleting existing ships', () => {
    const f = fixture(); completeCore(f);
    const ships = Array.from({ length: STATION_SIZES.S.berths + 1 }, () => f.sim.spawnShip(f.p, 'hauler', 'std', f.g.id, f.st.pos));
    for (const s of ships.slice(0, -1)) expect((f.sim as any).dockShip(s, f.st)).toBe(true);
    expect((f.sim as any).dockShip(ships.at(-1), f.st)).toBe(false);
    expect(ships.at(-1)!.state).toBe('space');
    expect(ships.slice(0, -1).every(s => s.state === 'docked')).toBe(true);
    expect(berthFits(f.st, 'L')).toBe(false); built(f, 'dock');
    expect(stationBerths(f.st)).toBe(STATION_SIZES.S.berths + 2);
    expect((f.sim as any).dockShip(ships.at(-1), f.st)).toBe(true);
  });

  it('holds a completed ship build safely until a berth becomes free', () => {
    const f = fixture(); completeCore(f); built(f, 'yard_s'); built(f, 'power');
    const ships = Array.from({ length: STATION_SIZES.S.berths }, () => f.sim.spawnShip(f.p, 'hauler', 'std', f.g.id, f.st.pos));
    for (const ship of ships) expect((f.sim as any).dockShip(ship, f.st)).toBe(true);
    const build: ShipBuild = { id: 'waiting-hull', classId: 'corvette', loadoutId: 'gun', fit: [], left: 1, total: 100, started: true, paid: 1000 };
    f.st.builds = [build];
    expect(stepBuilds(f.st, f.co, 10, f.sim.st)).toEqual([]);
    expect(f.st.builds).toEqual([build]); expect(build.why).toMatch(/정박 공간/);
    f.sim.undock(ships[0]);
    expect(stepBuilds(f.st, f.co, 1, f.sim.st)).toEqual([build]); expect(f.st.builds).toEqual([]);
    expect(stepBuilds(f.st, f.co, 1, f.sim.st)).toEqual([]);
  });

  it('keeps manually unloaded cargo aboard until physical handling finishes, including across restart', () => {
    const f = fixture(); completeCore(f);
    expect(f.sim.command(f.p, { c: 'setOp', group: f.g.id, op: { k: 'idle' } })).toBeNull();
    const ship = f.sim.spawnShip(f.p, 'hauler', 'std', f.g.id, f.st.pos); ship.cargo.alloy = 120;
    expect((f.sim as any).dockShip(ship, f.st)).toBe(true);
    expect(f.sim.command(f.p, { c: 'unloadCargo', ship: ship.id })).toBeNull();
    expect(qty(ship.cargo, 'alloy')).toBe(120); expect(qty(f.st.storage[f.p], 'alloy')).toBe(0);
    for (let i = 0; i < 20; i++) f.sim.update(.25);
    expect(ship.cargoWork?.done).toBeGreaterThan(0); expect(qty(ship.cargo, 'alloy')).toBe(120);
    const restored = new WorldSim(JSON.parse(f.sim.serialize()), { migrateContent: false }); (restored as any).npcSlow = () => {};
    expect(restored.st.ships[ship.id].cargoWork).toEqual(ship.cargoWork);
    for (let i = 0; i < 60; i++) restored.update(.25);
    expect(qty(restored.st.ships[ship.id].cargo, 'alloy')).toBe(0);
    expect(qty(restored.st.stations[f.st.id].storage[f.p], 'alloy')).toBe(120);
    restored.update(1); expect(qty(restored.st.stations[f.st.id].storage[f.p], 'alloy')).toBe(120);
    const s = restored.st.ships[ship.id]; s.cargo.alloy = 24;
    expect(restored.command(f.p, { c: 'unloadCargo', ship: ship.id })).toBeNull();
    expect(restored.command(f.p, { c: 'setOp', group: f.g.id, op: { k: 'move', to: { x: f.st.pos.x + 1000, y: 0, z: 0 } } })).toBeNull();
    expect(s.cargoWork).toBeUndefined(); expect(qty(s.cargo, 'alloy')).toBe(24);
  });

  it('physically transports purchased construction materials across gates and resumes handling after restart', () => {
    const f = fixture(); completeCore(f);
    expect(f.sim.command(f.p, { c: 'queueModule', station: f.st.id, kind: 'refinery' })).toBeNull();
    const plan = f.st.modules.find(m => m.kind === 'refinery')!;
    expect(f.sim.command(f.p, { c: 'buy', station: 'astra', res: 'alloy', amount: 220 })).toBeNull();
    const group = f.sim.newGroup(f.p, '장거리 공급'), carrier = f.sim.spawnShip(f.p, 'hauler', 'std', group.id, f.sim.st.stations.astra.pos);
    expect(f.sim.command(f.p, { c: 'putRoute', group: group.id, config: { name: '현장 공급', from: 'astra', to: f.st.id, item: 'alloy', amount: 220, mode: 'construction', repeat: false } })).toBeNull();
    const route = Object.values(f.sim.st.logistics!).find(r => r.group === group.id)!;
    for (let i = 0; i < 8000 && !carrier.cargoWork; i++) f.sim.update(.25);
    expect(carrier.cargoWork?.key).toBe(`route:${route.id}:unload`);
    expect(qty(carrier.cargo, 'alloy')).toBe(220); expect(qty(f.st.storage[f.p], 'alloy')).toBe(0); expect(plan.reserved?.alloy ?? 0).toBe(0);
    for (let i = 0; i < 16; i++) f.sim.update(.25);
    const restored = new WorldSim(JSON.parse(f.sim.serialize()), { migrateContent: false }); (restored as any).npcSlow = () => {};
    expect(restored.st.ships[carrier.id].cargoWork).toEqual(carrier.cargoWork);
    const resultPlan = restored.st.stations[f.st.id].modules.find(m => m.kind === 'refinery')!;
    for (let i = 0; i < 1000 && (restored.st.logistics![route.id].stats.delivered ?? 0) < 220; i++) restored.update(.25);
    expect(restored.st.logistics![route.id].stats.delivered).toBe(220);
    const total = qty(restored.st.stations.astra.storage[f.p], 'alloy') + qty(restored.st.ships[carrier.id].cargo, 'alloy') + qty(restored.st.stations[f.st.id].storage[f.p], 'alloy') + (resultPlan.reserved?.alloy ?? 0) + (resultPlan.used?.alloy ?? 0);
    expect(total).toBeCloseTo(220, 6);
    restored.update(1); expect(restored.st.logistics![route.id].stats.delivered).toBe(220);
  }, 60_000);
});

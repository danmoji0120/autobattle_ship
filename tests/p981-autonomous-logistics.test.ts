import { describe, expect, it } from 'vitest';
import { WorldSim } from '../src/world/sim';
import { GameServer, type Conn } from '../src/server/core';
import { qty, type Station } from '../src/world/types';
import { publicCap } from '../src/world/storage';
import type { PoolRequest } from '../src/world/autonomousLogistics';
import { dispatchPool } from '../src/world/autonomousLogistics';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { moneySupply, observeWorld } from '../src/world/observe';

function fixture(count = 1) {
  const sim = WorldSim.create(981), p = sim.addPlayer('공용 물류'), co = sim.st.companies[p]; co.credits = 1e8;
  for (const id of Object.keys(sim.st.ships)) delete sim.st.ships[id];
  for (const id of Object.keys(sim.st.groups)) delete sim.st.groups[id];
  for (const l of Object.values(sim.st.lairs)) { l.alive = false; l.respawnAt = 1e10; }
  for (const system of Object.values(sim.st.systems)) system.security = 100;
  const a = sim.st.stations.astra, g = sim.newGroup(p, '공용 수송'); a.storage[p].ore = 500; a.storage[p].alloy = 500;
  const make = (id: string, x: number): Station => ({ ...structuredClone(a), id, name: id, public: false, owner: p, pos: { ...a.pos, x: a.pos.x + x }, market: null, funds: undefined, fundsMax: undefined, shipStock: undefined, storage: { [p]: {} }, builds: [], orders: [], jobs: [], listings: [], modules: ['core', 'power', 'logistics'].map((kind, slot) => ({ kind, slot, built: true, progress: 1 })) });
  const b = make('pool_b', 500), c = make('pool_c', -600), d = make('pool_d', 850);
  for (const st of [b, c, d]) sim.st.stations[st.id] = st;
  const ships = Array.from({ length: count }, () => { const s = sim.spawnShip(p, 'hauler', 'std', g.id, a.pos); (sim as any).dockShip(s, a); return s; });
  const must = (error: string | null) => expect(error).toBeNull();
  const create = (patch: Partial<PoolRequest> = {}) => { must(sim.command(p, { c: 'poolCreate', request: { from: a.id, to: b.id, item: 'ore', kind: 'transfer', amount: 20, priority: 5, repeat: false, ...patch } })); return Object.values(sim.st.logisticsJobs!).at(-1)!; };
  const enroll = () => must(sim.command(p, { c: 'poolShips', ships: ships.map(s => s.id), on: true }));
  return { sim, p, co, a, b, c, d, g, ships, create, enroll, must };
}
const run = (sim: WorldSim, seconds: number) => { for (let t = 0; t < seconds; t += .25) sim.update(.25); };

describe('P9.8.1 autonomous company logistics', () => {
  it('dispatches three ships of one group independently to different jobs', () => {
    const f = fixture(3), jobs = [f.create({ to: f.b.id }), f.create({ to: f.c.id }), f.create({ to: f.d.id })]; f.enroll(); run(f.sim, 2);
    expect(new Set(jobs.map(j => j.ship)).size).toBe(3); expect(jobs.every(j => !!j.ship && j.carried === 20)).toBe(true);
    run(f.sim, 120); expect(jobs.map(j => j.state)).toEqual(['complete', 'complete', 'complete']);
    expect([f.b, f.c, f.d].map(s => qty(s.storage[f.p], 'ore'))).toEqual([20, 20, 20]);
    expect(qty(f.a.storage[f.p], 'ore') + f.ships.reduce((n, s) => n + qty(s.cargo, 'ore'), 0) + [f.b, f.c, f.d].reduce((n, s) => n + qty(s.storage[f.p], 'ore'), 0)).toBe(500);
  });
  it('runs transfer, production supply and construction supply independently in the same group', () => {
    const f = fixture(3); f.must(f.sim.command(f.p, { c: 'queueModule', station: f.c.id, kind: 'warehouse' }));
    const jobs = [f.create({ to: f.d.id }), f.create({ to: f.b.id, kind: 'supply' }), f.create({ to: f.c.id, item: 'alloy', kind: 'construction' })];
    f.enroll(); run(f.sim, 2); expect(new Set(jobs.map(j => j.ship)).size).toBe(3); expect(jobs.every(j => !!j.ship)).toBe(true);
    run(f.sim, 120); expect(jobs.map(j => j.state)).toEqual(['complete', 'complete', 'complete']);
    expect(jobs.map(j => j.delivered)).toEqual([20, 20, 20]); expect(qty(f.b.storage[f.p], 'ore')).toBe(20); expect(qty(f.d.storage[f.p], 'ore')).toBe(20);
    const plan = f.c.modules.find(m => m.kind === 'warehouse')!;
    expect(qty(f.a.storage[f.p], 'alloy') + qty(f.c.storage[f.p], 'alloy') + qty(plan.reserved, 'alloy') + qty(plan.used, 'alloy') + f.ships.reduce((n, s) => n + qty(s.cargo, 'alloy'), 0)).toBeCloseTo(500, 6);
  });
  it('automatically assigns the next job to one ship and respects priority', () => {
    const f = fixture(), low = f.create({ to: f.b.id, priority: 1 }), high = f.create({ to: f.c.id, priority: 9 }); f.enroll(); run(f.sim, 2);
    expect(high.ship).toBe(f.ships[0].id); expect(low.ship).toBeUndefined();
    run(f.sim, 180); expect(high.state).toBe('complete'); expect(low.state).toBe('complete'); expect(high.delivered).toBe(20); expect(low.delivered).toBe(20);
  });
  it('competing requests never take more than the same physical stock, including restore', () => {
    const f = fixture(2); f.a.storage[f.p].alloy = 15;
    // An unfinished construction plan creates real demand at both destinations.
    for (const st of [f.b, f.c]) { f.must(f.sim.command(f.p, { c: 'queueModule', station: st.id, kind: 'warehouse' })); }
    const jobs = [f.create({ item: 'alloy', kind: 'construction', to: f.b.id, amount: 20 }), f.create({ item: 'alloy', kind: 'construction', to: f.c.id, amount: 20 })]; f.enroll(); run(f.sim, 2);
    expect(jobs.reduce((n, j) => n + j.carried + j.reserved, 0)).toBe(15); expect(qty(f.a.storage[f.p], 'alloy')).toBe(0);
    const restored = new WorldSim(JSON.parse(f.sim.serialize()), { migrateContent: false }); run(restored, 100);
    const js = Object.values(restored.st.logisticsJobs!); expect(js.reduce((n, j) => n + j.delivered + j.carried, 0)).toBe(15);
    expect(js.reduce((n, j) => n + j.reserved, 0)).toBe(0);
  });
  it('holds cargo when a destination is full and resumes when space returns', () => {
    const f = fixture(); f.b.public = true; f.b.owner = 'guild'; f.b.storage[f.p].ore = publicCap(f.co, f.b);
    const j = f.create(); f.enroll(); run(f.sim, 80); expect(j.code).toBe('storage'); expect(j.carried).toBe(20); expect(qty(f.ships[0].cargo, 'ore')).toBe(20);
    f.b.storage[f.p].ore -= 20; run(f.sim, 45); expect(j.state).toBe('complete'); expect(j.delivered).toBe(20); expect(qty(f.ships[0].cargo, 'ore')).toBe(0);
  });
  it('manual command, exclusion and destruction retain surviving cargo and account for loss', () => {
    const f = fixture(2), j = f.create(); f.enroll(); run(f.sim, 2); const ship = f.sim.st.ships[j.ship!]; expect(j.carried).toBe(20);
    f.must(f.sim.command(f.p, { c: 'moveShip', ship: ship.id, group: f.g.id })); expect(qty(ship.cargo, 'ore')).toBe(20); expect(ship.logisticsPool).toBe(false); expect(j.withdrawn).toBe(20); expect(j.ship).toBeUndefined();
    run(f.sim, 6); const replacement = f.sim.st.ships[j.ship!]; expect(replacement.id).not.toBe(ship.id); expect(j.carried).toBe(20);
    delete f.sim.st.ships[replacement.id]; run(f.sim, 2); expect(j.lost).toBe(20); expect(j.carried).toBe(0); expect(qty(ship.cargo, 'ore')).toBe(20);
  });
  it('pause and cancellation do not teleport loaded goods; restored in-flight jobs complete once', () => {
    const f = fixture(), j = f.create(); f.enroll(); run(f.sim, 2); f.must(f.sim.command(f.p, { c: 'poolControl', job: j.id, action: 'pause' }));
    const saved = f.sim.serialize(), restored = new WorldSim(JSON.parse(saved), { migrateContent: false }); run(restored, 30);
    const r = restored.st.logisticsJobs![j.id]; expect(r.carried).toBe(20); expect(qty(restored.st.ships[f.ships[0].id].cargo, 'ore')).toBe(20);
    f.must(restored.command(f.p, { c: 'poolControl', job: j.id, action: 'resume' })); run(restored, 100); expect(r.state).toBe('complete'); expect(r.delivered).toBe(20); expect(qty(restored.st.stations[f.b.id].storage[f.p], 'ore')).toBe(20);
    run(restored, 30); expect(r.delivered).toBe(20);
    const other = f.create(); run(f.sim, 2); f.must(f.sim.command(f.p, { c: 'poolControl', job: j.id, action: 'cancel' })); expect(qty(f.ships[0].cargo, 'ore')).toBe(20); expect(j.withdrawn).toBe(20); expect(other.state).not.toBe('complete');
  });
  it('keeps legacy routes and their manifests intact and rejects mining ships and foreign commands', () => {
    const f = fixture(2); const legacy = f.sim.newGroup(f.p, '기존 노선'); f.must(f.sim.command(f.p, { c: 'moveShip', ship: f.ships[0].id, group: legacy.id }));
    f.must(f.sim.command(f.p, { c: 'putRoute', group: legacy.id, config: { name: '기존', from: f.a.id, to: f.b.id, item: 'ore', mode: 'transfer', amount: 20, repeat: true } })); f.sim.tick(0);
    const route = Object.values(f.sim.st.logistics!)[0]; expect(route.manifests[f.ships[0].id].amount).toBe(20);
    expect(f.sim.command(f.p, { c: 'poolShips', ships: [f.ships[0].id], on: true })).toMatch(/수송/);
    const file = f.sim.serialize(), restored = new WorldSim(JSON.parse(file), { migrateContent: false });
    expect(restored.st.logistics![route.id].manifests[f.ships[0].id].amount).toBe(20);
    const job = f.create({ to: f.c.id }); f.must(f.sim.command(f.p, { c: 'poolShips', ships: [f.ships[1].id], on: true })); run(f.sim, 100); expect(job.state).toBe('complete'); expect(route.stats.delivered).toBeGreaterThan(0);
    const foreign = f.sim.addPlayer('다른 회사'); expect(f.sim.command(foreign, { c: 'poolControl', job: job.id, action: 'cancel' })).toMatch(/자사/);
    const mine = f.sim.newGroup(f.p, '채굴'); f.sim.spawnShip(f.p, 'miner', 'std', mine.id, f.a.pos); f.must(f.sim.command(f.p, { c: 'setOp', group: mine.id, op: { k: 'mine', field: 'kestrel', deliver: 'astra', sell: false } })); f.must(f.sim.command(f.p, { c: 'moveShip', ship: f.ships[1].id, group: mine.id }));
    expect(f.sim.command(f.p, { c: 'poolShips', ships: [f.ships[1].id], on: true })).toMatch(/수송/);
  });
  it('filters company jobs and ship pool metadata from other players snapshots', () => {
    const f = fixture(); f.create(); f.enroll(); run(f.sim, 2); const other = f.sim.addPlayer('다른 회사');
    const server = new GameServer({ v: 1, world: JSON.parse(f.sim.serialize()), auth: {} }, { singleplayer: false, snapInterval: 1 }); const sent: any[] = [];
    const conn = { company: other, send: (msg: any) => sent.push(msg), view: 'astra' } as unknown as Conn;
    (server as any).sendSnap(conn, (server as any).snapBase()); const state = sent[0].state;
    expect(Object.keys(state.logisticsJobs)).toHaveLength(0); expect(state.ships[f.ships[0].id].logisticsJob).toBeUndefined(); expect(state.ships[f.ships[0].id].logisticsPool).toBeUndefined();
  });
  it('sells only this job’s cargo, waits for market funds, and repeats only when explicitly requested', () => {
    const f = fixture(), s = f.ships[0]; s.cargo.ore = 7;
    f.b.public = true; f.b.owner = 'guild'; f.b.market = structuredClone(f.a.market); f.b.funds = 0; f.b.fundsMax = 0;
    const j = f.create({ kind: 'sell', repeat: true, amount: 20 }); f.enroll(); run(f.sim, 70);
    expect(j.code).toBe('budget'); expect(j.carried).toBe(20); expect(qty(s.cargo, 'ore')).toBe(27); expect(j.delivered).toBe(0);
    f.b.funds = 10_000; f.b.fundsMax = 10_000;
    const moneyBefore = moneySupply(f.sim.st); let created = 0, destroyed = 0;
    const stop = observeWorld(f.sim.st, e => { if (e.kind === 'currency.create') created += e.amount; if (e.kind === 'currency.destroy') destroyed += e.amount; });
    run(f.sim, 140); stop();
    expect(j.cycles).toBeGreaterThan(0); expect(j.delivered).toBeGreaterThanOrEqual(20); expect(qty(s.cargo, 'ore')).toBeGreaterThanOrEqual(7);
    expect(qty(f.a.storage[f.p], 'ore') + qty(s.cargo, 'ore') + j.reserved + j.delivered).toBeCloseTo(507, 6);
    expect(moneySupply(f.sim.st) - moneyBefore).toBeCloseTo(created - destroyed, 6);
    f.must(f.sim.command(f.p, { c: 'poolControl', job: j.id, action: 'cancel' })); expect(qty(s.cargo, 'ore')).toBeGreaterThanOrEqual(7);
  });
  it('restores a sized station’s in-progress physical loading without moving the same goods twice', () => {
    const f = fixture(); f.b.size = 'S'; f.b.storage[f.p].ore = 120;
    const j = f.create({ from: f.b.id, to: f.a.id, amount: 80 }); f.enroll();
    for (let i = 0; i < 2000 && !f.ships[0].cargoWork; i++) f.sim.update(.25);
    const s = f.ships[0]; expect(s.cargoWork?.key).toBe(`pool:${j.id}:load`); expect(qty(f.b.storage[f.p], 'ore')).toBe(40); expect(j.reserved).toBe(80); expect(j.carried).toBe(0);
    const restored = new WorldSim(JSON.parse(f.sim.serialize()), { migrateContent: false }); run(restored, 160);
    expect(restored.st.logisticsJobs![j.id].state).toBe('complete'); expect(restored.st.logisticsJobs![j.id].delivered).toBe(80);
    expect(qty(restored.st.stations[f.b.id].storage[f.p], 'ore') + qty(restored.st.stations[f.a.id].storage[f.p], 'ore') + qty(restored.st.ships[s.id].cargo, 'ore')).toBe(620);
  });
  it('suspends individual dispatch on direct group orders and on explicit pool exclusion', () => {
    const f = fixture(), j = f.create(); f.enroll(); run(f.sim, 2); expect(j.carried).toBe(20);
    f.must(f.sim.command(f.p, { c: 'setOp', group: f.g.id, op: { k: 'idle' } }));
    expect(f.ships[0].logisticsPool).toBe(false); expect(j.withdrawn).toBe(20); expect(qty(f.ships[0].cargo, 'ore')).toBe(20);
    f.must(f.sim.command(f.p, { c: 'poolShips', ships: [f.ships[0].id], on: true })); run(f.sim, 6); expect(j.carried).toBe(20);
    f.must(f.sim.command(f.p, { c: 'poolShips', ships: [f.ships[0].id], on: false }));
    expect(j.withdrawn).toBe(40); expect(qty(f.ships[0].cargo, 'ore')).toBe(40); expect(j.ship).toBeUndefined();
  });
  it('reserves real source stock, protects its warehouse space, restores and returns it on cancel', () => {
    const f = fixture(); const j = f.create(); f.enroll();
    const room = f.sim.room(f.a, f.p), worth = f.sim.netWorth(f.p); dispatchPool(f.sim);
    expect(j.reserved).toBe(20); expect(qty(f.a.storage[f.p], 'ore')).toBe(480);
    expect(f.sim.room(f.a, f.p)).toBe(room); expect(f.sim.netWorth(f.p)).toBeCloseTo(worth, 6);
    const restored = new WorldSim(JSON.parse(f.sim.serialize()), { migrateContent: false });
    expect(restored.st.logisticsJobs![j.id].reserved).toBe(20); expect(restored.room(restored.st.stations[f.a.id], f.p)).toBe(room);
    f.must(restored.command(f.p, { c: 'poolControl', job: j.id, action: 'cancel' }));
    expect(qty(restored.st.stations[f.a.id].storage[f.p], 'ore')).toBe(500); expect(restored.st.logisticsJobs![j.id].reserved).toBe(0);
  });
  it('retains a source reservation if the station disappears and releases it only once after recovery', () => {
    const f = fixture(), j = f.create(); f.enroll(); dispatchPool(f.sim); const saved = f.sim.st.stations[f.a.id];
    delete f.sim.st.stations[f.a.id]; f.must(f.sim.command(f.p, { c: 'poolControl', job: j.id, action: 'cancel' }));
    expect(j.reserved).toBe(20); const restored = new WorldSim(JSON.parse(f.sim.serialize()), { migrateContent: false });
    restored.st.stations[f.a.id] = saved; run(restored, 2); expect(restored.st.logisticsJobs![j.id].reserved).toBe(0); expect(qty(saved.storage[f.p], 'ore')).toBe(500);
    run(restored, 2); expect(qty(saved.storage[f.p], 'ore')).toBe(500);
  });
  it('prevents legacy logistics and production from consuming dispatch-reserved stock', () => {
    const f = fixture(); f.b.storage[f.p].ore = 20; f.b.modules.push({ kind: 'refinery', slot: 4, built: true, progress: 1 });
    const j = f.create({ from: f.b.id, to: f.c.id, amount: 20 }); f.enroll(); dispatchPool(f.sim);
    expect(j.reserved).toBe(20); expect(qty(f.b.storage[f.p], 'ore')).toBe(0);
    f.must(f.sim.command(f.p, { c: 'prodOrder', station: f.b.id, recipe: 'alloy_direct', mode: 'count', n: 1 }));
    expect(f.b.jobs).toHaveLength(0); expect(j.reserved).toBe(20);
    const g = f.sim.newGroup(f.p, '구형 운송'), legacyShip = f.sim.spawnShip(f.p, 'hauler', 'std', g.id, f.b.pos); (f.sim as any).dockShip(legacyShip, f.b);
    f.must(f.sim.command(f.p, { c: 'putRoute', group: g.id, config: { name: '경쟁 노선', from: f.b.id, to: f.d.id, item: 'ore', mode: 'transfer', amount: 20, repeat: false } }));
    f.sim.tick(0); const route = Object.values(f.sim.st.logistics!)[0]; expect(route.stats.loaded).toBe(0); expect(j.reserved).toBe(20);
    f.must(f.sim.command(f.p, { c: 'poolControl', job: j.id, action: 'cancel' })); expect(qty(f.b.storage[f.p], 'ore')).toBe(20);
  });
  it('dispatches concurrent companies only to their own ships and their own source stock', () => {
    const f = fixture(), q = f.sim.addPlayer('두 번째 회사'), group = f.sim.newGroup(q, '별도 수송');
    f.sim.st.companies[q].credits = 1e8; f.a.storage[q].ore = 30;
    const ship = f.sim.spawnShip(q, 'hauler', 'std', group.id, f.a.pos); (f.sim as any).dockShip(ship, f.a);
    f.must(f.sim.command(q, { c: 'poolShips', ships: [ship.id], on: true }));
    f.must(f.sim.command(q, { c: 'poolCreate', request: { from: f.a.id, to: 'nova', item: 'ore', kind: 'transfer', amount: 30, priority: 5, repeat: false } }));
    const own = f.create(); f.enroll(); run(f.sim, 2);
    const other = Object.values(f.sim.st.logisticsJobs!).find(j => j.owner === q)!;
    expect(own.ship).toBe(f.ships[0].id); expect(other.ship).toBe(ship.id); expect(own.carried + own.reserved).toBe(20); expect(other.carried + other.reserved).toBe(30);
    expect(qty(f.a.storage[f.p], 'ore')).toBe(480); expect(qty(f.a.storage[q], 'ore')).toBe(0);
  });
  it('loads the actual base-commit P9.7 in-flight save idempotently and runs new pool jobs beside it', () => {
    const fixture = JSON.parse(gunzipSync(readFileSync('tests/fixtures/p971-inflight.json.gz')).toString());
    const sim = new WorldSim(fixture.world, { migrateContent: false }), route = sim.st.logistics![fixture.route];
    expect(fixture.base).toBe('86fa5f7320c3b62a149c7acf116b84d0e1b9dedf'); expect(route.manifests[fixture.oldShip].amount).toBe(20);
    const twice = new WorldSim(JSON.parse(sim.serialize()), { migrateContent: false }); expect(twice.st.logistics![fixture.route]).toEqual(route);
    expect(twice.command(fixture.p, { c: 'poolShips', ships: [fixture.newShip], on: true })).toBeNull();
    expect(twice.command(fixture.p, { c: 'poolCreate', request: { from: fixture.source, to: fixture.target, item: 'ore', kind: 'transfer', amount: 15, priority: 5, repeat: false } })).toBeNull();
    run(twice, 120);
    expect(twice.st.logistics![fixture.route].stats.delivered).toBe(20); expect(Object.values(twice.st.logisticsJobs!)[0].delivered).toBe(15);
    expect(qty(twice.st.stations[fixture.source].storage[fixture.p], 'ore') + qty(twice.st.stations[fixture.target].storage[fixture.p], 'ore') + qty(twice.st.ships[fixture.oldShip].cargo, 'ore') + qty(twice.st.ships[fixture.newShip].cargo, 'ore')).toBe(100);
  });
  it('returns a destroyed ship’s uncollected reservation before assigning another ship', () => {
    const f = fixture(2); f.b.storage[f.p].ore = 30;
    const j = f.create({ from: f.b.id, to: f.c.id, amount: 20 }); f.enroll(); dispatchPool(f.sim);
    const doomed = j.ship!; expect(j.reserved).toBe(20); expect(qty(f.b.storage[f.p], 'ore')).toBe(10);
    delete f.sim.st.ships[doomed]; run(f.sim, 2);
    expect(j.lost).toBe(0); expect(j.reserved + qty(f.b.storage[f.p], 'ore')).toBe(30);
    run(f.sim, 150); expect(j.state).toBe('complete'); expect(j.delivered).toBe(20); expect(qty(f.b.storage[f.p], 'ore')).toBe(10);
  });
  it('keeps the source stock unreserved when a gate is unavailable and recovers after reconnection', () => {
    const f = fixture(), gates = f.sim.st.systems.astra.gates; f.sim.st.systems.astra.gates = [];
    const j = f.create({ to: 'helios' }); f.enroll(); run(f.sim, 6);
    expect(j.code).toBe('path'); expect(j.reserved).toBe(0); expect(qty(f.a.storage[f.p], 'ore')).toBe(500);
    f.sim.st.systems.astra.gates = gates; run(f.sim, 600); expect(j.state).toBe('complete'); expect(j.delivered).toBe(20);
    expect(qty(f.a.storage[f.p], 'ore') + qty(f.sim.st.stations.helios.storage[f.p], 'ore') + qty(f.ships[0].cargo, 'ore')).toBe(500);
  });
  it('reproduces the legacy one-route constraint and empty return trip for the audit', () => {
    const f = fixture(), config = { name: '기존', from: f.a.id, to: f.b.id, item: 'ore', mode: 'transfer' as const, amount: 20, repeat: true };
    f.must(f.sim.command(f.p, { c: 'putRoute', group: f.g.id, config }));
    expect(f.sim.command(f.p, { c: 'putRoute', group: f.g.id, config: { ...config, to: f.c.id } })).toMatch(/이미 노선/);
    const route = Object.values(f.sim.st.logistics!)[0];
    for (let i = 0; i < 800 && route.stats.trips < 1; i++) f.sim.update(.25);
    expect(route.stats.trips).toBe(1); expect(qty(f.ships[0].cargo, 'ore')).toBe(0); expect(route.cursors[f.ships[0].id].phase).toBe('source');
    const pos = { ...f.ships[0].pos }; run(f.sim, 2);
    expect(Math.hypot(f.ships[0].pos.x - pos.x, f.ships[0].pos.z - pos.z)).toBeGreaterThan(1);
    expect(qty(f.ships[0].cargo, 'ore')).toBe(0); expect(f.sim.opOf(f.g).k).toBe('haul');
  });
  it('reports a full dock and resumes its loaded shipment when a berth opens', () => {
    const f = fixture(); f.b.size = 'S'; const parked = f.sim.newGroup(f.p, '정박 대기');
    const blockers = Array.from({ length: 4 }, () => { const s = f.sim.spawnShip(f.p, 'hauler', 'std', parked.id, f.b.pos); expect((f.sim as any).dockShip(s, f.b)).toBe(true); return s; });
    const events: string[] = []; const stop = observeWorld(f.sim.st, e => { if (e.kind === 'logistics' && e.ship === f.ships[0].id) events.push(e.reason ?? ''); });
    const j = f.create(); f.enroll(); run(f.sim, 20);
    expect(j.code).toBe('berth_full'); expect(j.reason).toContain('정박 공간'); expect(j.carried).toBe(20);
    (f.sim as any).undock(blockers[0]); run(f.sim, 80);
    stop(); expect(j.state).toBe('complete'); expect(j.delivered).toBe(20); expect(events.some(e => e.startsWith('blocked:'))).toBe(true); expect(events).toContain('resumed');
  });
});

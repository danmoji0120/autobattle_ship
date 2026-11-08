import { describe, it, expect } from 'vitest';
import { WorldSim } from '../src/world/sim';
import { GameServer, type Conn } from '../src/server/core';
import { qty, type Station } from '../src/world/types';
import { econOf } from '../src/world/hullops';
import { publicCap, setLease } from '../src/world/storage';
import { routeShips, type RouteConfig } from '../src/world/logistics';
import type { ServerMsg } from '../src/server/protocol';

function fixture() {
  const sim = WorldSim.create(512), p = sim.addPlayer('물류 회사'), co = sim.st.companies[p];
  for (const id of Object.keys(sim.st.ships)) delete sim.st.ships[id];
  for (const id of Object.keys(sim.st.groups)) delete sim.st.groups[id];
  for (const lair of Object.values(sim.st.lairs)) { lair.alive = false; lair.respawnAt = 1e10; }
  for (const sys of Object.values(sim.st.systems)) sys.security = 100;
  co.credits = 1e6;
  const g = sim.newGroup(p, '운송반'), a = sim.st.stations.astra;
  const s = sim.spawnShip(p, 'hauler', 'std', g.id, a.pos);
  (sim as any).dockShip(s, a);
  const b: Station = { ...structuredClone(a), id: 'depot', name: '생산 기지', public: false, owner: p, pos: { ...a.pos, x: a.pos.x + 400 }, market: null, funds: undefined, fundsMax: undefined, shipStock: undefined, storage: { [p]: {} }, modules: ['core', 'power', 'refinery', 'logistics'].map((kind, slot) => ({ kind, slot, built: true, progress: 1 })) };
  sim.st.stations[b.id] = b; a.storage[p].ore = 100;
  return { sim, p, co, g, s, a, b };
}
const config = (f: ReturnType<typeof fixture>, patch: Partial<RouteConfig> = {}): RouteConfig => ({ name: '철광 운송', from: f.a.id, to: f.b.id, item: 'ore', mode: 'transfer', amount: 20, repeat: true, ...patch });
function create(f: ReturnType<typeof fixture>, patch: Partial<RouteConfig> = {}) {
  expect(f.sim.command(f.p, { c: 'putRoute', group: f.g.id, config: config(f, patch) })).toBeNull();
  return Object.values(f.sim.st.logistics!)[0];
}
const run = (sim: WorldSim, seconds: number) => { for (let t = 0; t < seconds; t += .25) sim.update(.25); };

describe('managed authoritative logistics', () => {
  it('repeated transfer preserves existing cargo, ownership and resources; duplicate execution at the same time cannot load twice', () => {
    const f = fixture(); f.s.cargo.ore = 7; const r = create(f);
    f.sim.tick(0); f.sim.tick(0); expect(f.a.storage[f.p].ore).toBe(80); expect(f.s.cargo.ore).toBe(27);
    run(f.sim, 240);
    expect(f.a.storage[f.p].ore).toBe(0); expect(f.b.storage[f.p].ore).toBe(100); expect(f.s.cargo.ore).toBe(7);
    expect(r.stats.loaded).toBe(100); expect(r.stats.delivered).toBe(100); expect(r.stats.sold).toBe(0); expect(r.stats.earned).toBe(0);
    expect(r.stats.trips).toBe(5); expect(f.s.owner).toBe(f.p); expect(r.recent.length).toBeLessThanOrEqual(60);
  });
  it('one-way, edit, pause/resume and cancellation are explicit and keep cargo aboard', () => {
    const f = fixture(), r = create(f, { repeat: false }); f.sim.tick(0);
    expect(f.sim.command(f.p, { c: 'routeControl', routes: [r.id], action: 'pause' })).toBeNull();
    const cargo = qty(f.s.cargo, 'ore'); run(f.sim, 30); expect(qty(f.s.cargo, 'ore')).toBe(cargo);
    expect(f.sim.command(f.p, { c: 'putRoute', route: r.id, group: f.g.id, config: config(f, { mode: 'sell', to: 'nova' }) })).toMatch(/운송/);
    expect(f.sim.command(f.p, { c: 'putRoute', route: r.id, group: f.g.id, config: config(f, { name: '수정', repeat: false, amount: 10 }) })).toBeNull();
    expect(f.sim.command(f.p, { c: 'routeControl', routes: [r.id], action: 'resume' })).toBeNull(); run(f.sim, 90);
    expect(r.state).toBe('complete'); expect(r.stats.trips).toBe(1); expect(f.b.storage[f.p].ore).toBe(20);
    expect(f.sim.command(f.p, { c: 'routeControl', routes: [r.id], action: 'resume' })).toBeNull(); f.sim.tick(0); run(f.sim, 20);
    const sum = f.a.storage[f.p].ore + qty(f.s.cargo, 'ore') + f.b.storage[f.p].ore;
    expect(f.sim.command(f.p, { c: 'routeControl', routes: [r.id], action: 'cancel' })).toBeNull();
    run(f.sim, 20); expect(f.sim.st.logistics![r.id]).toBeUndefined(); expect(f.a.storage[f.p].ore + qty(f.s.cargo, 'ore') + f.b.storage[f.p].ore).toBe(sum);
  });
  it('full destination and lost leased capacity hold cargo with bounded retries and resume when space returns', () => {
    const f = fixture(); f.b.public = true; f.b.owner = 'guild'; f.b.market = null;
    f.b.storage[f.p].ore = publicCap(f.co, f.b); const r = create(f); run(f.sim, 60);
    expect(r.cursors[f.s.id].code).toBe('storage'); expect(r.cursors[f.s.id].attempts).toBeLessThan(12); expect(qty(f.s.cargo, 'ore')).toBe(20);
    const all = f.a.storage[f.p].ore + qty(f.s.cargo, 'ore') + f.b.storage[f.p].ore;
    expect(setLease(f.sim.st, f.co, f.b, 1)).toBeNull(); run(f.sim, 30);
    expect(r.stats.delivered).toBeGreaterThan(0); expect(f.a.storage[f.p].ore + qty(f.s.cargo, 'ore') + f.b.storage[f.p].ore).toBe(all);
    expect(setLease(f.sim.st, f.co, f.b, 0)).toBeNull(); run(f.sim, 60);
    expect(f.a.storage[f.p].ore + qty(f.s.cargo, 'ore') + f.b.storage[f.p].ore).toBe(all);
  });
  it('automatic sale retains unsold shipment on board, retries budgets, and never sells pre-existing cargo', () => {
    const f = fixture(); f.b.public = true; f.b.owner = 'guild'; f.b.market = structuredClone(f.a.market); f.b.funds = 0; f.b.fundsMax = 0;
    f.s.cargo.ore = 7; const r = create(f, { mode: 'sell', repeat: false }); run(f.sim, 30);
    expect(r.cursors[f.s.id].code).toBe('budget'); expect(r.stats.sold).toBe(0); expect(qty(f.s.cargo, 'ore')).toBe(27);
    f.b.funds = 1000; f.b.fundsMax = 1000; run(f.sim, 45);
    expect(r.stats.sold).toBe(20); expect(r.stats.earned).toBeGreaterThan(0); expect(qty(f.s.cargo, 'ore')).toBe(7); expect(qty(f.b.storage[f.p], 'ore')).toBe(0);
    expect(r.state).toBe('complete');
  });
  it('supply requires existing logistics infrastructure and reserves incoming shipments across fleets', () => {
    const f = fixture(); f.b.orders = [{ id: 'ore_supply', recipe: 'smelt', mode: 'stock', n: 100, done: 0 } as any];
    // Select the actual registered ore-input recipe; the test never invents a production recipe.
    const RECIPES = recipes;
    f.b.orders[0].recipe = Object.values(RECIPES).find(r => !!r.in.ore)!.id;
    f.b.orders[0].paused = true;
    const r = create(f, { mode: 'supply', minStock: 10, targetStock: 30 }); run(f.sim, 20);
    expect(r.stats.loaded).toBe(0); expect(r.cursors[f.s.id].code).toBe('supply');
    f.b.orders[0].paused = false;
    // Keep production waiting for power, while its real input request remains active.
    for (const m of f.b.modules) if (m.kind === 'refinery') m.built = false;
    const second = f.sim.spawnShip(f.p, 'hauler', 'std', f.g.id, f.a.pos); (f.sim as any).dockShip(second, f.a);
    run(f.sim, 100);
    expect(qty(f.b.storage[f.p], 'ore')).toBe(30); expect(r.stats.loaded).toBe(30); expect(r.stats.delivered).toBe(30);
  });
  it('blocked jump paths preserve shipment, recover automatically, and missing destinations can be edited safely', () => {
    const f = fixture(), r = create(f, { to: 'helios', repeat: false });
    const gates = f.sim.st.systems.astra.gates; f.sim.st.systems.astra.gates = []; run(f.sim, 5);
    expect(r.cursors[f.s.id].code).toBe('path'); expect(qty(f.s.cargo, 'ore')).toBe(20);
    f.sim.st.systems.astra.gates = gates; run(f.sim, 180); expect(r.stats.delivered).toBe(20);
    expect(f.sim.command(f.p, { c: 'routeControl', routes: [r.id], action: 'resume' })).toBeNull(); run(f.sim, 30);
    delete f.sim.st.stations.helios; run(f.sim, 20); expect(r.state).toBe('paused');
    expect(f.sim.command(f.p, { c: 'putRoute', route: r.id, group: f.g.id, config: config(f, { repeat: false }) })).toBeNull();
    expect(f.sim.command(f.p, { c: 'routeControl', routes: [r.id], action: 'resume' })).toBeNull(); run(f.sim, 120);
    expect(r.state).toBe('complete');
  });
  it('manual orders take priority, active state survives reload, and destruction pauses an empty fleet', () => {
    const f = fixture(), r = create(f); f.sim.tick(0);
    const file = JSON.parse(f.sim.serialize()), restored = new WorldSim(file, { migrateContent: false });
    expect(restored.st.logistics![r.id].manifests[f.s.id].amount).toBe(20);
    expect(restored.command(f.p, { c: 'setOp', group: f.g.id, op: { k: 'idle' } })).toBeNull();
    expect(restored.st.logistics![r.id].state).toBe('paused'); run(restored, 20); expect(qty(restored.st.ships[f.s.id].cargo, 'ore')).toBe(20);
    delete restored.st.ships[f.s.id]; run(restored, 2);
    expect(restored.st.logistics![r.id].stats.lost).toBe(20); expect(restored.st.logistics![r.id].state).toBe('paused');
  });
  it('manual cargo unloading resolves a full hold without sales, consumption or duplicate delivery', () => {
    const f = fixture(); f.s.cargo.ore = econOf(f.s).cargo; const r = create(f); f.sim.tick(0);
    const original = f.a.storage[f.p].ore + qty(f.s.cargo, 'ore');
    const credits = f.co.credits;
    expect(f.sim.command(f.p, { c: 'unloadCargo', ship: f.s.id })).toBeNull();
    expect(f.co.credits).toBe(credits); expect(r.state).toBe('paused');
    expect(f.a.storage[f.p].ore + qty(f.s.cargo, 'ore')).toBe(original);
    expect(qty(f.s.cargo, 'ore')).toBe(0);
    run(f.sim, 2); expect(Object.keys(r.manifests)).toHaveLength(0);
    expect((r.stats.withdrawn ?? 0) + r.stats.delivered + r.stats.lost).toBe(r.stats.loaded);
    expect(f.sim.command(f.p, { c: 'routeControl', routes: [r.id], action: 'resume' })).toBeNull();
    run(f.sim, 45); expect(r.stats.delivered).toBeGreaterThan(0);
  });
  it('moving a ship between route fleets pauses both and mixed-ownership bulk requests are atomic', () => {
    const f = fixture(), r = create(f); f.sim.tick(0);
    const second = f.sim.newGroup(f.p, '다른 운송반'); f.sim.spawnShip(f.p, 'hauler', 'std', second.id, f.a.pos);
    expect(f.sim.command(f.p, { c: 'putRoute', group: second.id, config: config(f, { name: '둘째' }) })).toBeNull();
    const r2 = Object.values(f.sim.st.logistics!).find(x => x.group === second.id)!;
    expect(f.sim.command(f.p, { c: 'moveShip', ship: f.s.id, group: second.id })).toBeNull();
    expect(r.state).toBe('paused'); expect(r2.state).toBe('paused'); expect(qty(f.s.cargo, 'ore')).toBe(20);
    const q = f.sim.addPlayer('타사 운송'), group = Object.values(f.sim.st.groups).find(g => g.owner === q)!;
    expect(f.sim.command(q, { c: 'putRoute', group: group.id, config: config(f, { to: 'nova' }) })).toBeNull();
    const foreign = Object.values(f.sim.st.logistics!).find(x => x.owner === q)!;
    expect(f.sim.command(f.p, { c: 'routeControl', routes: [r2.id, foreign.id], action: 'resume' })).toMatch(/자사/);
    expect(r2.state).toBe('paused');
    expect(f.sim.command(q, { c: 'unloadCargo', ship: f.s.id })).toMatch(/자사/);
    expect(f.sim.command(q, { c: 'setOp', group: group.id, op: { k: 'haul', from: f.a.id, to: 'nova', res: 'ore', route: r.id } })).toMatch(/물류/);
  });
  it('owns settings on the server, rejects cross-company batches atomically, redacts snapshots and gates c0', () => {
    const f = fixture(), r = create(f), other = f.sim.addPlayer('타사');
    expect(f.sim.command(other, { c: 'routeControl', routes: [r.id], action: 'cancel' })).toMatch(/자사/);
    expect(f.sim.command(other, { c: 'putRoute', route: r.id, group: f.g.id, config: config(f) })).toMatch(/자사/);
    const server = new GameServer({ v: 1, world: JSON.parse(f.sim.serialize()), auth: { other } }, { singleplayer: false, snapInterval: .1 });
    const sent: ServerMsg[] = [], conn: Conn = { id: 'peer', lastEvent: 0, battles: new Set(), send: m => sent.push(JSON.parse(JSON.stringify(m))) };
    server.connect(conn); server.handle('peer', { t: 'hello', name: '타사', token: 'other' });
    expect(JSON.stringify((sent.find(m => m.t === 'snap') as any).state.logistics)).not.toContain(r.id);
    delete f.sim.st.contentV; const before = f.sim.serialize();
    expect(f.sim.command(f.p, { c: 'putRoute', group: f.g.id, config: config(f) })).toMatch(/월드/); expect(f.sim.serialize()).toBe(before);
  });
});
import { RECIPES as recipes } from '../src/world/industry';

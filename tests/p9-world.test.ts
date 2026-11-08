import { describe, expect, it } from 'vitest';
import { GameServer, type Conn } from '../src/server/core';
import { WorldSim } from '../src/world/sim';
import { newWorld } from '../src/world/worldgen';
import { nextGate, jumps, sysAt, sysOriginX } from '../src/world/geom';
import { surveyStep, salvageLoot, SCAN_NEED, seedSites } from '../src/world/explore';
import { qty } from '../src/world/types';
import { FOUND_COST } from '../src/world/data';
import { npcMarketStep } from '../src/world/economy';
import { berthOf } from '../src/world/hullops';

const LEGACY = ['helios', 'astra', 'drake', 'ember', 'fang'];
const run = (sim: WorldSim, seconds: number) => { for (let t = 0; t < seconds; t += .25) sim.update(.25); };
const quiet = (sim: WorldSim) => { (sim as any).npcSlow = () => {}; for (const l of Object.values(sim.st.lairs)) { l.alive = false; l.respawnAt = 1e10; } };

describe('P9 authored world', () => {
  it('creates a unique connected 22-system graph with matching reciprocal gates and spatial ownership', () => {
    const sim = WorldSim.create(42), w = sim.st, systems = Object.values(w.systems);
    expect(systems).toHaveLength(22);
    expect(new Set(systems.map(s => s.id)).size).toBe(22);
    expect(new Set(systems.map(s => s.idx)).size).toBe(22);
    for (const group of [w.stations, w.fields, w.lairs]) {
      expect(new Set(Object.values(group).map(x => x.id)).size).toBe(Object.keys(group).length);
      for (const [key, entity] of Object.entries(group)) expect(entity.id).toBe(key);
    }
    for (const s of systems) {
      expect(sysAt(w.systems, s.origin)?.id).toBe(s.id);
      expect(new Set(s.gates.map(g => g.id)).size).toBe(s.gates.length);
      for (const g of s.gates) {
        const back = w.systems[g.to]?.gates.find(x => x.id === g.exit);
        expect(back, `${g.id} missing return gate`).toBeDefined();
        expect(back!.to).toBe(s.id); expect(back!.exit).toBe(g.id);
        expect(sysAt(w.systems, g.pos)?.id).toBe(s.id);
      }
      for (const d of systems) {
        if (d.id === s.id) continue;
        expect(nextGate(w.systems, s.id, d.id), `${s.id} -> ${d.id}`).not.toBeNull();
        // The existing coordinated-fleet route builder supports at most eight jumps.
        expect(jumps(w.systems, s.id, d.id)).toBeLessThanOrEqual(8);
      }
      for (const p of s.planets) expect(sysAt(w.systems, p.pos)?.id).toBe(s.id);
    }
    for (const x of [...Object.values(w.stations), ...Object.values(w.fields), ...Object.values(w.lairs)]) expect(sysAt(w.systems, x.pos), x.id).toBeDefined();
    const membership: Record<string, string> = {
      p9_lyra_port: 'lyra', p9_ceres_works: 'ceres', p9_anvil_port: 'anvil', p9_harbor_port: 'harbor', p9_forge_works: 'forge', p9_junction_port: 'junction',
      p9_anvil_ore: 'anvil', p9_anvil_titanium: 'anvil', p9_shard_crystal: 'shard', p9_salvage_debris: 'salvage', p9_dusk_vein: 'dusk', p9_blackgate_ore: 'blackgate',
      p9_watch_lair: 'watch', p9_blackgate_lair: 'blackgate', p9_dusk_lair: 'dusk',
    };
    for (const [id, expected] of Object.entries(membership)) {
      const entity = w.stations[id] ?? w.fields[id] ?? w.lairs[id];
      expect(entity, id).toBeDefined(); expect(sysAt(w.systems, entity.pos)?.id, id).toBe(expected);
    }
    for (const id of ['quiet', 'rime', 'frontier']) {
      const s = w.systems[id]; expect(s.planets).toHaveLength(0); expect(s.exploration?.slots).toBe(0);
      expect([...Object.values(w.stations), ...Object.values(w.fields), ...Object.values(w.lairs)].some(x => sysAt(w.systems, x.pos)?.id === id)).toBe(false);
      expect(s.gates).toHaveLength(1);
    }
    // The northern exterior has one entrance: a deliberate strategic bottleneck.
    const blocked = (g: { id: string }) => g.id !== 'gate:junction>shard' && g.id !== 'gate:shard>junction';
    expect(nextGate(w.systems, 'astra', 'blackgate', blocked)).toBeNull();
    expect(nextGate(w.systems, 'shard', 'blackgate', blocked)).not.toBeNull();
    expect(w.systems.astra.gates.length).toBeGreaterThan(3);
  });

  it('keeps system lookup correct after records are added, removed, replaced or reindexed', () => {
    const systems = structuredClone(WorldSim.create(44).st.systems), original = systems.lyra, pos = { ...original.origin };
    expect(sysAt(systems, pos)).toBe(original);
    delete systems.lyra; expect(sysAt(systems, pos)).toBeUndefined();
    const replacement = { ...original, id: 'replacement' }; systems.replacement = replacement;
    expect(sysAt(systems, pos)).toBe(replacement);
    replacement.idx = 60; expect(sysAt(systems, pos)).toBeUndefined();
    expect(sysAt(systems, { x: sysOriginX(60), y: 0, z: 0 })).toBe(replacement);
  });

  it('keeps the five original systems and assets, and never expands an existing c0 or growth save', () => {
    const old = newWorld(91), c0 = new WorldSim(structuredClone(old), { migrateContent: false });
    const growth = new WorldSim(structuredClone(old));
    const p = growth.addPlayer('기존 회사'); growth.st.stations.astra.storage[p].ore = 777;
    const before = JSON.parse(growth.serialize());
    const restored = new WorldSim(structuredClone(before), { migrateContent: false });
    expect(Object.keys(c0.st.systems)).toEqual(LEGACY);
    expect(Object.keys(restored.st.systems)).toEqual(LEGACY);
    expect(restored.st.stations.astra.storage[p].ore).toBe(777);
    for (const id of LEGACY) expect(restored.st.systems[id]).toEqual(before.systems[id]);
    const fresh = WorldSim.create(91);
    for (const id of LEGACY) {
      expect(fresh.st.systems[id].origin).toEqual(growth.st.systems[id].origin);
      expect(fresh.st.systems[id].planets).toEqual(growth.st.systems[id].planets);
      const oldGates = old.systems[id].gates;
      expect(fresh.st.systems[id].gates.slice(0, oldGates.length)).toEqual(oldGates);
    }
    for (const [id, s] of Object.entries(growth.st.stations)) expect(fresh.st.stations[id].pos).toEqual(s.pos);
  });

  it('is deterministic and persists surveyed sites and player assets without recreating or moving them', () => {
    const a = WorldSim.create(907), b = WorldSim.create(907);
    expect(a.serialize()).toBe(b.serialize());
    const p = a.addPlayer('탐사 회사'), site = Object.values(a.st.sites!).find(s => s.system === 'relic')!;
    expect(site.tier).toBe(3);
    expect(Object.values(a.st.sites!).some(s => s.system === 'blackgate')).toBe(false);
    expect(surveyStep(a.st, p, 'relic', SCAN_NEED[site.tier])).toContain(site);
    site.work = 123; const loot = salvageLoot(a.st, a.st.companies[p], site, () => .4);
    expect(loot.cargo.alloy).toBeGreaterThan(0);
    const original = JSON.parse(a.serialize()), restored = new WorldSim(structuredClone(original), { migrateContent: false });
    expect(restored.st.sites![site.id]).toEqual(original.sites[site.id]);
    expect(restored.st.systems).toEqual(original.systems);
    expect(restored.st.companies[p]).toEqual(original.companies[p]);
    const count = Object.keys(restored.st.sites!).length; seedSites(restored.st); expect(Object.keys(restored.st.sites!)).toHaveLength(count);
  });

  it('continues the same seeded P9 simulation after saving and restoring', () => {
    const a = WorldSim.create(908); a.addPlayer('결정론 회사'); run(a, 8);
    const b = new WorldSim(JSON.parse(a.serialize()), { migrateContent: false });
    for (let i = 0; i < 240; i++) { a.update(.25); b.update(.25); }
    expect(b.serialize()).toBe(a.serialize());
  });

  it('creates regional demand, finite mining budgets and real industrial conversion without changing legacy prices', () => {
    const w = WorldSim.create(81).st, legacy = new WorldSim(newWorld(81)).st;
    for (const id of ['astra', 'nova', 'helios']) expect(w.stations[id].market).toEqual(legacy.stations[id].market);
    expect(w.stations.p9_anvil_port.fundsMax).toBe(35000);
    expect(berthOf(w.stations.p9_ceres_works)).toBe('L');
    expect(berthOf(w.stations.p9_anvil_port)).toBe('M');
    expect(w.stations.p9_ceres_works.fundsMax!).toBeGreaterThan(w.stations.p9_anvil_port.fundsMax!);
    const factory = w.stations.p9_ceres_works, before = { ...factory.market!.metal };
    const ore = factory.market!.ore.stock;
    npcMarketStep(factory, factory.market!, 10, 0, 1, false);
    expect(factory.market!.ore.stock).toBeLessThan(ore);
    expect(factory.market!.metal.stock).toBeGreaterThan(before.stock);
  });

  it('chooses actual nearby jump routes and a market that buys the mined goods', () => {
    const sim = WorldSim.create(82), p = sim.addPlayer('채굴 항로');
    // Spatial index makes Forge appear closer in raw coordinates, but Rustport is one jump from Dusk.
    expect(sim.autoDeliver(p, 'p9_dusk_vein', true)).toBe('rustport');
    expect(sim.nearestDock(sim.st.fields.p9_dusk_vein.pos, p)?.id).toBe('rustport');
    // The nearest outpost has no crystal or rare-ore market; choose a buyer two jumps away.
    expect(sim.autoDeliver(p, 'p9_shard_crystal', true)).toBe('drakeout');
    (sim as any).contracts();
    expect(Object.values(sim.st.contracts).find(c => c.target === 'p9_dusk_lair')?.stationId).toBe('rustport');
  });

  it('replicates the same expanded world to two independent multiplayer clients and restores it', () => {
    const server = new GameServer(null, { singleplayer: false, snapInterval: 1 }, 73);
    const messages: any[][] = [[], []];
    for (let i = 0; i < 2; i++) {
      const c: Conn = { id: `peer${i}`, lastEvent: 0, battles: new Set(), send: m => messages[i].push(structuredClone(m)) };
      server.connect(c); server.handle(c.id, { t: 'hello', name: `회사${i}` });
    }
    expect(Object.keys(server.sim.st.companies).filter(id => server.sim.st.companies[id].kind === 'player')).toHaveLength(2);
    for (const msgs of messages) expect(Object.keys(msgs.find(m => m.t === 'snap').state.systems)).toHaveLength(22);
    const [a, b] = [...server.conns.values()].map(c => c.company!);
    const site = Object.values(server.sim.st.sites!).find(s => s.system === 'relic')!;
    expect(messages.every(msgs => !msgs.find(m => m.t === 'snap').state.sites[site.id])).toBe(true);
    surveyStep(server.sim.st, a, 'relic', SCAN_NEED[site.tier]); server.step(1);
    expect(messages[0].filter(m => m.t === 'snap').at(-1).state.sites[site.id]).toBeDefined();
    expect(messages[1].filter(m => m.t === 'snap').at(-1).state.sites[site.id]).toBeUndefined();
    expect(site.seen).toEqual([a]); expect(site.seen).not.toContain(b);
    const file = server.snapshotFile(), reload = new GameServer(structuredClone(file), { singleplayer: false, snapInterval: 1, migrateContent: false });
    expect(reload.sim.st.systems).toEqual(file.world.systems);
    expect(Object.keys(reload.sim.st.companies)).toEqual(Object.keys(file.world.companies));
  });

  it('permits a real station foundation in an initially empty frontier system', () => {
    const sim = WorldSim.create(93); quiet(sim);
    const p = sim.addPlayer('변경 개척'), group = sim.newGroup(p, '공작반'), sys = sim.st.systems.quiet;
    sim.st.companies[p].credits = 1e6;
    const at = { x: sys.origin.x + 10000, y: 0, z: 0 };
    const ship = sim.spawnShip(p, 'constructor', 'std', group.id, at); ship.cargo.alloy = FOUND_COST.alloy;
    expect(sim.command(p, { c: 'setOp', group: group.id, op: { k: 'found', at, name: '첫 변경 기지' } })).toBeNull();
    run(sim, 2);
    const station = Object.values(sim.st.stations).find(s => s.owner === p && s.name === '첫 변경 기지');
    expect(station).toBeDefined(); expect(sysAt(sim.st.systems, station!.pos)?.id).toBe('quiet');
  });

  it('runs the existing bounded pirate and trader AI in the new regions', () => {
    const sim = WorldSim.create(95);
    for (const l of Object.values(sim.st.lairs)) {
      if (l.id.startsWith('p9_')) l.nextBand = 0;
      else { l.alive = false; l.respawnAt = 1e10; }
    }
    run(sim, 4);
    for (const id of ['p9_watch_lair', 'p9_blackgate_lair', 'p9_dusk_lair']) {
      const groups = Object.values(sim.st.groups).filter(g => g.owner === 'pirates' && g.npc?.home === id && g.shipIds.length);
      expect(groups).toHaveLength(1);
      expect(sim.st.lairs[id].maxBands).toBe(1);
    }
    expect(Object.values(sim.st.groups).some(g => g.owner === 'guild' && g.npc?.role === 'trader')).toBe(true);
  });

  it('does not populate empty and frontier systems with settled-lane rogues when security is raised', () => {
    const sim = WorldSim.create(95);
    for (const s of Object.values(sim.st.systems)) if (s.kind !== 'core') s.security = 75;
    for (const l of Object.values(sim.st.lairs)) { l.alive = false; l.respawnAt = 1e10; }
    (sim.rng as any).chance = () => true;
    (sim as any).pirateForces();
    const systems = Object.values(sim.st.groups).filter(g => g.npc?.role === 'rogue').map(g => g.npc!.sys).sort();
    expect(systems).toEqual(['astra', 'ceres', 'harbor', 'lyra']);
  });

  it('moves an actual fleet to the distant lawless endpoint and back through eight gates', () => {
    const sim = WorldSim.create(94); quiet(sim);
    const p = sim.addPlayer('왕복 항해'), group = sim.newGroup(p, '정찰대'); sim.st.companies[p].credits = 1e7;
    for (const id of Object.keys(sim.st.ships)) delete sim.st.ships[id];
    const quietSystem = sim.st.systems.quiet, targetSystem = sim.st.systems.blackgate;
    expect(jumps(sim.st.systems, quietSystem.id, targetSystem.id)).toBe(8);
    const start = { x: quietSystem.origin.x + 9000, y: 0, z: 0 }, target = { x: targetSystem.origin.x + 9000, y: 0, z: 0 };
    const ship = sim.spawnShip(p, 'corvette', 'gun', group.id, start);
    const sail = (destination: typeof start, system: string) => {
      expect(sim.command(p, { c: 'setOp', group: group.id, op: { k: 'move', to: destination } })).toBeNull();
      for (let t = 0; t < 6000 && (sysAt(sim.st.systems, ship.pos)?.id !== system || Math.hypot(ship.pos.x - destination.x, ship.pos.z - destination.z) > 1800); t += .5) sim.update(.5);
      expect(sysAt(sim.st.systems, ship.pos)?.id).toBe(system);
      expect(Math.hypot(ship.pos.x - destination.x, ship.pos.z - destination.z)).toBeLessThan(1800);
    };
    sail(target, targetSystem.id); sail(start, quietSystem.id);
  }, 120000);

  it('repeats a four-jump freight route, recovers after a gate outage and reloads the in-flight manifest', () => {
    let sim = WorldSim.create(205); quiet(sim);
    const p = sim.addPlayer('장거리 운송'), co = sim.st.companies[p]; co.credits = 1e7;
    for (const id of Object.keys(sim.st.ships)) delete sim.st.ships[id];
    for (const id of Object.keys(sim.st.groups)) delete sim.st.groups[id];
    const from = sim.st.stations.p9_junction_port, to = sim.st.stations.p9_harbor_port;
    expect(jumps(sim.st.systems, 'junction', 'harbor')).toBeGreaterThanOrEqual(4);
    const group = sim.newGroup(p, '장거리 화물선'), ship = sim.spawnShip(p, 'hauler', 'std', group.id, from.pos);
    (sim as any).dockShip(ship, from); from.storage[p].ore = 40;
    expect(sim.command(p, { c: 'putRoute', group: group.id, config: { name: '원료 공급', from: from.id, to: to.id, item: 'ore', mode: 'transfer', amount: 20, repeat: true } })).toBeNull();
    const route = Object.values(sim.st.logistics!)[0];
    const oldGates = sim.st.systems.junction.gates; sim.st.systems.junction.gates = [];
    run(sim, 3); expect(route.cursors[ship.id].code).toBe('path'); expect(qty(ship.cargo, 'ore')).toBe(20);
    sim.st.systems.junction.gates = oldGates;
    sim = new WorldSim(JSON.parse(sim.serialize()), { migrateContent: false }); quiet(sim);
    for (let t = 0; t < 5000 && sim.st.logistics![route.id].stats.delivered < 40; t += .25) sim.update(.25);
    const r = sim.st.logistics![route.id];
    expect(r.stats.loaded).toBe(40); expect(r.stats.delivered).toBe(40); expect(r.stats.trips).toBe(2);
    expect(qty(sim.st.stations[from.id].storage[p], 'ore') + qty(sim.st.ships[ship.id].cargo, 'ore') + qty(sim.st.stations[to.id].storage[p], 'ore')).toBe(40);

    // Reconfigure the same fleet for a long-distance sale; the destination cannot pay at first.
    const buyer = sim.st.stations[from.id]; buyer.funds = 0; buyer.fundsMax = 0;
    expect(sim.command(p, { c: 'putRoute', route: r.id, group: group.id, config: { name: '장거리 판매', from: to.id, to: from.id, item: 'ore', mode: 'sell', amount: 20, repeat: false } })).toBeNull();
    for (let t = 0; t < 3000 && r.cursors[ship.id]?.code !== 'budget'; t += .5) sim.update(.5);
    expect(r.cursors[ship.id]?.code).toBe('budget'); expect(qty(sim.st.ships[ship.id].cargo, 'ore')).toBe(20); expect(r.stats.sold).toBe(0);
    buyer.funds = 10000; buyer.fundsMax = 10000;
    for (let t = 0; t < 100 && r.stats.sold < 20; t += .5) sim.update(.5);
    expect(r.stats.sold).toBe(20); expect(r.stats.earned).toBeGreaterThan(0); expect(qty(sim.st.ships[ship.id].cargo, 'ore')).toBe(0);

    // Supply a real production order at a player-owned facility across the same multi-gate route.
    const depot = { ...structuredClone(buyer), id: 'p9_test_factory', name: '원료 공급 공장', public: false, owner: p, market: null, funds: undefined, fundsMax: undefined,
      pos: { ...buyer.pos, x: buyer.pos.x + 3000 }, storage: { [p]: {} },
      modules: ['core', 'power', 'refinery', 'logistics'].map((kind, slot) => ({ kind, slot, built: kind !== 'refinery', progress: kind === 'refinery' ? 0 : 1 })),
      orders: [{ id: 'supply', recipe: 'alloy_direct', mode: 'stock' as const, n: 100, done: 0 }] };
    sim.st.stations[depot.id] = depot;
    expect(sim.command(p, { c: 'putRoute', route: r.id, group: group.id, config: { name: '공장 원료 공급', from: to.id, to: depot.id, item: 'ore', mode: 'supply', amount: 20, repeat: false, minStock: 5, targetStock: 20 } })).toBeNull();
    expect(sim.command(p, { c: 'routeControl', routes: [r.id], action: 'resume' })).toBeNull();
    for (let t = 0; t < 5000 && qty(depot.storage[p], 'ore') < 20; t += .5) sim.update(.5);
    expect(qty(depot.storage[p], 'ore')).toBe(20); expect(qty(sim.st.stations[to.id].storage[p], 'ore')).toBe(0);
    expect(r.stats.loaded).toBe(80); expect(r.stats.delivered).toBe(80); expect(r.stats.sold).toBe(20);
  }, 120000);
});

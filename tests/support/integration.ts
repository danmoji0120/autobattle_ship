// Isolated assets for integration tests. Purchases, orders, consumption and movements use real commands.
import { GameServer } from '../../src/server/core';
import { WorldSim } from '../../src/world/sim';
import { FACILITIES, TECHS } from '../../src/world/industry';
import { buildNeeds } from '../../src/world/production';
import type { Station } from '../../src/world/types';

export function integrationFixture(seed = 871) {
  const initial = WorldSim.create(seed), p = initial.addPlayer('통합 산업');
  const co = initial.st.companies[p]; co.credits = 20_000_000; co.rep = 1000; co.stats.contracts = 10;
  co.tech = ['guided_missiles', 'mining_lasers', 'logistics_ai', 'light_cruiser_design', 'microelectronics', 'optical_lasers', 'long_sensors'];
  for (const l of Object.values(initial.st.lairs)) { l.alive = false; l.respawnAt = 1e10; }
  for (const s of Object.values(initial.st.systems)) s.security = 100;
  const a = initial.st.stations.astra;
  const station = (id: string, dx: number, modules: string[]): Station => ({ ...structuredClone(a), id, name: id === 'integration_factory' ? '통합 제련소' : '통합 물류항', public: false, owner: p, pos: { ...a.pos, x: a.pos.x + dx }, market: null, funds: undefined, fundsMax: undefined, shipStock: undefined, storage: { [p]: {} }, builds: [], orders: [], jobs: [], listings: [], shipListings: [], modules: modules.map((kind, slot) => ({ kind, slot, progress: 1, built: true })) });
  initial.st.stations.integration_factory = station('integration_factory', 700, ['core', 'power', 'power', 'power', 'power', 'refinery', 'logistics', 'dock', 'yard_s', 'lab_basic', 'fitting', 'comms']);
  initial.st.stations.integration_depot = station('integration_depot', -700, ['core', 'dock', 'trade_hub']);
  const server = new GameServer({ v: 1, world: JSON.parse(initial.serialize()), auth: { integration: p } }, { singleplayer: false, snapInterval: 1, analytics: { snapshotSeconds: 300 } });
  const sim = server.sim, factory = sim.st.stations.integration_factory, depot = sim.st.stations.integration_depot;
  const must = (error: string | null) => { if (error) throw Error(error); };
  const combat = sim.newGroup(p, 'P8 군함'), mine = sim.newGroup(p, 'P8 채굴'), supply = sim.newGroup(p, 'P8 원료 운송'), output = sim.newGroup(p, 'P8 제품 운송');
  for (const [hull, classId, at, preset, group] of [
    ['patrol_pathfinder', 'corvette', 'helios', 'pathfinder_patrol', combat.id],
    ['destroyer_lancet', 'destroyer', 'helios', 'lancet_salvo', combat.id],
    ['cruiser_vigil', 'light_cruiser', 'helios', 'vigil_mixed', combat.id],
    ['miner_quarry', 'miner', 'astra', 'quarry_mining', mine.id],
    ['hauler_meridian', 'hauler', 'exchange', 'meridian_cargo', supply.id],
  ]) must(sim.command(p, { c: 'buyShip', station: at, classId, loadoutId: '', hull, preset, group }));
  const find = (hull: string) => Object.values(sim.st.ships).find(s => s.owner === p && s.hull === hull)!;
  const carrier = find('hauler_meridian'), miner = find('miner_quarry');
  (sim as any).dockShip(carrier, sim.st.stations.astra);
  // A second industrial hull is a scenario asset, not an extra purchase from the one-ship public stock.
  const product = sim.spawnHull(p, 'hauler_meridian', 'hauler_meridian_std', 'meridian_cargo', output.id, factory.pos);
  (sim as any).dockShip(product, factory);
  must(sim.command(p, { c: 'buy', station: 'astra', res: 'ore', amount: 600 }));
  return { server, sim, p, co: sim.st.companies[p], factory, depot, combat, mine, supply, output, carrier, miner, product, must, find };
}
export function startIntegrationIndustry(f: ReturnType<typeof integrationFixture>) {
  const { sim, p, must, factory, depot, supply, output } = f;
  must(sim.command(p, { c: 'prodOrder', station: factory.id, recipe: 'alloy_direct', mode: 'stock', n: 140 }));
  must(sim.command(p, { c: 'putRoute', group: supply.id, config: { name: 'P8 원료 공급', from: 'astra', to: factory.id, item: 'ore', mode: 'supply', amount: 80, minStock: 60, targetStock: 120, repeat: true } }));
  must(sim.command(p, { c: 'putRoute', group: output.id, config: { name: 'P8 합금 출하', from: factory.id, to: depot.id, item: 'alloy', mode: 'transfer', amount: 14, repeat: true } }));
}
export function startIntegrationProjects(f: ReturnType<typeof integrationFixture>) {
  const { sim, p, factory, must } = f, stock = factory.storage[p];
  // Provide test materials once, before they are consumed. These aren't production/loot observations.
  for (const [item, n] of Object.entries(TECHS.process_control.cost)) stock[item] = (stock[item] ?? 0) + n;
  must(sim.command(p, { c: 'research', station: factory.id, tech: 'process_control' }));
  for (const [item, n] of Object.entries(FACILITIES.warehouse.mats)) stock[item] = (stock[item] ?? 0) + n;
  must(sim.command(p, { c: 'queueModule', station: factory.id, kind: 'warehouse' }));
  must(sim.command(p, { c: 'buyBlueprint', station: 'astra', blueprint: 'bp_patrol_pathfinder' }));
  const need = buildNeeds('corvette', '', [], { hull: 'patrol_pathfinder', variant: 'patrol_pathfinder_std', preset: 'pathfinder_patrol' });
  for (const [item, n] of Object.entries(need)) stock[item] = (stock[item] ?? 0) + n;
  must(sim.command(p, { c: 'buildShip', station: factory.id, classId: 'corvette', loadoutId: '', hull: 'patrol_pathfinder', preset: 'pathfinder_patrol' }));
}
export const integrationRun = (s: GameServer, seconds: number) => { for (let t = 0; t < seconds; t += .25) s.step(.25); };

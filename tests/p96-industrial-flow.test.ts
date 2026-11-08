import { describe, expect, it } from 'vitest';
import { WorldSim } from '../src/world/sim';
import { qty } from '../src/world/types';
import { jumps, sysAt } from '../src/world/geom';

describe('P9.6 frontier industry', () => {
  it('founds an S station, supplies and builds its facilities, mines, refines and ships the product', () => {
    const sim = WorldSim.create(969); (sim as any).npcSlow = () => {};
    for (const lair of Object.values(sim.st.lairs)) { lair.alive = false; lair.respawnAt = 1e10; }
    const p = sim.addPlayer('실제 산업 흐름'), co = sim.st.companies[p]; co.credits = 1_000_000;
    const field = sim.st.fields.p9_anvil_ore, source = sim.st.stations.astra;
    const at = { ...field.pos, x: field.pos.x + 4000 };
    expect(jumps(sim.st.systems, 'astra', sysAt(sim.st.systems, at)!.id)).toBeGreaterThanOrEqual(2);
    const until = (description: string, predicate: () => boolean, seconds = 4000) => {
      for (let t = 0; t < seconds && !predicate(); t += .25) sim.update(.25);
      if (!predicate()) throw new Error(`${description}: ${JSON.stringify({ time: sim.time, groups: Object.values(sim.st.groups).filter(g => g.owner === p).map(g => ({ name: g.name, op: g.op.k, status: g.status })), routes: Object.values(sim.st.logistics ?? {}).map(r => ({ state: r.state, stats: r.stats, cursors: r.cursors })) })}`);
    };
    const builders = sim.newGroup(p, '실제 공작반'), constructor = sim.spawnShip(p, 'constructor', 'std', builders.id, source.pos);
    expect((sim as any).dockShip(constructor, source)).toBe(true);
    expect(sim.command(p, { c: 'buy', station: source.id, res: 'alloy', amount: 300, ship: constructor.id })).toBeNull();
    expect(sim.command(p, { c: 'setOp', group: builders.id, op: { k: 'found', at, name: '앤빌 산업 거점', size: 'S' } })).toBeNull();
    until('foundation', () => Object.values(sim.st.stations).some(s => s.owner === p && s.modules[0].built));
    const station = Object.values(sim.st.stations).find(s => s.owner === p)!;
    expect(station.size).toBe('S');
    expect(qty(constructor.cargo, 'alloy')).toBe(0);
    for (const kind of ['warehouse', 'dock', 'refinery']) expect(sim.command(p, { c: 'queueModule', station: station.id, kind })).toBeNull();
    const supply = [
      { item: 'alloy', amount: 490, from: 'astra' },
      { item: 'structure', amount: 10, from: 'p9_forge_works' },
      { item: 'machinery', amount: 8, from: 'p9_harbor_port' },
    ];
    const carriers = supply.map(({ item, amount, from }) => {
      expect(sim.command(p, { c: 'buy', station: from, res: item, amount })).toBeNull();
      const group = sim.newGroup(p, `${item} 공급`), ship = sim.spawnShip(p, 'hauler', 'std', group.id, sim.st.stations[from].pos);
      expect(sim.command(p, { c: 'putRoute', group: group.id, config: { name: `${item} 공급`, from, to: station.id, item, amount, mode: 'construction', repeat: true } })).toBeNull();
      return { group, ship, item };
    });
    expect(qty(station.storage[p], 'alloy')).toBe(0); // purchase is still at the selling station
    until('facilities', () => ['warehouse', 'dock', 'refinery'].every(k => station.modules.some(m => m.kind === k && m.built)), 6000);
    for (const carrier of carriers) {
      const route = Object.values(sim.st.logistics!).find(r => r.group === carrier.group.id)!;
      expect(route.stats.delivered).toBeGreaterThan(0);
      expect(sim.command(p, { c: 'routeControl', routes: [route.id], action: 'cancel' })).toBeNull();
    }
    const miners = sim.newGroup(p, '기존 자동 채굴선'), miner = sim.spawnShip(p, 'miner', 'std', miners.id, source.pos);
    const beforeField = field.amount;
    expect(sim.command(p, { c: 'setOp', group: miners.id, op: { k: 'mine', field: field.id, deliver: station.id, sell: false } })).toBeNull();
    expect(sim.command(p, { c: 'prodOrder', station: station.id, recipe: 'metal', mode: 'count', n: 1 })).toBeNull();
    until('automatic mining and refining', () => qty(station.storage[p], 'metal') >= 20, 6000);
    expect(co.stats.mined).toBeGreaterThan(40); expect(field.amount).toBeLessThan(beforeField);
    const freight = carriers[0];
    expect(sim.command(p, { c: 'putRoute', group: freight.group.id, config: { name: '정련 금속 출하', from: station.id, to: source.id, item: 'metal', amount: 20, mode: 'transfer', repeat: false } })).toBeNull();
    until('shipment', () => qty(source.storage[p], 'metal') >= 20, 4000);
    const shipped = Object.values(sim.st.logistics!).find(r => r.group === freight.group.id)!;
    expect(shipped.stats.loaded).toBe(20); expect(shipped.stats.delivered).toBe(20);
    expect(qty(station.storage[p], 'metal')).toBe(0); expect(qty(freight.ship.cargo, 'metal')).toBe(0);
    expect(sim.st.ships[miner.id]).toBeDefined();
  }, 60_000);
});

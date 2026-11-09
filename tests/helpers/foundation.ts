import type { WorldSim } from '../../src/world/sim';

/** Add a fixture freighter carrying a separately purchased load to the founding expedition. */
export function addFoundationFreighter(sim: WorldSim, player: string, group: string) {
  const source = sim.st.stations.astra;
  const ship = sim.spawnShip(player, 'hauler', 'std', group, source.pos);
  if (!(sim as any).dockShip(ship, source)) throw new Error('fixture freighter could not dock');
  const error = sim.command(player, { c: 'buy', station: source.id, res: 'alloy', amount: 300, ship: ship.id });
  if (error) throw new Error(`fixture freighter could not buy alloy: ${error}`);
  return ship;
}

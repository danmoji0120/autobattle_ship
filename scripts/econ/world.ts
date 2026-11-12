// Economy-analysis worlds. Two origins exist and they do NOT price goods the same way:
//   fresh     WorldSim.create(seed): the c3→c4 migration runs before upgradeIndustry adds most goods, so
//             only ore/alloy/crystal get c4 prices; every later good keeps its hand-set ITEMS price.
//   p10       the expanded universe (WorldSim.create(seed, { layout: 'p10' })): more markets and faction programs
//   migrated  an old c0 save (industry goods already in its markets) moved to c4: every raw good is
//             repriced to 25 % and every made good to its production-cost value (valueOf × station mult).
// A proposal (proposals.ts) is applied in memory only, to this process: nothing here is written to disk.
import { WorldSim } from '../../src/world/sim';
import { newWorld } from '../../src/world/worldgen';
import type { Proposal } from './proposals';

export type Origin = 'fresh' | 'migrated' | 'p10';

export function makeWorld(seed: number, origin: Origin, proposal: Proposal): WorldSim {
  proposal.patch?.();                                     // static data (recipes, NPC demand, facility costs)
  let sim: WorldSim;
  if (origin === 'fresh') sim = WorldSim.create(seed);
  else if (origin === 'p10') sim = WorldSim.create(seed, { layout: 'p10' });   // 40 systems, faction demand, fog
  else {
    const st = newWorld(seed); delete (st as { contentV?: number }).contentV;
    const c0 = new WorldSim(st, { migrateContent: false });
    sim = new WorldSim(JSON.parse(c0.serialize()), { migrateContent: true });
  }
  proposal.reprice?.(sim.st);                             // market base prices, as a migration would set them
  return sim;
}

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
import { migrateEconChain } from '../../src/world/econMigrate';

export type Origin = 'fresh' | 'migrated' | 'p10';

export function makeWorld(seed: number, origin: Origin, proposal: Proposal): WorldSim {
  proposal.patch?.();                                     // static data (recipes, NPC demand, facility costs)
  const lv = proposal.live, econ = lv ? { econ: 'chain' as const, eq: lv.eq, alloyDirect: lv.alloyDirect } : {};
  let sim: WorldSim;
  if (origin === 'fresh') sim = WorldSim.create(seed, econ);
  else if (origin === 'p10') sim = WorldSim.create(seed, { layout: 'p10', ...econ });   // 40 systems, faction demand, fog
  else {
    const st = newWorld(seed); delete (st as { contentV?: number }).contentV;
    const c0 = new WorldSim(st, { migrateContent: false });
    sim = new WorldSim(JSON.parse(c0.serialize()), { migrateContent: true });
    if (lv) { const r = migrateEconChain(sim.st, lv); if (!r.ok) throw new Error(`econ migration: ${r.why}`); }
  }
  proposal.reprice?.(sim.st);                             // market base prices, as a migration would set them
  return sim;
}

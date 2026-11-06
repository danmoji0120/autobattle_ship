// A save as the production world holds it before content migration v2 (contentV 0): built from a fresh
// world with player ships and stored equipment, then stripped of every field the content model added.
import { WorldSim } from '../../src/world/sim';
import type { WorldState } from '../../src/world/types';

export function makeC0World(seed = 11): { st: WorldState; players: string[] } {
  const sim = WorldSim.create(seed);
  const p = sim.addPlayer('이관 테스트');
  sim.st.companies[p].credits = 20_000_000; sim.st.companies[p].rep = 1000;   // baseline c4-b1: a battleship alone is ~2.6M
  for (const [classId, loadoutId] of [['battleship', 'fortress'], ['cruiser', 'missile'], ['destroyer', 'gun']] as const)
    { const e = sim.command(p, { c: 'buyShip', station: 'helios', classId, loadoutId }); if (e) throw new Error(`buyShip failed: ${classId} ${e}`); }
  for (let t = 0; t < 120; t += 0.5) sim.update(0.5);
  const st: WorldState = JSON.parse(sim.serialize());
  delete st.contentV; delete st.grants; delete st.conversions;
  for (const s of Object.values(st.ships)) { delete s.hull; delete s.variant; delete s.fitting; }
  for (const x of Object.values(st.stations)) for (const b of x.builds ?? []) { delete b.hull; delete b.variant; }
  return { st, players: [p] };
}

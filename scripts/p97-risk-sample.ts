// One isolated, unescorted field trial with normal NPC activity. This is not a profit guarantee.
import { mkdirSync, writeFileSync } from 'node:fs';
import { WorldSim } from '../src/world/sim';
import { qty } from '../src/world/types';
import { REGIONAL_FIELDS } from '../src/world/regional';

const sim = WorldSim.create(9701), p = sim.addPlayer('격리 위험 표본');
const co = sim.st.companies[p]; co.credits = 1_000_000; // test capital, not player progression
const destinations: Record<string, string> = { anvil: 'p9_anvil_port', shard: 'drakeout', dusk: 'rustport', blackgate: 'drakeout' };
const fleets = REGIONAL_FIELDS.map(f => {
  const group = sim.newGroup(p, `${f.name} 무호위 표본`), ship = sim.spawnShip(p, 'miner', 'std', group.id, sim.st.fields[f.id].pos);
  const error = sim.command(p, { c: 'setOp', group: group.id, op: { k: 'mine', field: f.id, deliver: destinations[f.sys], sell: false } });
  if (error) throw Error(`${f.id}: ${error}`);
  return { field: f.id, system: f.sys, item: f.res, destination: destinations[f.sys], group: group.id, ship: ship.id };
});
const started = Date.now(), credits = co.credits;
for (let i = 0; i < 3600 * 4; i++) sim.update(.25);
const result = { seed: 9701, gameSeconds: sim.time, cpuWallMs: Date.now() - started, creditChange: co.credits - credits, lost: co.stats.lost,
  fleets: fleets.map(f => ({ ...f, shipAlive: !!sim.st.ships[f.ship], shipState: sim.st.ships[f.ship]?.state ?? 'lost', status: sim.st.groups[f.group]?.status,
    inHold: qty(sim.st.ships[f.ship]?.cargo, f.item), delivered: qty(sim.st.stations[f.destination].storage[p], f.item), depositLeft: sim.st.fields[f.field].amount })),
  assumptions: 'One seeded miner per origin starts at the field with fixture capital; no escorts; NPCs and normal upkeep enabled. Starter fleet is included in upkeep. Goods are stored, not sold; price and realised profit are not measured.' };
mkdirSync('artifacts/p97', { recursive: true });
writeFileSync('artifacts/p97/risk-sample.json', JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));

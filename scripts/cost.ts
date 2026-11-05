import { defaultPlayerFleet, fleetCost } from '../src/sim/fleet';
import { SCENARIOS } from '../src/sim/data/scenarios';
console.log('player', fleetCost(defaultPlayerFleet()));
for (const s of SCENARIOS) console.log(s.id, fleetCost(s.enemy));

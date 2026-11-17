import '../../src/world/sim';
import { SHIP_CLASSES } from '../../src/sim/data/ships';
import { rateClass } from '../../src/world/combatRating';
for (const c of ['corvette', 'frigate', 'destroyer', 'light_cruiser', 'cruiser', 'battlecruiser', 'battleship', 'dreadnought'])
  for (const l of SHIP_CLASSES[c].loadouts) console.log(c.padEnd(14), l.id.padEnd(9), 'old', SHIP_CLASSES[c].cost, 'new', rateClass(c, l.id).toFixed(0));

import { WorldSim } from '../../src/world/sim';
import { STANDARD_WORLD } from '../../src/world/worldPreset';
const { territory: _t, ...o } = STANDARD_WORLD as any;
const sim = WorldSim.create(41, o);
const t1 = Date.now();
for (let i = 0; i < 3600 * 2; i++) sim.tick(1);
console.log('baseline 2h ms', Date.now() - t1, 'sovV', sim.st.sovV);

// Digest of ordinary battles (no BB-EX): must be identical before and after the BB-EX engine work.
import { World } from '../src/sim/world';
import { defaultPlayerFleet } from '../src/sim/fleet';
import { SCENARIOS } from '../src/sim/data/scenarios';
import '../src/content/registry';

const out: string[] = [];
for (const sc of SCENARIOS) for (const seed of [1, 7, 42]) {
  const w = new World({ seed, scenarioId: sc.id, fleets: [defaultPlayerFleet(), sc.enemy] });
  while (w.time < 150 && !w.outcome) w.step();
  out.push(`${sc.id}:${seed}:${w.digest()}:${w.tick}:${w.outcome?.winner ?? '-'}`);
}
console.log(out.join('\n'));

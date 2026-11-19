// P16.7: small preservation check — ordinary battles (scenarios × rules 0/2/3) and a short standard world run
// must give the same digests before and after the repair-ship code (no repair gear in any of them).
//   npx vite-node scripts/p16/repair-digest.ts [-- out.json]
import '../../src/content/registry';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { World } from '../../src/sim/world';
import { defaultPlayerFleet } from '../../src/sim/fleet';
import { SCENARIOS } from '../../src/sim/data/scenarios';
import { WorldSim } from '../../src/world/sim';
import { STANDARD_WORLD } from '../../src/world/worldPreset';

const out = process.argv.slice(2).filter(a => a !== '--')[0];
const rows: Record<string, string> = {};
for (const sc of SCENARIOS.slice(0, 4)) for (const rules of [0, 2, 3]) {
  const w = new World({ seed: 1, scenarioId: sc.id, rules, fleets: [defaultPlayerFleet(), sc.enemy] });
  while (!w.outcome && w.time < 700) w.step();
  rows[`${sc.id}.r${rules}`] = `${w.digest()}|${w.tick}|${w.outcome?.winner}`;
}
const sim = WorldSim.create(11, { ...STANDARD_WORLD });
for (let t = 0; t < 3600; t += 1) sim.tick(1);
const eng = Object.values(sim.st.engagements).map(e => `${e.id}:${e.done ? 1 : 0}:${e.winner ?? ''}`).sort();
const ships = Object.values(sim.st.ships).map(s => `${s.id}:${s.hp.toFixed(6)}:${s.state}`).sort();
rows.world11 = createHash('sha1').update(eng.join('|') + '#' + ships.join('|') + '#' + Object.values(sim.st.companies).map(c => Math.round(c.credits)).join(',')).digest('hex').slice(0, 16);
for (const [k, v] of Object.entries(rows)) console.log(k.padEnd(20), v);
if (out) fs.writeFileSync(out, JSON.stringify(rows, null, 1));

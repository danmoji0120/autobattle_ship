// Fingerprint of worlds that must not change with faction economy v2: c0 (5 systems), P9, P10 (v1
// factions) and P10 with value-chain (B) pricing, each run for a fixed number of 1 s ticks.
// Run on two commits and compare the hashes.   npx vite-node scripts/faction/legacy-hash.ts -- [ticks]
import { createHash } from 'node:crypto';
import { WorldSim } from '../../src/world/sim';
import { newWorld } from '../../src/world/worldgen';
const ticks = Number(process.argv.slice(2).find(a => /^\d+$/.test(a)) ?? 3600);
const worlds: [string, () => WorldSim][] = [
  ['c0', () => new WorldSim(newWorld(21))],
  ['p9', () => WorldSim.create(21)],
  ['p10-v1', () => WorldSim.create(21, { layout: 'p10' })],
  ['p10-v1-chain', () => WorldSim.create(21, { layout: 'p10', econ: 'chain' })],
];
for (const [name, make] of worlds) {
  const sim = make();
  for (let i = 0; i < ticks; i++) sim.tick(1);
  const s = sim.serialize();
  console.log(name.padEnd(14), createHash('sha256').update(s).digest('hex').slice(0, 16), s.length);
}

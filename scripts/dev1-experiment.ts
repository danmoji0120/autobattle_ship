// Isolated default 100-seed pair experiment; never connects to the persistent world.
import { mkdirSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { defaultConfig, runBattle, summarize, type BattleResult } from '../src/devlab/labModel';

const config = defaultConfig(), battles: BattleResult[] = [], start = performance.now();
for (let i = 0; i < 100; i++) {
  const seed = config.seed + i;
  battles.push(runBattle(config, seed, false), runBattle(config, seed, true));
  if ((i + 1) % 10 === 0) process.stderr.write(`${(i + 1) * 2}/200\n`);
}
const result = { schema: 'siderarium-combat-results-1', config, battles, summary: summarize(battles),
  byPlacement: { original: summarize(battles.filter(b => !b.swapped)), swapped: summarize(battles.filter(b => b.swapped)) },
  wallSeconds: (performance.now() - start) / 1000 };
mkdirSync('artifacts/dev1', { recursive: true });
writeFileSync('artifacts/dev1/default-experiment.json', JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ summary: result.summary, byPlacement: result.byPlacement, wallSeconds: result.wallSeconds }));

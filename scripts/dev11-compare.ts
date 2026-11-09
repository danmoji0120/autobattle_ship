// Re-run the DEV-1 reference pair without touching the saved baseline artifact.
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { defaultConfig, migrateConfig, runBattle, summarize, type BattleResult } from '../src/devlab/labModel';
const baseline = JSON.parse(readFileSync('artifacts/dev1/default-experiment.json', 'utf8'));
const config = migrateConfig(baseline.config);
if (JSON.stringify(config) !== JSON.stringify(defaultConfig())) throw new Error('Default differs from imported DEV-1 setup');
const battles: BattleResult[] = [];
for (let i = 0; i < 100; i++) {
  const seed = config.seed + i;
  battles.push(runBattle(config, seed, false), runBattle(config, seed, true));
}
const mismatches = battles.flatMap((battle, i) => JSON.stringify(battle) === JSON.stringify(baseline.battles[i]) ? [] : [i]);
mkdirSync('artifacts/dev11', { recursive: true });
writeFileSync('artifacts/dev11/default-experiment.json', JSON.stringify({ schema: 'siderarium-combat-results-1', config, battles, summary: summarize(battles), mismatches }, null, 2));
console.log(JSON.stringify({ summary: summarize(battles), mismatches }));
if (mismatches.length) throw new Error('DEV-1 battle results changed');

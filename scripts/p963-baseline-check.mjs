// Compare the immutable P9.6.2 definitions with the working tree; no server or database is touched.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { deepStrictEqual } from 'node:assert';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const baseline = 'e55c0f77ce0d3b8904c7a040083aad39a282ecf6';
const tmp = mkdtempSync(path.join(tmpdir(), 'siderarium-p963-data-')), oldRoot = path.join(tmp, 'old');
mkdirSync(oldRoot);
execFileSync('tar', ['-x', '-C', oldRoot], { input: execFileSync('git', ['archive', baseline], { maxBuffer: 32 * 1024 * 1024 }) });
symlinkSync(path.resolve('node_modules'), path.join(oldRoot, 'node_modules'));
async function bundle(root, name) {
  const entry = path.join(tmp, `${name}.ts`), out = path.join(tmp, `${name}.mjs`);
  writeFileSync(entry, `import ${JSON.stringify(path.join(root, 'src/content/registry.ts'))};\nexport { FACILITIES, RECIPES, TECHS, ITEMS } from ${JSON.stringify(path.join(root, 'src/world/industry.ts'))};\nexport { STATION_SIZES } from ${JSON.stringify(path.join(root, 'src/world/stations.ts'))};\n`);
  await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'silent' });
  return import(pathToFileURL(out).href);
}
const old = await bundle(oldRoot, 'old'), current = await bundle(process.cwd(), 'new');
deepStrictEqual(current.STATION_SIZES, old.STATION_SIZES);
deepStrictEqual(current.RECIPES, old.RECIPES); deepStrictEqual(current.TECHS, old.TECHS); deepStrictEqual(current.ITEMS, old.ITEMS);
deepStrictEqual(Object.keys(current.FACILITIES).sort(), Object.keys(old.FACILITIES).sort());
for (const [id, previous] of Object.entries(old.FACILITIES)) {
  const next = current.FACILITIES[id];
  if (id === 'core') { deepStrictEqual(next, previous); continue; }
  deepStrictEqual(next.legacyBuild, { credits: previous.credits, mats: previous.mats }, `${id} legacy terms`);
  const { credits: a, mats: b, minStation, legacyBuild, ...features } = next;
  const { credits: c, mats: d, ...oldFeatures } = previous;
  deepStrictEqual(features, oldFeatures, `${id} capability`);
}
const result = { baseline, facilitiesCompared: Object.keys(old.FACILITIES).length - 1,
  legacyFacilityTerms: 'identical', stationCoreAndOperatingCharacteristics: 'identical',
  facilityEffectsAndBuildTimes: 'identical', itemsRecipesAndResearch: 'identical' };
mkdirSync('artifacts/p963', { recursive: true });
writeFileSync('artifacts/p963/baseline-comparison.json', JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));

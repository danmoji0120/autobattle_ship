// Reproduce the inherited facility-name input on the P9.5 baseline and on this branch.
// Both worlds are in-memory fixtures; no server, database, or external account is touched.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const baseline = 'cfc3717912a5da563eabe593d325ce77a3062035';
const tmp = mkdtempSync(path.join(tmpdir(), 'siderarium-p96-input-')), oldRoot = path.join(tmp, 'old');
mkdirSync(oldRoot);
execFileSync('tar', ['-x', '-C', oldRoot], { input: execFileSync('git', ['archive', baseline], { maxBuffer: 32 * 1024 * 1024 }) });
symlinkSync(path.resolve('node_modules'), path.join(oldRoot, 'node_modules'));
async function load(root, name) {
  const entry = path.join(tmp, `${name}.ts`), bundle = path.join(tmp, `${name}.mjs`);
  writeFileSync(entry, `export { WorldSim } from ${JSON.stringify(path.join(root, 'src/world/sim.ts'))};\n`);
  await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', outfile: bundle, logLevel: 'silent' });
  return import(pathToFileURL(bundle).href);
}
function probe({ WorldSim }) {
  const sim = WorldSim.create(969), p = sim.addPlayer('검증 회사'), source = sim.st.stations.astra;
  const st = { ...structuredClone(source), id: 'input_test', owner: p, public: false, market: null, storage: { [p]: {} }, modules: [{ kind: 'core', slot: 0, built: true, progress: 1 }] };
  sim.st.stations[st.id] = st;
  const before = sim.st.companies[p].credits;
  let returned = null, exception = null;
  try { returned = sim.command(p, { c: 'queueModule', station: st.id, kind: 'constructor' }); }
  catch (e) { exception = String(e); }
  return { returned, exception, creditsFinite: Number.isFinite(sim.st.companies[p].credits), creditsUnchanged: sim.st.companies[p].credits === before, modules: st.modules.length };
}
const old = probe(await load(oldRoot, 'baseline')), current = probe(await load(process.cwd(), 'current'));
if (!old.exception || old.creditsFinite || current.returned !== '건설 불가' || !current.creditsUnchanged || current.modules !== 1) throw Error('Unexpected baseline/current input-check result');
const result = { baseline, old, current };
mkdirSync('artifacts/p96', { recursive: true });
writeFileSync('artifacts/p96/facility-input-results.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));

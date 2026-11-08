// Compare a genuine content-v0 world against the integration commit, without migrating it.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';

const baseline = 'fcc1485a94dee0a5983a637c59005e3db7f7c89e';
const tmp = mkdtempSync(path.join(tmpdir(), 'siderarium-p9-c0-')), oldRoot = path.join(tmp, 'old');
mkdirSync(oldRoot);
execFileSync('tar', ['-x', '-C', oldRoot], { input: execFileSync('git', ['archive', baseline], { maxBuffer: 32 * 1024 * 1024 }) });
symlinkSync(path.resolve('node_modules'), path.join(oldRoot, 'node_modules'));
async function bundle(root, name) {
  const entry = path.join(tmp, `${name}.ts`), out = path.join(tmp, `${name}.mjs`);
  writeFileSync(entry, `export { GameServer } from ${JSON.stringify(path.join(root, 'src/server/core.ts'))};\nexport { newWorld } from ${JSON.stringify(path.join(root, 'src/world/worldgen.ts'))};\n`);
  await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'silent' });
  return import(pathToFileURL(out).href);
}
const Old = await bundle(oldRoot, 'old'), New = await bundle(process.cwd(), 'new');
Object.defineProperty(performance, 'now', { value: () => 0 }); // Identical pre-existing NPC battle budget.
const opts = { singleplayer: false, snapInterval: 1e9, migrateContent: false };
const initial = new Old.GameServer({ v: 1, world: Old.newWorld(833), auth: {} }, opts);
initial.sim.addPlayer('c0 회사 하나'); initial.sim.addPlayer('c0 회사 둘');
const file = initial.snapshotFile();
if (file.world.contentV !== undefined || file.world.sites !== undefined || Object.keys(file.world.systems).length !== 5) throw Error('fixture is not a genuine five-system c0 save');
const a = new Old.GameServer(structuredClone(file), opts), b = new New.GameServer(structuredClone(file), opts);
const hash = sim => createHash('sha256').update(sim.serialize()).digest('hex');
for (let i = 1; i <= 1800 * 4; i++) {
  a.step(.25); b.step(.25);
  if (i % 240 === 0 && hash(a.sim) !== hash(b.sim)) throw Error(`c0 divergence at ${i / 4}s`);
}
const result = { baseline, contentV: 0, systems: 5, companies: 2, seconds: 1800, minuteHashesMatched: 30, hash: hash(a.sim), analyticsActive: !!b.analytics, reconciliation: b.analytics.query('admin', '').health.reconciliation };
mkdirSync('artifacts/p9', { recursive: true });
writeFileSync('artifacts/p9/c0-genuine-results.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));

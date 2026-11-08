// Compare original committed server to this worktree, including the active analytics collector.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, symlinkSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os'; import path from 'node:path'; import { pathToFileURL } from 'node:url'; import { createHash } from 'node:crypto';
import { build } from 'esbuild';
const baseline = process.env.C0_BASELINE_REF ?? '4a19e19bc47ca7ae27d9c97e7f57533232686fe1';
const temp = mkdtempSync(path.join(tmpdir(), 'siderarium-c0-')), old = path.join(temp, 'baseline'); mkdirSync(old);
execFileSync('tar', ['-x', '-C', old], { input: execFileSync('git', ['archive', baseline], { maxBuffer: 32 * 1024 * 1024 }) });
symlinkSync(path.resolve('node_modules'), path.join(old, 'node_modules'));
await build({ entryPoints: [path.join(old, 'src/server/core.ts')], bundle: true, platform: 'node', format: 'esm', outfile: path.join(temp, 'old.mjs'), logLevel: 'silent' });
await build({ entryPoints: ['src/server/core.ts'], bundle: true, platform: 'node', format: 'esm', outfile: path.join(temp, 'new.mjs'), logLevel: 'silent' });
const { GameServer: Old } = await import(pathToFileURL(path.join(temp, 'old.mjs')).href), { GameServer: New } = await import(pathToFileURL(path.join(temp, 'new.mjs')).href);
Object.defineProperty(performance, 'now', { value: () => 0 }); // Hold existing wall-time NPC budget constant.
const opts = { singleplayer: false, snapInterval: 1e9, migrateContent: false };
const initial = new Old(null, opts, 833); initial.sim.addPlayer('c0 보호'); initial.sim.addPlayer('c0 물류');
const file = initial.snapshotFile(); delete file.world.contentV;
const a = new Old(structuredClone(file), opts), b = new New(structuredClone(file), opts);
const hash = sim => createHash('sha256').update(sim.serialize()).digest('hex');
const seconds = 1800;
for (let i = 1; i <= seconds * 4; i++) {
  a.step(.25); b.step(.25);
  if (i % 240 === 0 && hash(a.sim) !== hash(b.sim)) throw Error(`c0 divergence at ${i / 4}s`);
}
const report = { baseline, companies: 2, seconds, minuteHashesMatched: 30, hash: hash(a.sim), analyticsActive: !!b.analytics, reconciliation: b.analytics.query('admin', '').health.reconciliation };
mkdirSync('artifacts/storage-analytics', { recursive: true }); writeFileSync('artifacts/storage-analytics/c0-results.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));

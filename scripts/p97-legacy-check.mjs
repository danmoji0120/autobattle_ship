// Compare real old c0 and P9 saves against the exact P9.7 base without applying a migration.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';

const baseline = 'b041dedc2da59d34492233f4eee07bd36778ff8d';
const temp = mkdtempSync(path.join(tmpdir(), 'siderarium-p97-legacy-'));
try {
  const oldRoot = path.join(temp, 'old'); mkdirSync(oldRoot);
  execFileSync('tar', ['-x', '-C', oldRoot], { input: execFileSync('git', ['archive', baseline], { maxBuffer: 32 * 1024 * 1024 }) });
  symlinkSync(path.resolve('node_modules'), path.join(oldRoot, 'node_modules'));
  async function bundle(root, name) {
    const entry = path.join(temp, `${name}.ts`), out = path.join(temp, `${name}.mjs`);
    writeFileSync(entry, `export { GameServer } from ${JSON.stringify(path.join(root, 'src/server/core.ts'))};\nexport { newWorld } from ${JSON.stringify(path.join(root, 'src/world/worldgen.ts'))};\n`);
    await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'silent' });
    return import(pathToFileURL(out).href);
  }
  const Old = await bundle(oldRoot, 'old'), New = await bundle(process.cwd(), 'new');
  Object.defineProperty(performance, 'now', { value: () => 0 });
  const opts = { singleplayer: false, snapInterval: 1e9, migrateContent: false };
  const hash = s => createHash('sha256').update(JSON.stringify(s.snapshotFile())).digest('hex');
  const results = [];
  for (const mode of ['c0', 'p9']) {
    const initial = mode === 'c0' ? new Old.GameServer({ v: 1, world: Old.newWorld(970), auth: {} }, opts) : new Old.GameServer(null, opts, 970);
    const p = initial.sim.addPlayer('격리 구형 저장'), q = initial.sim.addPlayer('두 번째 회사');
    initial.sim.st.companies[p].credits = 100000; initial.sim.st.companies[q].credits = 100000;
    const saved = initial.snapshotFile();
    if (saved.world.regionalV !== undefined || Object.keys(saved.world.systems).length !== (mode === 'c0' ? 5 : 22)) throw Error(`invalid ${mode} fixture`);
    let a = new Old.GameServer(structuredClone(saved), opts), b = new New.GameServer(structuredClone(saved), opts);
    const same = label => { const x = hash(a), y = hash(b); if (x !== y) throw Error(`${mode} ${label}: ${x} != ${y}`); return x; };
    same('restore');
    for (const cmd of [{ c: 'buy', station: 'astra', res: 'ore', amount: 30 }, { c: 'sell', station: 'astra', res: 'ore', amount: 10 }, { c: 'list', station: 'astra', item: 'ore', qty: 5, price: 10 }]) {
      const x = a.sim.command(p, cmd), y = b.sim.command(p, cmd);
      if (x !== null || y !== x) throw Error(`${mode} ${cmd.c}: ${x} / ${y}`); same(cmd.c);
    }
    const listing = a.sim.st.stations.astra.listings[0].id;
    for (const [company, cmd] of [[q, { c: 'buyListing', station: 'astra', listing, qty: 2 }], [p, { c: 'delist', station: 'astra', listing }]]) {
      const x = a.sim.command(company, cmd), y = b.sim.command(company, cmd);
      if (x !== null || y !== x) throw Error(`${mode} ${cmd.c}: ${x} / ${y}`); same(cmd.c);
    }
    const hashes = [];
    for (let i = 1; i <= 300 * 4; i++) {
      a.step(.25); b.step(.25);
      if (i % 240 === 0) hashes.push({ seconds: i / 4, hash: same(`${i / 4}s`) });
      if (i === 600) { a = new Old.GameServer(a.snapshotFile(), opts); b = new New.GameServer(b.snapshotFile(), opts); same('restart'); }
    }
    results.push({ mode, systems: Object.keys(saved.world.systems).length, oldFields: Object.keys(saved.world.fields).length, hashes, restoredAtSeconds: 150 });
  }
  const result = { baseline, results, note: 'Synthetic companies and credits; no regional activation and no production data.' };
  const out = process.env.SIDERARIUM_ARTIFACT_DIR || 'artifacts/p97'; mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, 'legacy-comparison.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
} finally { rmSync(temp, { recursive: true, force: true }); }

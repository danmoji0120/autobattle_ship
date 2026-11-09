// Compare a genuine content-v0 world against the P9.6.3 baseline, without migrating it.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';

const baseline = '793ff7746ae08c2500d4c4c44eb39aed99ed9b22';
const tmp = mkdtempSync(path.join(tmpdir(), 'siderarium-p9631-c0-')), oldRoot = path.join(tmp, 'old');
mkdirSync(oldRoot);
execFileSync('tar', ['-x', '-C', oldRoot], { input: execFileSync('git', ['archive', baseline], { maxBuffer: 32 * 1024 * 1024 }) });
symlinkSync(path.resolve('node_modules'), path.join(oldRoot, 'node_modules'));
async function bundle(root, name) {
  const entry = path.join(tmp, `${name}.ts`), out = path.join(tmp, `${name}.mjs`);
  writeFileSync(entry, `export { GameServer } from ${JSON.stringify(path.join(root, 'src/server/core.ts'))};\nexport { newWorld } from ${JSON.stringify(path.join(root, 'src/world/worldgen.ts'))};\nexport { watchMoney } from ${JSON.stringify(path.join(root, 'src/world/observe.ts'))};\n`);
  await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'silent' });
  return import(pathToFileURL(out).href);
}
const Old = await bundle(oldRoot, 'old'), New = await bundle(process.cwd(), 'new');
Object.defineProperty(performance, 'now', { value: () => 0 }); // Identical pre-existing NPC battle budget.
const opts = { singleplayer: false, snapInterval: 1e9, migrateContent: false };
const initial = new Old.GameServer({ v: 1, world: Old.newWorld(833), auth: {} }, opts);
const company = initial.sim.addPlayer('c0 회사 하나'); initial.sim.addPlayer('c0 회사 둘');
Old.watchMoney(initial.sim.st, 'fixture_capital', { company }, () => { initial.sim.st.companies[company].credits = 100000; });
const buy = initial.sim.command(company, { c: 'buyShip', station: 'astra', classId: 'constructor', loadoutId: 'std' }); if (buy) throw Error(buy);
const group = Object.values(initial.sim.st.groups).find(g => g.owner === company && g.shipIds.some(id => initial.sim.st.ships[id].classId === 'constructor'));
const p = initial.sim.st.stations.astra.pos;
const found = initial.sim.command(company, { c: 'setOp', group: group.id, op: { k: 'found', at: { x: p.x + 2600, y: 0, z: p.z + 2600 }, name: 'c0 결정론 기지' } }); if (found) throw Error(found);
const file = initial.snapshotFile();
if (file.world.contentV !== undefined || file.world.sites !== undefined || Object.keys(file.world.systems).length !== 5) throw Error('fixture is not a genuine five-system c0 save');
const a = new Old.GameServer(structuredClone(file), opts), b = new New.GameServer(structuredClone(file), opts);
const hash = sim => createHash('sha256').update(sim.serialize()).digest('hex');
for (let i = 1; i <= 1800 * 4; i++) {
  a.step(.25); b.step(.25);
  if (i === 2000) {
    const station = Object.values(a.sim.st.stations).find(s => s.owner === company);
    if (!station?.modules.some(m => m.kind === 'core' && m.built)) throw Error('c0 foundation did not complete');
    // Probe the c0 XL yard in an isolated clone; new growth-only tech must not alter old worlds.
    const pa = new Old.GameServer(structuredClone(a.snapshotFile()), opts), pb = new New.GameServer(structuredClone(a.snapshotFile()), opts);
    for (const server of [pa, pb]) {
      server.sim.st.stations[station.id].modules.push({ kind: 'yard_l', slot: 20, built: true, progress: 1 });
      server.sim.st.companies[company].credits = 1_000_000;
      server.sim.st.companies[company].tech = ['capital_hulls'];
    }
    const xl = { c: 'queueModule', station: station.id, kind: 'yard_xl' };
    const oldRefusal = pa.sim.command(company, xl), newRefusal = pb.sim.command(company, xl);
    if (!oldRefusal?.includes('드레드노트') || oldRefusal !== newRefusal || hash(pa.sim) !== hash(pb.sim)) throw Error(`c0 XL yard refusal differs: ${oldRefusal} / ${newRefusal}`);
    for (const server of [pa, pb]) server.sim.st.companies[company].tech.push('dreadnought_program');
    const oldAccept = pa.sim.command(company, xl), newAccept = pb.sim.command(company, xl);
    if (oldAccept || newAccept || hash(pa.sim) !== hash(pb.sim)) throw Error(`c0 XL yard acceptance differs: ${oldAccept} / ${newAccept}`);
    for (const kind of ['refinery', 'yard_s']) {
      const command = { c: 'queueModule', station: station.id, kind };
      const first = a.sim.command(company, command), second = b.sim.command(company, command);
      if (first || second || first !== second || hash(a.sim) !== hash(b.sim)) throw Error(`c0 ${kind} construction differs: ${first} / ${second}`);
    }
    for (const server of [a, b]) {
      const own = server.sim.st.stations[station.id];
      own.modules.push({ kind: 'yard_l', slot: 20, built: true, progress: 1 });
      server.sim.st.companies[company].tech = ['battleship_design'];
    }
    const command = { c: 'buildShip', station: station.id, classId: 'battleship', loadoutId: 'std' };
    const first = a.sim.command(company, command), second = b.sim.command(company, command);
    if (first || second || first !== second || hash(a.sim) !== hash(b.sim)) throw Error(`c0 battleship build differs: ${first} / ${second}`);
  }
  if (i % 240 === 0 && hash(a.sim) !== hash(b.sim)) throw Error(`c0 divergence at ${i / 4}s`);
}
const result = { baseline, contentV: 0, systems: 5, companies: 2, constructionCommands: ['refinery', 'yard_s', 'battleship (legacy tier 3)', 'XL yard legacy research refusal and acceptance'], seconds: 1800, minuteHashesMatched: 30, hash: hash(a.sim), analyticsActive: !!b.analytics, reconciliation: b.analytics.query('admin', '').health.reconciliation };
mkdirSync('artifacts/p9631', { recursive: true });
writeFileSync('artifacts/p9631/c0-results.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));

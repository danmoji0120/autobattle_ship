// Compare an isolated growth world and real battle engine against the exact integration base.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const { build } = createRequire(path.join(process.cwd(), 'package.json'))('esbuild');
const baseline = '1ffbcebb4df473159deccd50d92c92caa1fcf48d';
const tmp = mkdtempSync(path.join(tmpdir(), 'siderarium-p9632-compare-')), oldRoot = path.join(tmp, 'old');
mkdirSync(oldRoot);
execFileSync('tar', ['-x', '-C', oldRoot], { input: execFileSync('git', ['archive', baseline], { maxBuffer: 32 * 1024 * 1024 }) });
symlinkSync(path.resolve('node_modules'), path.join(oldRoot, 'node_modules'));
async function bundle(root, name) {
  const entry = path.join(tmp, `${name}.ts`), out = path.join(tmp, `${name}.mjs`);
  writeFileSync(entry, `export { WorldSim } from ${JSON.stringify(path.join(root, 'src/world/sim.ts'))};\nexport { GameServer } from ${JSON.stringify(path.join(root, 'src/server/core.ts'))};\nexport { World } from ${JSON.stringify(path.join(root, 'src/sim/world.ts'))};\nexport { defaultPlayerFleet } from ${JSON.stringify(path.join(root, 'src/sim/fleet.ts'))};\nexport { getScenario } from ${JSON.stringify(path.join(root, 'src/sim/data/scenarios.ts'))};\n`);
  await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'silent' });
  return import(pathToFileURL(out).href);
}
const Old = await bundle(oldRoot, 'old'), New = await bundle(process.cwd(), 'new');
Object.defineProperty(performance, 'now', { value: () => 0 });
const sim = Old.WorldSim.create(96329), seller = sim.addPlayer('비교 판매사'), buyer = sim.addPlayer('비교 구매사');
sim.st.companies[seller].credits = 1_000_000; sim.st.companies[buyer].credits = 1_000_000;
sim.st.companies[seller].rep = 1000; sim.st.stations.astra.storage[seller].ore = 100;
for (const l of Object.values(sim.st.lairs)) { l.alive = false; l.respawnAt = 1e10; }
const initial = { v: 1, world: JSON.parse(sim.serialize()), auth: { seller, buyer } };
const opts = { singleplayer: false, snapInterval: 1e9, migrateContent: false };
let a = new Old.GameServer(structuredClone(initial), opts), b = new New.GameServer(structuredClone(initial), opts);
const digest = s => createHash('sha256').update(s.sim.serialize()).digest('hex');
const serverDigest = s => createHash('sha256').update(JSON.stringify(s.snapshotFile())).digest('hex');
const equal = label => { const x = digest(a), y = digest(b); if (x !== y) throw Error(`${label} world mismatch ${x} / ${y}`); const sx = serverDigest(a), sy = serverDigest(b); if (sx !== sy) throw Error(`${label} server snapshot mismatch ${sx} / ${sy}`); return x; };
const generation = { systems: Object.keys(a.sim.st.systems).length, stations: Object.keys(a.sim.st.stations).length, ships: Object.keys(a.sim.st.ships).length, hash: equal('initial generation'), serverHash: serverDigest(a) };
const command = (co, cmd) => { const x = a.sim.command(co, cmd), y = b.sim.command(co, cmd); if (x !== y || x !== null) throw Error(`${cmd.c} mismatch: ${x} / ${y}`); equal(cmd.c); };
command(seller, { c: 'buy', station: 'astra', res: 'alloy', amount: 50 });
command(seller, { c: 'sell', station: 'astra', res: 'ore', amount: 10 });
command(seller, { c: 'list', station: 'astra', item: 'ore', qty: 10, price: 10 });
const listing = a.sim.st.stations.astra.listings[0].id;
command(buyer, { c: 'buyListing', station: 'astra', listing, qty: 4 });
command(seller, { c: 'delist', station: 'astra', listing });
command(seller, { c: 'buyShip', station: 'helios', classId: 'frigate', loadoutId: 'aa' });
const economy = { sellerCredits: a.sim.st.companies[seller].credits, buyerCredits: a.sim.st.companies[buyer].credits,
  sellerOre: a.sim.st.stations.astra.storage[seller].ore, buyerOre: a.sim.st.stations.astra.storage[buyer].ore,
  sellerAlloy: a.sim.st.stations.astra.storage[seller].alloy, marketOre: a.sim.st.stations.astra.market.ore.stock, hash: digest(a), serverHash: serverDigest(a) };
const prepare = s => {
  const quiet = s.sim.st.systems.quiet, at = { x: quiet.origin.x + 10000, y: 0, z: 0 };
  const group = s.sim.newGroup(seller, '비교 공작반');
  const constructor = s.sim.spawnShip(seller, 'constructor', 'std', group.id, at); constructor.cargo.alloy = 300;
  const hauler = s.sim.spawnShip(seller, 'hauler', 'std', group.id, at); hauler.cargo.alloy = 300;
  const err = s.sim.command(seller, { c: 'setOp', group: group.id, op: { k: 'found', at, name: '비교 정거장', size: 'S' } });
  if (err) throw Error(`foundation ${err}`);
};
prepare(a); prepare(b); equal('foundation setup');
const checkpoints = [];
for (let i = 1; i <= 360 * 4; i++) {
  a.step(.25); b.step(.25);
  if (i % 240 === 0) checkpoints.push({ seconds: i / 4, hash: equal(`world ${i / 4}s`), serverHash: serverDigest(a) });
  if (i === 600) {
    a = new Old.GameServer(a.snapshotFile(), opts); b = new New.GameServer(b.snapshotFile(), opts); equal('save/restore');
  }
}
const station = Object.values(a.sim.st.stations).find(s => s.owner === seller && s.name === '비교 정거장');
if (!station?.modules[0].built) throw Error('fixture S station did not complete');
const world = { seconds: 360, savedAtSeconds: 150, checkpoints, station: { id: station.id, size: station.size, built: station.modules[0].built } };
const battle = [];
for (const seed of [1, 7, 23]) {
  const setup = lib => ({ seed, scenarioId: 'kestrel', fleets: [lib.defaultPlayerFleet(), lib.getScenario('kestrel').enemy] });
  const x = new Old.World(setup(Old)), y = new New.World(setup(New));
  x.runUntilEnd(); y.runUntilEnd();
  if (!x.outcome || !y.outcome) throw Error(`battle seed ${seed} did not reach an outcome`);
  const xa = { digest: x.digest(), outcome: x.outcome, time: x.time }, ya = { digest: y.digest(), outcome: y.outcome, time: y.time };
  if (JSON.stringify(xa) !== JSON.stringify(ya)) throw Error(`battle seed ${seed} diverged`);
  battle.push({ seed, ...xa });
}
const result = { baseline, current: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), generation, economy, world, battle,
  fixture: 'two isolated companies, fixture credits and 600 alloy, normal regional security and lairs disabled; no production data' };
const out = process.env.P9632_VERIFICATION_DIR ?? 'artifacts/p9632-integration'; mkdirSync(out, { recursive: true });
writeFileSync(path.join(out, 'comparison.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));

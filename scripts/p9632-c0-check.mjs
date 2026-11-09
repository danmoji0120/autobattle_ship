// Compare valid c0 trade and replay from the exact P9.6.3.2 parent, without content migration.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';

const baseline = '1ffbcebb4df473159deccd50d92c92caa1fcf48d';
const tmp = mkdtempSync(path.join(tmpdir(), 'siderarium-p9632-c0-')), oldRoot = path.join(tmp, 'old');
mkdirSync(oldRoot);
execFileSync('tar', ['-x', '-C', oldRoot], { input: execFileSync('git', ['archive', baseline], { maxBuffer: 32 * 1024 * 1024 }) });
symlinkSync(path.resolve('node_modules'), path.join(oldRoot, 'node_modules'));
async function bundle(root, name) {
  const entry = path.join(tmp, `${name}.ts`), out = path.join(tmp, `${name}.mjs`);
  writeFileSync(entry, `export { GameServer } from ${JSON.stringify(path.join(root, 'src/server/core.ts'))};\nexport { newWorld } from ${JSON.stringify(path.join(root, 'src/world/worldgen.ts'))};\nexport { econOf } from ${JSON.stringify(path.join(root, 'src/world/hullops.ts'))};\n`);
  await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'silent' });
  return import(pathToFileURL(out).href);
}
const Old = await bundle(oldRoot, 'old'), New = await bundle(process.cwd(), 'new');
Object.defineProperty(performance, 'now', { value: () => 0 });
const options = { singleplayer: false, snapInterval: 1e9, migrateContent: false };
const initial = new Old.GameServer({ v: 1, world: Old.newWorld(833), auth: {} }, options);
const seller = initial.sim.addPlayer('c0 판매 회사'), buyer = initial.sim.addPlayer('c0 구매 회사');
initial.sim.st.companies[seller].credits = 100_000; initial.sim.st.companies[buyer].credits = 100_000;
const file = initial.snapshotFile();
if (file.world.contentV !== undefined || Object.keys(file.world.systems).length !== 5) throw Error('fixture is not a genuine five-system c0 save');
let a = new Old.GameServer(structuredClone(file), options), b = new New.GameServer(structuredClone(file), options);
const hash = sim => createHash('sha256').update(sim.serialize()).digest('hex');
const command = (co, cmd) => {
  const x = a.sim.command(co, cmd), y = b.sim.command(co, cmd);
  if (x !== y || x !== null || hash(a.sim) !== hash(b.sim)) throw Error(`${cmd.c} differs: ${x} / ${y}`);
};
command(seller, { c: 'buy', station: 'astra', res: 'ore', amount: 30 });
command(seller, { c: 'sell', station: 'astra', res: 'ore', amount: 10 });
command(seller, { c: 'list', station: 'astra', item: 'ore', qty: 5, price: 10 });
const listing = a.sim.st.stations.astra.listings[0].id;
command(buyer, { c: 'buyListing', station: 'astra', listing, qty: 2 });
command(seller, { c: 'delist', station: 'astra', listing });
let matched = 0;
for (let i = 1; i <= 300 * 4; i++) {
  a.step(.25); b.step(.25);
  if (i % 240 === 0) { if (hash(a.sim) !== hash(b.sim)) throw Error(`c0 divergence at ${i / 4}s`); matched++; }
  if (i === 600) { a = new Old.GameServer(a.snapshotFile(), options); b = new New.GameServer(b.snapshotFile(), options); if (hash(a.sim) !== hash(b.sim)) throw Error('c0 restore diverged'); }
}
// The safety fix deliberately changes the c0 edge case that previously overfilled a hold.
const edge = (lib) => {
  const server = new lib.GameServer(structuredClone(file), options), sim = server.sim, station = sim.st.stations.astra;
  const group = sim.newGroup(seller, 'c0 소량 화물'), ship = sim.spawnShip(seller, 'hauler', 'std', group.id, station.pos);
  if (!sim.dockShip(ship, station)) throw Error('could not prepare c0 cargo fixture');
  const cap = lib.econOf(ship).cargo; ship.cargo.ore = .25; station.storage[seller].ore = cap * 2;
  const err = sim.command(seller, { c: 'setOp', group: group.id, op: { k: 'haul', from: station.id, to: 'nova', res: 'ore' } });
  if (err) throw Error(err);
  for (let i = 0; i < 80 && ship.cargo.ore <= .25; i++) sim.update(.25);
  return { cap, cargo: ship.cargo.ore, remaining: station.storage[seller].ore };
};
const legacyFractionalCargo = { old: edge(Old), current: edge(New) };
if (legacyFractionalCargo.old.cargo !== legacyFractionalCargo.old.cap + .25 || legacyFractionalCargo.current.cargo !== legacyFractionalCargo.current.cap || legacyFractionalCargo.old.cargo + legacyFractionalCargo.old.remaining !== legacyFractionalCargo.current.cargo + legacyFractionalCargo.current.remaining) throw Error('fractional hold safety comparison failed');
const result = { baseline, contentV: 0, systems: 5, companies: 2, commands: ['buy', 'sell', 'list', 'buyListing', 'delist'], seconds: 300, matchingMinuteHashes: matched, restartAtSeconds: 150, hash: hash(a.sim), intentionallyChangedFractionalHold: legacyFractionalCargo };
mkdirSync('artifacts/p9632', { recursive: true });
writeFileSync('artifacts/p9632/c0-results.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));

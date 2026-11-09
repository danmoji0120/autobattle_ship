// Isolated local file-backed server: real accounts, WebSocket authorization and process restart.
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import { build } from 'esbuild';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = mkdtempSync(path.join(tmpdir(), 'siderarium-p95-mp-')), save = path.join(dir, 'world.json');
const port = 8358, base = `http://127.0.0.1:${port}`, out = process.env.SIDERARIUM_ARTIFACT_DIR || 'artifacts/p95', checks = [], sockets = [];
let server;
const delay = ms => new Promise(r => setTimeout(r, ms));
function check(ok, label) { if (!ok) throw Error(label); checks.push(label); console.log('PASS', label); }
async function until(fn, message, timeout = 30000) { const end = Date.now() + timeout; while (Date.now() < end) { const value = await fn(); if (value) return value; await delay(100); } throw Error(message); }
async function start() {
  const child = spawn('node', ['dist-server/server.mjs'], { env: { ...process.env, PORT: String(port), SAVE_FILE: save, DATABASE_URL: '', SAVE_INTERVAL_S: '.5', WORLD_SEED: '951' } });
  let log = ''; child.stdout.on('data', d => log += d); child.stderr.on('data', d => log += d);
  await until(() => log.includes('listening on'), 'isolated server did not start: ' + log, 20000); server = child;
}
async function stop() { for (const ws of sockets.splice(0)) ws.close(); if (server) { const child = server; server = undefined; await new Promise(resolve => { child.once('exit', resolve); child.kill('SIGTERM'); }); } }
class Pilot {
  cookie = ''; seq = 1; messages = [];
  constructor(name) { this.name = name; }
  async post(route, body) { const r = await fetch(base + route, { method: 'POST', headers: { origin: base, 'content-type': 'application/json', cookie: this.cookie }, body: JSON.stringify(body) }); const c = r.headers.get('set-cookie'); if (c) this.cookie = c.split(';')[0]; return r.status; }
  async connect() {
    this.messages = []; this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { origin: base, cookie: this.cookie } }); sockets.push(this.ws);
    this.ws.on('message', raw => { const m = JSON.parse(String(raw)); this.messages.push(m); if (m.t === 'needPmc') this.ws.send(JSON.stringify({ t: 'createPmc', name: this.name })); });
    await new Promise((resolve, reject) => { this.ws.once('open', resolve); this.ws.once('error', reject); }); this.ws.send(JSON.stringify({ t: 'hello', name: this.name }));
    this.id = (await this.wait(m => m.t === 'welcome')).company;
  }
  wait(test) { return until(() => this.messages.find(test), 'missing socket response', 12000); }
  async cmd(cmd) { const id = this.seq++; this.ws.send(JSON.stringify({ t: 'cmd', id, cmd })); return this.wait(m => m.t === 'ack' && m.id === id); }
  async snap(test = () => true) { return until(() => this.messages.filter(m => m.t === 'snap').findLast(test), 'missing matching snapshot', 12000); }
}
try {
  await start();
  const a = new Pilot('원정 A'), b = new Pilot('원정 B');
  check(await a.post('/api/auth/signup', { loginId: 'p95_alpha', password: 'p95-alpha-password-123', confirm: 'p95-alpha-password-123' }) === 200, 'first isolated account signs in');
  check(await b.post('/api/auth/signup', { loginId: 'p95_beta', password: 'p95-beta-password-123', confirm: 'p95-beta-password-123' }) === 200, 'second isolated account signs in');
  await a.connect(); await b.connect(); await stop();
  const entry = path.join(dir, 'entry.mjs'), bundle = path.join(dir, 'core.mjs');
  writeFileSync(entry, `export { GameServer } from ${JSON.stringify(path.resolve('src/server/core.ts'))};\nexport { watchMoney } from ${JSON.stringify(path.resolve('src/world/observe.ts'))};\n`);
  await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', outfile: bundle, logLevel: 'silent' });
  const { GameServer, watchMoney } = await import(pathToFileURL(bundle).href);
  const seeded = new GameServer(JSON.parse(readFileSync(save, 'utf8')), { singleplayer: false, snapInterval: 1, migrateContent: false });
  const sim = seeded.sim; sim.npcSlow = () => {}; for (const l of Object.values(sim.st.lairs)) { l.alive = false; l.respawnAt = 1e10; }
  for (const pilot of [a, b]) watchMoney(sim.st, 'fixture_capital', { company: pilot.id }, () => { sim.st.companies[pilot.id].credits = 500000; });
  const quiet = sim.st.systems.quiet, target = { x: quiet.origin.x + 10000, y: 0, z: 0 };
  const buildA = sim.newGroup(a.id, 'A 공작반'); sim.spawnShip(a.id, 'constructor', 'std', buildA.id, target);
  if (sim.command(a.id, { c: 'setOp', group: buildA.id, op: { k: 'found', at: target, name: '격리 현장' } })) throw Error('fixture founding failed');
  for (let i = 0; i < 20 && !Object.values(sim.st.stations).some(s => s.owner === a.id); i++) sim.update(.25);
  const site = Object.values(sim.st.stations).find(s => s.owner === a.id); if (!site) throw Error('fixture site missing');
  if (sim.command(a.id, { c: 'buy', station: 'astra', res: 'alloy', amount: 300 })) throw Error('fixture market purchase failed');
  const freight = sim.newGroup(a.id, 'A 운송'), ship = sim.spawnShip(a.id, 'hauler', 'std', freight.id, sim.st.stations.astra.pos); sim.dockShip(ship, sim.st.stations.astra);
  const config = { name: '격리 현장 공급', from: 'astra', to: site.id, item: 'alloy', mode: 'construction', amount: 300, repeat: true };
  if (sim.command(a.id, { c: 'putRoute', group: freight.id, config })) throw Error('fixture route failed');
  const route = Object.values(sim.st.logistics).find(r => r.group === freight.id);
  for (let i = 0; i < 4800 && !(route.manifests[ship.id] && sim.sysOf(ship.pos)?.id !== 'astra'); i++) sim.update(.25);
  if (!route.manifests[ship.id] || sim.sysOf(ship.pos)?.id === 'astra') throw Error('fixture cargo did not leave Astra');
  if (sim.command(a.id, { c: 'routeControl', routes: [route.id], action: 'pause' })) throw Error('fixture pause failed');
  const buildB = sim.newGroup(b.id, 'B 공작반'); sim.spawnShip(b.id, 'constructor', 'std', buildB.id, sim.st.stations.astra.pos);
  const remote = sim.st.systems.rime, atB = { x: remote.origin.x + 10000, y: 0, z: 0 };
  if (sim.command(b.id, { c: 'setOp', group: buildB.id, op: { k: 'found', at: atB, name: '환급 검증' } })) throw Error('fixture B funding failed');
  const expectedB = sim.st.companies[b.id].credits;
  writeFileSync(save, JSON.stringify(seeded.snapshotFile()));
  await start(); await a.connect(); await b.connect();
  const as = await a.snap(m => !!m.state.logistics?.[route.id]), bs = await b.snap(m => !!m.state.groups?.[buildB.id]);
  check(as.state.logistics[route.id].manifests[ship.id].amount === 300 && as.state.ships[ship.id].cargo.alloy === 300, 'owner sees a real paused multi-gate shipment');
  check(!bs.state.logistics?.[route.id] && !bs.state.stations[site.id].storage[a.id] && !bs.state.companies[a.id].foundingEscrow, 'other company snapshots hide routes, stock and prepayment');
  check((await b.cmd({ c: 'routeControl', routes: [route.id], action: 'resume' })).err?.includes('자사'), 'foreign company cannot resume the shipment');
  check((await b.cmd({ c: 'unloadCargo', ship: ship.id })).err?.includes('자사'), 'foreign company cannot take cargo');
  check((await b.cmd({ c: 'setOp', group: buildB.id, op: { k: 'build', station: site.id } })).err?.includes('자사'), 'foreign company cannot deliver to another company site');
  await stop(); await start(); await a.connect(); await b.connect();
  const ar = await a.snap(m => !!m.state.logistics?.[route.id]), br = await b.snap(m => !!m.state.companies[b.id].foundingEscrow?.[buildB.id]);
  check(ar.state.logistics[route.id].manifests[ship.id].amount === 300 && ar.state.ships[ship.id].cargo.alloy === 300 && ar.state.logistics[route.id].stats.loaded === 300, 'file-backed process restart restores cargo and manifest without duplicate loading');
  check(br.state.companies[b.id].foundingEscrow[buildB.id] === 16000, 'process restart restores the other company’s refundable prepayment');
  check(!(await b.cmd({ c: 'setOp', group: buildB.id, op: { k: 'idle' } })).err, 'owner can cancel its own founding order after restart');
  const refunded = await b.snap(m => !m.state.companies[b.id].foundingEscrow && m.state.companies[b.id].credits >= expectedB + 15999);
  check(refunded.state.companies[b.id].credits <= expectedB + 16000, 'prepayment is returned once without credit duplication');
  check(!(await a.cmd({ c: 'routeControl', routes: [route.id], action: 'resume' })).err, 'owner can resume the preserved route after restart');
  const purchase = { c: 'buy', station: 'astra', res: 'alloy', amount: 20, request: { seq: 1, id: 'p95_mp_retry_1' } };
  check(!(await b.cmd(purchase)).err && !(await b.cmd(purchase)).err, 'duplicate WebSocket purchase request is acknowledged without a second trade');
  await b.snap(m => m.state.companies[b.id].lastPurchase?.seq === 1 && m.state.stations.astra.storage[b.id]?.alloy === 20);
  await stop(); await start(); await b.connect();
  check(!(await b.cmd(purchase)).err, 'same purchase can be retried after a server process restart');
  const purchaseSnap = await b.snap(m => m.state.companies[b.id].lastPurchase?.seq === 1);
  check(purchaseSnap.state.stations.astra.storage[b.id]?.alloy === 20, 'restart and retry do not duplicate purchased material');
  await stop(); const final = JSON.parse(readFileSync(save, 'utf8'));
  const world = final.world, core = world.stations[site.id].modules[0];
  const conserved = (world.stations.astra.storage[a.id].alloy || 0) + (world.ships[ship.id]?.cargo.alloy || 0) + (world.stations[site.id].storage[a.id].alloy || 0) + (core.reserved?.alloy || 0) + (core.used?.alloy || 0) + (core.built ? 600 : 0);
  check(!core.built && world.logistics[route.id].stats.loaded === 300 && Math.abs(conserved - 300) < 1e-6, 'partial supply leaves the core waiting and conserves the purchased cargo exactly once');
  mkdirSync(out, { recursive: true }); writeFileSync(`${out}/multiplayer-results.json`, JSON.stringify({ checks, passed: checks.length, processRestarts: 3, shipment: 300, escrowRefund: 16000 }, null, 2));
  console.log(JSON.stringify({ passed: checks.length }));
} catch (error) { console.error(error); process.exitCode = 1; }
finally { await stop(); }

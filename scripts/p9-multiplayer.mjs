// Two real WebSocket clients against a disposable local server and file-backed test world.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import WebSocket from 'ws';

const dir = mkdtempSync(path.join(tmpdir(), 'siderarium-p9-mp-'));
const save = path.join(dir, 'world.json');
const binary = path.resolve('dist-server/server.mjs'), staticDir = path.resolve('dist');
const probe = net.createServer();
await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
const base = `http://127.0.0.1:${port}`, checks = [], sockets = [];
let child;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, reason, ms = 30000) { const end = Date.now() + ms; while (Date.now() < end) { const value = await fn(); if (value) return value; await delay(100); } throw Error(reason); }
function check(ok, label) { if (!ok) throw Error(label); checks.push(label); console.log('PASS', label); }
async function start() {
  let log = '';
  child = spawn('node', [binary], { cwd: dir, env: { ...process.env, PORT: String(port), STATIC_DIR: staticDir, SAVE_FILE: save, DATABASE_URL: '', WORLD_RESET: '', CONTENT_MIGRATE: '', WORLD_SEED: '9402', SAVE_INTERVAL_S: '.2' } });
  child.stdout.on('data', d => log += d); child.stderr.on('data', d => log += d);
  await until(() => { if (child.exitCode !== null) throw Error(log); return log.includes('listening on'); }, `local server did not start: ${log}`);
}
async function stop() {
  for (const s of sockets.splice(0)) s.close();
  if (child) { const p = child; child = undefined; await new Promise(resolve => { p.once('exit', resolve); p.kill('SIGTERM'); }); }
}
class Pilot {
  constructor(name) { this.name = name; this.messages = []; this.seq = 1; }
  async signup(loginId) {
    const response = await fetch(base + '/api/auth/signup', { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ loginId, password: 'p9-test-password-123', confirm: 'p9-test-password-123' }) });
    this.cookie = response.headers.get('set-cookie')?.split(';')[0];
    if (response.status !== 200 || !this.cookie) throw Error(`signup failed: ${response.status}`);
  }
  async connect() {
    this.messages = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { origin: base, cookie: this.cookie } }); this.ws = ws; sockets.push(ws);
    ws.on('message', raw => { const m = JSON.parse(String(raw)); this.messages.push(m); if (m.t === 'needPmc') ws.send(JSON.stringify({ t: 'createPmc', name: this.name })); });
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    ws.send(JSON.stringify({ t: 'hello', name: this.name }));
    this.id = (await this.wait(m => m.t === 'welcome')).company;
    await this.wait(m => m.t === 'snap');
  }
  wait(test) { return until(() => this.messages.find(test), `missing socket response for ${this.name}`); }
  async command(cmd) { const id = this.seq++; this.ws.send(JSON.stringify({ t: 'cmd', id, cmd })); return this.wait(m => m.t === 'ack' && m.id === id); }
  snap() { return this.messages.filter(m => m.t === 'snap').at(-1).state; }
}
try {
  await start(); const a = new Pilot('P9 첫 회사'), b = new Pilot('P9 둘째 회사');
  await a.signup('p9_alpha'); await b.signup('p9_beta'); await a.connect(); await b.connect();
  check(a.id !== b.id, 'two separate accounts join the same test server');
  for (const p of [a, b]) {
    const state = p.snap();
    check(Object.keys(state.systems).length === 22 && !!state.systems.blackgate && !!state.systems.quiet, `${p.name} receives the 22-system topology`);
    check(!state.sites?.site_relic_0, `${p.name} does not receive the undiscovered archive`);
  }
  const state = a.snap(), group = Object.values(state.groups).find(g => g.owner === a.id && g.shipIds.length);
  const target = { ...state.systems.harbor.origin, x: state.systems.harbor.origin.x + 9000 };
  const ack = await a.command({ c: 'setOp', group: group.id, op: { k: 'move', to: target } });
  check(!ack.err, 'server accepts a real cross-system movement order');
  await until(() => { try { const f = JSON.parse(readFileSync(save, 'utf8')); return f.world.groups[group.id]?.op?.k === 'move'; } catch { return false; } }, 'movement was not saved');
  await stop();
  const before = JSON.parse(readFileSync(save, 'utf8'));
  await start(); await a.connect(); await b.connect();
  const after = a.snap();
  check(a.id === before.world.groups[group.id].owner && after.groups[group.id].op.k === 'move', 'restart restores the owner and in-progress command');
  check(Object.keys(after.systems).length === 22 && JSON.stringify(after.systems.blackgate.gates) === JSON.stringify(before.world.systems.blackgate.gates), 'restart preserves all systems and destination gates');
  const oldShips = Object.values(before.world.ships).filter(s => s.owner === a.id).map(s => s.id).sort();
  const newShips = Object.values(after.ships).filter(s => s.owner === a.id).map(s => s.id).sort();
  check(JSON.stringify(newShips) === JSON.stringify(oldShips), 'restart preserves every ship in the first company fleet');
  const stores = stations => Object.fromEntries(Object.entries(stations).map(([id, s]) => [id, s.storage[a.id] ?? {}]));
  check(JSON.stringify(stores(after.stations)) === JSON.stringify(stores(before.world.stations)), 'restart preserves all first-company station inventories');
  check(after.companies[a.id].credits === before.world.companies[a.id].credits, 'restart preserves the first company credit balance');
  check(!!after.companies[b.id] && !b.snap().sites?.site_relic_0, 'second company and undiscovered site privacy survive restart');
  mkdirSync('artifacts/p9', { recursive: true });
  writeFileSync('artifacts/p9/multiplayer-results.json', JSON.stringify({ passed: checks.length, checks, backend: 'temporary JSON file', realWebSockets: 2, restarts: 1 }, null, 2));
} finally { await stop(); }

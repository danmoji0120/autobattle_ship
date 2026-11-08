// Isolated real HTTP/WebSocket server test. No production database or account is used.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os'; import path from 'node:path'; import WebSocket from 'ws';
const dir = mkdtempSync(path.join(tmpdir(), 'siderarium-analytics-mp-')), save = path.join(dir, 'world.json'), port = 8343, base = `http://localhost:${port}`;
let server; const sockets = [], checks = [];
const check = (condition, label) => { if (!condition) throw Error(label); checks.push(label); console.log('PASS', label); };
const delay = ms => new Promise(r => setTimeout(r, ms));
async function start(admin = '') {
  const p = spawn('node', ['dist-server/server.mjs'], { env: { ...process.env, DATABASE_URL: '', SAVE_FILE: save, PORT: String(port), WORLD_SEED: '663', ANALYTICS_ADMIN_ACCOUNTS: admin } });
  let log = ''; p.stdout.on('data', d => log += d); p.stderr.on('data', d => log += d);
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error(log)), 20000); const poll = setInterval(() => { if (log.includes('listening on')) { clearTimeout(timer); clearInterval(poll); resolve(); } }, 30); p.on('exit', c => { clearTimeout(timer); clearInterval(poll); reject(Error(`server exited ${c}: ${log}`)); }); });
  server = p;
}
async function stop() { if (!server) return; const p = server; server = null; for (const ws of sockets.splice(0)) ws.close(); await new Promise(r => { p.once('exit', r); p.kill('SIGTERM'); }); }
class Browser {
  cookie = ''; id = ''; seq = 1;
  constructor(name) { this.name = name; }
  async post(route, body) { const r = await fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json', origin: base, cookie: this.cookie }, body: JSON.stringify(body) }); const c = r.headers.get('set-cookie'); if (c) this.cookie = c.split(';')[0]; return { status: r.status, body: await r.json() }; }
  async connect() {
    this.ws = new WebSocket(`ws://localhost:${port}/ws`, { headers: { cookie: this.cookie, origin: base } }); sockets.push(this.ws); this.messages = [];
    this.ws.on('message', raw => { const m = JSON.parse(String(raw)); this.messages.push(m); if (m.t === 'needPmc') this.ws.send(JSON.stringify({ t: 'createPmc', name: this.name })); });
    await new Promise((r, j) => { this.ws.once('open', r); this.ws.once('error', j); });
    this.ws.send(JSON.stringify({ t: 'hello', name: 'untrusted', token: 'untrusted' }));
    const welcome = await this.wait(m => m.t === 'welcome'); this.id = welcome.company;
  }
  async wait(test) { const until = Date.now() + 10000; while (Date.now() < until) { const m = this.messages.find(test); if (m) return m; await delay(20); } throw Error('WebSocket response timeout'); }
  async query(scope, extra = {}) { const id = this.seq++; this.ws.send(JSON.stringify({ t: 'analytics', id, scope, ...extra })); return this.wait(m => m.t === 'analytics' && m.id === id); }
  async cmd(cmd) { const id = this.seq++; this.ws.send(JSON.stringify({ t: 'cmd', id, cmd })); return this.wait(m => m.t === 'ack' && m.id === id); }
}
try {
  await start(); const a = new Browser('관리자 시험사'), b = new Browser('플레이어 시험사');
  const aa = await a.post('/api/auth/signup', { loginId: 'analytics_admin', password: 'test-analytics-password-123', confirm: 'test-analytics-password-123' });
  const bb = await b.post('/api/auth/signup', { loginId: 'analytics_player', password: 'test-analytics-password-456', confirm: 'test-analytics-password-456' });
  check(aa.status === 201 || aa.status === 200, 'first test account signs in'); check(bb.status === 201 || bb.status === 200, 'second test account signs in');
  await a.connect(); await b.connect(); const company = a.id;
  check(!!(await a.query('admin')).error, 'administrator access is disabled without trusted server configuration');
  check((await a.cmd({ c: 'lease', station: 'astra', blocks: 1 })).err === null, 'real rental command creates a prepaid lease');
  await stop(); const first = JSON.parse(readFileSync(save, 'utf8'));
  check(first.analytics?.version === 1 && first.analytics.current.rows.length > 0, 'server file save includes actual telemetry');
  await start(aa.body.account.id);
  await a.post('/api/auth/login', { loginId: 'analytics_admin', password: 'test-analytics-password-123', confirm: 'test-analytics-password-123' });
  await b.post('/api/auth/login', { loginId: 'analytics_player', password: 'test-analytics-password-456', confirm: 'test-analytics-password-456' });
  await a.connect(); await b.connect(); check(a.id === company, 'account and company survive server restart');
  const forbidden = await b.query('admin', { account: aa.body.account.id, admin: true });
  check(!!forbidden.error && !forbidden.data, 'forged client admin/account fields do not grant access');
  const own = await b.query('player'); check(!!own.data && own.data.current.companies.length === 1 && own.data.current.companies[0].id === b.id, 'player query returns only its own company');
  check(own.data.totals.every(r => r.company === b.id && !r.kind.startsWith('currency.')), 'private event rows are scoped to the authenticated company');
  const snap = await b.wait(m => m.t === 'snap');
  check(snap.state.companies[a.id].leases === undefined && snap.state.companies[a.id].credits === 0, 'ordinary snapshots redact competitor finances and lease data');
  check(snap.state.stations.astra.storage[a.id] === undefined, 'ordinary snapshots redact competitor warehouse inventory');
  const all = await a.query('admin'); check(all.data?.scope === 'admin' && all.data.current.companies.length === 2, 'trusted server account receives administrator analysis');
  check(Math.abs(all.data.health.reconciliation) < .001, 'real server currency ledger reconciles');
  const persisted = all.data.totals.filter(r => r.kind === 'income' && r.company === a.id && r.reason === 'company_creation').reduce((n, r) => n + r.amount, 0);
  check(persisted === 12000, 'restart does not duplicate starting-money statistics');
  await stop();
  mkdirSync('artifacts/storage-analytics', { recursive: true }); writeFileSync('artifacts/storage-analytics/multiplayer-results.json', JSON.stringify({ checks, passed: checks.length }, null, 2));
} catch (e) { console.error(e); process.exitCode = 1; } finally { await stop(); }

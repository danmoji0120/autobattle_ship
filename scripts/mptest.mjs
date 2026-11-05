// Two real WebSocket clients against the Node server: join, command, cross-visibility,
// token reconnect, and persistence across a server restart.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import WebSocket from 'ws';
const PORT = 8199, SAVE = 'data/mptest.json';
fs.rmSync(SAVE, { force: true });
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) process.exitCode = 1; };
const startServer = () => new Promise(res => {
  const p = spawn('node', ['dist-server/server.mjs'], { env: { ...process.env, PORT: String(PORT), SAVE_FILE: SAVE, WORLD_SEED: '5' } });
  p.stdout.on('data', d => { const s = String(d); process.stdout.write('  [srv] ' + s); if (s.includes('listening')) res(p); });
  p.stderr.on('data', d => process.stdout.write('  [srv!] ' + d));
});
class Client {
  constructor(name, token) { this.name = name; this.token = token; this.snap = null; this.events = []; this.acks = new Map(); this.seq = 1; }
  open() { return new Promise(res => {
    this.ws = new WebSocket(`ws://localhost:${PORT}/ws`);
    this.ws.on('open', () => this.ws.send(JSON.stringify({ t: 'hello', name: this.name, token: this.token })));
    this.ws.on('message', raw => {
      const m = JSON.parse(String(raw));
      if (m.t === 'welcome') { this.company = m.company; this.token = m.token; res(); }
      if (m.t === 'snap') this.snap = m.state;
      if (m.t === 'events') this.events.push(...m.list);
      if (m.t === 'ack') this.acks.get(m.id)?.(m.err);
    });
  }); }
  cmd(cmd) { const id = this.seq++; return new Promise(r => { this.acks.set(id, r); this.ws.send(JSON.stringify({ t: 'cmd', id, cmd })); }); }
  group(name) { return Object.values(this.snap.groups).find(g => g.owner === this.company && g.name === name); }
  close() { this.ws.close(); }
}
const wait = ms => new Promise(r => setTimeout(r, ms));
let srv = await startServer();
const a = new Client('알파 PMC'), b = new Client('베타 컴퍼니');
await a.open(); await b.open();
await wait(800);
ok(a.company && b.company && a.company !== b.company, `two companies: ${a.company}, ${b.company}`);
ok(Object.values(a.snap.companies).some(c => c.id === b.company), 'A sees B in the shared world');
const mining = a.group('제1 채굴반');
const err = await a.cmd({ c: 'setOp', group: mining.id, op: { k: 'mine', field: 'kestrel', deliver: 'astra', sell: true } });
ok(err === null, 'A orders mining');
const bad = await b.cmd({ c: 'setOp', group: mining.id, op: { k: 'idle' } });
ok(bad !== null, `B cannot command A's group (${bad})`);
const before = Object.values(b.snap.ships).filter(s => s.owner === a.company).map(s => ({ ...s.pos }));
await wait(6000);
const after = Object.values(b.snap.ships).filter(s => s.owner === a.company);
const moved = after.filter((s, i) => Math.hypot(s.pos.x - before[i].x, s.pos.z - before[i].z) > 50).length;
ok(moved >= 2, `B observes A's miners moving (${moved} ships moved)`);
ok(a.events.some(e => e.text.includes('채굴 작전')), 'A received its commander radio');
ok(!b.events.some(e => e.company === a.company), "B doesn't receive A's private events");
// reconnect with token
const tokA = a.token; a.close(); await wait(500);
const a2 = new Client('ignored', tokA); await a2.open();
ok(a2.company === a.company, 'token reconnect restores the same PMC');
await wait(600);
const t1 = a2.snap.time;
// restart server: state persists
a2.close(); b.close();
srv.kill('SIGTERM'); await new Promise(r => srv.on('exit', r));
ok(fs.existsSync(SAVE), 'world saved on shutdown');
srv = await startServer();
const a3 = new Client('x', tokA); await a3.open(); await wait(700);
ok(a3.company === a.company && a3.snap.time >= t1 - 1, `after restart same PMC & world time continues (t=${a3.snap.time.toFixed(1)} ≥ ${t1.toFixed(1)})`);
ok(a3.group('제1 채굴반').op.k === 'mine', 'orders survive restart');
a3.close(); srv.kill('SIGTERM');

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
      if (m.t === 'mov') { this.movs = (this.movs || 0) + 1; for (const r of m.s) { const sh = this.snap?.ships[r[0]]; if (sh) { sh.pos.x = r[1]; sh.pos.z = r[3]; } } }
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
await wait(1600);
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
// players in different systems: B's escort flies through the gate to Drake
ok((a.movs || 0) > 20, `compact motion packets stream between snapshots (${a.movs})`);
const esc = b.group('경비대');
ok(await b.cmd({ c: 'setOp', group: esc.id, op: { k: 'move', to: { ...b.snap.stations.drakeout.pos, x: b.snap.stations.drakeout.pos.x + 1500 } } }) === null, 'B orders its escort to another system (Drake)');
const sysOf = p => Math.round(p.x / 250000) + 2;
let inDrake = false;
for (let i = 0; i < 240 && !inDrake; i++) { await wait(1000); const ss = Object.values(b.snap.ships).filter(s => esc.shipIds.includes(s.id)); inDrake = ss.length > 0 && ss.every(s => sysOf(s.pos) === 2); }
ok(inDrake, 'B escort jumped through the gate and is in Drake');
await wait(1500);
ok(!Object.values(a.snap.ships).some(s => esc.shipIds.includes(s.id)), "A (viewing Astra) is not sent B's ships in Drake (interest management)");
ok(Object.values(a.snap.ships).some(s => s.owner === a.company), 'A still sees its own ships');
a.ws.send(JSON.stringify({ t: 'view', sys: 'drake' })); await wait(800);
ok(Object.values(a.snap.ships).some(s => esc.shipIds.includes(s.id)), "A switches view to Drake and sees B's escort there");
a.ws.send(JSON.stringify({ t: 'view', sys: 'astra' }));
// reconnect with token
const tokA = a.token; a.close(); await wait(500);
const a2 = new Client('ignored', tokA); await a2.open();
ok(a2.company === a.company, 'token reconnect restores the same PMC');
await wait(600);
ok(await a2.cmd({ c: 'setOp', group: mining.id, op: { k: 'mine', field: 'kestrel', deliver: '', sell: false, auto: true } }) === null, 'A switches mining to automatic destination + storage');
await wait(1200);
const t1 = a2.snap.time;
// restart server: state persists
a2.close(); b.close();
srv.kill('SIGTERM'); await new Promise(r => srv.on('exit', r));
ok(fs.existsSync(SAVE), 'world saved on shutdown');
srv = await startServer();
const a3 = new Client('x', tokA); await a3.open(); await wait(700);
ok(a3.company === a.company && a3.snap.time >= t1 - 1, `after restart same PMC & world time continues (t=${a3.snap.time.toFixed(1)} ≥ ${t1.toFixed(1)})`);
{ const op = a3.group('제1 채굴반').op; ok(op.k === 'mine' && op.auto === true && op.sell === false && !!a3.snap.stations[op.deliver], `mining settings survive restart (auto → ${op.deliver}, store)`); }
a3.close(); srv.kill('SIGTERM');

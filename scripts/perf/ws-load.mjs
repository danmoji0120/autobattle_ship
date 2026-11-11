// Real WebSocket load test against a built server (dist-server/server.mjs) in an isolated temp directory.
// Accounts are created over HTTP, every client opens an authenticated socket, creates its PMC, puts its
// starting fleet to work (mining + escort) and keeps a ping going like the browser client.
// Measures the server process (CPU from /proc, RSS), wire bytes per client (compressed frames as received)
// and decoded JSON bytes, the server's own 2-second tick reports, and (newer servers) the internal /status.
//   node scripts/perf/ws-load.mjs [dir=.] [clients=10] [seconds=120] [port=8311]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const DIR = path.resolve(process.argv[2] ?? '.');
const N = Number(process.argv[3] ?? 10), SECS = Number(process.argv[4] ?? 120), PORT = Number(process.argv[5] ?? 8311);
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sid-wsload-'));
const env = { ...process.env, PORT: String(PORT), SAVE_FILE: path.join(tmp, 'world.json'), WORLD_SEED: '1', DATABASE_URL: '', SIDERARIUM_REQUIRE_DB: '', STATIC_DIR: path.join(DIR, 'dist') };
const srv = spawn(process.execPath, [...(process.env.NODE_ARGS ? process.env.NODE_ARGS.split(' ') : []), path.join(DIR, 'dist-server/server.mjs')], { env, cwd: tmp });
let log = '';
srv.stdout.on('data', d => { log += d; }); srv.stderr.on('data', d => { log += d; });
await new Promise((res, rej) => { const t = setInterval(() => { if (log.includes('listening')) { clearInterval(t); res(); } }, 50); setTimeout(() => rej(new Error('server did not start\n' + log)), 60000); });

const proc = () => {
  const stat = fs.readFileSync(`/proc/${srv.pid}/stat`, 'utf8').split(') ')[1].split(' ');
  const status = fs.readFileSync(`/proc/${srv.pid}/status`, 'utf8');
  return { cpu: (Number(stat[11]) + Number(stat[12])) / 100 /* USER_HZ */, rss: Number(/VmRSS:\s+(\d+)/.exec(status)[1]) / 1024 };
};

async function signup(i) {
  const loginId = `load_${i}_${Date.now() % 100000}`;
  const r = await fetch(`${BASE}/api/auth/signup`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.9.${i >> 8}.${i & 255}` }, body: JSON.stringify({ loginId, password: 'load-pass-1234', confirm: 'load-pass-1234' }) });
  if (r.status !== 200) throw new Error(`signup ${r.status} ${await r.text()}`);
  return r.headers.get('set-cookie').split(';')[0];
}

const clients = [];
function client(i, cookie) {
  return new Promise(resolve => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { cookie }, perMessageDeflate: true });
    const c = { i, ws, bytes: 0, msgs: 0, kinds: {}, stats: [], company: null, groups: null, started: false, ready: false, maxMsg: 0, errors: 0 };
    let seq = 1;
    const send = m => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m));
    ws.on('open', () => send({ t: 'hello', name: '', proto: 2 }));
    ws.on('message', raw => {
      const s = String(raw); c.bytes += s.length; c.msgs++; if (s.length > c.maxMsg) c.maxMsg = s.length;
      let m; try { m = JSON.parse(s); } catch { c.errors++; return; }
      c.kinds[m.t] = (c.kinds[m.t] ?? 0) + 1;
      if (m.t === 'needPmc') send({ t: 'createPmc', name: `Load ${i}` });
      if (m.t === 'welcome') { c.company = m.company; c.ready = true; resolve(c); }
      if (m.t === 'stats') c.stats.push(m);
      const groups = m.t === 'snap' ? m.state.groups : m.t === 'sd' ? m.u?.groups && Object.fromEntries(Object.entries(m.u.groups)) : null;
      if (groups && !c.started && c.company) {
        const mine = Object.values(groups).filter(g => g.owner === c.company);
        const miners = mine.find(g => g.name === '제1 채굴반'), guard = mine.find(g => g.name === '경비대');
        if (miners) {
          c.started = true;
          send({ t: 'cmd', id: seq++, cmd: { c: 'setOp', group: miners.id, op: { k: 'mine', field: 'kestrel', deliver: 'astra', sell: true } } });
          if (guard) send({ t: 'cmd', id: seq++, cmd: { c: 'setOp', group: guard.id, op: { k: 'escort', group: miners.id } } });
        }
      }
    });
    ws.on('error', () => { c.errors++; });
    c.ping = setInterval(() => send({ t: 'ping', at: Date.now() }), 2000);
    clients.push(c);
  });
}

const t0 = Date.now();
for (let i = 0; i < N; i++) await client(i, await signup(i));
console.error(`${N} clients connected in ${Date.now() - t0} ms`);
await new Promise(r => setTimeout(r, 5000)); // settle (PMC creation, first snapshots)
for (const c of clients) { c.bytes = 0; c.msgs = 0; c.stats = []; c.wire0 = c.ws._socket.bytesRead; c.maxMsg = 0; c.kinds = {}; }
const p0 = proc(), w0 = Date.now();
let rssMax = p0.rss;
const sampler = setInterval(() => { rssMax = Math.max(rssMax, proc().rss); }, 1000);
await new Promise(r => setTimeout(r, SECS * 1000));
clearInterval(sampler);
const p1 = proc(), wall = (Date.now() - w0) / 1000;
let status = null;
try { const r = await fetch(`${BASE}/status`); if (r.ok) status = await r.json(); } catch { /* older servers */ }
const sum = a => a.reduce((x, y) => x + y, 0);
const wire = sum(clients.map(c => c.ws._socket.bytesRead - c.wire0)), dec = sum(clients.map(c => c.bytes));
const ticks = clients[0].stats;
const out = {
  dir: path.basename(DIR), clients: N, seconds: SECS,
  server_cpu_pct_one_core: +((p1.cpu - p0.cpu) / wall * 100).toFixed(1),
  rss_MB: { end: +p1.rss.toFixed(0), max: +rssMax.toFixed(0) },
  per_client_wire_KBps: +(wire / N / wall / 1024).toFixed(2), per_client_json_KBps: +(dec / N / wall / 1024).toFixed(2),
  server_wire_KBps: +(wire / wall / 1024).toFixed(1),
  max_msg_KB: +(Math.max(...clients.map(c => c.maxMsg)) / 1024).toFixed(1),
  tick_report: ticks.length ? { avg_ms: +(sum(ticks.map(t => t.tickMs)) / ticks.length).toFixed(3), max_ms: +Math.max(...ticks.map(t => t.tickMax)).toFixed(1), rate: +(sum(ticks.map(t => t.rate)) / ticks.length).toFixed(3) } : null,
  kinds: clients[0].kinds, started: clients.filter(c => c.started).length, errors: sum(clients.map(c => c.errors)),
  status: status && { tick: status.tick, net: status.net, save: status.save && { ok: status.save.ok, lastBytes: status.save.lastBytes } },
};
console.log(JSON.stringify(out));
for (const c of clients) { clearInterval(c.ping); c.ws.close(); }
srv.kill('SIGTERM');
await new Promise(r => srv.on('exit', r));
fs.rmSync(tmp, { recursive: true, force: true });

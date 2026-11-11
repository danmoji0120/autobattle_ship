// Abuse scenarios against a built server (dist-server/server.mjs) in an isolated temp directory:
// a normal client keeps playing while other sockets send invalid frames, oversized and malformed messages,
// floods, never read (slow reader) or vanish. Reports whether the server survived and the normal client
// kept receiving updates.     node scripts/perf/ws-abuse.mjs [dir=.] [port=8321]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const DIR = path.resolve(process.argv[2] ?? '.');
const PORT = Number(process.argv[3] ?? 8321);
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sid-abuse-'));
const env = { ...process.env, PORT: String(PORT), SAVE_FILE: path.join(tmp, 'world.json'), WORLD_SEED: '1', DATABASE_URL: '', SIDERARIUM_REQUIRE_DB: '', STATIC_DIR: path.join(DIR, 'dist'),
  // small buffers so the slow-reader case triggers within the test (production defaults are larger)
  WS_SEND_HIGH: '65536', WS_SEND_LIMIT: String(4 * 1024 * 1024), WS_CONGESTED_MAX_S: '8', WS_HEARTBEAT_S: process.env.HEARTBEAT_S ?? '3' };
let srv, log = '';
const deaths = [];
const start = async () => {
  log = '';
  srv = spawn(process.execPath, [path.join(DIR, 'dist-server/server.mjs')], { env, cwd: tmp });
  srv.stdout.on('data', d => { log += d; }); srv.stderr.on('data', d => { log += d; });
  srv.exitCode = null;
  await new Promise((res, rej) => { const t = setInterval(() => { if (log.includes('listening')) { clearInterval(t); res(); } }, 50); setTimeout(() => rej(new Error('no start\n' + log)), 60000); });
};
const alive = async () => { try { const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(3000) }); return r.ok; } catch { return false; } };
let n = 0;
async function account() {
  const i = n++;
  const r = await fetch(`${BASE}/api/auth/signup`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.7.0.${i}` }, body: JSON.stringify({ loginId: `abuse_${i}_${Date.now() % 1e5}`, password: 'abuse-pass-1234', confirm: 'abuse-pass-1234' }) });
  return r.headers.get('set-cookie').split(';')[0];
}
function open(cookie, opts = {}) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { cookie }, perMessageDeflate: opts.deflate ?? true });
    ws.on('open', () => res(ws)); ws.on('error', () => {}); setTimeout(() => rej(new Error('open timeout')), 10000);
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const closed = ws => new Promise(r => { if (ws.readyState === ws.CLOSED) r({ code: 'already' }); ws.on('close', (code, reason) => r({ code, reason: String(reason) })); setTimeout(() => r({ code: 'still open' }), 20000); });

await start();
const results = [];
const record = async (name, fn) => {
  let detail;
  try { detail = await fn(); } catch (e) { detail = 'error: ' + e.message; }
  const up = await alive();
  // newer servers: what the server itself counted (terminations are invisible to a paused client socket)
  const ws = await fetch(`${BASE}/status`).then(r => r.ok && r.headers.get('content-type')?.includes('json') ? r.json() : null, () => null).then(s => s?.ws ?? null);
  results.push({ name, detail, serverAlive: up, ...(ws ? { serverCounters: { slowTerminated: ws.slowTerminated, heartbeatTerminated: ws.heartbeatTerminated, floodClosed: ws.floodClosed, errors: ws.errors, dropped: ws.dropped } } : {}) });
  if (!up) { const m = /Error: [^\n]*/.exec(log); deaths.push({ after: name, error: m?.[0] ?? log.slice(-300) }); await start(); }
};

// the normal client: plays and counts state updates
const normal = await open(await account());
let updates = 0, lastUpdate = Date.now(), maxGap = 0, acks = 0;
normal.on('message', raw => { const m = JSON.parse(String(raw)); if (m.t === 'needPmc') normal.send(JSON.stringify({ t: 'createPmc', name: 'Normal' })); if (m.t === 'snap' || m.t === 'sd') { const now = Date.now(); maxGap = Math.max(maxGap, now - lastUpdate); lastUpdate = now; updates++; } if (m.t === 'ack') acks++; });
normal.send(JSON.stringify({ t: 'hello', name: '', proto: 2 }));
await sleep(3000);
updates = 0; maxGap = 0; lastUpdate = Date.now();

await record('invalid UTF-8 text frame', async () => {
  const ws = await open(await account(), { deflate: false });
  // FIN + text opcode, masked, 2-byte payload 0xff 0xfe (not UTF-8)
  ws._socket.write(Buffer.from([0x81, 0x82, 0, 0, 0, 0, 0xff, 0xfe]));
  return closed(ws);
});
await record('reserved opcode frame', async () => {
  const ws = await open(await account(), { deflate: false });
  ws._socket.write(Buffer.from([0x83, 0x80, 0, 0, 0, 0]));
  return closed(ws);
});
await record('oversized message (1 MiB)', async () => {
  const ws = await open(await account());
  ws.send(JSON.stringify({ t: 'cmd', id: 1, cmd: { c: 'newGroup', name: 'x'.repeat(1 << 20) } }));
  return closed(ws);
});
await record('malformed JSON / non-object messages x200', async () => {
  const ws = await open(await account());
  for (let i = 0; i < 200; i++) ws.send(i % 3 ? '{"t":' : i % 2 ? '[1,2]' : 'null');
  await sleep(1000);
  return { open: ws.readyState === ws.OPEN };
});
await record('command flood (20000 cmds)', async () => {
  const ws = await open(await account());
  ws.send(JSON.stringify({ t: 'hello', name: '', proto: 2 }));
  let errAcks = 0; ws.on('message', raw => { const m = JSON.parse(String(raw)); if (m.t === 'ack' && m.err?.includes('너무 많')) errAcks++; });
  for (let i = 0; i < 20000 && ws.readyState === ws.OPEN; i++) ws.send(JSON.stringify({ t: 'cmd', id: i, cmd: { c: 'newGroup', name: 'flood' } }));
  const c = await closed(ws);
  return { ...c, rateLimitedAcks: errAcks };
});
await record('slow reader (never reads, kept 25 s)', async () => {
  const ws = await open(await account());
  ws.send(JSON.stringify({ t: 'hello', name: '', proto: 1 })); // full snapshots: the heaviest stream
  ws.on('message', raw => { if (JSON.parse(String(raw)).t === 'needPmc') { ws.send(JSON.stringify({ t: 'createPmc', name: 'Slow' })); setTimeout(() => ws._socket.pause(), 500); } });
  const t0 = Date.now();
  const c = await Promise.race([closed(ws), sleep(25000).then(() => ({ code: 'still open after 25 s' }))]);
  return { ...c, afterS: ((Date.now() - t0) / 1000).toFixed(1) };
});
await record('vanished peer (no close, no pong)', async () => {
  const ws = await open(await account());
  ws._socket.pause(); // stops reading: pings are never answered
  const t0 = Date.now();
  const c = await Promise.race([closed(ws), sleep(15000).then(() => ({ code: 'still open after 15 s' }))]);
  return { ...c, afterS: ((Date.now() - t0) / 1000).toFixed(1) };
});
await record('reconnect churn (40 open/close)', async () => {
  const cookie = await account();
  for (let i = 0; i < 40; i++) { const ws = await open(cookie); ws.send(JSON.stringify({ t: 'hello', name: '', proto: 2 })); await sleep(20); ws.terminate(); }
  await sleep(500);
  return 'done';
});

const normalAlive = normal.readyState === normal.OPEN;
const status = await fetch(`${BASE}/status`).then(r => r.ok && r.headers.get('content-type')?.includes('json') ? r.json() : null, () => null);
console.log(JSON.stringify({ dir: path.basename(DIR), results, crashes: deaths, normalClient: { open: normalAlive, updates, maxGapMs: maxGap }, ws: status?.ws ?? null }, null, 1));
normal.close();
srv.kill('SIGTERM');
await new Promise(r => srv.on('exit', r));
fs.rmSync(tmp, { recursive: true, force: true });

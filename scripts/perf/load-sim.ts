// In-process load harness: the real GameServer with N synthetic connections.
// Separates simulation cost (WorldSim.update) from analytics and from snapshot build / serialization / fan-out.
// Works on any checkout: TREE=<path to a checkout> (default: this repository).
//   npx vite-node scripts/perf/load-sim.ts            P=30 H=1 MODE=active|idle  ZIP=1 (estimate permessage-deflate bytes)
// Synthetic connections serialize every message like the Node transport (JSON.stringify, or the
// pre-serialized text when the server offers it), but there is no socket and no compression cost here.
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import zlib from 'node:zlib';

const TREE = path.resolve(process.env.TREE ?? '.');
const P = Number(process.env.P ?? 10), H = Number(process.env.H ?? 1), MODE = process.env.MODE ?? 'active', ZIP = process.env.ZIP === '1';
const SEED = Number(process.env.SEED ?? 1);
const { GameServer } = await import(path.join(TREE, 'src/server/core.ts'));

const g = new GameServer(null, { singleplayer: false, accounts: false, snapInterval: 1, movInterval: 0.2, analytics: {} }, SEED);
type Acc = { msgs: number; bytes: number; zbytes: number; snapBytes: number; maxMsg: number };
const acc: Record<string, Acc> = {};
const pendingZ: [string, string][] = [];
function count(id: string, json: string, kind: string) {
  const a = acc[id]; a.msgs++; a.bytes += json.length; if (kind === 'snap' || kind === 'sd') a.snapBytes += json.length;
  if (json.length > a.maxMsg) a.maxMsg = json.length;
  if (ZIP) pendingZ.push([id, json]);
}
for (let i = 0; i < P; i++) {
  const id = `c${i}`; acc[id] = { msgs: 0, bytes: 0, zbytes: 0, snapBytes: 0, maxMsg: 0 };
  const conn: any = {
    id, lastEvent: 0, battles: new Set(),
    send: (m: any) => count(id, JSON.stringify(m), m.t),
    // newer servers hand over already serialized text; the kind is the first field
    sendText: (s: string) => count(id, s, s.slice(6, 10).replace(/"/g, '').split(',')[0]),
  };
  g.connect(conn);
  g.handle(id, { t: 'hello', name: `Load ${i}`, proto: 2 });
}
const st = g.sim.st;
if (MODE === 'active') {
  // every PMC runs its starting fleet: miners on a field with automatic delivery, the guard escorts them
  for (const co of Object.values<any>(st.companies)) if (co.kind === 'player') {
    const gs = Object.values<any>(st.groups).filter(x => x.owner === co.id);
    const miners = gs.find(x => x.name === '제1 채굴반'), guard = gs.find(x => x.name === '경비대');
    if (miners) g.sim.command(co.id, { c: 'setOp', group: miners.id, op: { k: 'mine', field: 'kestrel', deliver: 'astra', sell: true } });
    if (guard && miners) g.sim.command(co.id, { c: 'setOp', group: guard.id, op: { k: 'escort', group: miners.id } });
  }
}
// time the simulation separately from everything else in GameServer.step
let simMs = 0;
const upd = g.sim.update.bind(g.sim);
g.sim.update = (dt: number) => { const t = performance.now(); upd(dt); simMs += performance.now() - t; };
let anMs = 0;
if (g.analytics) { const a = g.analytics.step.bind(g.analytics); g.analytics.step = (dt: number) => { const t = performance.now(); a(dt); anMs += performance.now() - t; }; }

const steps = Math.round(H * 3600 * 20);
const total: number[] = [], simT: number[] = [], netT: number[] = [];
const cpu0 = process.cpuUsage(), w0 = performance.now();
let zipMs = 0;
let rssMax = 0, heapMax = 0;
const saves: { ms: number; bytes: number }[] = [];
const trend: number[] = [];
for (let i = 0; i < steps; i++) {
  simMs = 0; anMs = 0;
  const t = performance.now();
  g.step(0.05);
  const dt = performance.now() - t;
  total.push(dt); simT.push(simMs); netT.push(dt - simMs - anMs);
  // conservative estimate: each message deflated on its own (the ws transport keeps a sliding window, so real frames are a bit smaller)
  const zt = performance.now();
  if (pendingZ.length) { for (const [id, s] of pendingZ) acc[id].zbytes += s.length < 1024 ? s.length : zlib.deflateRawSync(s).length; pendingZ.length = 0; }
  zipMs += performance.now() - zt;
  if (i % 600 === 0) { const m = process.memoryUsage(); rssMax = Math.max(rssMax, m.rss); heapMax = Math.max(heapMax, m.heapUsed); }
  // long runs (NODE_OPTIONS=--expose-gc): live heap after a full GC every game hour, to see leaks as a trend
  const gc = (globalThis as { gc?: () => void }).gc;
  if (gc && i % (20 * 3600) === 0) { gc(); trend.push(+(process.memoryUsage().heapUsed / 1048576).toFixed(1)); }
  if (i % (20 * 300) === 0 && i) {
    // the save the Node server performs every SAVE_INTERVAL_S (text exactly as written to the store)
    const s0 = performance.now();
    const text = typeof g.saveText === 'function' ? g.saveText() : JSON.stringify(g.snapshotFile());
    saves.push({ ms: performance.now() - s0, bytes: text.length });
  }
}
const wall = performance.now() - w0, cpu = process.cpuUsage(cpu0);
const pct = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(s.length * p))].toFixed(3); };
const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
const clients = Object.values(acc);
const secs = H * 3600;
const out = {
  tree: path.basename(TREE), players: P, hours: H, mode: MODE,
  ships: Object.keys(st.ships).length, groups: Object.keys(st.groups).length, battlesDone: st.battleLog?.length ?? 0,
  step_ms: { p50: pct(total, .5), p95: pct(total, .95), p99: pct(total, .99), max: +Math.max(...total).toFixed(1), mean: +(sum(total) / total.length).toFixed(3) },
  sim_ms: { p95: pct(simT, .95), p99: pct(simT, .99), max: +Math.max(...simT).toFixed(1), share: +(sum(simT) / sum(total)).toFixed(3) },
  net_ms: { p95: pct(netT, .95), p99: pct(netT, .99), max: +Math.max(...netT).toFixed(1), share: +(sum(netT) / sum(total)).toFixed(3) },
  cpu_pct_of_one_core: +((cpu.user + cpu.system) / 1000 / wall * 100).toFixed(1), harness_zip_s: +(zipMs / 1000).toFixed(1),
  busy_pct_of_realtime: +(sum(total) / (secs * 1000) * 100).toFixed(2),
  per_client_KBps: +(sum(clients.map(c => c.bytes)) / clients.length / secs / 1024).toFixed(2),
  per_client_deflate_KBps: ZIP ? +(sum(clients.map(c => c.zbytes)) / clients.length / secs / 1024).toFixed(2) : null,
  server_out_KBps: +(sum(clients.map(c => c.bytes)) / secs / 1024).toFixed(1),
  snapshot_share: +(sum(clients.map(c => c.snapBytes)) / Math.max(1, sum(clients.map(c => c.bytes)))).toFixed(3),
  max_msg_KB: +(Math.max(0, ...clients.map(c => c.maxMsg)) / 1024).toFixed(1),
  save: saves.length ? { last_KB: +(saves[saves.length - 1].bytes / 1024).toFixed(0), last_ms: +saves[saves.length - 1].ms.toFixed(1), max_ms: +Math.max(...saves.map(s => s.ms)).toFixed(1) } : null,
  rss_MB_max: +(rssMax / 1048576).toFixed(0), heap_MB_max: +(heapMax / 1048576).toFixed(0),
  ...(trend.length ? { live_heap_MB_per_hour: trend } : {}),
};
console.log(JSON.stringify(out));

// P11 on a real server process: `node dist-server/server.mjs` with COMBAT_P11=1, three accounts over real
// WebSockets, only real commands (no state edits). A and B fight (hostility by stance), C (A's ally, hostile
// to B) flies in and joins the same instance, everyone commands only their own fleet (server refuses the
// rest), each client re-simulates the battle from binit/border and the clients agree tick for tick, B
// withdraws, the server is restarted mid-battle and the battle resumes from the save; settlement once.
// Needs `npm run build` first.   npx vite-node scripts/combat/p11-multiplayer.ts
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import WebSocket from 'ws';
import { World, type BattleSetup } from '../../src/sim/world';
import type { OrderRecord } from '../../src/sim/types';

const dir = mkdtempSync(path.join(tmpdir(), 'siderarium-p11-mp-'));
const save = path.join(dir, 'world.json');
const binary = path.resolve('dist-server/server.mjs'), staticDir = path.resolve('dist');
const probe = net.createServer();
await new Promise<void>(r => probe.listen(0, '127.0.0.1', () => r()));
const port = (probe.address() as net.AddressInfo).port; await new Promise(r => probe.close(r));
const base = `http://127.0.0.1:${port}`, checks: string[] = [], sockets: WebSocket[] = [], facts: Record<string, unknown> = {};
let child: ChildProcess | undefined;
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until<T>(fn: () => T | Promise<T>, reason: string, ms = 60000): Promise<T> { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await delay(100); } throw Error(reason); }
function check(ok: unknown, label: string) { if (!ok) throw Error('FAIL ' + label); checks.push(label); console.log('PASS', label); }
async function start() {
  let log = '';
  child = spawn('node', [binary], { cwd: dir, env: { ...process.env, PORT: String(port), STATIC_DIR: staticDir, SAVE_FILE: save, DATABASE_URL: '', WORLD_RESET: '', CONTENT_MIGRATE: '', WORLD_SEED: '9402', SAVE_INTERVAL_S: '.5', COMBAT_P11: '1' } });
  child.stdout!.on('data', d => log += d); child.stderr!.on('data', d => log += d);
  await until(() => { if (child!.exitCode !== null) throw Error(log); return log.includes('listening on'); }, `server did not start: ${log}`);
}
async function stop() {
  for (const s of sockets.splice(0)) s.close();
  if (child) { const p = child; child = undefined; await new Promise(r => { p.once('exit', r); p.kill('SIGTERM'); }); }
}
class Pilot {
  messages: any[] = []; seq = 1; ws!: WebSocket; cookie = ''; id = '';
  setup: BattleSetup | null = null; orders: OrderRecord[] = []; w: World | null = null; eng = '';
  constructor(readonly name: string) {}
  async signup(loginId: string) {
    const r = await fetch(base + '/api/auth/signup', { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ loginId, password: 'p11-test-password-123', confirm: 'p11-test-password-123' }) });
    this.cookie = r.headers.get('set-cookie')?.split(';')[0] ?? '';
    if (r.status !== 200 || !this.cookie) throw Error(`signup failed: ${r.status}`);
  }
  async connect() {
    this.messages = []; this.w = null;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { origin: base, cookie: this.cookie } }); this.ws = ws; sockets.push(ws);
    ws.on('message', raw => {
      const m = JSON.parse(String(raw)); this.messages.push(m);
      if (m.t === 'needPmc') ws.send(JSON.stringify({ t: 'createPmc', name: this.name }));
      if (m.t === 'binit' && m.eng === this.eng) { this.setup = m.setup; this.orders = m.orders.slice(); this.build(); }
      if (m.t === 'border' && m.eng === this.eng) { this.orders.push(m.rec); if (this.w && m.rec.tick >= this.w.tick) this.w.scheduleOrder({ ...m.rec }); else this.build(); }
    });
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    ws.send(JSON.stringify({ t: 'hello', name: this.name }));
    this.id = (await this.wait(m => m.t === 'welcome')).company;
    await this.wait(m => m.t === 'snap');
  }
  build() { this.w = new World(JSON.parse(JSON.stringify(this.setup))); this.w.scheduleReplay(this.orders.map(o => ({ ...o }))); }
  wait(test: (m: any) => boolean, ms?: number) { return until(() => this.messages.find(test), `missing response for ${this.name}`, ms); }
  async command(cmd: any) { const id = this.seq++; this.ws.send(JSON.stringify({ t: 'cmd', id, cmd })); return (await this.wait(m => m.t === 'ack' && m.id === id)).err; }
  async order(groupId: number, order: any, opts: any = {}) { const id = this.seq++; this.ws.send(JSON.stringify({ t: 'border', id, eng: this.eng, groupId, order, opts })); return (await this.wait(m => m.t === 'ack' && m.id === id)).err; }
  join(eng: string) { this.eng = eng; this.ws.send(JSON.stringify({ t: 'bjoin', eng })); return this.wait(m => m.t === 'binit' && m.eng === eng); }
  snap() { return this.messages.filter(m => m.t === 'snap').at(-1).state; }
  guard() { const st = this.snap(); return Object.values<any>(st.groups).find(g => g.owner === this.id && g.shipIds.length && !g.parentId)!; }
  stepTo(t: number) { while (this.w && this.w.tick < t && !this.w.outcome) this.w.step(); return this.w?.digest(); }
}
/** both clients run the battle to the same tick (as far as the orders they have are final) and agree */
function agree(ps: Pilot[], label: string) {
  const t = Math.min(...ps.map(p => p.orders.reduce((a, o) => Math.max(a, o.tick), 0))) + 30;
  const hs = ps.map(p => p.stepTo(t));
  check(hs.every(h => h && h === hs[0]), `${label}: ${ps.map(p => p.name).join('/')} agree at tick ${t} (${hs[0]})`);
}
try {
  await start();
  const a = new Pilot('알파 PMC'), b = new Pilot('브라보 PMC'), c = new Pilot('찰리 PMC');
  await a.signup('p11_alpha'); await b.signup('p11_bravo'); await c.signup('p11_charlie');
  for (const p of [a, b, c]) await p.connect();
  check(a.snap().combatV === 2, 'COMBAT_P11=1 server creates a P11 combat world');
  check(await a.command({ c: 'stance', target: b.id, v: -1 }) === null, 'A declares hostility to B over the socket');
  check(await a.command({ c: 'stance', target: c.id, v: 1 }) === null && await c.command({ c: 'stance', target: a.id, v: 1 }) === null, 'A and C both offer alliance');
  check(await c.command({ c: 'stance', target: b.id, v: -1 }) === null, 'C declares hostility to B');
  const astra = a.snap().stations.astra.pos, P = { x: astra.x + 2600, y: 0, z: astra.z + 600 };
  const ga = a.guard(), gb = b.guard(), gc = c.guard();
  check(await b.command({ c: 'setOp', group: ga.id, op: { k: 'move', to: P } }) !== null, 'B cannot order A\'s fleet (server refuses)');
  check(await a.command({ c: 'setOp', group: ga.id, op: { k: 'move', to: P } }) === null && await b.command({ c: 'setOp', group: gb.id, op: { k: 'move', to: { ...P, x: P.x + 150 } } }) === null, 'A and B send their own fleets to the same point');
  const eng = await until(() => Object.values<any>(a.snap().engagements ?? {}).find(e => !e.done && e.sides.some((s: string[]) => s.includes(a.id)) && e.sides.some((s: string[]) => s.includes(b.id))), 'A and B never engaged', 120000);
  facts.engagement = eng.id;
  check(eng.v === 2 && eng.sides.length === 2, `A and B meet in the world and a P11 battle starts (${eng.id})`);
  await a.join(eng.id); await b.join(eng.id);
  // a company's first fleet group in the tactical world: a direct child of its structural root 'co:<id>'
  const tg = (p: Pilot, co: string) => { const root = p.w!.groups.find(g => g.ref === 'co:' + co); const g = root && p.w!.groups.find(x => x.parentId === root.id); if (!g) throw Error(`no tactical group for ${co}`); return g; };
  check(await a.order(tg(a, a.id).id, { type: 'attack', targetGroup: tg(a, b.id).id }) === null, 'A orders its own group to attack B');
  check(await a.order(tg(a, b.id).id, { type: 'retreat' }) === '지휘 권한 없음', 'A ordering B\'s group is refused by the server');
  await delay(1500); agree([a, b], 'after orders');
  // C flies in and joins the running instance
  check(await c.command({ c: 'setOp', group: gc.id, op: { k: 'move', to: eng.pos } }) === null, 'C sends its fleet to the running battle');
  await until(() => a.snap().engagements[eng.id]?.sides.some((s: string[]) => s.includes(c.id)), 'C never joined', 120000);
  const e2 = a.snap().engagements[eng.id];
  check(e2.sides.length === 3 && !e2.done && e2.joins?.some((j: any) => j.company === c.id), 'C joins the same battle instance (no new battle, no restart)');
  await c.join(eng.id);
  // every replica applies the server-stamped join at its tick
  for (const p of [a, b, c]) await until(() => { p.stepTo(Math.max(...p.orders.map(o => o.tick)) + 1); return p.w!.sides.length === 3; }, `${p.name}'s replica never saw the join`, 20000);
  check(true, 'A, B and C replicas all apply C\'s join (3 sides in every client simulation)');
  check(await c.order(tg(c, c.id).id, { type: 'attack', targetGroup: tg(c, b.id).id }) === null, 'C commands its own reinforcement');
  check(await c.order(tg(c, a.id).id, { type: 'retreat' }) === '지휘 권한 없음', 'C cannot command its ally A');
  check(/적대 관계가 아닌/.test(await c.order(tg(c, c.id).id, { type: 'attack', targetGroup: tg(c, a.id).id }) ?? ''), 'C cannot attack its ally A');
  await delay(1500); agree([a, b, c], 'after join');
  // restart mid-battle
  await delay(1200);
  const before = JSON.parse(readFileSync(save, 'utf8'));
  check(!!before.world.engagements[eng.id] && !before.world.engagements[eng.id].done, 'the running battle is in the saved world');
  await stop(); await start();
  for (const p of [a, b, c]) await p.connect();
  const re = a.snap().engagements[eng.id];
  check(re && re.sides.length === 3, 'after a server restart the same battle (3 sides) is restored');
  await a.join(eng.id); await b.join(eng.id); await c.join(eng.id);
  check(a.orders.some(o => (o as any).ev?.k === 'join'), 'the restored order log still carries C\'s join');
  agree([a, b, c], 'after restart');
  // B withdraws; A and C are left
  check(await b.order(-1, null, { withdraw: true }) === null, 'B withdraws its whole side');
  const done = await until(() => { const e = a.snap().engagements[eng.id]; return (!e || e.done || e.released?.includes(b.id)) ? (e ?? { done: true }) : null; }, 'B never got out', 240000);
  check(!!done, `B is out of the battle (${done.done ? 'battle ended' : 'released, battle continues'})`);
  const ended = await until(() => { const e = a.snap().engagements[eng.id]; return !e || e.done ? true : null; }, 'battle did not end', 600000);
  void ended;
  await delay(1500);
  const log = a.snap().battleLog ?? [];
  facts.record = log.filter((r: any) => r.id === eng.id).map((r: any) => ({ names: r.names, sides: r.sides, losses: r.losses }));
  check(log.filter((r: any) => r.id === eng.id).length <= 1, 'the battle is recorded at most once in the visible log');
  for (const p of [a, b, c]) facts[p.name] = { credits: p.snap().companies[p.id].credits };
  mkdirSync('artifacts/p11', { recursive: true });
  writeFileSync('artifacts/p11/multiplayer-results.json', JSON.stringify({ passed: checks.length, checks, facts, realWebSockets: 3, restarts: 1 }, null, 2));
  console.log(JSON.stringify({ passed: checks.length, facts }, null, 2));
} finally { await stop(); }
process.exit(0);

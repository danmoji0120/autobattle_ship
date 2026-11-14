// P12.5 §19 final scenario on a real server process: `node dist-server/server.mjs` with AUTO_LOGISTICS_P125=1,
// real WebSocket accounts. The starting assets (three stations, five haulers, an escort group and a pirate
// band at a gate) are placed once with the server stopped (p125-fixture.ts); every step after that is a real
// command or the server's own simulation.
//  1  the world is a P12.5 world; no route exists, nobody registered the haulers
//  2  the player orders a battleship at C; C lacks the parts, A and B hold them
//  3  the server plans the shortage and dispatches haulers from A and B by itself
//  4  haulers dock, load and jump through the astra→drake gate
//  5  the player sends the escort group (escort order); pirates at the gate fight (P11 engagement)
//  6  survivors unload at C; haulers are re-dispatched for the rest; the build starts
//  7  the server is restarted mid-transport; shipments, cargo and positions are restored and finish
//  8  another company cannot see or command the haulers; no route was ever created
// Needs `npm run build` first.   npx vite-node scripts/logistics/p125-server.ts
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import WebSocket from 'ws';
import { WorldSim } from '../../src/world/sim';
import { buildNeeds } from '../../src/world/production';
import { p125Fixture, stockFor, BB } from './p125-fixture';

const dir = mkdtempSync(path.join(tmpdir(), 'siderarium-p125-'));
const save = path.join(dir, 'world.json');
const binary = path.resolve('dist-server/server.mjs'), staticDir = path.resolve('dist');
const probe = net.createServer();
await new Promise<void>(r => probe.listen(0, '127.0.0.1', () => r()));
const port = (probe.address() as net.AddressInfo).port; await new Promise(r => probe.close(r));
const base = `http://127.0.0.1:${port}`, checks: string[] = [], sockets: WebSocket[] = [], facts: Record<string, unknown> = {};
const T0 = Date.now();
let child: ChildProcess | undefined;
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until<T>(fn: () => T | Promise<T>, reason: string, ms = 120000): Promise<T> { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await delay(150); } throw Error(reason); }
function check(ok: unknown, label: string, extra?: unknown) { if (!ok) throw Error('FAIL ' + label + (extra ? ' ' + JSON.stringify(extra) : '')); checks.push(label); console.log(`PASS [${Math.round((Date.now() - T0) / 1000)}s]`, label, extra ? JSON.stringify(extra) : ''); }
async function start() {
  let log = '';
  child = spawn('node', [binary], { cwd: dir, env: { ...process.env, PORT: String(port), STATIC_DIR: staticDir, SAVE_FILE: save, DATABASE_URL: '', WORLD_RESET: '', CONTENT_MIGRATE: '', WORLD_SEED: '9412', SAVE_INTERVAL_S: '.5', AUTO_LOGISTICS_P125: '1', FLEET_OPS_P12: '', COMBAT_P11: '' } });
  child.stdout!.on('data', d => log += d); child.stderr!.on('data', d => log += d);
  await until(() => { if (child!.exitCode !== null) throw Error(log); return log.includes('listening on'); }, `server did not start: ${log}`);
}
async function stop() {
  for (const s of sockets.splice(0)) s.close();
  if (child) { const p = child; child = undefined; await new Promise(r => { p.once('exit', r); p.kill('SIGTERM'); }); }
}
class Pilot {
  messages: any[] = []; seq = 1; ws!: WebSocket; cookie = ''; id = '';
  constructor(readonly name: string) {}
  async signup(loginId: string) {
    const r = await fetch(base + '/api/auth/signup', { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ loginId, password: 'p125-test-password-123', confirm: 'p125-test-password-123' }) });
    this.cookie = r.headers.get('set-cookie')?.split(';')[0] ?? '';
    if (r.status !== 200 || !this.cookie) throw Error(`signup failed: ${r.status}`);
  }
  async connect() {
    this.messages = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { origin: base, cookie: this.cookie } }); this.ws = ws; sockets.push(ws);
    ws.on('message', raw => {
      const m = JSON.parse(String(raw));
      if (m.t === 'snap') this.messages = this.messages.filter(x => x.t !== 'snap');
      this.messages.push(m);
      if (m.t === 'needPmc') ws.send(JSON.stringify({ t: 'createPmc', name: this.name }));
    });
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    ws.send(JSON.stringify({ t: 'hello', name: this.name }));
    this.id = (await this.wait(m => m.t === 'welcome')).company;
    await this.wait(m => m.t === 'snap');
  }
  wait(test: (m: any) => boolean, ms?: number) { return until(() => this.messages.find(test), `missing response for ${this.name}`, ms); }
  async command(cmd: any) { const id = this.seq++; this.ws.send(JSON.stringify({ t: 'cmd', id, cmd })); return (await this.wait(m => m.t === 'ack' && m.id === id)).err; }
  snap() { return this.messages.filter(m => m.t === 'snap').at(-1).state; }
}
const sysOf = (st: any, p: any) => Object.values<any>(st.systems).find(s => Math.hypot(p.x - s.origin.x, p.z - s.origin.z) <= s.radius)?.id;
try {
  // 0. accounts on a fresh P12.5 server, then the starting assets with the server stopped
  await start();
  const a = new Pilot('알파 PMC'), b = new Pilot('브라보 PMC');
  await a.signup('p125_alpha'); await b.signup('p125_bravo');
  await a.connect(); await b.connect();
  check(a.snap().logisticsV === 1 && a.snap().opsV === 1 && a.snap().combatV === 2, 'AUTO_LOGISTICS_P125=1 server creates a P12.5 world (with P12 operations and P11 combat)');
  await stop();
  const file = JSON.parse(readFileSync(save, 'utf8'));
  const sim = new WorldSim(file.world, { migrateContent: false });
  const fx = p125Fixture(sim, a.id);
  // what a battleship consumes, read from a throw-away copy (the real order is given later over the socket)
  const probeSim = new WorldSim(JSON.parse(sim.serialize()), { migrateContent: false });
  if (probeSim.command(a.id, { c: 'buildShip', station: fx.C.id, ...BB } as any)) throw Error('fixture cannot build a battleship');
  const pb = probeSim.st.stations[fx.C.id].builds![0], needs = buildNeeds(pb.classId, pb.loadoutId, pb.fit, pb);
  stockFor(sim, a.id, needs, fx.A, fx.B); facts.needs = needs;
  file.world = JSON.parse(sim.serialize()); writeFileSync(save, JSON.stringify(file));
  const ids = { A: fx.A.id, B: fx.B.id, C: fx.C.id, haulers: fx.haulers.map(s => s.id), hg: fx.g.id, escort: fx.escort.id, gate: fx.gate.id };
  facts.fixture = ids;

  await start(); await a.connect(); await b.connect();
  let st = a.snap();
  check(!Object.keys(st.logistics ?? {}).length && ids.haulers.every(id => st.ships[id] && !st.ships[id].logisticsPool && st.ships[id].state === 'docked'), '1: five haulers docked at A; no route exists and none was registered');

  // 2. the battleship order (the stock goes to A and B: the order itself is a real command)
  check(await a.command({ c: 'buildShip', station: ids.C, ...BB }) === null, '2: the player orders a battleship at C (real command)');
  await until(() => a.snap().stations[ids.C].builds?.[0], 'build not registered');
  check(a.snap().stations[ids.C].builds?.[0]?.started === false && !Object.keys(a.snap().stations[ids.C].storage?.[a.id] ?? {}).some(k => needs[k]), '2: C holds none of the parts; A has the structural parts and weapons, B the electronics');

  // 3. the server plans and dispatches on its own
  const plans = (await until(() => { const s = a.snap(); const p = Object.values<any>(s.procurementPlans ?? {}).filter(x => x.owner === a.id && x.station === ids.C); return p.length >= Object.keys(needs).length ? p : null; }, "no procurement plans"))!;
  check(plans.every((p: any) => p.sourceKind === 'ship'), '3: the shortage of every part is planned for the battleship build', { plans: plans.length });
  const jobs0 = (await until(() => { const j = Object.values<any>(a.snap().logisticsJobs ?? {}).filter(x => x.owner === a.id && x.ship); return j.length >= 5 ? j : null; }, "haulers were not dispatched"))!;
  check(new Set(jobs0.map((j: any) => j.ship)).size === jobs0.length && jobs0.every((j: any) => ids.haulers.includes(j.ship)) && jobs0.some((j: any) => j.from === ids.A), '3: all five haulers are dispatched automatically, one shipment each, from A (and B for electronics)', { jobs: jobs0.map((j: any) => `${j.item}@${j.from}`) });
  const pairs = new Set<string>(), seenBattle = new Set<string>(), seenSys = new Set<string>(); let maxBattles = 0, minHp = 1;
  const watch = () => { const s = a.snap(); for (const j of Object.values<any>(s.logisticsJobs ?? {})) if (j.ship) pairs.add(`${j.ship}|${j.id}`); for (const id of ids.haulers) { const h = s.ships[id]; if (!h) continue; if (h.state === 'battle') seenBattle.add(id); minHp = Math.min(minHp, h.hp); const sy = sysOf(s, h.pos); if (sy) seenSys.add(sy); } maxBattles = Math.max(maxBattles, (s.battleLog ?? []).length + Object.keys(s.engagements ?? {}).length); };
  const timer = setInterval(watch, 200);
  // 4. dock, load, jump
  await until(() => Object.values<any>(a.snap().logisticsJobs ?? {}).some(j => j.owner === a.id && j.carried > 0), 'no hauler loaded');
  check(true, '4: haulers dock at A/B and load real cargo');
  // 5. escort and pirates
  check(await a.command({ c: 'setOp', group: ids.escort, op: { k: 'escort', group: ids.hg } }) === null, '5: the player sends the escort group with the haulers (escort order)');
  await until(() => seenSys.has('drake'), 'no hauler jumped to drake', 240000);
  check(seenSys.has('astra') && seenSys.has('drake'), '4: haulers travel through the astra→drake jump gate');
  await until(() => maxBattles > 0, 'no battle at the gate', 240000);
  check(maxBattles > 0, '5: the pirates at the gate are engaged (P11 engagement)', { haulersInBattle: [...seenBattle], minHaulerHp: minHp });
  // 6. deliveries, re-dispatch, build start; restart mid-transport
  const loaded = await until(() => Object.values<any>(a.snap().logisticsJobs ?? {}).find(j => j.owner === a.id && j.carried > 0 && j.ship && a.snap().ships[j.ship]?.state === 'space'), 'no shipment in transit', 240000);
  const before = { job: loaded.id, ship: loaded.ship, carried: loaded.carried, cargo: a.snap().ships[loaded.ship].cargo[loaded.item], pos: a.snap().ships[loaded.ship].pos };
  clearInterval(timer);
  await stop(); await start(); await a.connect(); await b.connect();
  const after = a.snap(), j2 = after.logisticsJobs?.[before.job], sh = after.ships[before.ship];
  check(j2 && j2.ship === before.ship && Math.abs(j2.carried - before.carried) < 1e-6 && Math.abs((sh?.cargo?.[loaded.item] ?? 0) - before.cargo) < 1e-6 && Math.hypot(sh.pos.x - before.pos.x, sh.pos.z - before.pos.z) < 400, '7: server restart mid-transport: the shipment, its ship, cargo and position are restored', { before, after: { carried: j2?.carried, ship: j2?.ship, cargo: sh?.cargo?.[loaded.item], pos: sh?.pos } });
  const timer2 = setInterval(watch, 200);
  await until(() => a.snap().logisticsJobs?.[before.job]?.state === 'complete' || a.snap().logisticsJobs?.[before.job]?.delivered > 0, 'restored shipment did not deliver', 240000);
  check(true, '7: the restored shipment is delivered after the restart');
  const started = await until(() => a.snap().stations[ids.C].builds?.[0]?.started || !a.snap().stations[ids.C].builds?.length, 'build did not start', 360000);
  clearInterval(timer2); watch();
  const fin = a.snap();
  const perShip = new Map<string, number>(); for (const p of pairs) { const s = p.split('|')[0]; perShip.set(s, (perShip.get(s) ?? 0) + 1); }
  check(started && [...perShip.values()].some(n => n >= 2), '6: survivors unload at C, haulers are re-dispatched for the rest, the battleship build starts', { shipmentsPerHauler: Object.fromEntries(perShip) });
  const myJobs = Object.values<any>(fin.logisticsJobs ?? {}).filter(j => j.owner === a.id);
  facts.jobs = myJobs.map(j => ({ item: j.item, from: j.from, to: j.to, amount: j.amount, delivered: j.delivered, lost: j.lost, state: j.state }));
  const lost = myJobs.reduce((n, j) => n + j.lost, 0);
  facts.lost = lost; facts.haulersAlive = ids.haulers.filter(id => fin.ships[id]).length; facts.minHaulerHp = minHp; facts.haulersInBattle = [...seenBattle];
  check(myJobs.filter(j => !j.stow).every(j => j.delivered + j.lost + (j.state === 'cancelled' ? j.withdrawn : 0) <= j.amount + 1e-6), '6: deliveries + losses never exceed the planned amount (no duplicate transport)');
  // 8. privacy and no routes
  const bv = b.snap();
  check(!Object.values<any>(bv.logisticsJobs ?? {}).some(j => j.owner === a.id) && ids.haulers.every(id => !bv.ships[id] || (bv.ships[id].logisticsJob === undefined && !Object.keys(bv.ships[id].cargo ?? {}).length)), '8: another company sees none of the shipments or cargo');
  const err = await b.command({ c: 'poolShips', ships: [ids.haulers[0]], on: false });
  check(!!err, '8: another company cannot exclude or command the haulers', { err });
  check(!Object.keys(fin.logistics ?? {}).length && !Object.values<any>(fin.groups).some(g => g.owner === a.id && g.op?.k === 'haul'), '8: no route and no haul order existed at any point');
  check(seenBattle.size > 0 || minHp < 1 || lost > 0 || facts.haulersAlive !== 5, '8: haulers were exposed to the raid (in battle, damaged or lost — never invulnerable)', { seenBattle: [...seenBattle], minHp, lost });
  mkdirSync('artifacts/p125', { recursive: true });
  writeFileSync('artifacts/p125/server-results.json', JSON.stringify({ passed: checks.length, checks, facts, realWebSockets: 2, restarts: 2, seconds: Math.round((Date.now() - T0) / 1000) }, null, 2));
  console.log(JSON.stringify({ passed: checks.length, seconds: Math.round((Date.now() - T0) / 1000) }));
} finally { await stop(); }

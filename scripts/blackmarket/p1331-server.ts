// P13.3.1 short real-server check of the changed paths: `node dist-server/server.mjs` with BLACKMARKET_P133=1 and two
// real WebSocket accounts. H: a dock inspection seizes B's stolen goods from A → customs return lot at that station
// (no transfer home, private to B); C: B claims it with a docked ship within real hold/storage capacity, across a
// restart; U: an automatic unloading run with stolen goods aboard waits instead of heading into an inspection; L: a
// lane raid without a known black market says why it picks no target. Starting assets are placed once with the
// server stopped (incl. a recorded 'seize' inspection outcome for one ship, see H); then only real commands.
//   npm run build && npx vite-node scripts/blackmarket/p1331-server.ts [label]
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import WebSocket from 'ws';
import { WorldSim } from '../../src/world/sim';
import { sysAt } from '../../src/world/geom';
import { econOf } from '../../src/world/hullops';
import type { V } from '../../src/world/types';

const SEED = process.env.SEED ?? '133';
const label = process.argv[2] ?? 'run';
const dir = mkdtempSync(path.join(tmpdir(), 'siderarium-p1331-'));
const save = path.join(dir, 'world.json'), analytics = path.join(dir, 'world.analytics.json');
const binary = path.resolve('dist-server/server.mjs'), staticDir = path.resolve('dist');
const probe = net.createServer();
await new Promise<void>(r => probe.listen(0, '127.0.0.1', () => r()));
const port = (probe.address() as net.AddressInfo).port; await new Promise(r => probe.close(r));
const base = `http://127.0.0.1:${port}`, sockets: WebSocket[] = [];
const checks: { ok: boolean; label: string; extra?: unknown; t: number }[] = [], infos: { label: string; extra?: unknown }[] = [], facts: Record<string, any> = { seed: SEED, label, clock: 'server real time, speed 1 (multiplayer)', load: '2 accounts, ~8 scenario ships, no NPC fleets' };
const T0 = Date.now();
let child: ChildProcess | undefined;
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until<T>(fn: () => T | Promise<T>, reason: string, ms = 120000): Promise<NonNullable<T>> { const end = Date.now() + ms; while (Date.now() < end) { let v: T | undefined; try { v = await fn(); } catch { v = undefined; } if (v) return v as NonNullable<T>; await delay(200); } throw Error(reason); }
function check(ok: unknown, l: string, extra?: unknown) { checks.push({ ok: !!ok, label: l, ...(extra === undefined ? {} : { extra }), t: Math.round((Date.now() - T0) / 1000) }); console.log(ok ? 'PASS' : 'FAIL', `[${Math.round((Date.now() - T0) / 1000)}s]`, l, extra !== undefined ? JSON.stringify(extra) : ''); }
const info = (l: string, extra?: unknown) => { infos.push({ label: l, ...(extra === undefined ? {} : { extra }) }); console.log('INFO', l, extra !== undefined ? JSON.stringify(extra) : ''); };
async function start() {
  let log = '';
  child = spawn('node', [binary], { cwd: dir, env: { ...process.env, PORT: String(port), STATIC_DIR: staticDir, SAVE_FILE: save, DATABASE_URL: '', WORLD_RESET: '', CONTENT_MIGRATE: '', WORLD_SEED: SEED, SAVE_INTERVAL_S: '.5', BLACKMARKET_P133: '1', PIRACY_P132: '', SALVAGE_P131: '', AUTO_LOGISTICS_P125: '', FLEET_OPS_P12: '', COMBAT_P11: '' } });
  child.stdout!.on('data', d => log += d); child.stderr!.on('data', d => log += d);
  await until(() => { if (child!.exitCode !== null) throw Error(log); return log.includes('listening on'); }, `server did not start: ${log}`);
}
async function stop() {
  for (const s of sockets.splice(0)) s.close();
  if (child) { const p = child; child = undefined; await new Promise(r => { p.once('exit', r); p.kill('SIGTERM'); }); }
}
class Pilot {
  messages: any[] = []; seq = 1; trade = 0; ws!: WebSocket; cookie = ''; id = ''; raw: string[] = [];
  constructor(readonly name: string) {}
  async signup(loginId: string) {
    const r = await fetch(base + '/api/auth/signup', { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ loginId, password: 'p1331-test-password-123', confirm: 'p1331-test-password-123' }) });
    this.cookie = r.headers.get('set-cookie')?.split(';')[0] ?? '';
    if (r.status !== 200 || !this.cookie) throw Error(`signup failed: ${r.status}`);
  }
  async connect() {
    this.messages = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { origin: base, cookie: this.cookie } }); this.ws = ws; sockets.push(ws);
    ws.on('message', raw => {
      const text = String(raw); const m = JSON.parse(text);
      if (m.t === 'snap') { this.messages = this.messages.filter(x => x.t !== 'snap'); this.raw = [text]; }
      if (m.t === 'ack') this.messages = this.messages.filter(x => x.t !== 'ack' || x.id > m.id - 50);
      this.messages.push(m);
      if (m.t === 'needPmc') ws.send(JSON.stringify({ t: 'createPmc', name: this.name }));
    });
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    ws.send(JSON.stringify({ t: 'hello', name: this.name }));
    this.id = (await this.wait(m => m.t === 'welcome')).company;
    await this.wait(m => m.t === 'snap');
  }
  wait(test: (m: any) => boolean, ms?: number) { return until(() => this.messages.find(test), `missing response for ${this.name}`, ms); }
  async command(cmd: any) { const id = this.seq++; this.ws.send(JSON.stringify({ t: 'cmd', id, cmd })); return (await this.wait(m => m.t === 'ack' && m.id === id)).err ?? null; }
  /** a trade with a fresh request id (consecutive per company, as the client does) */
  nextRequest() { this.trade++; return { seq: this.trade, id: `p1331-${this.name.charAt(0)}-${String(this.trade).padStart(6, '0')}` }; }
  snap() { return this.messages.filter(m => m.t === 'snap').at(-1).state; }
  /** a snapshot received after now (so it reflects a command just acknowledged) */
  async fresh() { const n = this.messages.filter(m => m.t === 'snap').at(-1); await until(() => this.messages.filter(m => m.t === 'snap').at(-1) !== n, 'no new snapshot', 10000); return this.snap(); }
}
const readWorld = () => JSON.parse(readFileSync(save, 'utf8')).world;
const flowRows = () => {
  if (!existsSync(analytics)) return [] as any[];
  const st = JSON.parse(readFileSync(analytics, 'utf8')).store;
  return [...(st.hourly ?? []).flatMap((h: any) => h.rows ?? []), ...(st.current?.rows ?? []), ...(st.fine ?? []).flatMap((h: any) => h.rows ?? [])];
};
const hotOf = (k: string) => { if (!k.startsWith('hot:')) return null; const i = k.lastIndexOf(':'); return { item: k.slice(4, i), owner: k.slice(i + 1) }; };
const P = (a: V, dx: number, dz: number): V => ({ x: a.x + dx, y: 0, z: a.z + dz });
const sumC = (o: any) => Object.values<number>(o ?? {}).reduce((a, n) => a + n, 0);


const A = new Pilot('A 약탈 PMC'), B = new Pilot('B 운송 PMC');
try {
  await start();
  await A.signup('p1331_a'); await B.signup('p1331_b');
  await A.connect(); await B.connect();
  await stop();
  // ---- starting assets, placed once with the server stopped (real seed map)
  const file = JSON.parse(readFileSync(save, 'utf8'));
  const sim = new WorldSim(file.world, { migrateContent: false });
  const st = sim.st;
  for (const id of Object.keys(st.ships)) delete st.ships[id];
  for (const id of Object.keys(st.groups)) delete st.groups[id];
  for (const l of Object.values(st.lairs)) { l.alive = false; l.respawnAt = 1e10; l.nextBand = 1e10; }
  for (const co of [A.id, B.id]) st.companies[co].credits = 1e6;
  // the law reaches everywhere (security ≥ 50): no public station can be reached without inspection risk
  for (const sys of Object.values(st.systems)) sys.security = Math.max(sys.security, 50);
  const bmSt = new Set(Object.values(st.blackMarkets!).map(b => b.station));
  const homeB = st.companies[B.id].homeStation;
  const X = Object.values(st.stations).filter(s => s.public && s.id !== homeB && !bmSt.has(s.id) && sim.canDock(s, A.id) && sim.canDock(s, B.id)).sort((a, b) => a.id < b.id ? -1 : 1)[0];
  const sysX = sysAt(st.systems, X.pos)!;
  const fleet = (o: string, name: string, pos: V, comp: string[]) => {
    const g = sim.newGroup(o, name); g.commanderId = sim.newCommander(o, 2).id;
    comp.forEach((cl, i) => { const s = sim.spawnShip(o, cl, 'std', g.id, { x: pos.x + i * 40, y: 0, z: pos.z }); s.logisticsExcluded = true; }); return g;
  };
  // H: A's hauler with 200 of B's stolen electronics docks at X. The inspection outcome for this ship at X is recorded
  //    as 'seize' for the current and the next 30-minute window (the engine replays a recorded outcome), so the seizure
  //    itself is certain; everything after it is the server's own code.
  const ah = fleet(A.id, 'A 장물 운반선', P(X.pos, 400, 0), ['hauler']);
  const ahs = st.ships[ah.shipIds[0]]; ahs.cargo[`hot:electronics:${B.id}`] = 200;
  const win = Math.floor(st.time / 1800); ahs.insp = { [`st:${X.id}#${win}`]: 'seize', [`st:${X.id}#${win + 1}`]: 'seize' };
  // B's hauler near X, its hold full except 60 units
  const bh = fleet(B.id, 'B 인수선', P(X.pos, -400, 0), ['hauler']);
  const bhs = st.ships[bh.shipIds[0]]; bhs.cargo.ore = Math.floor(econOf(bhs).cargo) - 60;
  // U: A's salvager in X's system with 90 stolen alloy of B aboard (recovered earlier), and a container to recover 4.5 km
  //    away (beyond the 3 km on-site auto pickup of an idle fleet, so only the order recovers it)
  const au = fleet(A.id, 'A 인양선', P(sysX.origin, 2500, 2500), ['hauler']);
  const aus = st.ships[au.shipIds[0]]; const hk = `hot:alloy:${B.id}`; aus.cargo[hk] = 90; aus.salvaged = { [hk]: 90 };
  (st.drops ??= {}).dp_p1331 = { id: 'dp_p1331', kind: 'drop', name: '시험 컨테이너', system: sysX.id, pos: P(aus.pos, 4500, 0), created: st.time, expires: st.time + 1e7, ship: 'x', owner: A.id, by: A.id, ev: 'p1331', lots: [{ id: 'l1', k: 'cargo', item: 'ore', n: 5, owner: A.id }], initial: 5, taken: {}, seen: [A.id] } as any;
  // R: A's raid group on a lane in X's system; B's loaded hauler passes; A knows no black market
  const lane = P(sysX.origin, -6000, -6000);
  const bv = fleet(B.id, 'B 화물선', P(lane, 1500, 0), ['hauler']); st.ships[bv.shipIds[0]].cargo.alloy = 300;
  const ar = fleet(A.id, 'A 항로 약탈대', P(lane, 0, 2500), ['destroyer', 'frigate', 'hauler']);
  file.world = JSON.parse(sim.serialize()); writeFileSync(save, JSON.stringify(file));
  const ids = { X: X.id, sysX: sysX.id, homeB, ah: ah.id, ahs: ahs.id, bh: bh.id, bhs: bhs.id, au: au.id, aus: aus.id, bv: bv.id, ar: ar.id };
  facts.ids = ids; facts.station = X.name;
  await start(); await A.connect(); await B.connect();
  const view = (p: Pilot) => p.snap();
  const homeElec0 = view(B).stations[homeB]?.storage?.[B.id]?.electronics ?? 0;

  // ---- H: seizure → customs lot at X (no instant transfer home)
  check(await A.command({ c: 'setOp', group: ids.ah, op: { k: 'dock', station: ids.X } }) === null, 'H-0: A orders its hauler with stolen goods to dock at ' + X.name);
  const lotB = await until(() => view(B).companies[B.id]?.bm?.customs?.[0], 'H: no customs lot appeared for B', 300000);
  const vA = await A.fresh(), vB = await B.fresh();
  facts.h = { lot: lotB, aHold: vA.ships[ids.ahs]?.cargo, bHome: vB.stations[homeB]?.storage?.[B.id]?.electronics ?? 0, aLog: (vA.companies[A.id].bm?.log ?? []).map((x: any) => ({ k: x.k, at: x.at, fine: x.fine })) };
  check((vA.ships[ids.ahs]?.cargo?.[`hot:electronics:${B.id}`] ?? 0) === 0 && facts.h.aLog.some((x: any) => x.k === 'seize' && x.at === ids.X), 'H-1: the dock inspection seized all 200 stolen units from A\'s hold (A fined, logged)', facts.h);
  check(lotB.item === 'electronics' && lotB.n === 200 && lotB.station === ids.X && lotB.from === A.id, 'H-2: B gets a customs return lot of 200 plain electronics at the seizing station, not at its home', lotB);
  check(facts.h.bHome === homeElec0, 'H-3: nothing arrived in B\'s home-station storage (no instant transfer)', { before: homeElec0, after: facts.h.bHome });
  check(vA.companies[B.id]?.bm === undefined && !A.raw[0]?.includes('"customs"'), 'H-4: A never receives B\'s customs lots');
  check((vB.companies[B.id].bm?.log ?? []).some((x: any) => x.k === 'held' && x.at === ids.X), 'H-5: B sees the held lot in its own log');

  // ---- claim: needs a docked ship, real capacity
  const e0 = await B.command({ c: 'customsClaim', lot: lotB.id, ship: ids.bhs });
  check(e0 && /정박/.test(e0), 'C-1: claiming without a ship docked at that station is refused', { err: e0 });
  check(await B.command({ c: 'setOp', group: ids.bh, op: { k: 'dock', station: ids.X } }) === null, 'C-2: B orders its hauler to dock at ' + X.name);
  await until(() => { const s = view(B).ships[ids.bhs]; return s?.state === 'docked' ? s : null; }, 'C: B hauler never docked', 300000);
  const e1 = await B.command({ c: 'customsClaim', lot: lotB.id, ship: ids.bhs });
  const vB1 = await B.fresh();
  const hold1 = vB1.ships[ids.bhs].cargo.electronics ?? 0, left1 = vB1.companies[B.id].bm?.customs?.[0]?.n;
  check(e1 === null && hold1 === 60 && left1 === 140, 'C-3: a claim into the hold moves only the free hold (60); 140 keep waiting at customs', { err: e1, hold1, left1 });
  const e2 = await B.command({ c: 'customsClaim', lot: lotB.id, ship: ids.bhs });
  check(e2 && /화물칸 부족/.test(e2) && (await B.fresh()).companies[B.id].bm?.customs?.[0]?.n === 140, 'C-4: with a full hold the claim is refused and nothing moves', { err: e2 });
  const e3 = await A.command({ c: 'customsClaim', lot: lotB.id, ship: ids.ahs });
  check(e3 !== null, 'C-5: another company cannot claim B\'s lot', { err: e3 });

  // ---- restart: the lot comes back exactly
  await delay(1500); await stop();
  const w1 = readWorld();
  await start(); await A.connect(); await B.connect(); await delay(1000);
  const vB2 = B.snap();
  check(JSON.stringify(w1.companies[B.id].bm?.customs) === JSON.stringify(vB2.companies[B.id].bm?.customs) && vB2.companies[B.id].bm?.customs?.[0]?.n === 140, 'R-1: after a restart the customs lot (140 at the seizing station) is exactly as saved and B receives it again', { saved: w1.companies[B.id].bm?.customs, view: vB2.companies[B.id].bm?.customs });
  const store0 = vB2.stations[ids.X]?.storage?.[B.id]?.electronics ?? 0;
  const e4 = await B.command({ c: 'customsClaim', lot: lotB.id, ship: ids.bhs, toStorage: true });
  const vB3 = await B.fresh();
  const store1 = vB3.stations[ids.X]?.storage?.[B.id]?.electronics ?? 0;
  check(e4 === null && store1 - store0 === 140 && !vB3.companies[B.id].bm?.customs, 'C-6: the rest is claimed into B\'s storage at that station (room permitting); the lot is gone', { err: e4, moved: store1 - store0 });

  // ---- U: automatic unloading never heads into an inspection; it waits with the cargo and says why
  const eU = await A.command({ c: 'setOp', group: ids.au, op: { k: 'recover', wreck: 'dp_p1331' } });
  check(eU === null, 'U-0: A orders its salvager (90 stolen alloy aboard) to recover a container (auto-unload afterwards)', { err: eU, drop: !!view(A).drops?.dp_p1331 });
  const gU = await until(() => { const g = view(A).groups[ids.au]; return g?.status && /장물 안전 하역지 없음/.test(g.status) ? g : null; }, 'U: the salvager never reported the wait', 300000);
  await delay(5000);
  const vU = await A.fresh(), su = vU.ships[ids.aus];
  facts.u = { status: vU.groups[ids.au].status, state: su.state, cargo: su.cargo, warnEvents: A.messages.filter(m => m.t === 'events').flatMap(m => m.list).filter((e: any) => /장물 안전 하역지 없음/.test(e.text)).length };
  check(su.cargo[hk] === 90 && su.state !== 'docked' && !(vU.companies[A.id].bm?.log ?? []).some((x: any) => x.k === 'seize' && x.t > (lotB.t ?? 0) + 1), 'U-1: with no safe station the salvager keeps all 90 stolen units aboard and does not dock anywhere (no inspection)', facts.u);
  check(/작업 불가 — 장물 안전 하역지 없음/.test(gU.status) && facts.u.warnEvents >= 1, 'U-2: the fleet panel status says why, and the owner got a warning', facts.u);

  // ---- R: lane raid without a known black market
  check(await A.command({ c: 'stance', target: B.id, v: -1 }) === null, 'L-0: A declares B hostile');
  check(await B.command({ c: 'setOp', group: ids.bv, op: { k: 'move', to: P(lane, -6000, 0) } }) === null, 'L-1: B\'s loaded hauler passes along the lane');
  check(await A.command({ c: 'setOp', group: ids.ar, op: { k: 'plunder', at: lane, radius: 3000, policy: 'nonlethal' } }) === null, 'L-2: A orders a lane raid');
  const gR = await until(() => { const g = view(A).groups[ids.ar]; return g?.plx?.why ? g : null; }, 'L: the raid never reported a reason', 120000);
  facts.l = { why: gR.plx.why, target: gR.plx.target ?? null, known: view(A).companies[A.id].bm?.known ?? [] };
  check(/암시장 미발견/.test(gR.plx.why) && !gR.plx.target && Object.keys(view(A).blackMarkets ?? {}).length === 0, 'L-3: the raid picks no target and says that a black market must be found first; A still knows no market', facts.l);

  // ---- accounting of the seized electronics from the save
  await delay(1500); await stop();
  const w2 = readWorld();
  const elec = (w: any) => { let n = 0; const of = (c: any) => Object.entries<number>(c ?? {}).reduce((a, [k, v]) => a + (k === 'electronics' || hotOf(k)?.item === 'electronics' ? v : 0), 0); for (const s of Object.values<any>(w.ships)) if ([A.id, B.id].includes(s.owner)) n += of(s.cargo); for (const s of Object.values<any>(w.stations)) for (const c of [A.id, B.id]) n += of(s.storage?.[c]); for (const c of [A.id, B.id]) n += (w.companies[c].bm?.customs ?? []).filter((l: any) => l.item === 'electronics').reduce((a: number, l: any) => a + l.n, 0); return n; };
  facts.acc = { placed: 200 + homeElec0, held: elec(w2) };
  check(Math.abs(elec(w2) - 200 - homeElec0) < 1e-9, 'ACC: every seized unit is accounted for (B hold 60 + B storage at the station 140; nothing created or lost)', facts.acc);
  const rows = flowRows().filter(r => r.kind === 'blackmarket' && ['customs_hold', 'customs_claim'].includes(r.reason));
  facts.flows = rows.map(r => ({ reason: r.reason, amount: r.amount, station: r.station }));
  check(rows.filter(r => r.reason === 'customs_hold').reduce((a, r) => a + r.amount, 0) === 200 && rows.filter(r => r.reason === 'customs_claim').reduce((a, r) => a + r.amount, 0) === 200, 'ACC: server analytics record 200 held at customs and 200 claimed', facts.flows);
} catch (e) { check(false, 'run', { error: String((e as Error)?.stack ?? e).slice(0, 800) }); }
finally {
  await stop();
  const outDir = 'artifacts/p1331';
  mkdirSync(outDir, { recursive: true });
  const passed = checks.filter(c => c.ok).length, failed = checks.filter(c => !c.ok).length;
  writeFileSync(`${outDir}/server-${label}.json`, JSON.stringify({ passed, failed, checks, infos, facts, realWebSockets: 2, restarts: 2, seconds: Math.round((Date.now() - T0) / 1000) }, null, 2));
  console.log(JSON.stringify({ passed, failed, seconds: Math.round((Date.now() - T0) / 1000) }));
  process.exit(failed ? 1 : 0);
}

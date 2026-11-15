// P13.4.1 law accounting on a real server process: `node dist-server/server.mjs` with LAW_P134=1 and three real
// WebSocket accounts on the real seed map (the world's own Union garrisons / patrols / response fleets).
//   A — smuggler with too little money: one hauler in Helios carrying B's stolen electronics, two heavy cannons
//       (banned in Union open space), ECM modules (only a station import ban — legal in open space), ore (legal); its escort
//       battlecruiser has heavy cannons FITTED (equipment, not cargo). A is wanted for one extortion case (recorded with the
//       server stopped, seen by the station). A is offline → the stop demand is compliance → the guards inspect.
//       → seizure: stolen goods to customs for B, cannons confiscated, ECM / ore / fitted module untouched; the
//         smuggling fine is assessed in full, A's 1,000 cr are collected at once, the rest stays owed on the case
//         (state open, served — no second dispatch); the extortion fine stays owed too.
//       → lawPay refused while no A ship is near a station that can take it (no money moves).
//       → server restart #1 (with the server stopped A receives 30,000 cr — recorded as an external deposit).
//       → A brings its hauler next to the creditor station, pays 500 cr of the smuggling fine (partial), then sends
//         the same full-payment request twice in a row (duplicate): exactly the remainder is taken once, the second
//         is refused; the case closes as paid.
//       → server restart #2: the whole law book, A's credits and B's customs lot come back exactly; A pays the
//         extortion fine; nothing is owed; level back to none.
//   B — the stolen goods' owner: sees its customs lot, never A's record.
//   C — normal company: a hauler in Helios with ore + ECM cargo, no crime: never inspected, no case, sees nothing of A.
// Accounting: A's credits = start − (collected at once + paid later) exactly; every payment is in A's ledger
// (fines / law_fines); fine = paid + unpaid on every case at every step. Needs `npm run build` first.
//   npx vite-node scripts/law/p1341-server.ts [attempt-label]
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import WebSocket from 'ws';
import { WorldSim } from '../../src/world/sim';
import { lawCrime } from '../../src/world/law';
import { hotKey } from '../../src/world/blackmarket';
import { fittingItems } from '../../src/world/fitting';
import type { V } from '../../src/world/types';

const SEED = process.env.SEED ?? '133';
const label = process.argv[2] ?? 'run';
const dir = mkdtempSync(path.join(tmpdir(), 'siderarium-p1341-'));
const save = path.join(dir, 'world.json');
const binary = path.resolve('dist-server/server.mjs'), staticDir = path.resolve('dist');
const probe = net.createServer();
await new Promise<void>(r => probe.listen(0, '127.0.0.1', () => r()));
const port = (probe.address() as net.AddressInfo).port; await new Promise(r => probe.close(r));
const base = `http://127.0.0.1:${port}`, sockets: WebSocket[] = [];
let child: ChildProcess | undefined;
const T0 = Date.now();
const checks: { ok: boolean; label: string; extra?: unknown; t: number }[] = [], infos: { label: string; extra?: unknown }[] = [];
const facts: Record<string, any> = { seed: SEED, label, clock: 'server real time, speed 1 (multiplayer)', load: '3 accounts, scenario fleets + the world\'s own Union forces (other NPC fleets removed)' };
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until<T>(f: () => T | null | undefined | false, why: string, ms = 30000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const v = f(); if (v) return v; if (Date.now() > end) throw Error(why); await delay(250); }
}
function check(ok: unknown, l: string, extra?: unknown) { checks.push({ ok: !!ok, label: l, ...(extra === undefined ? {} : { extra }), t: Math.round((Date.now() - T0) / 1000) }); console.log(ok ? 'PASS' : 'FAIL', `[${Math.round((Date.now() - T0) / 1000)}s]`, l, extra !== undefined ? JSON.stringify(extra).slice(0, 600) : ''); }
const info = (l: string, extra?: unknown) => { infos.push({ label: l, ...(extra === undefined ? {} : { extra }) }); console.log('INFO', l, extra !== undefined ? JSON.stringify(extra).slice(0, 600) : ''); };
let serverLog = '';
async function start() {
  serverLog = '';
  child = spawn('node', [binary], { cwd: dir, env: { ...process.env, PORT: String(port), STATIC_DIR: staticDir, SAVE_FILE: save, DATABASE_URL: '', WORLD_RESET: '', CONTENT_MIGRATE: '', WORLD_SEED: SEED, SAVE_INTERVAL_S: '.5', LAW_P134: '1', BLACKMARKET_P133: '', PIRACY_P132: '', SALVAGE_P131: '', AUTO_LOGISTICS_P125: '', FLEET_OPS_P12: '', COMBAT_P11: '' } });
  child.stdout!.on('data', d => serverLog += d); child.stderr!.on('data', d => serverLog += d);
  await until(() => { if (child!.exitCode !== null) throw Error(serverLog); return serverLog.includes('listening on'); }, `server did not start: ${serverLog}`);
}
async function stop() {
  for (const s of sockets.splice(0)) s.close();
  // a server that already exited (e.g. refused a save) must not leave this await hanging with an empty event loop
  if (child) { const p = child; child = undefined; if (p.exitCode === null && p.signalCode === null) await new Promise(r => { p.once('exit', r); p.kill('SIGTERM'); }); }
}
class Pilot {
  messages: any[] = []; seq = 1; ws!: WebSocket; cookie = ''; id = ''; online = false; raw = 0;
  constructor(readonly name: string) {}
  async signup(loginId: string) {
    const r = await fetch(base + '/api/auth/signup', { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ loginId, password: 'p1341-test-password-123', confirm: 'p1341-test-password-123' }) });
    this.cookie = r.headers.get('set-cookie')?.split(';')[0] ?? '';
    if (r.status !== 200 || !this.cookie) throw Error(`signup failed: ${r.status}`);
  }
  async connect() {
    this.messages = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { origin: base, cookie: this.cookie } }); this.ws = ws; sockets.push(ws);
    ws.on('message', raw => {
      const text = String(raw); const m = JSON.parse(text);
      if (m.t === 'snap') { this.messages = this.messages.filter(x => x.t !== 'snap'); this.raw = text.length; (m as any)._text = text; }
      if (m.t === 'ack') this.messages = this.messages.filter(x => x.t !== 'ack' || x.id > m.id - 50);
      if (m.t === 'ev' || m.t === 'events') { /* keep */ }
      this.messages.push(m);
      if (this.messages.length > 4000) this.messages = this.messages.filter(x => x.t === 'snap' || x.t === 'welcome').concat(this.messages.filter(x => x.t !== 'snap' && x.t !== 'welcome').slice(-1000));
      if (m.t === 'needPmc') ws.send(JSON.stringify({ t: 'createPmc', name: this.name }));
    });
    ws.on('close', () => { this.online = false; });
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    this.online = true;
    ws.send(JSON.stringify({ t: 'hello', name: this.name }));
    this.id = (await this.wait(m => m.t === 'welcome')).company;
    await this.wait(m => m.t === 'snap');
  }
  async disconnect() { const ws = this.ws; await new Promise(r => { ws.once('close', r); ws.close(); }); this.online = false; }
  wait(test: (m: any) => boolean, ms?: number) { return until(() => this.messages.find(test), `missing response for ${this.name}`, ms); }
  async command(cmd: any) { const id = this.seq++; this.ws.send(JSON.stringify({ t: 'cmd', id, cmd })); return (await this.wait(m => m.t === 'ack' && m.id === id)).err ?? null; }
  snapMsg() { return this.messages.filter(m => m.t === 'snap').at(-1); }
  snap() { return this.snapMsg().state; }
  async fresh() { const n = this.snapMsg(); await until(() => this.snapMsg() !== n, 'no new snapshot', 10000); return this.snap(); }
}
const readWorld = () => JSON.parse(readFileSync(save, 'utf8')).world;
const P = (a: V, dx: number, dz: number): V => ({ x: a.x + dx, y: 0, z: a.z + dz });
const d3 = (a: V, b: V) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

const A = new Pilot('A 밀수 PMC'), B = new Pilot('B 원소유 PMC'), C = new Pilot('C 일반 PMC');
const law = (v: any) => v.companies[A.id]?.law;
const sumOf = (o: any) => Object.values<number>(o ?? {}).reduce((a, n) => a + n, 0);
const ledgerOf = (w: any, co: string) => { const L = w.companies[co].ops?.ledger ?? []; const r: Record<string, number> = {}; for (const b of L) for (const [k, v] of Object.entries<number>(b.exp ?? {})) if (/fine/.test(k)) r[k] = (r[k] ?? 0) + v; return r; };
const consistent = (L: any) => (L?.cases ?? []).every((c: any) => c.fine >= 0 && c.paid >= 0 && c.paid <= c.fine) && (L?.fined ?? 0) === (L?.paid ?? 0) + (L?.unpaid ?? 0);
try {
  await start();
  await A.signup('p1341_a'); await B.signup('p1341_b'); await C.signup('p1341_c');
  await A.connect(); await B.connect(); await C.connect();
  check(A.snap().lawV === 1, '0: LAW_P134=1 server creates a P13.4 law world', { lawV: A.snap().lawV });
  await stop();

  // ---- starting assets, placed once with the server stopped (real map, real Union forces)
  let file = JSON.parse(readFileSync(save, 'utf8'));
  let sim = new WorldSim(file.world, { migrateContent: false });
  let st = sim.st;
  for (const g of Object.values(st.groups)) if (g.owner !== 'union') { for (const id of g.shipIds) delete st.ships[id]; delete st.groups[g.id]; }
  for (const s of Object.values(st.ships)) if (s.owner !== 'union') delete st.ships[s.id];
  for (const l of Object.values(st.lairs)) { l.alive = false; l.respawnAt = 1e10; l.nextBand = 1e10; }
  const setupDrop = st.companies[A.id].credits - 1000;   // the starting credits cut to 1,000 here: the ledger books it as 'other'
  st.companies[A.id].credits = 1000; st.companies[B.id].credits = 1e6; st.companies[C.id].credits = 1e6;
  const fleet = (o: string, name: string, pos: V, comp: string[]) => {
    const g = sim.newGroup(o, name); g.commanderId = sim.newCommander(o, 2).id;
    comp.forEach((cl, i) => { const s = sim.spawnShip(o, cl, 'std', g.id, { x: pos.x + i * 40, y: 0, z: pos.z }); s.logisticsExcluded = true; }); return g;
  };
  const HE = st.stations.helios;
  const a1 = fleet(A.id, 'A 밀수선', P(HE.pos, 7000, -3000), ['hauler', 'battlecruiser']);
  const ah = st.ships[a1.shipIds[0]];
  const hk = hotKey('electronics', B.id);
  ah.cargo = { [hk]: 40, eq_heavy_cannon: 2, mod_ecm: 3, ore: 30 };
  const bc = st.ships[a1.shipIds[1]];
  const c1 = fleet(C.id, 'C 화물선', P(HE.pos, 7000, 3000), ['hauler']);
  st.ships[c1.shipIds[0]].cargo = { ore: 30, mod_ecm: 3 };
  const ex = lawCrime(sim, { kind: 'extortion', by: A.id, group: a1.id, ship: ah.id, sys: 'helios', pos: ah.pos, value: 20000, key: 'p1341:ex', how: 'station' });
  file.world = JSON.parse(sim.serialize()); writeFileSync(save, JSON.stringify(file));
  const ids = { a1: a1.id, ah: ah.id, c1: c1.id, cs: c1.shipIds[0], ex: ex?.id, hk };
  facts.ids = ids; facts.start = { creditsA: 1000, setupDrop, cargoA: { ...ah.cargo }, fitA: fittingItems(bc.fitting), bc: bc.id, cargoC: { ...st.ships[c1.shipIds[0]].cargo }, extortion: ex && { fine: ex.fine, state: ex.state, known: ex.known } };
  check(ex && ex.known && ex.state === 'open' && ex.fine > 0, 'S-0: A is wanted for one extortion case seen by Helios station (recorded with the server stopped)', facts.start.extortion);

  // ============ inspection with A offline
  await start(); await B.connect(); await C.connect();
  const fundsHe0 = Math.round(readWorld().stations.helios.funds ?? 0);
  const stop1 = await until(() => { const w = readWorld(); const g = w.groups[ids.a1]; return g?.lawStop?.end === 'inspected' ? { w, stop: g.lawStop } : null; }, 'no inspection', 900000);
  await delay(1200);
  let w = readWorld();
  const smug = Object.values<any>(w.law.cases).filter(c => c.by === A.id && c.kind === 'smuggling');
  const opsA = Object.values<any>(w.law.ops).filter(o => o.target === ids.a1 || o.group === ids.a1 || o.co === A.id);
  const sc = smug[0];
  const log = (w.companies[A.id].bm?.log ?? []).filter((e: any) => e.k === 'seize');
  facts.inspect = { stop: stop1.stop, smug: smug.map(c => ({ id: c.id, fine: c.fine, paid: c.paid, state: c.state, served: c.served, creditor: c.creditor, auth: c.auth, fixed: c.fixed })), seizeLog: log, cargoA: w.ships[ids.ah]?.cargo, fitA: w.ships[ids.ah]?.fit, creditsA: w.companies[A.id].credits, customsB: w.companies[B.id].bm?.customs, ledgerA: ledgerOf(w, A.id), ops: opsA.length, opKeys: Object.keys(w.law.ops) };
  info('inspection result', facts.inspect);
  const cargo = w.ships[ids.ah]?.cargo ?? {};
  check((cargo[hk] ?? 0) === 0 && (cargo.eq_heavy_cannon ?? 0) === 0, 'I-1: the stop inspection seized the stolen electronics and the heavy cannons (banned in Union open space)', cargo);
  check(cargo.mod_ecm === 3 && cargo.ore === 30, 'I-2: ECM cargo (only a station import ban — legal in open space) and ore (legal) stay aboard', cargo);
  const fitNow = fittingItems(w.ships[facts.start.bc]?.fitting);
  check((facts.start.fitA.eq_heavy_cannon ?? 0) > 0 && JSON.stringify(fitNow) === JSON.stringify(facts.start.fitA), 'I-3: the heavy cannons FITTED to A\'s battlecruiser are equipment, not cargo — untouched by the inspection', { before: facts.start.fitA, after: fitNow });
  const custB = (w.companies[B.id].bm?.customs ?? []).filter((l: any) => l.item === 'electronics').reduce((a: number, l: any) => a + l.n, 0);
  check(custB === 40, 'I-4: B\'s 40 electronics wait for B at customs (conserved)', { custB });
  const paid0 = sc?.paid ?? 0; facts.paid0 = paid0;
  check(smug.length === 1 && sc.fixed && sc.fine === Math.round(log[0]?.value * 0.3) && paid0 === log[0]?.fine && paid0 > 0 && paid0 <= 1000 && sc.fine - sc.paid === log[0]?.owed && sc.state === 'open' && sc.served !== undefined && !!sc.creditor, 'I-5: one smuggling case: full fine assessed (30% of the seized value), everything A had (its 1,000 cr less upkeep since the start, whole credits) collected at once, the rest owed on the case, open, served (enforced), with a creditor station', facts.inspect.smug);
  check(facts.inspect.creditsA >= 0 && facts.inspect.creditsA < 1 && (facts.inspect.ledgerA.fines ?? 0) === paid0, 'I-6: A\'s credits went to 0.xx (whole credits collected) — never negative from the fine — and the amount collected is in A\'s ledger (fines)', { credits: w.companies[A.id].credits, ledger: facts.inspect.ledgerA });
  const smugAmt = sc.fine;
  // no repeated dispatch for a served case that still owes: watch for 120 s of game time
  const t0 = w.time, nOps0 = Object.keys(w.law.ops).length, seq0 = w.law.seq;
  await until(() => readWorld().time > t0 + 120, 'time', 300000);
  w = readWorld();
  const newOps = Object.values<any>(w.law.ops).filter(o => !facts.inspect.opKeys.includes(o.id));
  const cases2 = Object.values<any>(w.law.cases).filter(c => c.by === A.id);
  facts.noRedispatch = { t: Math.round(w.time - t0), newOps: newOps.map(o => ({ id: o.id, phase: o.phase, target: o.target ?? o.group })), cases: cases2.map(c => `${c.kind}:${c.state}:${c.fine}/${c.paid}`), seq: [seq0, w.law.seq], stop: w.groups[ids.a1]?.lawStop };
  check(newOps.length === 0 && smug.length === Object.values<any>(w.law.cases).filter(c => c.by === A.id && c.kind === 'smuggling').length, 'I-7: with the debt still owed no new dispatch / stop / smuggling case followed in 120 s (served cases are not re-enforced)', facts.noRedispatch);
  void nOps0;
  // C was never inspected
  const cC = w.ships[ids.cs]?.cargo;
  check(cC?.ore === 30 && cC?.mod_ecm === 3 && !Object.values<any>(w.law.cases).some(c => c.by === C.id) && !(w.companies[C.id].bm?.log ?? []).some((e: any) => e.k === 'seize'), 'I-8: C\'s ordinary hauler (ore + ECM cargo, no crime) was never stopped or inspected — no case', { cargo: cC });

  // ============ A connects: sees its debt; pay refused far from the creditor
  await A.connect();
  let L = law(A.snap());
  facts.viewA1 = L;
  check(L && L.fined === L.paid + L.unpaid && L.unpaid === (smugAmt - paid0) + facts.start.extortion.fine && consistent(L), 'V-1: A\'s own view: total fined = paid + unpaid; unpaid = smuggling rest + extortion fine', { fined: L?.fined, paid: L?.paid, unpaid: L?.unpaid });
  const vs = L.cases.find((c: any) => c.id === sc.id);
  check(vs && vs.served && vs.state === 'open' && vs.creditor === sc.creditor, 'V-2: the smuggling case shows as enforced (served) and still open with its creditor', vs);
  const caseBook = (x: any) => JSON.stringify(Object.values<any>(x.law.cases).filter(c => c.by === A.id).map(c => [c.id, c.fine, c.paid, c.state]));
  await delay(1200); const pre = readWorld();
  const far = await A.command({ c: 'lawPay', case: sc.id, amount: 500 });
  await delay(1200); const post = readWorld();
  check(far !== null && caseBook(pre) === caseBook(post) && JSON.stringify(ledgerOf(pre, A.id)) === JSON.stringify(ledgerOf(post, A.id)), 'P-1: lawPay is refused while A has no money and no ship near a station that takes it — no case or ledger entry changes', { err: far, ledger: ledgerOf(post, A.id) });

  // ============ restart #1 — external deposit of 30,000 cr while stopped
  await stop();
  w = readWorld();
  const book1 = JSON.stringify({ cases: w.law.cases, keys: w.law.keys });
  file = JSON.parse(readFileSync(save, 'utf8'));
  file.world.companies[A.id].credits = Math.round(file.world.companies[A.id].credits) + 30000;
  writeFileSync(save, JSON.stringify(file));
  await start(); await A.connect(); await B.connect(); await C.connect();
  await delay(1500);
  w = readWorld();
  check(JSON.stringify({ cases: w.law.cases, keys: w.law.keys }) === book1, 'R-1: after restart #1 every case (fine, paid, state, served, creditor) and the key index are exactly as saved', { cases: Object.keys(w.law.cases).length });
  L = law(A.snap());
  check(L?.unpaid === facts.viewA1.unpaid, 'R-2: the unpaid amount survived the restart (not lost, not doubled, no retroactive bill)', { unpaid: L?.unpaid });

  // ============ partial payment next to the creditor station, then a duplicate full payment
  const cred = w.stations[sc.creditor];
  check(await A.command({ c: 'setOp', group: ids.a1, op: { k: 'move', to: P(cred.pos, 2500, 0) } }) === null, 'P-2: A flies its hauler next to the creditor station (no docking needed)', { creditor: cred.id });
  await until(() => { const s = A.snap().ships[ids.ah]; return s && d3(s.pos, cred.pos) < 4000 + (cred.radius ?? 0) - 200 ? s : null; }, 'hauler did not arrive', 600000);
  await delay(800);
  const cr1 = (await A.fresh()).companies[A.id].credits;
  const fund1 = Math.round(readWorld().stations[cred.id].funds ?? 0);
  const lf = async () => { await delay(1200); return ledgerOf(readWorld(), A.id).law_fines ?? 0; };
  const lf0 = await lf();
  const p1 = await A.command({ c: 'lawPay', case: sc.id, amount: 500 });
  const v1 = await A.fresh(); const c1v = law(v1).cases.find((c: any) => c.id === sc.id);
  const lf1 = await lf();
  // upkeep keeps running between two snapshots (≈1 cr/s for these two hulls): the ledger is the exact record, the
  // credit balance is checked within that drift
  facts.partial = { err: p1, credits: [cr1, v1.companies[A.id].credits], ledgerLawFines: [lf0, lf1], case: c1v };
  check(p1 === null && lf1 - lf0 === 500 && Math.abs(cr1 - v1.companies[A.id].credits - 500) < 5 && c1v.paid === paid0 + 500 && c1v.state === 'open' && consistent(law(v1)), 'P-3: a partial payment of 500 cr: exactly 500 booked (law_fines), credits −500 (± upkeep drift), case paid +500, still open with the rest owed', facts.partial);
  const rest = smugAmt - paid0 - 500;
  const id1 = A.seq++, id2 = A.seq++;
  A.ws.send(JSON.stringify({ t: 'cmd', id: id1, cmd: { c: 'lawPay', case: sc.id, amount: rest } }));
  A.ws.send(JSON.stringify({ t: 'cmd', id: id2, cmd: { c: 'lawPay', case: sc.id, amount: rest } }));
  const r1 = (await A.wait(m => m.t === 'ack' && m.id === id1)).err ?? null, r2 = (await A.wait(m => m.t === 'ack' && m.id === id2)).err ?? null;
  // and the very same command id resent (a client retry)
  A.ws.send(JSON.stringify({ t: 'cmd', id: id1, cmd: { c: 'lawPay', case: sc.id, amount: rest } }));
  await delay(1500);
  const v2 = await A.fresh(); const c2v = law(v2).cases.find((c: any) => c.id === sc.id);
  const lf2 = await lf();
  facts.dup = { r1, r2, credits: [v1.companies[A.id].credits, v2.companies[A.id].credits], ledgerLawFines: [lf1, lf2], case: c2v, rest };
  check(r1 === null && r2 !== null && lf2 - lf1 === rest && Math.abs(v1.companies[A.id].credits - v2.companies[A.id].credits - rest) < 10, 'P-4: the same full payment sent twice (and the first command id resent): the remainder was taken exactly once, the duplicate refused', facts.dup);
  check(c2v.paid === c2v.fine && c2v.state === 'closed' && c2v.end === 'paid', 'P-5: fully paid, the smuggling case closed (종결, paid)', c2v);
  await delay(1200);
  const wP = readWorld();
  const fund2 = Math.round(wP.stations[cred.id].funds ?? 0);
  facts.funds = { creditor: cred.id, before: fund1, after: fund2, paidLater: 500 + rest, heliosAtStart: fundsHe0 };
  info('creditor station funds (fundsIn has its own inflow factor / cap — partial sink by design)', facts.funds);
  check(fund2 >= fund1 && fund2 - fund1 <= 500 + rest + 1, 'P-6: the money went to the creditor station (never more than was paid)', facts.funds);

  // ============ restart #2 — exact restore, then pay the extortion fine
  await delay(1200);
  await stop();
  const before2 = readWorld();
  const pick = (x: any) => JSON.stringify({ cases: x.law.cases, keys: x.law.keys, credits: Math.round(x.companies[A.id].credits), customs: x.companies[B.id].bm?.customs, ledger: ledgerOf(x, A.id) });
  const k1 = pick(before2);
  await start(); await A.connect(); await B.connect(); await C.connect();
  await delay(1500); await stop();
  const k2 = pick(readWorld());
  check(k1 === k2, 'R-3: after restart #2 the law book, A\'s credits, A\'s fine ledger and B\'s customs lot are exactly as saved', { k1: k1.length });
  await start(); await A.connect(); await B.connect(); await C.connect();
  const cr3 = (await A.fresh()).companies[A.id].credits;
  const p3 = await A.command({ c: 'lawPay' });
  const v3 = await A.fresh(); const L3 = law(v3);
  facts.final = { err: p3, credits: [cr3, v3.companies[A.id].credits], level: L3?.level, unpaid: L3?.unpaid, fined: L3?.fined, paid: L3?.paid, cases: L3?.cases?.map((c: any) => `${c.kind}:${c.state}:${c.end ?? ''}:${c.fine}/${c.paid}`) };
  check(p3 === null && (L3?.unpaid ?? 0) === 0 && Math.abs(cr3 - v3.companies[A.id].credits - facts.start.extortion.fine) < 5, 'P-7: A pays the extortion fine; nothing owed any more', facts.final);
  const lf3 = await lf();
  const p4 = await A.command({ c: 'lawPay' });
  const lf4 = await lf();
  check(p4 !== null && lf4 === lf3, 'P-8: a further payment request is refused — nothing more booked, no double collection', { err: p4, ledger: [lf3, lf4] });

  // ============ accounting
  await delay(1200);
  const wf = readWorld();
  const led = ledgerOf(wf, A.id);
  const totalFines = smugAmt + facts.start.extortion.fine;
  const paidCases = Object.values<any>(wf.law.cases).filter(c => c.by === A.id).reduce((a, c) => a + c.paid, 0);
  // every other expense booked meanwhile (ship upkeep …), less the setup cut itself, and income less the 30,000 deposit
  const upkeep = Object.values<any>(wf.companies[A.id].ops?.ledger ?? []).reduce((a, b) => a + sumOf(b.exp) - (b.exp?.fines ?? 0) - (b.exp?.law_fines ?? 0), 0) - facts.start.setupDrop;
  const incA = Object.values<any>(wf.companies[A.id].ops?.ledger ?? []).reduce((a, b) => a + sumOf(b.inc), 0) - 30000;
  const spent = 1000 + 30000 - wf.companies[A.id].credits;
  facts.acc = { ledger: led, paidCases, totalFines, otherExpenses: +upkeep.toFixed(2), income: incA, spent: +spent.toFixed(2), credits: wf.companies[A.id].credits };
  check(paidCases === totalFines && Math.round((led.fines ?? 0) + (led.law_fines ?? 0)) === totalFines, 'ACC-1: the cases\' paid amounts and A\'s ledger (fines at the seizure + law_fines later) both equal the total assessed — every credit collected once', facts.acc);
  check(Math.abs(spent - totalFines - upkeep + incA) < 2, 'ACC-1b: A\'s balance change (1,000 start + 30,000 deposit − end) = fines + the other expenses booked meanwhile (ship upkeep; the setup cut and the deposit, booked as other, excluded) — nothing else moved A\'s money', facts.acc);
  const allA = Object.values<any>(wf.law.cases).filter(c => c.by === A.id);
  check(allA.every(c => c.paid === c.fine && c.state !== 'open'), 'ACC-2: every A case is fine = paid, none open', allA.map(c => `${c.kind}:${c.state}:${c.fine}/${c.paid}`));
  const hotLeft = Object.values<any>(wf.ships).filter(s => s.owner === A.id).reduce((a, s) => a + (s.cargo?.[hk] ?? 0), 0);
  const cust = (wf.companies[B.id].bm?.customs ?? []).filter((l: any) => l.item === 'electronics').reduce((a: number, l: any) => a + l.n, 0);
  check(hotLeft + cust === 40, 'ACC-3: B\'s 40 electronics are conserved (customs), no unit created or lost through the restarts', { hotLeft, cust });

  // ============ privacy
  const vB = await B.fresh(), vC = await C.fresh();
  const rawB = B.snapMsg()?._text ?? '', rawC = C.snapMsg()?._text ?? '';
  check(!vB.companies[A.id]?.law && !vC.companies[A.id]?.law && !rawB.includes(sc.id) && !rawC.includes(sc.id) && !rawC.includes('"law_fines"'), 'PR-1: B and C never receive A\'s law record, case ids or fines', {});
  check(!vC.companies[C.id]?.law?.cases?.length, 'PR-2: C, a normal company, has no case of its own', vC.companies[C.id]?.law);
  check((vB.companies[B.id]?.bm?.customs ?? []).some((l: any) => l.item === 'electronics') || JSON.stringify(vB).includes('electronics'), 'PR-3: B sees its own customs lot', {});
} catch (e) { check(false, 'run', { error: String((e as Error)?.stack ?? e).slice(0, 1500), serverTail: serverLog.slice(-1500) }); }
finally {
  await stop();
  const outDir = 'artifacts/p1341';
  mkdirSync(outDir, { recursive: true });
  const passed = checks.filter(c => c.ok).length, failed = checks.filter(c => !c.ok).length;
  writeFileSync(`${outDir}/server-${label}.json`, JSON.stringify({ passed, failed, checks, infos, facts, realWebSockets: 3, seconds: Math.round((Date.now() - T0) / 1000) }, null, 2));
  console.log(JSON.stringify({ passed, failed, seconds: Math.round((Date.now() - T0) / 1000) }));
  process.exit(failed ? 1 : 0);
}

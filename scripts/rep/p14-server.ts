// P14.0 reputation on a real server process: `node dist-server/server.mjs` with three real WebSocket accounts.
//   Phase 1 — REPUTATION_P14=1 creates a repV world: a new company starts neutral (credit 0, no faction trust).
//   Phase 2 — the save is swapped (server stopped) for a P10 repV world of the same seed holding the same accounts
//             (the production server only creates P9 worlds; faction trust needs the P10 factions). Through real
//             commands: a sale at the Iron Command's Bulwark yard raises iron trust and company credit (nobody
//             else's); the iron battleship blueprint is refused with the exact missing trust; the Helios yard refuses a
//             military hull for missing Union trust and a civilian hull for missing credit; a fourth dreadnought
//             holder is refused with nothing charged; B and C never see A's reputation; the record survives a restart;
//             once trust and contract record are met the blueprint is bought.
//   Phase 3 — an existing growth save without repV, started with REPUTATION_P14_MIGRATE=1: credit is mapped
//             monotonically, the legacy value kept, faction standing untouched, assets unchanged, the purchase rights
//             lost under the new rule kept for the grace period; a second migrating start changes nothing.
// Needs `npm run build` first.   npx vite-node scripts/rep/p14-server.ts [attempt-label]
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import WebSocket from 'ws';
import { WorldSim } from '../../src/world/sim';
import { mapLegacy, repRecord } from '../../src/world/reputation';
import { CONTENT } from '../../src/content/registry';

const SEED = process.env.SEED ?? '133';
const label = process.argv[2] ?? 'run';
const dir = mkdtempSync(path.join(tmpdir(), 'siderarium-p14-'));
const save = path.join(dir, 'world.json');
const binary = path.resolve('dist-server/server.mjs'), staticDir = path.resolve('dist');
const probe = net.createServer();
await new Promise<void>(r => probe.listen(0, '127.0.0.1', () => r()));
const port = (probe.address() as net.AddressInfo).port; await new Promise(r => probe.close(r));
const base = `http://127.0.0.1:${port}`, sockets: WebSocket[] = [];
let child: ChildProcess | undefined;
const T0 = Date.now();
const checks: { ok: boolean; label: string; extra?: unknown; t: number }[] = [];
const facts: Record<string, any> = { seed: SEED, label, clock: 'server real time, speed 1 (multiplayer)' };
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until<T>(f: () => T | null | undefined | false, why: string, ms = 30000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const v = f(); if (v) return v; if (Date.now() > end) throw Error(why); await delay(250); }
}
function check(ok: unknown, l: string, extra?: unknown) { checks.push({ ok: !!ok, label: l, ...(extra === undefined ? {} : { extra }), t: Math.round((Date.now() - T0) / 1000) }); console.log(ok ? 'PASS' : 'FAIL', `[${Math.round((Date.now() - T0) / 1000)}s]`, l, extra !== undefined ? JSON.stringify(extra).slice(0, 600) : ''); }
let serverLog = '', allLog = '';
async function start(env: Record<string, string> = {}) {
  serverLog = '';
  child = spawn('node', [binary], { cwd: dir, env: { ...process.env, PORT: String(port), STATIC_DIR: staticDir, SAVE_FILE: save, DATABASE_URL: '', WORLD_RESET: '', CONTENT_MIGRATE: '', WORLD_SEED: SEED, SAVE_INTERVAL_S: '.5', REPUTATION_P14: '', REPUTATION_P14_MIGRATE: '', ...env } });
  child.stdout!.on('data', d => { serverLog += d; allLog += d; }); child.stderr!.on('data', d => { serverLog += d; allLog += d; });
  await until(() => { if (child!.exitCode !== null) throw Error(serverLog); return serverLog.includes('listening on'); }, `server did not start: ${serverLog}`);
}
async function stop() {
  for (const s of sockets.splice(0)) s.close();
  if (child) { const p = child; child = undefined; if (p.exitCode === null && p.signalCode === null) await new Promise(r => { p.once('exit', r); p.kill('SIGTERM'); }); }
}
class Pilot {
  messages: any[] = []; seq = 1; ws!: WebSocket; cookie = ''; id = '';
  constructor(readonly name: string) {}
  async signup(loginId: string) {
    const r = await fetch(base + '/api/auth/signup', { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ loginId, password: 'p14-test-password-123', confirm: 'p14-test-password-123' }) });
    this.cookie = r.headers.get('set-cookie')?.split(';')[0] ?? '';
    if (r.status !== 200 || !this.cookie) throw Error(`signup failed: ${r.status}`);
  }
  async connect() {
    this.messages = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { origin: base, cookie: this.cookie } }); this.ws = ws; sockets.push(ws);
    ws.on('message', raw => {
      const text = String(raw); const m = JSON.parse(text);
      if (m.t === 'snap') { this.messages = this.messages.filter(x => x.t !== 'snap'); (m as any)._text = text; }
      this.messages.push(m);
      if (this.messages.length > 4000) this.messages = this.messages.filter(x => x.t === 'snap' || x.t === 'welcome').concat(this.messages.filter(x => x.t !== 'snap' && x.t !== 'welcome').slice(-1000));
      if (m.t === 'needPmc') ws.send(JSON.stringify({ t: 'createPmc', name: this.name }));
    });
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    ws.send(JSON.stringify({ t: 'hello', name: this.name }));
    this.id = (await this.wait(m => m.t === 'welcome')).company;
    await this.wait(m => m.t === 'snap');
  }
  wait(test: (m: any) => boolean, ms?: number) { return until(() => this.messages.find(test), `missing response for ${this.name}`, ms); }
  async command(cmd: any) { const id = this.seq++; this.ws.send(JSON.stringify({ t: 'cmd', id, cmd })); return (await this.wait(m => m.t === 'ack' && m.id === id)).err ?? null; }
  snapMsg() { return this.messages.filter(m => m.t === 'snap').at(-1); }
  snap() { return this.snapMsg().state; }
  async fresh() { const n = this.snapMsg(); await until(() => this.snapMsg() !== n, 'no new snapshot', 10000); return this.snap(); }
}
const readFile = () => JSON.parse(readFileSync(save, 'utf8'));
const readWorld = () => readFile().world;
const A = new Pilot('A 철갑 협력 PMC'), B = new Pilot('B 관찰 PMC'), C = new Pilot('C 레거시 PMC');
const repOf = (w: any, id: string) => ({ rep: w.companies[id].rep, standing: w.companies[id].standing ?? {}, acc: w.companies[id].repx?.acc ?? {} });
try {
  // ============ phase 1: a REPUTATION_P14 server creates a repV world; a new company is neutral
  await start({ REPUTATION_P14: '1' });
  await A.signup('p14_a'); await B.signup('p14_b'); await C.signup('p14_c');
  await A.connect(); await B.connect(); await C.connect();
  const s0 = A.snap();
  check(s0.repV === 1 && s0.companies[A.id].rep === 0 && !Object.values<number>(s0.companies[A.id].standing ?? {}).some(v => v !== 0), '1-1: REPUTATION_P14=1 server creates a repV world; a new PMC starts at credit 0 with no faction trust', { repV: s0.repV, rep: s0.companies[A.id].rep, standing: s0.companies[A.id].standing });
  await stop();

  // ============ phase 2: the same accounts in a P10 repV world (prepared with the server stopped)
  let file = readFile();
  const sim = WorldSim.create(Number(SEED), { layout: 'p10', rep: 'p14' });
  const w = sim.st;
  const idMap: Record<string, string> = {};
  for (const [p, n] of [[A, A.name], [B, B.name], [C, C.name]] as const) { const nid = sim.addPlayer(n); idMap[p.id] = nid; }
  for (const [acc, co] of Object.entries<string>(file.accounts)) file.accounts[acc] = idMap[co] ?? co;
  for (const p of [A, B, C]) p.id = idMap[p.id];
  // quiet world: no NPC fleets roam into the yards during the run
  for (const g of Object.values(w.groups)) if (w.companies[g.owner]?.kind !== 'player') { for (const id of g.shipIds) delete w.ships[id]; delete w.groups[g.id]; }
  for (const l of Object.values(w.lairs ?? {})) { (l as any).alive = false; (l as any).respawnAt = 1e10; (l as any).nextBand = 1e10; }
  for (const p of [A, B, C]) w.companies[p.id].credits = 5e6;
  const BW = w.stations.p10_bulwark_yard;
  (sim as any).storage(BW, A.id).weapon_parts = 100;
  BW.funds = Math.max(BW.funds ?? 0, 500000);
  // three dreadnought holders already exist (two recorded, one held from before the fix)
  w.uniques = { ...(w.uniques ?? {}), bp_dreadnought_mk1: ['x_holder_1', 'x_holder_2'] };
  (w.companies[B.id].blueprints ??= {}).bp_dreadnought_mk1 = { src: 'faction', t: 0 } as any;
  w.stations.helios.shipStock!.destroyer_mk1 = { n: 3, t: 0 } as any;
  w.stations.helios.shipStock!.miner_xl = { n: 3, t: 0 } as any;
  file.world = JSON.parse(sim.serialize()); writeFileSync(save, JSON.stringify(file));
  facts.ids = { A: A.id, B: B.id, C: C.id };

  await start({ REPUTATION_P14: '1' });
  await A.connect(); await B.connect(); await C.connect();
  const v0 = A.snap();
  check(v0.repV === 1 && !!v0.factions?.iron && v0.stations.p10_bulwark_yard?.faction === 'iron', '2-0: the server runs the P10 repV world (six factions; Bulwark yard is the Iron Command\'s)', { factions: Object.keys(v0.factions ?? {}) });
  // sale at an Iron Command yard
  const r0 = repOf(readWorld(), A.id);
  const sellErr = await A.command({ c: 'sell', station: 'p10_bulwark_yard', res: 'weapon_parts', amount: 100 });
  await delay(1500);
  let wf = readWorld();
  const r1 = repOf(wf, A.id), b1 = repOf(wf, B.id);
  facts.sale = { err: sellErr, before: r0, after: r1, log: wf.companies[A.id].repx?.log?.slice(-3) };
  check(sellErr === null && (r1.standing.iron ?? 0) > (r0.standing.iron ?? 0) && r1.rep > r0.rep && (r1.standing.iron ?? 0) < 5, '2-1: selling 100 weapon parts at the Bulwark yard raised iron trust and company credit — by a small amount (no jump to a top band)', facts.sale);
  check(Object.entries(r1.standing).every(([f, v]) => f === 'iron' || v === (r0.standing[f] ?? 0)), '2-2: no other faction\'s trust moved (no automatic cross gain)', r1.standing);
  check(b1.rep === 0 && !Object.values<number>(b1.standing).some(v => v), '2-3: B (another company) is untouched', b1);

  // the iron battleship blueprint: refused for missing trust, credits unchanged
  let cr = (await A.fresh()).companies[A.id].credits;
  const bpErr = await A.command({ c: 'buyBlueprint', station: 'p10_bulwark_yard', blueprint: 'bp_battleship_mk1' });
  let after = (await A.fresh()).companies[A.id];
  check(typeof bpErr === 'string' && /철갑 사령부 신뢰도 45 필요/.test(bpErr) && !after.blueprints?.bp_battleship_mk1 && Math.abs(cr - after.credits) < 100, '2-4: buyBlueprint bp_battleship_mk1 refused with the exact missing iron trust; nothing charged', { err: bpErr, credits: [cr, after.credits] });
  // public yard: military hull needs Union trust, civilian hull needs company credit
  const milErr = await A.command({ c: 'buyShip', station: 'helios', classId: CONTENT.hulls.destroyer_mk1.classId, hull: 'destroyer_mk1' });
  const civErr = await A.command({ c: 'buyShip', station: 'helios', classId: CONTENT.hulls.miner_xl.classId, hull: 'miner_xl' });
  check(/연합 관리청 신뢰도 10 필요/.test(milErr ?? '') && /회사 신용도 5 필요/.test(civErr ?? ''), '2-5: Helios yard refuses destroyer_mk1 for missing Union trust and miner_xl (civilian) for missing company credit (5)', { milErr, civErr });
  // a fourth dreadnought holder
  await stop();
  file = readFile();
  const WA = file.world.companies[A.id];
  WA.standing = { ...(WA.standing ?? {}), union: 100 }; WA.rep = 60;
  const simU = new WorldSim(file.world, { migrateContent: false });
  for (let i = 0; i < 40; i++) repRecord(simU.st, A.id, 'union', 'k', `setup-u${i}`);
  file.world = JSON.parse(simU.serialize()); writeFileSync(save, JSON.stringify(file));
  await start({ REPUTATION_P14: '1' }); await A.connect(); await B.connect(); await C.connect();
  cr = (await A.fresh()).companies[A.id].credits;
  const dnErr = await A.command({ c: 'buyBlueprint', station: 'helios', blueprint: 'bp_dreadnought_mk1' });
  after = (await A.fresh()).companies[A.id];
  check(/한도/.test(dnErr ?? '') && !after.blueprints?.bp_dreadnought_mk1 && Math.abs(cr - after.credits) < 100, '2-6: with three holders (one held from before the fix) a fourth dreadnought purchase is refused — nothing charged, nothing granted', { err: dnErr, credits: [cr, after.credits] });
  const milOk = await A.command({ c: 'buyShip', station: 'helios', classId: CONTENT.hulls.destroyer_mk1.classId, hull: 'destroyer_mk1' });
  check(milOk === null, '2-7: with Union trust the same destroyer_mk1 purchase succeeds (ship ownership unchanged otherwise)', { err: milOk });

  // privacy
  await delay(800);
  const vB = await B.fresh(), vA = await A.fresh();
  const rawB = B.snapMsg()?._text ?? '';
  const ownRx = vA.companies[A.id].repx;
  check(ownRx && Array.isArray(ownRx.log) && ownRx.keys === undefined && ownRx.cases === undefined, '2-8: A sees its own reputation record and change log, never the applied-event keys or crime tallies', { fields: Object.keys(ownRx ?? {}) });
  check(!vB.companies[A.id]?.repx && !vB.companies[A.id]?.standing && vB.companies[A.id]?.rep === 0 && !rawB.includes('setup-u1'), '2-9: B never receives A\'s credit, trust or reputation record', { aSeenByB: Object.keys(vB.companies[A.id] ?? {}) });

  // restart: the record comes back exactly
  await delay(1200); await stop();
  const k1 = JSON.stringify(readWorld().companies[A.id].repx) + JSON.stringify(readWorld().companies[A.id].standing) + readWorld().companies[A.id].rep;
  await start({ REPUTATION_P14: '1' }); await A.connect(); await delay(1500); await stop();
  const k2 = JSON.stringify(readWorld().companies[A.id].repx) + JSON.stringify(readWorld().companies[A.id].standing) + readWorld().companies[A.id].rep;
  check(k1 === k2, '2-10: after a restart A\'s credit, trust and reputation record (keys, log, cases) are exactly as saved', { len: k1.length });

  // trust and contract record met → the blueprint is sold
  file = readFile();
  file.world.companies[A.id].standing.iron = 50;
  const simI = new WorldSim(file.world, { migrateContent: false });
  for (let i = 0; i < 11; i++) repRecord(simI.st, A.id, 'iron', 'k', `setup-i${i}`);
  file.world = JSON.parse(simI.serialize()); writeFileSync(save, JSON.stringify(file));
  await start({ REPUTATION_P14: '1' }); await A.connect(); await B.connect();
  const e11 = await A.command({ c: 'buyBlueprint', station: 'p10_bulwark_yard', blueprint: 'bp_battleship_mk1' });
  check(/계약 실적 12건 필요/.test(e11 ?? ''), '2-11: with iron trust 50 but 11 iron contracts the blueprint is still refused for the contract record (12)', { err: e11 });
  await stop();
  file = readFile();
  const simJ = new WorldSim(file.world, { migrateContent: false });
  repRecord(simJ.st, A.id, 'iron', 'k', 'setup-i11');
  file.world = JSON.parse(simJ.serialize()); writeFileSync(save, JSON.stringify(file));
  await start({ REPUTATION_P14: '1' }); await A.connect();
  cr = (await A.fresh()).companies[A.id].credits;
  const okBp = await A.command({ c: 'buyBlueprint', station: 'p10_bulwark_yard', blueprint: 'bp_battleship_mk1' });
  after = (await A.fresh()).companies[A.id];
  facts.bought = { err: okBp, credits: [cr, after.credits], bp: after.blueprints?.bp_battleship_mk1 };
  check(okBp === null && after.blueprints?.bp_battleship_mk1?.src === 'faction' && cr - after.credits > 1000, '2-12: iron trust 50 + 12 iron contracts → the battleship blueprint is bought at Bulwark (charged, src faction)', facts.bought);
  await stop();

  // ============ phase 3: migrate an existing growth save without repV
  file = readFile();
  const old = WorldSim.create(Number(SEED));
  const oldIds: Record<string, string> = {};
  for (const p of [A, B, C]) oldIds[p.id] = old.addPlayer(p.name);
  for (const [acc, co] of Object.entries<string>(file.accounts)) file.accounts[acc] = oldIds[co] ?? co;
  for (const p of [A, B, C]) p.id = oldIds[p.id];
  const ow = old.st;
  ow.companies[A.id].rep = 75; ow.companies[A.id].standing = { union: 30, pirates: -12 }; ow.companies[A.id].credits = 3e6;
  ow.companies[B.id].rep = 12; ow.companies[C.id].rep = 0;
  check(!ow.repV && (ow as any).contentV >= 3, '3-0: the prepared save is a growth world without repV', { repV: ow.repV, contentV: (ow as any).contentV });
  file.world = JSON.parse(old.serialize()); writeFileSync(save, JSON.stringify(file));
  const assets = (x: any, id: string) => JSON.stringify({ ships: Object.values<any>(x.ships).filter(s => s.owner === id).map(s => [s.id, s.classId, s.hull ?? null]).sort(), bps: Object.keys(x.companies[id].blueprints ?? {}).sort(), standing: x.companies[id].standing ?? {} });
  const before = { A: assets(file.world, A.id), B: assets(file.world, B.id) };
  // a migrating start on a server that would NOT create new repV worlds (the switch is the migration flag)
  await start({ REPUTATION_P14_MIGRATE: '1' });
  const line1 = serverLog.split('\n').find(l => l.includes('P14.0 평판 이전')) ?? '';
  await A.connect(); await delay(1500); await stop();
  wf = readWorld();
  const RA = wf.companies[A.id];
  facts.migrate = { line: line1, A: { rep: RA.rep, legacy: RA.repx?.legacy, grand: RA.repx?.grand, standing: RA.standing }, B: { rep: wf.companies[B.id].rep, legacy: wf.companies[B.id].repx?.legacy } };
  check(wf.repV === 1 && /회사 3곳/.test(line1), '3-1: REPUTATION_P14_MIGRATE=1 converts the save (server log line names 3 companies)', { line: line1 });
  check(RA.rep === mapLegacy(75) && RA.repx?.legacy === 75 && wf.companies[B.id].rep === mapLegacy(12) && wf.companies[B.id].repx?.legacy === 12 && wf.companies[C.id].rep === 0, '3-2: credit mapped monotonically (75 → ' + mapLegacy(75) + ', 12 → ' + mapLegacy(12) + '), the legacy value kept; nobody reset to one value', facts.migrate);
  check(JSON.stringify(RA.standing) === JSON.stringify({ union: 30, pirates: -12 }), '3-3: faction standing kept as it was — the common reputation is not copied into it', RA.standing);
  check(assets(wf, A.id) === before.A && assets(wf, B.id) === before.B, '3-4: ships, blueprints and standing of A and B are unchanged by the migration', {});
  check((RA.repx?.grand?.keys?.length ?? 0) > 0 && RA.repx.grand.until > wf.time, '3-5: purchase rights A held under the old rule are kept for the grace period', RA.repx?.grand);
  const k3 = JSON.stringify({ rep: RA.rep, repx: { legacy: RA.repx.legacy, grand: RA.repx.grand, acc: RA.repx.acc }, st: RA.standing });
  await start({ REPUTATION_P14_MIGRATE: '1' });
  const line2 = serverLog.split('\n').find(l => l.includes('P14.0 평판 이전')) ?? '';
  await delay(1500); await stop();
  wf = readWorld(); const RA2 = wf.companies[A.id];
  const k4 = JSON.stringify({ rep: RA2.rep, repx: { legacy: RA2.repx.legacy, grand: RA2.repx.grand, acc: RA2.repx.acc }, st: RA2.standing });
  check(/이미 적용됨/.test(line2) && k3 === k4, '3-6: a second migrating start changes nothing (idempotent)', { line: line2 });
} catch (e) { check(false, 'run', { error: String((e as Error)?.stack ?? e).slice(0, 1500), serverTail: serverLog.slice(-1500) }); }
finally {
  await stop();
  const outDir = 'artifacts/p14';
  mkdirSync(outDir, { recursive: true });
  const passed = checks.filter(c => c.ok).length, failed = checks.filter(c => !c.ok).length;
  writeFileSync(`${outDir}/server-${label}.json`, JSON.stringify({ passed, failed, checks, facts, realWebSockets: 3, seconds: Math.round((Date.now() - T0) / 1000) }, null, 2));
  writeFileSync(`${outDir}/server-${label}.log`, allLog.split('\n').filter(l => /siderarium|error|Error/.test(l)).join('\n'));
  console.log(JSON.stringify({ passed, failed, seconds: Math.round((Date.now() - T0) / 1000) }));
  process.exit(failed ? 1 : 0);
}

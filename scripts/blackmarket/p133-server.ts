// P13.3 §7-D on a real server process: `node dist-server/server.mjs` with BLACKMARKET_P133=1 and three real
// WebSocket accounts on the real seed map (default securities):
//   A — raider: plunders B twice (P13.2 engine), the loot becomes B's stolen goods, A's hauler unloads it at the
//       nearest station (which finds that station's black market), A sells part from storage (S1) and runs a
//       physical smuggling operation with the rest of the second haul from the border market to the lawless one (S2).
//   B — victim: two haulers, never near a black market; must not see any black market or A's trade log.
//   C — smuggler: finds the lawless and the secure markets by docking, buys restricted goods at the lawless market
//       into its hold and runs them to the secure market through gate and dock inspections (S3).
// Starting assets are placed once with the server stopped; after that every step is a real command of one account
// or the server's own simulation. The server is restarted at the end; every unit of the scenario goods is accounted
// for from the save and the server's own analytics. Needs `npm run build` first.
//   npx vite-node scripts/blackmarket/p133-server.ts [attempt-label]
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import WebSocket from 'ws';
import { WorldSim } from '../../src/world/sim';
import type { V } from '../../src/world/types';

const SEED = process.env.SEED ?? '133';
const label = process.argv[2] ?? 'run';
const dir = mkdtempSync(path.join(tmpdir(), 'siderarium-p133-'));
const save = path.join(dir, 'world.json'), analytics = path.join(dir, 'world.analytics.json');
const binary = path.resolve('dist-server/server.mjs'), staticDir = path.resolve('dist');
const probe = net.createServer();
await new Promise<void>(r => probe.listen(0, '127.0.0.1', () => r()));
const port = (probe.address() as net.AddressInfo).port; await new Promise(r => probe.close(r));
const base = `http://127.0.0.1:${port}`, sockets: WebSocket[] = [];
const checks: { ok: boolean; label: string; extra?: unknown; t: number }[] = [], infos: { label: string; extra?: unknown }[] = [], facts: Record<string, any> = { seed: SEED, label, clock: 'server real time, speed 1 (multiplayer)', load: '3 accounts, ~12 scenario ships, no NPC fleets' };
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
    const r = await fetch(base + '/api/auth/signup', { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ loginId, password: 'p133-test-password-123', confirm: 'p133-test-password-123' }) });
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
  nextRequest() { this.trade++; return { seq: this.trade, id: `p133-${this.name.charAt(0)}-${String(this.trade).padStart(6, '0')}` }; }
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

const A = new Pilot('A 약탈 PMC'), B = new Pilot('B 운송 PMC'), C = new Pilot('C 밀수 PMC');
const START = { alloy: 200 + 150, electronics: 60 + 300, mod_ecm: 0 };
try {
  await start();
  await A.signup('p133_a'); await B.signup('p133_b'); await C.signup('p133_c');
  await A.connect(); await B.connect(); await C.connect();
  const s0 = A.snap();
  check(s0.blackMarketV === 1 && s0.piracyV === 1 && s0.salvageV === 1 && Object.keys(s0.blackMarkets ?? {}).length === 0, '0: BLACKMARKET_P133=1 server creates a P13.3 world (P13.2 + black markets); no account sees an undiscovered market', { known: Object.keys(s0.blackMarkets ?? {}) });
  await stop();
  // ---- starting assets, placed once with the server stopped (real map, default securities)
  const file = JSON.parse(readFileSync(save, 'utf8'));
  const sim = new WorldSim(file.world, { migrateContent: false });
  const st = sim.st;
  for (const id of Object.keys(st.ships)) delete st.ships[id];
  for (const id of Object.keys(st.groups)) delete st.groups[id];
  for (const l of Object.values(st.lairs)) { l.alive = false; l.respawnAt = 1e10; l.nextBand = 1e10; }
  for (const co of [A.id, B.id, C.id]) st.companies[co].credits = 1e6;
  const bms = st.blackMarkets!;
  const lawless = bms.bm_lawless, border = bms.bm_border, secure = bms.bm_secure;
  const L = st.stations[lawless.station], Bd = st.stations[border.station], S = st.stations[secure.station];
  facts.markets = Object.values(bms).map(b => ({ id: b.id, station: b.station, tier: b.tier, funds: Math.round(b.funds) }));
  const fleet = (o: string, name: string, pos: V, comp: string[], cmdr = true) => {
    const g = sim.newGroup(o, name); if (cmdr) g.commanderId = sim.newCommander(o, 2).id;
    comp.forEach((cl, i) => { const s = sim.spawnShip(o, cl, 'std', g.id, { x: pos.x + i * 40, y: 0, z: pos.z }); s.logisticsExcluded = true; }); return g;
  };
  // S1: lawless region — B's hauler passes near the lawless market's station, A waits with a hauler in its group
  const v1 = fleet(B.id, 'B 화물선 1', P(L.pos, 9000, -9000), ['hauler']); Object.assign(st.ships[v1.shipIds[0]].cargo, { alloy: 200, electronics: 60 });
  const a1 = fleet(A.id, 'A 약탈대 1', P(L.pos, 9000, -5500), ['destroyer', 'frigate', 'hauler']);
  // S2: border region — the same near the border market's station
  const v2 = fleet(B.id, 'B 화물선 2', P(Bd.pos, 9000, -9000), ['hauler']); st.ships[v2.shipIds[0]].cargo.alloy = 150;
  const a2 = fleet(A.id, 'A 약탈대 2', P(Bd.pos, 9000, -5500), ['destroyer', 'frigate', 'hauler']);
  // S3: C's hauler near the lawless station, C's scout near the secure market's station (they dock there by real orders)
  const c1 = fleet(C.id, 'C 밀수선', P(L.pos, -3000, 2500), ['hauler']);
  const c2 = fleet(C.id, 'C 정찰선', P(S.pos, -3000, 2500), ['hauler']);
  // S5: high-security space (Astra, security 80, B's home system) — A plunders a valuable cargo; its haulers must unload
  //     at an Astra station, where the dock inspection decides: seized (returned to B) or passed (stored as stolen)
  const AS = st.stations.astra;
  const v5 = fleet(B.id, 'B 화물선 5', P(AS.pos, 9000, -9000), ['hauler']); st.ships[v5.shipIds[0]].cargo.electronics = 300;
  const a5 = fleet(A.id, 'A 약탈대 5', P(AS.pos, 9000, -5500), ['destroyer', 'frigate', 'hauler', 'hauler']);
  // S4: A's scout near the secure market's station (A finds it by a real docking order)
  const a4 = fleet(A.id, 'A 정찰선', P(S.pos, 3000, -2500), ['hauler']);
  file.world = JSON.parse(sim.serialize()); writeFileSync(save, JSON.stringify(file));
  const ids = { L: L.id, Bd: Bd.id, S: S.id, v1: v1.id, v1s: v1.shipIds[0], a1: a1.id, a1h: a1.shipIds[2], v2: v2.id, v2s: v2.shipIds[0], a2: a2.id, a2h: a2.shipIds[2], c1: c1.id, c1s: c1.shipIds[0], c2: c2.id, a4: a4.id, v5: v5.id, v5s: v5.shipIds[0], a5: a5.id, a5h: [a5.shipIds[2], a5.shipIds[3]].join(',') };
  facts.ids = ids; facts.stations = { lawless: L.name, border: Bd.name, secure: S.name };
  await start(); await A.connect(); await B.connect(); await C.connect();
  const time = () => A.snap().time as number;
  const view = (p: Pilot) => p.snap();
  const hotA = (k: string) => `hot:${k}:${B.id}`;

  // ---- S1 / S2: two real plunders of B (P13.2 engine), started together
  check(await A.command({ c: 'stance', target: B.id, v: -1 }) === null, 'S1: A declares B hostile');
  for (const [g, v] of [[ids.v1, 1], [ids.v2, 2]] as const) {
    check(await B.command({ c: 'piracyPolicy', group: g, policy: 'survive' }) === null, `S${v}: B sets hauler ${v} to 생존 우선`);
    const to = view(B).ships[v === 1 ? ids.v1s : ids.v2s].pos;
    check(await B.command({ c: 'setOp', group: g, op: { k: 'move', to: { x: to.x - 6000, y: 0, z: to.z } } }) === null, `S${v}: B's hauler ${v} is under way`);
  }
  check(await B.command({ c: 'piracyPolicy', group: ids.v5, policy: 'survive' }) === null && await B.command({ c: 'setOp', group: ids.v5, op: { k: 'move', to: (p => ({ x: p.x - 6000, y: 0, z: p.z }))(view(B).ships[ids.v5s].pos) } }) === null, 'S5: B\'s valuable hauler is under way in high-security Astra');
  const bHome5 = (await B.fresh()).stations[view(B).companies[B.id].homeStation]?.storage?.[B.id]?.electronics ?? 0;
  check(await A.command({ c: 'setOp', group: ids.a5, op: { k: 'plunder', group: ids.v5, policy: 'nonlethal' } }) === null, 'S5: A orders a plunder of B 화물선 5 in high-security space');
  check(await A.command({ c: 'setOp', group: ids.a1, op: { k: 'plunder', group: ids.v1, policy: 'nonlethal' } }) === null, 'S1: A orders a non-destructive plunder of B 화물선 1 (lawless region)');
  check(await A.command({ c: 'setOp', group: ids.a2, op: { k: 'plunder', group: ids.v2, policy: 'nonlethal' } }) === null, 'S2: A orders a non-destructive plunder of B 화물선 2 (border region)');
  // C: contacts — dock at the lawless station and at the secure market's station (real orders, real travel)
  check(await C.command({ c: 'setOp', group: ids.c1, op: { k: 'dock', station: ids.L } }) === null, 'S3: C sends its hauler to the lawless station');
  check(await C.command({ c: 'setOp', group: ids.c2, op: { k: 'dock', station: ids.S } }) === null, 'S3: C sends its scout to the secure station');
  check(await A.command({ c: 'setOp', group: ids.a4, op: { k: 'dock', station: ids.S } }) === null, 'S4: A sends its scout to the secure station');

  // ---- S1: loot unloaded at the lawless station → A finds its black market → sells from storage
  const s1 = await until(() => { const v = view(A); const n = v.stations[ids.L]?.storage?.[A.id]; const g = v.groups[ids.a1]; return n && (n[hotA('alloy')] ?? 0) + (n[hotA('electronics')] ?? 0) > 0 && g?.op?.k === 'idle' ? { store: { alloy: n[hotA('alloy')] ?? 0, electronics: n[hotA('electronics')] ?? 0 }, plain: { alloy: n.alloy ?? 0, electronics: n.electronics ?? 0 } } : null; }, 'S1: the plundered goods never reached the lawless station', 600000);
  facts.s1 = { unloaded: s1, at: Math.round(time()) };
  check(s1.plain.alloy === 0 && s1.plain.electronics === 0, 'S1-1: A\'s loot arrived in its storage as B\'s stolen goods (hot:<item>:<B>), never as plain goods', s1);
  const vB1 = view(B).ships[ids.v1s];
  facts.s1.victimLeft = vB1?.cargo;
  check(vB1 && (vB1.cargo.alloy ?? 0) + s1.store.alloy <= 200 + 1e-9 && (vB1.cargo.electronics ?? 0) + s1.store.electronics <= 60 + 1e-9, 'S1-2: what A holds as stolen + what B still carries never exceeds what B had', facts.s1);
  const vA = view(A);
  check((vA.companies[A.id].bm?.known ?? []).includes(lawless.id) && vA.blackMarkets?.[lawless.id], 'S1-3: A\'s hauler docking at the lawless station found its black market (now replicated to A only)', { known: vA.companies[A.id].bm?.known });
  // a normal market refuses stolen goods; selling them at the black market pays exactly what the market books
  // the plunder takes the most valuable goods first — sell part of whichever stolen item A got most of
  const it1 = s1.store.electronics >= s1.store.alloy ? 'electronics' : 'alloy';
  const n1 = Math.max(1, Math.min(30, Math.floor(s1.store[it1] / 2)));
  facts.s1.sells = { item: it1, n: n1 };
  const nr = await A.command({ c: 'sell', station: ids.L, res: hotA(it1), amount: n1, request: A.nextRequest() });
  check(nr !== null, 'S1-4: the normal market refuses B\'s stolen goods', { err: nr });
  if (nr !== null) A.trade--;   // a refused trade does not use up its request number
  const before = await A.fresh(), b0 = before.blackMarkets[lawless.id], cr0 = before.companies[A.id].credits, st0 = before.stations[ids.L].storage[A.id][hotA(it1)];
  const r1 = A.nextRequest();
  const e1 = await A.command({ c: 'bmSell', station: ids.L, res: hotA(it1), amount: n1, request: r1 });
  check(e1 === null, 'S1-5: A sells part of the stolen goods at the lawless black market (bmSell from storage)', { err: e1, amount: n1 });
  const after = await A.fresh(), b1 = after.blackMarkets[lawless.id], cr1 = after.companies[A.id].credits, st1 = after.stations[ids.L].storage[A.id][hotA(it1)] ?? 0;
  const lg = (after.companies[A.id].bm?.log ?? []).filter((x: any) => x.k === 'sell').at(-1);
  const sale = { sold: b1.took - b0.took, paidByMarket: +(b1.paid - b0.paid).toFixed(6), fundsDrop: +(b0.funds - b1.funds).toFixed(6), storage: +(st0 - st1).toFixed(6), credits: +(cr1 - cr0).toFixed(6), log: lg && { items: lg.items, value: +lg.value.toFixed(6), fee: +lg.fine.toFixed(6) } };
  facts.s1.sale = sale;
  check(sale.sold === n1 && Math.abs(sale.storage - n1) < 1e-9 && Math.abs(sale.paidByMarket - lg.value) < 1e-6 && lg.items[hotA(it1)] === n1, 'S1-6: exactly the sold units left A\'s storage; the market booked the sale it paid (took/paid = log)', sale);
  // other scenarios run at the same time: a fine charged to A between the two snapshots is taken out first
  const finesBetween = (after.companies[A.id].bm?.log ?? []).filter((x: any) => x.k === 'seize' && x.t > before.time && x.t <= after.time).reduce((a: number, x: any) => a + (x.fine ?? 0), 0);
  (sale as any).otherFinesBetween = finesBetween;
  check(Math.abs(sale.credits + finesBetween - sale.paidByMarket) < 1e-6 || (sale.credits + finesBetween < sale.paidByMarket && sale.credits + finesBetween > sale.paidByMarket - 200), 'S1-7: A\'s credits rose by what the market paid (no more; at most a running-cost tick less; fines from other scenarios in the same moment taken out)', sale);
  check(sale.fundsDrop <= sale.paidByMarket + 1e-6, 'S1-8: the market\'s budget fell by what it paid (regeneration may add back)', sale);
  // duplicate request (same id): nothing changes
  const dup = await A.command({ c: 'bmSell', station: ids.L, res: hotA(it1), amount: n1, request: r1 });
  const after2 = await A.fresh();
  check(dup === null && after2.blackMarkets[lawless.id].took === b1.took && (after2.stations[ids.L].storage[A.id][hotA(it1)] ?? 0) === st1, 'S1-9: re-sending the same sale request is acknowledged without selling again', { dup, took: after2.blackMarkets[lawless.id].took });
  // C cannot sell anything stolen of A's — nor at a market C does not know
  check(await C.command({ c: 'bmSell', station: ids.Bd, res: hotA('alloy'), amount: 1 }) !== null, 'S1-10: C cannot trade at a black market it never found');

  // ---- S5 (P13.3.1 rules): automatic unloading of stolen goods never picks a risky station. In high-security Astra
  //      every reachable public station inspects at the dock, so the plunder's unloading is blocked: the goods stay
  //      aboard and nothing docks (S5-1/2/3). Then the player explicitly docks there (S5-4..7): that is inspected —
  //      seized goods wait at that station's customs for B (never moved to B's home), or the inspection passes.
  const custB = (v: any, item = 'electronics') => ((v.companies[B.id].bm?.customs ?? []) as any[]).filter(l => l.item === item).reduce((a, l) => a + l.n, 0);
  const s5 = await until(() => { const v = view(A), g = v.groups[ids.a5]; return g?.op?.k === 'idle' && !g.plx ? v : null; }, 'S5: the plunder did not finish', 600000);
  await delay(1500);
  const astraIds = ['astra', 'bastion', 'nova', 'barcaco'];
  const hauls5 = ids.a5h.split(',');
  const v5A = await A.fresh(), v5B = await B.fresh();
  const all5 = (v5A.groups[ids.a5]?.shipIds ?? hauls5) as string[];
  const aboard5a = all5.reduce((a, id) => a + (v5A.ships[id]?.cargo?.[hotA('electronics')] ?? 0), 0);
  const insp5a = (v5A.companies[A.id].bm?.log ?? []).filter((x: any) => (x.k === 'seize' || x.k === 'pass') && astraIds.includes(x.at));
  const stored5a = astraIds.reduce((a, id) => a + (v5A.stations[id]?.storage?.[A.id]?.[hotA('electronics')] ?? 0), 0);
  const left5 = v5B.ships[ids.v5s]?.cargo?.electronics ?? 0;
  const cust5a = custB(v5B);
  facts.s5 = { auto: { aboard: aboard5a, docked: hauls5.map(id => v5A.ships[id]?.state), inspections: insp5a.length, storedInAstra: stored5a, victimLeft: left5, customsB: cust5a, status: v5A.groups[ids.a5]?.status } };
  check(aboard5a > 0 && hauls5.every(id => v5A.ships[id]?.state !== 'docked'), 'S5-1: the plunder\'s automatic unloading in high-security space was blocked (P13.3.1 safe unloading): the stolen electronics stay aboard and no hauler docked', facts.s5.auto);
  check(insp5a.length === 0 && stored5a === 0, 'S5-2: blocked automatic unloading means no dock inspection and nothing stored as stolen at a risky station', facts.s5.auto);
  check(Math.abs(aboard5a + left5 + cust5a - 300) < 1e-9, 'S5-3: B\'s 300 electronics = still on B\'s hauler + aboard A\'s raid group (haulers and warships) — exactly', facts.s5.auto);
  // the player explicitly docks the loaded haulers at Astra: an explicit order is not filtered — it is inspected
  const t5 = time();
  check(await A.command({ c: 'setOp', group: ids.a5, op: { k: 'dock', station: 'astra' } }) === null, 'S5-4: A explicitly orders the loaded raiders to dock at Astra (a risky station)');
  await until(() => { const v = view(A); return hauls5.every(id => v.ships[id]?.state === 'docked') ? v : null; }, 'S5: the explicit dock did not complete', 600000);
  await delay(1500);
  const v5Ae = await A.fresh(), v5Be = await B.fresh();
  const lg5 = (v5Ae.companies[A.id].bm?.log ?? []).filter((x: any) => x.t >= t5 && (x.k === 'seize' || x.k === 'pass') && Object.keys(x.items ?? {}).includes(hotA('electronics')));
  const seized5 = lg5.filter((x: any) => x.k === 'seize').reduce((a: number, x: any) => a + (x.items[hotA('electronics')] ?? 0), 0);
  const aboard5 = all5.reduce((a, id) => a + (v5Ae.ships[id]?.cargo?.[hotA('electronics')] ?? 0), 0);
  const stolenAstra = astraIds.reduce((a, id) => a + (v5Ae.stations[id]?.storage?.[A.id]?.[hotA('electronics')] ?? 0), 0);
  const cust5 = custB(v5Be) - cust5a;
  const lots5 = ((v5Be.companies[B.id].bm?.customs ?? []) as any[]).filter(l => l.item === 'electronics' && l.t >= t5);
  const held5 = (v5Be.companies[B.id].bm?.log ?? []).filter((x: any) => x.k === 'held' && x.t >= t5);
  const homeB5 = v5Be.companies[B.id].homeStation;
  const back5 = (v5Be.stations[homeB5]?.storage?.[B.id]?.electronics ?? 0) - bHome5;
  const left5e = v5Be.ships[ids.v5s]?.cargo?.electronics ?? 0;
  facts.s5.explicit = { inspections: lg5.map((x: any) => ({ k: x.k, at: x.at, items: x.items, fine: x.fine && Math.round(x.fine), why: x.why })), seized: seized5, customsB: cust5, lots: lots5.map(l => ({ station: l.station, n: l.n })), heldLog: held5.length, toBHome: back5, aboard: aboard5, stolenStoredInAstra: stolenAstra, victimLeft: left5e };
  check(lg5.length > 0, 'S5-5: the explicit dock at Astra was inspected (dock event)', facts.s5.explicit);
  check(Math.abs(cust5 - seized5) < 1e-9 && back5 === 0 && (seized5 === 0 || (held5.length > 0 && lots5.every(l => l.station === 'astra'))), 'S5-6: every seized unit waits at the Astra customs office for B (B sees \'held\' in its log); nothing moved to B\'s home storage', facts.s5.explicit);
  check(Math.abs(seized5 + stolenAstra + aboard5 + left5e - 300) < 1e-9, 'S5-7: B\'s 300 electronics = on B\'s hauler + at customs for B + stolen in A\'s storage + aboard — exactly', facts.s5.explicit);
  if (seized5 > 0) check(lg5.some((x: any) => x.k === 'seize' && x.fine > 0), 'S5-8 (inspection outcome: seized): A was fined', facts.s5.explicit.inspections);
  else info('S5: the explicit dock inspection passed in this run (deterministic roll per ship, station and 30-minute window) — the customs path was not exercised by S5', facts.s5.explicit.inspections);
  void s5;

  // ---- S4: the rest of the stolen electronics on a run to the secure market (high-security gates and dock):
  //      whatever the inspections decide, every unit must end up sold, still aboard, or back with B
  await until(() => (view(A).companies[A.id].bm?.known ?? []).includes(secure.id), 'S4: A did not find the secure market', 600000);
  const s4pre = await A.fresh(), bpre = await B.fresh();
  const homeB = bpre.companies[B.id].homeStation;
  const eLeft = s4pre.stations[ids.L].storage[A.id]?.[hotA('electronics')] ?? 0;
  const bHome0 = bpre.stations[homeB]?.storage?.[B.id]?.electronics ?? 0, bCust0 = custB(bpre), aCr0 = s4pre.companies[A.id].credits, sec0 = s4pre.blackMarkets[secure.id];
  facts.s4 = { carried: eLeft, homeB };
  check(eLeft > 0 && await A.command({ c: 'setOp', group: ids.a1, op: { k: 'smuggle', from: ids.L, to: ids.S, items: [hotA('electronics')], sell: true } }) === null, 'S4-1: A orders the rest of the stolen electronics from the lawless station to the secure market (through high-security gates)', facts.s4);
  await until(() => { const g = view(A).groups[ids.a1]; return g?.op?.k === 'smuggle' ? null : g; }, 'S4: run did not finish', 900000);
  const s4 = await A.fresh(), b4 = await B.fresh();
  const lg4 = (s4.companies[A.id].bm?.log ?? []).filter((x: any) => x.t >= s4pre.time);
  const aboard4 = s4.ships[ids.a1h]?.cargo?.[hotA('electronics')] ?? 0, stored4 = s4.stations[ids.L].storage[A.id]?.[hotA('electronics')] ?? 0;
  const sold4 = lg4.filter((x: any) => x.k === 'sell').reduce((a: number, x: any) => a + (x.items[hotA('electronics')] ?? 0), 0);
  const seized4 = lg4.filter((x: any) => x.k === 'seize').reduce((a: number, x: any) => a + (x.items[hotA('electronics')] ?? 0), 0);
  const back4 = (b4.stations[homeB]?.storage?.[B.id]?.electronics ?? 0) - bHome0;
  const retLog = (b4.companies[B.id].bm?.log ?? []).filter((x: any) => x.k === 'held' && x.t >= s4pre.time);
  const cust4 = custB(b4) - bCust0;
  Object.assign(facts.s4, { log: lg4.map((x: any) => ({ k: x.k, at: x.at, items: x.items, value: x.value && Math.round(x.value), fine: x.fine && Math.round(x.fine), why: x.why })), sold: sold4, seized: seized4, aboard: aboard4, stored: stored4, toBHome: back4, customsB: cust4, bHeldLog: retLog, aCredits: Math.round(s4.companies[A.id].credits - aCr0), marketTook: s4.blackMarkets[secure.id].took - sec0.took });
  check(Math.abs(sold4 + seized4 + aboard4 + stored4 - eLeft) < 1e-9, 'S4-2: every carried stolen unit is sold, seized, still aboard or still stored — exactly', facts.s4);
  if (seized4 > 0) {
    const fine = lg4.find((x: any) => x.k === 'seize').fine;
    check(Math.abs(cust4 - seized4) < 1e-9 && back4 === 0 && retLog.length > 0 && fine > 0, 'S4-3 (inspection outcome: seized): the seized stolen electronics wait at customs for B (B sees \'held\' in its own log; nothing moved to B\'s home storage); A was fined', facts.s4);
  } else check(sold4 > 0 && s4.blackMarkets[secure.id].took - sec0.took >= sold4, 'S4-3 (inspection outcome: passed): the stolen electronics were sold at the secure market', facts.s4);

  // ---- S2 (P13.3.1 rules): the second plunder happens next to the border station, but that station inspects at the
  //      dock (small chance), so the plunder's automatic unloading avoids it and takes the loot to a zero-risk station
  //      (the lawless one). From there A runs a physical smuggling trip to the border market and sells there.
  const s2 = await until(() => { const v = view(A), g = v.groups[ids.a2]; if (g?.op?.k !== 'idle' || g.plx) return null; const ab = (g.shipIds as string[]).reduce((a, id) => a + (v.ships[id]?.cargo?.[hotA('alloy')] ?? 0), 0); const vic = view(B).ships[ids.v2s]?.cargo?.alloy; /* B's own view: A may no longer see B's hauler (fog) */ if (ab > 0 || vic === undefined || vic >= 150) return null; const n = v.stations[ids.L]?.storage?.[A.id]; return n && (n[hotA('alloy')] ?? 0) > 0 ? { stolen: n[hotA('alloy')], plain: n.alloy ?? 0, atBorder: v.stations[ids.Bd]?.storage?.[A.id]?.[hotA('alloy')] ?? 0, victimLeft: vic } : null; }, 'S2: the second plunder never unloaded at a safe station', 600000);
  facts.s2 = { unloaded: s2 };
  check(s2.atBorder === 0 && s2.plain === 0, 'S2-0: the plunder\'s automatic unloading avoided the border station (dock inspection risk > 0) and stored the loot as stolen goods at the zero-risk lawless station', facts.s2);
  // A finds the border market by docking there with an empty hold (nothing to inspect), as a player would
  check(await A.command({ c: 'setOp', group: ids.a2, op: { k: 'dock', station: ids.Bd } }) === null, 'S2-1: A docks the (now empty) raiders at the border station');
  await until(() => (view(A).companies[A.id].bm?.known ?? []).includes(border.id) && view(A).blackMarkets?.[border.id] ? true : null, 'S2: A never found the border market', 600000);
  check((view(A).stations[ids.Bd]?.storage?.[A.id]?.[hotA('alloy')] ?? 0) === 0, 'S2-1b: docking there found the border market; nothing stolen was carried there', facts.s2);
  const pre = await A.fresh();
  const preB = pre.blackMarkets[border.id], preCr = pre.companies[A.id].credits;
  check(await A.command({ c: 'setOp', group: ids.a2, op: { k: 'smuggle', from: ids.L, to: ids.Bd, items: [hotA('alloy')], sell: true } }) === null, 'S2-2: A orders a smuggling run: load the stolen alloy at the lawless station, fly to the border market, sell');
  const loaded = await until(() => { const s = view(A).ships[ids.a2h]; return s && (s.cargo[hotA('alloy')] ?? 0) > 0 && s.state !== 'docked' ? s.cargo[hotA('alloy')] : 0; }, 'S2: the hauler never left loaded', 300000);
  facts.s2.loaded = loaded;
  const left = view(A).stations[ids.L].storage[A.id]?.[hotA('alloy')] ?? 0;
  check(Math.abs(loaded + left - s2.stolen) < 1e-9, 'S2-3: the stolen alloy physically left storage into the hauler\'s hold (hold + what stayed = what was stored)', { loaded, left, stored: s2.stolen });
  const end2 = await until(() => { const g = view(A).groups[ids.a2]; return g?.op?.k === 'idle' ? g : null; }, 'S2: the smuggling run did not finish', 900000);
  const post = await A.fresh();
  const postB = post.blackMarkets[border.id];
  const lg2 = (post.companies[A.id].bm?.log ?? []).filter((x: any) => x.t >= pre.time);
  facts.s2.run = { status: end2.status, gameSeconds: Math.round(post.time - pre.time), log: lg2.map((x: any) => ({ k: x.k, at: x.at, items: x.items, value: x.value && Math.round(x.value), fine: x.fine && Math.round(x.fine), why: x.why })), aboard: post.ships[ids.a2h]?.cargo, took: postB.took - preB.took, paid: Math.round(postB.paid - preB.paid), credits: Math.round(post.companies[A.id].credits - preCr) };
  const seized2 = lg2.some((x: any) => x.k === 'seize');
  if (seized2) {
    check(lg2.filter((x: any) => x.k === 'sell').length === 0 && (post.ships[ids.a2h]?.cargo[hotA('alloy')] ?? 0) === 0, 'S2-4 (inspection outcome: seized): the run was stopped by an inspection; nothing was sold, the hold has no stolen alloy left', facts.s2.run);
  } else {
    const soldUnits = lg2.filter((x: any) => x.k === 'sell').reduce((a: number, x: any) => a + (x.items[hotA('alloy')] ?? 0), 0);
    const aboard = post.ships[ids.a2h]?.cargo[hotA('alloy')] ?? 0;
    check(soldUnits > 0 && postB.took - preB.took === soldUnits && Math.abs(soldUnits + aboard - loaded) < 1e-9, 'S2-4: the smuggled stolen alloy was carried to the border market and sold there from the hold; sold + still aboard = loaded, exactly', { soldUnits, aboard, loaded });
    const paid = postB.paid - preB.paid, dc = post.companies[A.id].credits - preCr;
    check(dc <= paid + 1e-6 && dc > paid - 2000, 'S2-5: A\'s credits rose by what the market paid during the run (no more; running costs may take some)', facts.s2.run);
  }
  check(lg2.filter((x: any) => x.k === 'pass' || x.k === 'seize').length === 0 || facts.s2.run.log.length > 0, 'S2-6: every inspection on the way is in A\'s own black-market log', facts.s2.run.log);

  // ---- S3: C buys restricted goods at the lawless market into its hold and runs them to the secure market
  await until(() => (view(C).companies[C.id].bm?.known ?? []).includes(lawless.id) && (view(C).companies[C.id].bm?.known ?? []).includes(secure.id), 'S3: C did not find both markets', 600000);
  check(true, 'S3-1: C\'s ships docked at the lawless and the secure stations and found both markets');
  await until(() => view(C).ships[ids.c1s]?.state === 'docked', 'C hauler not docked', 60000);
  const cv0 = await C.fresh(); const stock0 = cv0.blackMarkets[lawless.id].stock.mod_ecm.n, cc0 = cv0.companies[C.id].credits;
  const buyN = 8;
  const eb = await C.command({ c: 'bmBuy', station: ids.L, res: 'mod_ecm', amount: buyN, ship: ids.c1s, request: C.nextRequest() });
  const cv1 = await C.fresh();
  const buy = { err: eb, stock: +(stock0 - cv1.blackMarkets[lawless.id].stock.mod_ecm.n).toFixed(6), credits: Math.round(cc0 - cv1.companies[C.id].credits), hold: cv1.ships[ids.c1s].cargo.mod_ecm ?? 0 };
  facts.s3 = { buy };
  check(eb === null && Math.abs(buy.stock - buyN) < 0.01 && buy.hold === buyN && buy.credits > 0, 'S3-2: C bought restricted ECM modules from the lawless market\'s real stock into its hold, paying credits (stock fell by the amount, less a restock tick)', buy);
  const c3pre = await C.fresh(); const secPre = c3pre.blackMarkets[secure.id], ccPre = c3pre.companies[C.id].credits;
  check(await C.command({ c: 'setOp', group: ids.c1, op: { k: 'smuggle', to: ids.S, sell: true } }) === null, 'S3-3: C orders the hauler to run them to the secure market (gate and dock inspections on the way)');
  await until(() => { const g = view(C).groups[ids.c1]; return g?.op?.k === 'smuggle' ? null : g; }, 'S3: run did not finish', 900000).catch(() => null);
  const c3 = await C.fresh(); const secPost = c3.blackMarkets[secure.id];
  const lg3 = (c3.companies[C.id].bm?.log ?? []).filter((x: any) => x.t >= c3pre.time);
  facts.s3.run = { status: c3.groups[ids.c1]?.status, gameSeconds: Math.round(c3.time - c3pre.time), log: lg3.map((x: any) => ({ k: x.k, at: x.at, items: x.items, value: x.value && Math.round(x.value), fine: x.fine && Math.round(x.fine), why: x.why })), aboard: c3.ships[ids.c1s]?.cargo, credits: Math.round(c3.companies[C.id].credits - ccPre), marketPaid: Math.round(secPost.paid - secPre.paid) };
  if (lg3.some((x: any) => x.k === 'seize')) {
    const sz = lg3.find((x: any) => x.k === 'seize');
    check((c3.ships[ids.c1s]?.cargo.mod_ecm ?? 0) === 0 && sz.items?.mod_ecm === buyN && sz.fine > 0, 'S3-4 (inspection outcome: seized): every restricted module was confiscated and a fine charged; nothing sold', facts.s3.run);
  } else {
    const soldN = lg3.filter((x: any) => x.k === 'sell').reduce((a: number, x: any) => a + (x.items.mod_ecm ?? 0), 0);
    check(soldN + (c3.ships[ids.c1s]?.cargo.mod_ecm ?? 0) === buyN && secPost.took - secPre.took === soldN, 'S3-4 (inspection outcome: passed): the modules reached the secure market; sold + still aboard = bought, exactly', facts.s3.run);
  }

  // ---- D: privacy — B (victim) never found a market; nobody sees another company's log or inspection records
  const vb = view(B), vc = view(C);
  const leak = (v: any, me: string) => ({ markets: Object.keys(v.blackMarkets ?? {}), otherBm: Object.entries<any>(v.companies).filter(([id, c]) => id !== me && c.bm).map(([id]) => id), insp: Object.values<any>(v.ships).filter(s => s.owner !== me && s.insp).map(s => s.id), smug: Object.values<any>(v.groups ?? {}).filter(g => g.owner !== me && g.smug).map(g => g.id) });
  const lb = leak(vb, B.id), lc = leak(vc, C.id), la = leak(view(A), A.id);
  facts.privacy = { B: lb, C: lc, A: la };
  const bKnown: string[] = vb.companies[B.id].bm?.known ?? [];
  facts.privacy.Bfound = (vb.companies[B.id].bm?.log ?? []).filter((x: any) => x.k === 'found').map((x: any) => ({ at: x.at, why: x.why }));
  check(lb.markets.every(id => bKnown.includes(id)) && lb.markets.length === bKnown.length && lb.otherBm.length === 0 && lb.insp.length === 0 && lb.smug.length === 0, 'D-1: B (victim) sees only the markets its own ships found (its fleeing haulers docked at the nearest stations), nobody\'s trade/inspection log, no inspection records, no smuggling state', { ...lb, known: bKnown, found: facts.privacy.Bfound });
  check(lc.markets.every(id => [lawless.id, secure.id].includes(id)) && !lc.markets.includes(border.id) && lc.otherBm.length === 0 && lc.insp.length === 0 && lc.smug.length === 0, 'D-2: C sees only the two markets it found (not the border one A found) and nothing private of A or B', lc);
  const aKnown: string[] = view(A).companies[A.id].bm?.known ?? [];
  check(la.otherBm.length === 0 && la.insp.length === 0 && la.smug.length === 0 && la.markets.length === aKnown.length && la.markets.every(id => aKnown.includes(id)), 'D-3: A sees exactly the markets it found, nothing private of C', { ...la, known: aKnown });
  const rawB = B.raw[0] ?? '';
  const rawMk = Object.keys(JSON.parse(rawB).state?.blackMarkets ?? {});
  check(rawMk.every(id => bKnown.includes(id)) && !Object.values(bms).some(b => !bKnown.includes(b.id) && rawB.includes(`"id":"${b.id}"`)) && !rawB.includes('"insp"') && !rawB.includes('"smug"'), 'D-4: the raw snapshot bytes sent to B carry no market B did not find, no inspection record, no smuggling state', { bytes: rawB.length, markets: rawMk });

  // ---- restart: black markets, known lists, stolen keys and logs come back from the save
  await delay(1500); await stop();
  const w1 = readWorld();
  await start(); await A.connect(); await B.connect(); await C.connect(); await delay(1500);
  const vA2 = A.snap(), vC2 = C.snap();
  await stop();
  const w2 = readWorld();
  const pick = (w: any) => ({ known: Object.fromEntries([A.id, B.id, C.id].map(c => [c, w.companies[c].bm?.known ?? []])), logs: Object.fromEntries([A.id, C.id].map(c => [c, (w.companies[c].bm?.log ?? []).length])), markets: Object.fromEntries(Object.values<any>(w.blackMarkets).map(b => [b.id, { station: b.station, took: b.took, paid: Math.round(b.paid), sold: b.sold }])), hot: Object.fromEntries(Object.values<any>(w.stations).flatMap(s => Object.entries<any>(s.storage ?? {}).flatMap(([co, c]) => Object.entries<number>(c).filter(([k]) => k.startsWith('hot:')).map(([k, n]) => [`${s.id}/${co}/${k}`, +n.toFixed(6)])))) });
  const p1 = pick(w1), p2 = pick(w2);
  facts.restart = { before: p1, after: p2 };
  check(JSON.stringify(p1) === JSON.stringify(p2), 'R-1: after a restart the black markets (placement and books), every company\'s known list, logs and the stolen goods in storage are exactly as saved', facts.restart);
  check(Object.keys(vA2.blackMarkets ?? {}).sort().join() === [...p2.known[A.id]].sort().join() && Object.keys(vC2.blackMarkets ?? {}).sort().join() === [...p2.known[C.id]].sort().join(), 'R-2: after reconnecting, each account again receives exactly the markets it knows', { A: Object.keys(vA2.blackMarkets ?? {}), C: Object.keys(vC2.blackMarkets ?? {}) });

  // ---- accounting: every unit of the scenario goods, from the save + the server's own analytics
  const rows = flowRows();
  const co = [A.id, B.id, C.id];
  const held = (w: any, item: string) => {
    const of = (c: any) => Object.entries<number>(c ?? {}).reduce((a, [k, n]) => a + (k === item || hotOf(k)?.item === item ? n : 0), 0);
    let n = 0;
    for (const s of Object.values<any>(w.ships)) if (co.includes(s.owner)) n += of(s.cargo);
    for (const s of Object.values<any>(w.stations)) for (const c of co) n += of(s.storage?.[c]);
    for (const x of Object.values<any>(w.drops ?? {})) n += x.lots.filter((l: any) => l.item === item || hotOf(l.item)?.item === item).reduce((a: number, l: any) => a + l.n, 0);
    for (const x of Object.values<any>(w.wrecks ?? {})) n += x.lots.filter((l: any) => l.k === 'cargo' && (l.item === item || hotOf(l.item)?.item === item)).reduce((a: number, l: any) => a + l.n, 0);
    // P13.3.1: seized stolen goods waiting at customs for their owner
    for (const c of co) n += (w.companies[c]?.bm?.customs ?? []).filter((l: any) => l.item === item).reduce((a: number, l: any) => a + l.n, 0);
    return n;
  };
  const flow = (item: string, kind: string, reasons: string[]) => rows.filter(r => r.kind === kind && reasons.includes(r.reason) && co.includes(r.company) && (r.item === item || hotOf(r.item ?? '')?.item === item)).reduce((a, r) => a + r.amount, 0);
  const acct: Record<string, any> = {};
  for (const item of ['alloy', 'electronics', 'mod_ecm'] as const) {
    const h = held(w2, item), sold = flow(item, 'blackmarket', ['sell']), bought = flow(item, 'blackmarket', ['buy']), confiscated = flow(item, 'blackmarket', ['confiscate']), lost = flow(item, 'consume', ['combat_cargo_loss', 'drop_decay', 'wreck_decay']);
    acct[item] = { placed: START[item], boughtFromBlackMarket: bought, heldNow: +h.toFixed(6) /* incl. customs lots */, soldToBlackMarket: sold, confiscatedDestroyed: confiscated, lostOtherwise: lost };
    check(Math.abs(START[item] + bought - h - sold - confiscated - lost) < 1e-6, `ACC ${item}: placed + bought = held (ships, storage, containers, wrecks) + sold to black markets + confiscated + destroyed — exactly`, acct[item]);
  }
  facts.accounting = acct;
  const soldAll = rows.filter(r => r.kind === 'blackmarket' && r.reason === 'sell').reduce((a, r) => a + r.amount, 0);
  const tookAll = Object.values<any>(w2.blackMarkets).reduce((a, b) => a + b.took, 0);
  check(Math.abs(soldAll - tookAll) < 1e-6, 'ACC: the markets\' own books (took) equal the sale events in the server analytics', { soldAll, tookAll });
  const returned = rows.filter(r => r.kind === 'blackmarket' && r.reason === 'return');
  if (returned.length) info('seized stolen goods returned to their owner', returned);
  check(acct.alloy.soldToBlackMarket > 0, 'REQUIRED: real plunder goods were tracked as stolen, physically transported and sold at a black market (P13.3 Pass condition)', acct.alloy);
} catch (e) { check(false, 'run', { error: String((e as Error)?.stack ?? e).slice(0, 800) }); }
finally {
  await stop();
  const outDir = 'artifacts/p133';
  mkdirSync(outDir, { recursive: true });
  const passed = checks.filter(c => c.ok).length, failed = checks.filter(c => !c.ok).length;
  writeFileSync(`${outDir}/server-${label}.json`, JSON.stringify({ passed, failed, checks, infos, facts, realWebSockets: 3, restarts: 2, seconds: Math.round((Date.now() - T0) / 1000) }, null, 2));
  console.log(JSON.stringify({ passed, failed, seconds: Math.round((Date.now() - T0) / 1000) }));
  process.exit(failed ? 1 : 0);
}

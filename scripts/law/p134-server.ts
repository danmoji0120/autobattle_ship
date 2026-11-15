// P13.4 law enforcement on a real server process: `node dist-server/server.mjs` with LAW_P134=1 and three real
// WebSocket accounts on the real seed map (default securities, the world's own Union garrisons / patrols / response
// fleets). Every crime is a real plunder (P13.2 engine) of a real hauler; every enforcement step is the server's own
// simulation; every answer and payment is a real command of the suspect's account.
//   A — suspect: three raiding groups, each plunders one of B's haulers in a policed system.
//     L1 (Astra)  : extortion seen by the station → wanted → patrol flies out → stop demand → A is OFFLINE → the
//                   unanswered demand is compliance (not resistance) → inspection: stolen goods seized to customs,
//                   fine billed from credits.
//     L2 (Drake)  : extortion reported by the victim → dispatch → demand → A answers FLEE (command) and flies to
//                   Junction (no Union garrison) → flee case, real pursuit, pursuit ends (jurisdiction / lost / caught).
//                   A then pays its fines with the lawPay command (refused far from a policed station, accepted near one).
//     L3 (Helios) : extortion → dispatch → demand → A answers RESIST → a real P11 battle between the guards and that
//                   one group only: A's other group, C's armed fleet and B's victim hauler parked next to it stay out.
//   B — victim: three haulers (생존 우선), sees nothing of A's record.
//   C — bystander: an armed fleet parked next to the L3 stop; must never be pulled into the law battle.
// Starting assets are placed once with the server stopped; the server is restarted at the end and the whole law book
// must come back exactly. Guard ship positions are sampled from the server's own save (0.5 s) to prove they flew
// (no spawn, no teleport). Needs `npm run build` first.
//   npx vite-node scripts/law/p134-server.ts [attempt-label]
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
const dir = mkdtempSync(path.join(tmpdir(), 'siderarium-p134-'));
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
  if (child) { const p = child; child = undefined; await new Promise(r => { p.once('exit', r); p.kill('SIGTERM'); }); }
}
class Pilot {
  messages: any[] = []; seq = 1; ws!: WebSocket; cookie = ''; id = ''; online = false; raw = 0;
  constructor(readonly name: string) {}
  async signup(loginId: string) {
    const r = await fetch(base + '/api/auth/signup', { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ loginId, password: 'p134-test-password-123', confirm: 'p134-test-password-123' }) });
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

// ---- guard motion sampler: positions of the Union ships of every law operation, straight from the server's save
const motion = { samples: 0, worstRatio: 0, worst: null as any, jumps: 0, opsSeen: new Set<string>(), guardsSeen: new Set<string>(), unionShipsStart: 0, unionShipsMax: 0, unionShipIdsStart: new Set<string>(), newUnionShips: [] as { id: string; t: number; fromHome: number; group: string }[] };
let sampling = false;
async function sampler() {
  sampling = true;
  let last = new Map<string, { p: V; t: number; sys?: string }>();
  while (sampling) {
    await delay(700);
    if (!existsSync(save)) continue;
    let w: any; try { w = readWorld(); } catch { continue; }
    motion.samples++;
    const union = Object.values<any>(w.ships).filter(s => s.owner === 'union');
    motion.unionShipsMax = Math.max(motion.unionShipsMax, union.length);
    for (const s of union) if (motion.unionShipIdsStart.size && !motion.unionShipIdsStart.has(s.id) && !motion.newUnionShips.some(x => x.id === s.id)) { const g = w.groups[s.groupId], home = g?.npc && w.stations[g.npc.home]; motion.newUnionShips.push({ id: s.id, t: Math.round(w.time), group: s.groupId, fromHome: home ? Math.round(d3(s.pos, home.pos) - (home.radius ?? 0)) : -1 }); }
    const now = new Map<string, { p: V; t: number; sys?: string }>();
    for (const op of Object.values<any>(w.law?.ops ?? {})) {
      motion.opsSeen.add(op.id);
      for (const gid of op.guards) {
        const g = w.groups[gid]; if (!g) continue; motion.guardsSeen.add(gid);
        for (const id of g.shipIds) {
          const s = w.ships[id]; if (!s || s.state === 'battle' || s.state === 'docked') continue;
          now.set(id, { p: s.pos, t: w.time });
          const q = last.get(id);
          if (!q || w.time <= q.t) continue;
          const dt = w.time - q.t, d = d3(q.p, s.pos);
          if (s.jumpT !== undefined && s.jumpT > q.t) { motion.jumps++; continue; }   // a real gate jump (counted)
          // the in-system warp drive (~6-7 km/s) is the normal travel model; anything faster is a teleport
          const ratio = d / (7000 * dt + 50);
          if (ratio > motion.worstRatio) { motion.worstRatio = ratio; motion.worst = { ship: id, op: op.id, d: Math.round(d), dt: +dt.toFixed(2), warp: !!s.warp }; }
        }
      }
    }
    last = now;
  }
}

const A = new Pilot('A 수배 PMC'), B = new Pilot('B 운송 PMC'), C = new Pilot('C 제3 PMC');
try {
  await start();
  await A.signup('p134_a'); await B.signup('p134_b'); await C.signup('p134_c');
  await A.connect(); await B.connect(); await C.connect();
  const s0 = A.snap();
  check(s0.lawV === 1 && s0.blackMarketV === 1 && s0.piracyV === 1 && !('law' in s0 && s0.law), '0: LAW_P134=1 server creates a P13.4 world (P13.3 + law enforcement); the law book itself is never replicated', { lawV: s0.lawV, law: typeof s0.law });
  await stop();

  // ---- starting assets, placed once with the server stopped (real map, real Union forces)
  const file = JSON.parse(readFileSync(save, 'utf8'));
  const sim = new WorldSim(file.world, { migrateContent: false });
  const st = sim.st;
  for (const g of Object.values(st.groups)) if (g.owner !== 'union') { for (const id of g.shipIds) delete st.ships[id]; delete st.groups[g.id]; }
  for (const s of Object.values(st.ships)) if (s.owner !== 'union') delete st.ships[s.id];
  for (const l of Object.values(st.lairs)) { l.alive = false; l.respawnAt = 1e10; l.nextBand = 1e10; }
  for (const co of [A.id, B.id, C.id]) st.companies[co].credits = 1e6;
  const fleet = (o: string, name: string, pos: V, comp: string[]) => {
    const g = sim.newGroup(o, name); g.commanderId = sim.newCommander(o, 2).id;
    comp.forEach((cl, i) => { const s = sim.spawnShip(o, cl, 'std', g.id, { x: pos.x + i * 40, y: 0, z: pos.z }); s.logisticsExcluded = true; }); return g;
  };
  const AS = st.stations.astra, HE = st.stations.helios;
  const drake = st.systems.drake, gJ = drake.gates.find(g => g.to === 'junction')!;
  // L1: Astra, 6-7 km from the free port (inside the station's watch)
  const b1 = fleet(B.id, 'B 화물선 1', P(AS.pos, 5000, -5000), ['hauler']); st.ships[b1.shipIds[0]].cargo.ore = 300;
  const a1 = fleet(A.id, 'A 약탈대 1', P(AS.pos, 5000, -2000), ['destroyer', 'frigate', 'hauler']);
  // L2: Drake, close to the Junction gate (Junction has no Union garrison) — out of the station's sight, the victim reports
  const gp = gJ.pos, toward = (p: V, q: V, d: number): V => { const l = d3(p, q) || 1; return { x: p.x + (q.x - p.x) / l * d, y: 0, z: p.z + (q.z - p.z) / l * d }; };
  const l2 = toward(gp, drake.origin, 9000);
  const b2 = fleet(B.id, 'B 화물선 2', P(l2, 0, -1500), ['hauler']); st.ships[b2.shipIds[0]].cargo.ore = 300;
  const a2 = fleet(A.id, 'A 약탈대 2', P(l2, 0, 1500), ['frigate', 'frigate', 'hauler']);
  // L3: Helios, near the shipyard
  const b3 = fleet(B.id, 'B 화물선 3', P(HE.pos, 5000, -5000), ['hauler']); st.ships[b3.shipIds[0]].cargo.ore = 300;
  const a3 = fleet(A.id, 'A 약탈대 3', P(HE.pos, 5000, -2000), ['destroyer', 'destroyer', 'hauler']);
  // bystanders for L3 (placed later next to the stop): A's own other group and C's armed fleet, parked at Helios
  const a4 = fleet(A.id, 'A 예비대', P(HE.pos, 7000, 2000), ['frigate']);
  const c1 = fleet(C.id, 'C 무장 편대', P(HE.pos, 7400, 2000), ['destroyer', 'frigate']);
  // the bystanders take no automatic fights of their own
  for (const g of [a4, c1]) (g as any).piracyPolicy = undefined;
  file.world = JSON.parse(sim.serialize()); writeFileSync(save, JSON.stringify(file));
  const ids = { b1: b1.id, b1s: b1.shipIds[0], a1: a1.id, a1h: a1.shipIds[2], b2: b2.id, b2s: b2.shipIds[0], a2: a2.id, a2h: a2.shipIds[2], b3: b3.id, b3s: b3.shipIds[0], a3: a3.id, a3h: a3.shipIds[2], a4: a4.id, c1: c1.id, gJ: gJ.id };
  facts.ids = ids;
  const w0 = readWorld();
  for (const s of Object.values<any>(w0.ships)) if (s.owner === 'union') motion.unionShipIdsStart.add(s.id);
  motion.unionShipsStart = motion.unionShipIdsStart.size;
  facts.unionAtStart = { ships: motion.unionShipsStart, groups: Object.values<any>(w0.groups).filter(g => g.owner === 'union').map(g => `${g.id}:${g.npc?.role}:${g.npc?.sys}`) };
  await start(); await A.connect(); await B.connect(); await C.connect();
  void sampler();
  const time = () => B.snap().time as number;
  const law = (v: any) => v.companies[A.id]?.law;
  const plunder = async (n: number, bg: string, bs: string, ag: string) => {
    check(await B.command({ c: 'piracyPolicy', group: bg, policy: 'survive' }) === null, `L${n}: B sets hauler ${n} to 생존 우선`);
    const to = B.snap().ships[bs].pos;
    check(await B.command({ c: 'setOp', group: bg, op: { k: 'move', to: { x: to.x - 6000, y: 0, z: to.z } } }) === null, `L${n}: B's hauler ${n} is under way`);
    check(await A.command({ c: 'setOp', group: ag, op: { k: 'plunder', group: bg, policy: 'nonlethal', neutral: true } }) === null, `L${n}: A orders a non-destructive plunder of B 화물선 ${n} (neutral company — explicit permission; extortion where the law reaches)`);
  };
  // no hostility declared: a plunder at war is not a crime (P13.2 rule); extortion of a neutral company is

  // ============ L1: Astra — extortion → station sighting → wanted → patrol → stop → A offline → auto comply → inspection
  const cr1 = A.snap().companies[A.id].credits;
  await plunder(1, ids.b1, ids.b1s, ids.a1);
  const c1case = await until(() => { const L = law(A.snap()); const c = L?.cases?.find((x: any) => x.kind === 'extortion' && x.group === ids.a1); return c ? { L, c } : null; }, 'L1: no extortion case', 600000);
  facts.l1 = { case: c1case.c, level: c1case.L.level, score: c1case.L.score };
  check(c1case.c.auth === 'union' && c1case.c.sys === 'astra' && c1case.c.fine > 0, 'L1-1: A\'s real cargo demand in Astra became one extortion case under Union authority with a fine', facts.l1);
  check(c1case.L.level >= 2, 'L1-2: the case was known to the authority (seen / reported) and A is wanted (level ≥ 2)', facts.l1);
  const st1 = await until(() => { const g = A.snap().groups[ids.a1]; return g?.lawStop && g.lawStop.phase === 'demand' ? g.lawStop : null; }, 'L1: no stop demand', 600000);
  facts.l1.stop = st1;
  const w1 = readWorld(), op1 = w1.law.ops[st1.op];
  facts.l1.op = op1 && { guards: op1.guards.map((g: string) => `${g}:${w1.groups[g]?.npc?.role}:${w1.groups[g]?.npc?.sys}`), level: op1.level, t0: Math.round(op1.t0), sys: op1.sys };
  check(op1 && op1.guards.every((g: string) => motion.unionShipIdsStart.has(w1.groups[g]?.shipIds[0])), 'L1-3: the guards who stopped A are existing Union fleets of this world (no new ship was created)', facts.l1.op);
  const gd1 = op1 && Math.min(...op1.guards.flatMap((g: string) => w1.groups[g].shipIds.map((id: string) => w1.ships[id]?.pos).filter(Boolean)).map((p: V) => d3(p, A.snap().ships[ids.a1h].pos)));
  check(gd1 !== undefined && gd1 < 3000, 'L1-4: the guards physically reached A\'s group before demanding the stop', { nearest: Math.round(gd1) });
  // A goes offline right at the demand: no answer can come
  await A.disconnect();
  info('L1: A disconnected during the stop demand', { answerBy: st1.answerBy, now: time() });
  const st1b = await until(() => { const g = B.snap().groups[ids.a1]; void g; const w = readWorld(); const o = w.law.ops[st1.op]; const t = w.groups[ids.a1]; return t?.lawStop?.phase === 'released' || !o ? { stop: t?.lawStop, op: o } : null; }, 'L1: the stop never ended', 300000);
  await delay(1200);
  const wL1 = readWorld();
  const caseL1 = Object.values<any>(wL1.law.cases).find(c => c.id === c1case.c.id);
  facts.l1.after = { stop: st1b.stop, case: caseL1 && { state: caseL1.state, paid: caseL1.paid, fine: caseL1.fine, served: caseL1.served, end: caseL1.end }, resist: Object.values<any>(wL1.law.cases).filter(c => c.by === A.id && (c.kind === 'resist' || c.kind === 'flee')).length, customsB: (wL1.companies[B.id].bm?.customs ?? []).map((l: any) => ({ item: l.item, n: l.n, station: l.station, sys: l.sys })), aboard: wL1.ships[ids.a1h]?.cargo };
  check(st1b.stop?.end === 'inspected', 'L1-5: with A offline the unanswered demand was treated as compliance — the group held still and was inspected', facts.l1.after);
  check(facts.l1.after.resist === 0, 'L1-6: being offline / not answering never created a flee or resist case', facts.l1.after);
  check(caseL1 && caseL1.paid === caseL1.fine && caseL1.state === 'closed' && caseL1.end === 'paid', 'L1-7: the extortion fine was billed from A\'s credits at the inspection and the minor case closed as paid', facts.l1.after.case);
  const hot1 = Object.keys(wL1.ships[ids.a1h]?.cargo ?? {}).filter(k => k.startsWith('hot:')).reduce((a, k) => a + wL1.ships[ids.a1h].cargo[k], 0);
  const cust1 = (wL1.companies[B.id].bm?.customs ?? []).reduce((a: number, l: any) => a + l.n, 0);
  check(hot1 === 0 && cust1 > 0, 'L1-8: the stolen ore aboard A\'s hauler was seized and waits for B at customs in the same system (not shipped elsewhere)', { hotLeft: hot1, customs: facts.l1.after.customsB });
  await A.connect();
  const vA1 = A.snap();
  facts.l1.credits = { before: cr1, after: vA1.companies[A.id].credits };
  check(vA1.groups[ids.a1]?.lawStop?.phase === 'released' || !vA1.groups[ids.a1]?.lawStop, 'L1-9: after reconnecting A sees its group released (stop record shown to the owner)', vA1.groups[ids.a1]?.lawStop);

  // ============ L2: Drake — victim report → dispatch → demand → FLEE → pursuit → ends; then lawPay
  await plunder(2, ids.b2, ids.b2s, ids.a2);
  const c2 = await until(() => law(A.snap())?.cases?.find((x: any) => x.kind === 'extortion' && x.group === ids.a2 && x.state === 'open'), 'L2: no extortion case', 600000);
  facts.l2 = { case: c2 };
  info('L2: extortion case', c2);
  const st2 = await until(() => { const g = A.snap().groups[ids.a2]; return g?.lawStop?.phase === 'demand' ? g.lawStop : null; }, 'L2: no stop demand', 600000);
  facts.l2.stop = st2;
  const w2 = readWorld(), op2 = w2.law.ops[st2.op];
  facts.l2.op = { guards: op2.guards.map((g: string) => `${g}:${w2.groups[g]?.npc?.role}:${w2.groups[g]?.npc?.sys}`), level: op2.level };
  check(c2.auth === 'union' && c2.sys === 'drake' && op2, 'L2-1: A\'s plunder in Drake became a Union case and guards were dispatched and stopped A', facts.l2);
  check(await A.command({ c: 'lawAnswer', group: ids.a2, choice: 'flee' }) === null, 'L2-2: A answers the stop demand: flee');
  check(await A.command({ c: 'setOp', group: ids.a2, op: { k: 'move', to: P(st.systems.junction.origin, 0, 0) } }) === null, 'L2-3: A flies its group toward Junction (no Union garrison)');
  const fl = await until(() => law(A.snap())?.cases?.find((x: any) => x.kind === 'flee'), 'L2: no flee case', 60000);
  check(fl.auth === 'union' && fl.fine > 0, 'L2-4: fleeing the stop is its own case (flee, fine)', fl);
  const pur = await until(() => { const g = A.snap().groups[ids.a2]; return g?.lawStop?.phase === 'pursuit' ? g.lawStop : null; }, 'L2: no pursuit', 30000);
  check(!!pur, 'L2-5: A\'s group is under pursuit (its stop state says so)', pur);
  const end2 = await until(() => { const w = readWorld(); const o = w.law.ops[st2.op]; return !o || o.phase === 'return' || o.phase === 'fight' ? { end: o?.end, phase: o?.phase, stop: w.groups[ids.a2]?.lawStop, sys: (() => { const s = w.ships[ids.a2h]; return s?.pos; })() } : null; }, 'L2: the pursuit never ended', 1100000);
  facts.l2.end = end2;
  check(['left_jurisdiction', 'lost', 'timeout', 'distance'].includes(end2.end) || end2.phase === 'fight', 'L2-6: the pursuit ended by its own limits (left jurisdiction / lost / time / distance) or the guards caught up and fought — never an endless chase', end2);
  if (end2.phase === 'fight') {
    const ef = await until(() => { const w = readWorld(); const o = w.law.ops[st2.op]; return !o || o.phase === 'return' ? { end: o?.end } : null; }, 'L2: the pursuit battle never ended', 900000);
    facts.l2.fightEnd = ef; info('L2: the guards caught the fleeing group and fought it', ef);
  }
  // pay: refused while no ship is near a policed public station (A's L2 group is far away; A1 waits near Astra → move it first)
  const Lpre = law(await A.fresh());
  facts.l2.unpaid = Lpre?.unpaid;
  check(Lpre?.unpaid > 0, 'L2-7: A owes fines after the flight (extortion + flee)', { unpaid: Lpre?.unpaid, level: Lpre?.level });
  // move every other ship of A away from policed stations, then try to pay
  check(await A.command({ c: 'setOp', group: ids.a1, op: { k: 'move', to: P(st.systems.fang.origin, 0, 0) } }) === null, 'L2-8: A moves its first group out to Fang (lawless)');
  check(await A.command({ c: 'setOp', group: ids.a4, op: { k: 'move', to: P(st.systems.lyra.origin, 0, 0) } }) === null && await A.command({ c: 'setOp', group: ids.a3, op: { k: 'move', to: P(HE.pos, 30000, 0) } }) === null, 'L2-8b: A\'s reserve and third group move away from every policed station');
  await until(() => { const v = A.snap(); return [ids.a1, ids.a3, ids.a4].every(g => v.groups[g]?.op?.k !== 'move' || false) ? v : null; }, 'L2: groups did not arrive', 900000).catch(() => null);
  const payNo = await A.command({ c: 'lawPay' });
  facts.l2.payRefused = payNo;
  // the refusal only holds if no A ship is near a policed public station right now (check from the save)
  const wp = readWorld(); const pol = ['helios', 'astra', 'drake', 'ember'];
  const nearPol = Object.values<any>(wp.ships).filter(s => s.owner === A.id).some(s => Object.values<any>(wp.stations).some(x => x.public && (x.garrison ?? 0) > 0 && d3(x.pos, s.pos) < 4000 + (x.radius ?? 0)));
  void pol;
  check(payNo !== null || nearPol, 'L2-9: lawPay is refused while no A ship is near a policed public station (no stop running)', { err: payNo, nearPol });
  check(await A.command({ c: 'setOp', group: ids.a3, op: { k: 'move', to: P(HE.pos, 2500, 0) } }) === null, 'L2-10: A brings a ship close to Helios shipyard (it does not need to dock)');
  await until(() => { const s = A.snap().ships[ids.a3h]; return s && d3(s.pos, HE.pos) < 4000 + 600 ? s : null; }, 'L2: A3 did not reach Helios', 600000);
  const crP = (await A.fresh()).companies[A.id].credits;
  const payYes = await A.command({ c: 'lawPay' });
  const LP = law(await A.fresh());
  facts.l2.pay = { err: payYes, unpaidAfter: LP?.unpaid ?? 0, level: LP?.level ?? 0, credits: { before: crP, after: A.snap().companies[A.id].credits }, cases: LP?.cases?.map((c: any) => `${c.kind}:${c.state}:${c.end ?? ''}`) };
  check(payYes === null && (LP?.unpaid ?? 0) === 0 && crP - A.snap().companies[A.id].credits >= Lpre.unpaid - 1, 'L2-11: near Helios A pays every outstanding fine with lawPay (credits fall by the amount; nothing left unpaid)', facts.l2.pay);
  check((LP?.cases ?? []).filter((c: any) => c.kind === 'extortion' || c.kind === 'flee').every((c: any) => c.state === 'closed'), 'L2-12: paid minor cases (extortion, flee) close', facts.l2.pay);

  // ============ L3: Helios — extortion → dispatch → demand → RESIST → real P11 battle with only that group
  // put the bystanders right next to where A3 will plunder
  check(await A.command({ c: 'setOp', group: ids.a3, op: { k: 'move', to: P(HE.pos, 5000, -2000) } }) === null, 'L3: A3 returns to its post');
  await until(() => { const s = A.snap().ships[ids.a3h]; return s && d3(s.pos, P(HE.pos, 5000, -2000)) < 1500 ? s : null; }, 'L3: A3 not back', 300000);
  await plunder(3, ids.b3, ids.b3s, ids.a3);
  const c3 = await until(() => law(A.snap())?.cases?.find((x: any) => x.kind === 'extortion' && x.group === ids.a3 && x.state === 'open'), 'L3: no extortion case', 600000);
  facts.l3 = { case: c3 };
  const st3 = await until(() => { const g = A.snap().groups[ids.a3]; return g?.lawStop?.phase === 'demand' ? g.lawStop : null; }, 'L3: no stop demand', 600000);
  facts.l3.stop = st3;
  // bring A's reserve and C's armed fleet next to the stop (real flight) before answering
  const at3 = A.snap().ships[ids.a3h].pos;
  check(await A.command({ c: 'setOp', group: ids.a4, op: { k: 'move', to: P(at3, 900, 600) } }) === null && await C.command({ c: 'setOp', group: ids.c1, op: { k: 'move', to: P(at3, -900, 600) } }) === null, 'L3: A\'s reserve and C\'s armed fleet fly next to the stop');
  await until(() => { const a = A.snap().ships[A.snap().groups[ids.a4]?.shipIds[0]], c = C.snap().ships[C.snap().groups[ids.c1]?.shipIds[0]]; return a && c && d3(a.pos, at3) < 2500 && d3(c.pos, at3) < 2500 ? true : null; }, 'L3: bystanders did not arrive', 50000).catch(() => info('L3: bystanders were still on the way when A answered'));
  check(await A.command({ c: 'lawAnswer', group: ids.a3, choice: 'resist' }) === null, 'L3-1: A answers the stop demand: resist');
  const rs = await until(() => law(A.snap())?.cases?.find((x: any) => x.kind === 'resist'), 'L3: no resist case', 30000);
  check(rs.auth === 'union' && rs.fine > 0, 'L3-2: armed resistance is its own serious case', rs);
  const eng = await until(() => { const w = readWorld(); const o = w.law.ops[st3.op]; const e = o?.e ? w.engagements[o.e] : undefined; return e ? { e, o, w } : null; }, 'L3: no law battle', 120000);
  const others = (w: any, e: any) => (e.groupRefs ?? []).filter((g: string) => w.groups[g]?.owner !== 'union' && g !== ids.a3).map((g: string) => `${w.groups[g]?.owner}:${g}`);
  facts.l3.battle = { id: eng.e.id, law: eng.e.law && { op: eng.e.law.op, co: eng.e.law.co }, sides: eng.e.sides, groups: (eng.e.groupRefs ?? []).map((g: string) => `${eng.w.groups[g]?.owner}:${g}`), v: eng.e.v };
  check(eng.e.law?.co === A.id && eng.e.sides.flat().every((o: string) => o === 'union' || o === A.id) && others(eng.w, eng.e).length === 0, 'L3-3: a real P11 engagement between the Union guards and A\'s stopped group only', facts.l3.battle);
  // watch the battle to its end: nobody else is pulled in
  const intrude = new Set<string>();
  const endB = await until(() => {
    const w = readWorld(); const e = w.engagements[eng.e.id];
    if (e) { for (const x of others(w, e)) intrude.add(x); for (const o of e.sides.flat()) if (o !== 'union' && o !== A.id) intrude.add(o); }
    return !e || e.done ? { w } : null;
  }, 'L3: the law battle did not end', 1200000);
  const wB = endB.w;
  facts.l3.intruders = [...intrude];
  check(intrude.size === 0, 'L3-4: A\'s other group, C\'s armed fleet and B\'s victim hauler next to it were never pulled into the law battle', { intruders: [...intrude] });
  const hostile = (w: any, a: string, b: string) => !!w.stance?.[a]?.hostile?.includes(b);
  const rel = { AB: hostile(wB, A.id, B.id), AC: hostile(wB, A.id, C.id) || hostile(wB, C.id, A.id), unionA: hostile(wB, 'union', A.id) || hostile(wB, A.id, 'union'), coRel: wB.companies.union?.rel?.[A.id] };
  facts.l3.relations = rel;
  check(!rel.AC, 'L3-5: the law battle created no hostility between A and C (no diplomacy side effect)', rel);
  check(!rel.unionA, 'L3-6: the Union is not made permanently hostile to A (hostility existed only inside that engagement)', rel);
  const opEnd3 = await until(() => { const w = readWorld(); const o = w.law.ops[st3.op]; return !o || o.phase === 'return' ? { end: o?.end, w } : null; }, 'L3: the operation did not settle', 120000);
  const gatk = Object.values<any>(opEnd3.w.law.cases).filter(c => c.by === A.id && c.kind === 'guard_attack');
  facts.l3.end = { opEnd: opEnd3.end, guardAttack: gatk.map(c => ({ fine: c.fine, how: c.how, state: c.state })), a3Ships: opEnd3.w.groups[ids.a3]?.shipIds.filter((id: string) => opEnd3.w.ships[id]).length ?? 0, stop: opEnd3.w.groups[ids.a3]?.lawStop };
  check(['battle_over', 'suppressed'].includes(opEnd3.end), 'L3-7: the operation settled after the battle (battle over / suppressed)', facts.l3.end);
  info('L3: guard damage → guard_attack case', facts.l3.end.guardAttack);
  // B's hauler 3 and A3 were in a P13.2 truce after the plunder: no fight between them
  const abFights = Object.values<any>(opEnd3.w.engagements).filter((e: any) => !e.law && !e.done && e.sides.flat().includes(A.id) && e.sides.flat().includes(B.id));
  check(abFights.length === 0, 'L3-8: the enforcement did not restart a fight between A and the victim B', { n: abFights.length });
  const vA3 = await A.fresh();
  facts.l3.law = law(vA3);
  check(law(vA3)?.level >= 2 && law(vA3)?.cases?.some((c: any) => c.kind === 'resist' && c.state === 'open'), 'L3-9: after resisting A stays wanted (serious case open, fine owed)', { level: law(vA3)?.level, score: law(vA3)?.score, unpaid: law(vA3)?.unpaid });

  // ============ privacy: B and C never see A's record or stop state
  const vB = await B.fresh(), vC = await C.fresh();
  const leakB = !!vB.companies[A.id]?.law || Object.values<any>(vB.groups).some(g => g.owner === A.id && (g.lawStop || g.lawx)) || 'law' in vB && !!vB.law;
  const leakC = !!vC.companies[A.id]?.law || Object.values<any>(vC.groups).some(g => g.owner === A.id && (g.lawStop || g.lawx)) || 'law' in vC && !!vC.law;
  const rawB = B.snapMsg()?._text ?? '';
  check(!leakB && !leakC && !rawB.includes('"lawStop"') && !rawB.includes(c3.id), 'P-1: B and C never receive A\'s law record, case ids, or its fleets\' stop state', { leakB, leakC });
  check(!vA3.law && Object.values<any>(vA3.groups).every(g => !g.lawx), 'P-2: even A never receives the law book or the guards\' operation tags', {});

  // ============ restart: the law book, A's record and the customs lots come back exactly
  await delay(1500);
  sampling = false;
  const before = readWorld();
  const pick = (w: any) => ({ law: w.law && { seq: w.law.seq, cases: w.law.cases, keys: w.law.keys, ops: Object.fromEntries(Object.entries<any>(w.law.ops).map(([k, o]) => [k, { ...o, last: undefined, tp: undefined }])) }, coLaw: w.companies[A.id].law, customs: w.companies[B.id].bm?.customs, credits: Math.round(w.companies[A.id].credits) });
  await stop();
  const p1 = pick(readWorld());
  await start(); await A.connect(); await B.connect(); await C.connect();
  await delay(300);
  await stop();
  const p2 = pick(readWorld());
  const casesSame = JSON.stringify(p1.law?.cases) === JSON.stringify(p2.law?.cases) && JSON.stringify(p1.law?.keys) === JSON.stringify(p2.law?.keys) && JSON.stringify(p1.customs) === JSON.stringify(p2.customs);
  check(casesSame, 'R-1: after a server restart every case (fines, payments, states), the duplicate-key index and B\'s customs lots are exactly as saved', { cases: Object.keys(p1.law?.cases ?? {}).length });
  void before;

  // ============ conservation of B's 900 ore: B's haulers + customs + A's holds/storage (stolen) + containers + wrecks
  const wf = readWorld();
  const oreOf = (c: any) => Object.entries<number>(c ?? {}).reduce((a, [k, n]) => a + (k === 'ore' || (k.startsWith('hot:ore:')) ? n : 0), 0);
  let ore = 0;
  for (const s of Object.values<any>(wf.ships)) if ([A.id, B.id, C.id].includes(s.owner)) ore += oreOf(s.cargo);
  for (const x of Object.values<any>(wf.stations)) for (const c of [A.id, B.id, C.id]) ore += oreOf(x.storage?.[c]);
  for (const x of Object.values<any>(wf.drops ?? {})) ore += x.lots.filter((l: any) => l.item === 'ore' || l.item.startsWith('hot:ore:')).reduce((a: number, l: any) => a + l.n, 0);
  for (const x of Object.values<any>(wf.wrecks ?? {})) ore += x.lots.filter((l: any) => l.k === 'cargo' && (l.item === 'ore' || l.item.startsWith('hot:ore:'))).reduce((a: number, l: any) => a + l.n, 0);
  const cust = (wf.companies[B.id].bm?.customs ?? []).filter((l: any) => l.item === 'ore').reduce((a: number, l: any) => a + l.n, 0);
  facts.ore = { held: +ore.toFixed(6), customs: cust };
  info('ore accounting (lost cargo in sunk ships is destroyed in battle)', facts.ore);
  check(ore + cust <= 900 + 1e-6, 'ACC: no ore was created — B\'s 900 = what is still held + at customs (+ what was destroyed with sunk ships)', facts.ore);

  // ============ no dispatch loop: operations per target group stay few (each needs a new sighting)
  const perTarget: Record<string, number> = {};
  const disp = (() => { try { const st = JSON.parse(readFileSync(path.join(dir, 'world.analytics.json'), 'utf8')).store; return [...(st.hourly ?? []).flatMap((h: any) => h.rows ?? []), ...(st.current?.rows ?? []), ...(st.fine ?? []).flatMap((h: any) => h.rows ?? [])].filter((r: any) => r.kind === 'law' && r.reason === 'dispatch'); } catch { return []; } })();
  for (const r of disp) perTarget[r.group ?? '?'] = (perTarget[r.group ?? '?'] ?? 0) + (r.count ?? 1);
  facts.dispatchPerTarget = perTarget;
  check(Object.values(perTarget).every(n => n <= 4), 'M-0: no dispatch loop — at most a few operations per suspect group over the whole run', perTarget);
  // ============ guards flew, never spawned or teleported
  facts.motion = { samples: motion.samples, worstRatio: +motion.worstRatio.toFixed(3), worst: motion.worst, gateJumps: motion.jumps, ops: motion.opsSeen.size, guards: [...motion.guardsSeen], unionShipsStart: motion.unionShipsStart, unionShipsMax: motion.unionShipsMax, newUnionShips: motion.newUnionShips.length, redispatch: undefined as any };
  check(motion.samples > 50 && motion.opsSeen.size >= 3 && motion.worstRatio <= 1, 'M-1: sampled from the server\'s save, every dispatched guard ship moved no faster than the real warp drive (no teleport)', facts.motion);
  check(motion.newUnionShips.every(x => x.fromHome >= 0 && x.fromHome < 1500), 'M-2: no Union ship appeared in the field — the only new hulls are the existing refit rule replacing losses at the group\'s own home station', { newUnionShips: motion.newUnionShips })
  const need = ['L1-1', 'L1-3', 'L1-4', 'L1-5', 'L1-7', 'L1-8', 'L2-1', 'L2-4', 'L2-6', 'L2-11', 'L3-3', 'L3-4', 'L3-7', 'M-1'];
  const miss = need.filter(k => !checks.some(c => c.ok && c.label.startsWith(k + ':')));
  check(miss.length === 0, 'REQUIRED chain: real crime → report → physical dispatch → stop → comply (offline) / flee / resist → settlement, on one server world', { missing: miss });
} catch (e) { check(false, 'run', { error: String((e as Error)?.stack ?? e).slice(0, 1500), serverTail: serverLog.slice(-1500) }); }
finally {
  sampling = false;
  await stop();
  const outDir = 'artifacts/p134';
  mkdirSync(outDir, { recursive: true });
  const passed = checks.filter(c => c.ok).length, failed = checks.filter(c => !c.ok).length;
  writeFileSync(`${outDir}/server-${label}.json`, JSON.stringify({ passed, failed, checks, infos, facts, realWebSockets: 3, seconds: Math.round((Date.now() - T0) / 1000) }, null, 2));
  console.log(JSON.stringify({ passed, failed, seconds: Math.round((Date.now() - T0) / 1000) }));
  process.exit(failed ? 1 : 0);
}

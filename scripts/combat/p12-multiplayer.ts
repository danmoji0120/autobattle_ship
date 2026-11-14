// P12 §14 final scenario on a real server process: `node dist-server/server.mjs` with FLEET_OPS_P12=1, three
// accounts over real WebSockets, only real commands (no state edits).
//  1–2 A blockades a jump gate in Sunder (a system with no station) and holds the post
//  3–4 hostile B flies to the gate; A's commander intercepts and a P11 battle starts
//  5–6 C (hostile to B) gets a reinforce order for that battle and joins the same instance
//  7   B withdraws its side
//  8–9 A resumes the blockade at the gate; C's reinforce ends (idle, "증원 완료")
//  10–12 A presses return (no station): the commander picks one, the fleet jumps through a gate and docks
//  13  the server is restarted mid-return; the order and ships are restored and the return completes
//  14  the battle is recorded and settled exactly once
// Needs `npm run build` first.   npx vite-node scripts/combat/p12-multiplayer.ts
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import WebSocket from 'ws';

const dir = mkdtempSync(path.join(tmpdir(), 'siderarium-p12-mp-'));
const save = path.join(dir, 'world.json');
const binary = path.resolve('dist-server/server.mjs'), staticDir = path.resolve('dist');
const probe = net.createServer();
await new Promise<void>(r => probe.listen(0, '127.0.0.1', () => r()));
const port = (probe.address() as net.AddressInfo).port; await new Promise(r => probe.close(r));
const base = `http://127.0.0.1:${port}`, checks: string[] = [], sockets: WebSocket[] = [], facts: Record<string, unknown> = {};
const T0 = Date.now();
let child: ChildProcess | undefined;
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until<T>(fn: () => T | Promise<T>, reason: string, ms = 60000): Promise<T> { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await delay(150); } throw Error(reason); }
function check(ok: unknown, label: string) { if (!ok) throw Error('FAIL ' + label); checks.push(label); console.log(`PASS [${Math.round((Date.now() - T0) / 1000)}s]`, label); }
const d2 = (a: any, b: any) => Math.hypot(a.x - b.x, a.z - b.z);
async function start() {
  let log = '';
  child = spawn('node', [binary], { cwd: dir, env: { ...process.env, PORT: String(port), STATIC_DIR: staticDir, SAVE_FILE: save, DATABASE_URL: '', WORLD_RESET: '', CONTENT_MIGRATE: '', WORLD_SEED: '9412', SAVE_INTERVAL_S: '.5', FLEET_OPS_P12: '1', COMBAT_P11: '' } });
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
    const r = await fetch(base + '/api/auth/signup', { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ loginId, password: 'p12-test-password-123', confirm: 'p12-test-password-123' }) });
    this.cookie = r.headers.get('set-cookie')?.split(';')[0] ?? '';
    if (r.status !== 200 || !this.cookie) throw Error(`signup failed: ${r.status}`);
  }
  async connect() {
    this.messages = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { origin: base, cookie: this.cookie } }); this.ws = ws; sockets.push(ws);
    ws.on('message', raw => {
      const m = JSON.parse(String(raw));
      if (m.t === 'snap') this.messages = this.messages.filter(x => x.t !== 'snap');   // keep the latest only
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
  async order(eng: string, groupId: number, order: any, opts: any = {}) { const id = this.seq++; this.ws.send(JSON.stringify({ t: 'border', id, eng, groupId, order, opts })); return (await this.wait(m => m.t === 'ack' && m.id === id)).err; }
  snap() { return this.messages.filter(m => m.t === 'snap').at(-1).state; }
  guard() { const st = this.snap(); return Object.values<any>(st.groups).find(g => g.owner === this.id && g.shipIds.length && !g.parentId && g.shipIds.some((id: string) => ['destroyer', 'corvette', 'frigate'].includes(st.ships[id]?.classId)))!; }
  group(id: string) { return this.snap().groups[id]; }
  ships(id: string) { const st = this.snap(); return (st.groups[id]?.shipIds ?? []).map((s: string) => st.ships[s]).filter(Boolean); }
  center(id: string) { const ss = this.ships(id).filter((s: any) => s.state !== 'battle'); if (!ss.length) return null; return { x: ss.reduce((a: number, s: any) => a + s.pos.x, 0) / ss.length, z: ss.reduce((a: number, s: any) => a + s.pos.z, 0) / ss.length }; }
}
const sysOf = (st: any, p: any) => Object.values<any>(st.systems).find(s => Math.hypot(p.x - s.origin.x, p.z - s.origin.z) <= s.radius)?.id;
try {
  await start();
  const a = new Pilot('알파 PMC'), b = new Pilot('브라보 PMC'), c = new Pilot('찰리 PMC');
  await a.signup('p12_alpha'); await b.signup('p12_bravo'); await c.signup('p12_charlie');
  for (const p of [a, b, c]) await p.connect();
  const s0 = a.snap();
  check(s0.opsV === 1 && s0.combatV === 2, 'FLEET_OPS_P12=1 server creates a P12 world (with P11 combat)');
  check(await a.command({ c: 'stance', target: b.id, v: -1 }) === null && await c.command({ c: 'stance', target: b.id, v: -1 }) === null, 'A and C declare hostility to B (A–C stay neutral)');
  const ga = a.guard(), gb = b.guard(), gc = c.guard();
  const sunder = s0.systems.sunder, gate = sunder.gates.find((g: any) => g.to === 'ember');
  // ---- 1–2: A blockades the Sunder→Ember gate
  check(await b.command({ c: 'setOp', group: ga.id, op: { k: 'return' } }) !== null, 'B cannot order A\'s fleet (server refuses)');
  check(await a.command({ c: 'setOp', group: ga.id, op: { k: 'blockade', system: 'sunder', gate: gate.id } }) === null, '1. A orders its fleet to blockade the Sunder gate (one order: system + gate)');
  // C waits nearby in Sunder (not hostile to A), B stays home for now
  const wait = { x: gate.pos.x - 5200, y: 0, z: gate.pos.z + 3500 };
  check(await c.command({ c: 'setOp', group: gc.id, op: { k: 'rally', at: wait } }) === null, 'C rallies its fleet at a holding point in Sunder');
  await until(() => { const g = a.group(ga.id), cc = a.center(ga.id); return g.opx?.phase === 'hold' && cc && sysOf(a.snap(), cc) === 'sunder' && d2(cc, gate.pos) < 900; }, 'A never reached the gate post', 400000);
  facts.blockade = { status: a.group(ga.id).status, phase: a.group(ga.id).opx.phase };
  check(true, `2. A's fleet crosses two gates and holds the post at the gate ("${a.group(ga.id).status}")`);
  check(b.group(ga.id).op.k === 'idle' && b.group(ga.id).opx === undefined, 'other companies see neither A\'s order nor its operation state');
  await until(() => { const cc = c.center(gc.id); return cc && d2(cc, wait) < 900; }, 'C never reached its holding point', 400000);
  // ---- 3–4: B approaches the gate
  check(await b.command({ c: 'setOp', group: gb.id, op: { k: 'move', to: { x: gate.pos.x - 1500, y: 0, z: gate.pos.z - 900 } } }) === null, '3. hostile B sends its fleet toward the gate');
  const eng = await until(() => Object.values<any>(a.snap().engagements ?? {}).find(e => !e.done && e.sides.some((s: string[]) => s.includes(a.id)) && e.sides.some((s: string[]) => s.includes(b.id))), 'A and B never engaged', 400000);
  facts.engagement = eng.id;
  check(eng.v === 2 && d2(eng.pos, gate.pos) < 3000, `4. A's commander engages B at the gate — P11 battle ${eng.id}`);
  check(a.group(ga.id).op.k === 'blockade', '   A\'s blockade order is kept during the battle');
  // ---- 5–6: C reinforces
  check(await c.command({ c: 'setOp', group: gc.id, op: { k: 'reinforce', eng: eng.id } }) === null, '5. C is given a reinforce order for the running battle');
  await until(() => a.snap().engagements[eng.id]?.sides.some((s: string[]) => s.includes(c.id)), 'C never joined', 200000);
  const e2 = a.snap().engagements[eng.id];
  check(!e2.done && e2.joins?.some((j: any) => j.company === c.id) && e2.sides.length === 3, '6. C joins the same P11 battle instance (3 sides, no new battle)');
  // ---- 7: B withdraws
  await delay(1500);
  check(await b.order(eng.id, -1, null, { withdraw: true }) === null, '7. B withdraws its side');
  await until(() => { const e = a.snap().engagements[eng.id]; return !e || e.done; }, 'battle did not end', 600000);
  check(true, '   the battle ends');
  // ---- 8–9: A resumes the blockade, C's reinforce finishes
  await until(() => { const g = a.group(ga.id), cc = a.center(ga.id); return g.op.k === 'blockade' && g.opx?.phase === 'hold' && cc && d2(cc, gate.pos) < 900; }, 'A never resumed the blockade', 300000);
  check(true, `8. A resumes the gate blockade ("${a.group(ga.id).status}")`);
  await until(() => c.group(gc.id).op.k === 'idle' && c.group(gc.id).opx?.done === 'reinforce', 'C never finished its reinforce', 120000);
  check(true, `9. C's reinforce ends in its follow-up state: idle, "${c.group(gc.id).opx.reason}"`);
  // ---- 10–12: return
  const lostBefore = a.ships(ga.id).length;
  check(await a.command({ c: 'setOp', group: ga.id, op: { k: 'return' } }) === null, '10. A presses return (no station in the order)');
  const station = (await until(() => a.group(ga.id).opx?.station as string | undefined, "no return station chosen", 30000))!;
  const S = a.snap().stations[station];
  facts.returnStation = { id: station, name: S.name, system: sysOf(a.snap(), S.pos), score: a.group(ga.id).opx.score };
  check(sysOf(a.snap(), S.pos) !== 'sunder', `11. A's commander picks the destination itself: ${S.name} (${facts.returnStation && (facts.returnStation as any).system}) — Sunder has no station, so a gate must be crossed`);
  // ---- 13: restart mid-return
  await until(() => { const cc = a.center(ga.id); return cc && sysOf(a.snap(), cc) !== 'sunder'; }, 'A never jumped out of Sunder', 300000);
  check(true, '12a. A\'s fleet jumps through the gate out of Sunder');
  await delay(1200);
  const before = JSON.parse(readFileSync(save, 'utf8'));
  check(before.world.groups[ga.id].op.k === 'return' && before.world.groups[ga.id].opx?.station === station, 'the saved world holds the return order and the chosen station');
  const log0 = (before.world.battleLog ?? []).filter((r: any) => r.id === eng.id).length;
  const credits0 = [a, b, c].map(p => before.world.companies[p.id].credits);
  await stop(); await start();
  for (const p of [a, b, c]) await p.connect();
  const g1 = a.group(ga.id);
  check(g1.op.k === 'return' && g1.opx?.station === station, '13. after a server restart the return order and destination are restored');
  check(a.ships(ga.id).length === lostBefore, '   every ship of the fleet is restored');
  await until(() => a.group(ga.id).op.k === 'idle' && a.ships(ga.id).every((s: any) => s.state === 'docked' && s.task?.station === station), 'A never docked', 600000);
  check(true, `12b. A docks at ${S.name} and waits (no previous mission resumed: ${a.group(ga.id).op.k})`);
  // ---- 14: settled once
  await delay(1500);
  const st = a.snap();
  const rec = (st.battleLog ?? []).filter((r: any) => r.id === eng.id);
  facts.record = rec.map((r: any) => ({ names: r.names, sides: r.sides, losses: r.losses }));
  check(rec.length === 1 && log0 === 1, '14. the battle is recorded exactly once (before and after the restart)');
  const saved = JSON.parse(readFileSync(save, 'utf8'));
  const engs = Object.values<any>(saved.world.engagements).filter(e => e.id === eng.id);
  check(engs.every(e => e.done) && !Object.values<any>(saved.world.ships).some(s => s.engagement === eng.id), '   no ship is left pointing at the finished battle');
  facts.credits = { before: credits0, after: [a, b, c].map(p => p.snap().companies[p.id].credits) };
  mkdirSync('artifacts/p12', { recursive: true });
  writeFileSync('artifacts/p12/multiplayer-results.json', JSON.stringify({ passed: checks.length, checks, facts, realWebSockets: 3, restarts: 1, seconds: Math.round((Date.now() - T0) / 1000) }, null, 2));
  console.log(JSON.stringify({ passed: checks.length, facts }, null, 2));
} finally { await stop(); }
process.exit(0);

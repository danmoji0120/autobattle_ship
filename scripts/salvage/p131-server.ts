// P13.1 §18 scenario on a real server process: `node dist-server/server.mjs` with SALVAGE_P131=1 and three
// real WebSocket accounts — A military, B hauler with escort, C professional salvager. Starting assets are
// placed once with the server stopped; every step after that is a real command or the server's simulation
// (the only other offline edit is step 9's clock skip to the wrecks' expiry).
// Needs `npm run build` first.   npx vite-node scripts/salvage/p131-server.ts
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import WebSocket from 'ws';
import { WorldSim } from '../../src/world/sim';

const dir = mkdtempSync(path.join(tmpdir(), 'siderarium-p131-'));
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
  child = spawn('node', [binary], { cwd: dir, env: { ...process.env, PORT: String(port), STATIC_DIR: staticDir, SAVE_FILE: save, DATABASE_URL: '', WORLD_RESET: '', CONTENT_MIGRATE: '', WORLD_SEED: '9412', SAVE_INTERVAL_S: '.5', SALVAGE_P131: '1', AUTO_LOGISTICS_P125: '', FLEET_OPS_P12: '', COMBAT_P11: '' } });
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
    const r = await fetch(base + '/api/auth/signup', { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ loginId, password: 'p131-test-password-123', confirm: 'p131-test-password-123' }) });
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

const wreckOfEng = (st: any, eng: string) => Object.values<any>(st.wrecks ?? {}).filter(w => w.eng === eng);
const units = (w: any) => (w?.lots ?? []).reduce((n: number, l: any) => n + l.n, 0);
const sum = (o: any) => Object.values<number>(o ?? {}).reduce((a, n) => a + n, 0);
try {
  // 0. three accounts on a fresh P13.1 server
  await start();
  const A = new Pilot('A 군사 PMC'), B = new Pilot('B 운송 PMC'), C = new Pilot('C 인양 PMC');
  await A.signup('p131_a'); await B.signup('p131_b'); await C.signup('p131_c');
  await A.connect(); await B.connect(); await C.connect();
  const s0 = A.snap();
  check(s0.salvageV === 1 && s0.logisticsV === 1 && s0.opsV === 1 && s0.combatV === 2 && !s0.sites, 'SALVAGE_P131=1 server creates a P13.1 world (P11+P12+P12.5, no random derelicts)');
  await stop();
  // starting assets, placed once with the server stopped: B's escorted convoy with real cargo, A's battle group, C's salvage ship
  const file = JSON.parse(readFileSync(save, 'utf8'));
  const sim = new WorldSim(file.world, { migrateContent: false });
  for (const id of Object.keys(sim.st.ships)) delete sim.st.ships[id];
  for (const id of Object.keys(sim.st.groups)) delete sim.st.groups[id];
  for (const l of Object.values(sim.st.lairs)) { l.alive = false; l.respawnAt = 1e10; }
  const ast = sim.st.stations.astra, at = (dx: number, dz: number) => ({ x: ast.pos.x + dx, y: 0, z: ast.pos.z + dz });
  const fleet = (o: string, name: string, pos: any, comp: string[]) => { const g = sim.newGroup(o, name); g.commanderId = sim.newCommander(o, 2).id; comp.forEach((cl, i) => sim.spawnShip(o, cl, 'std', g.id, { x: pos.x + i * 40, y: 0, z: pos.z })); return g; };
  const conv = fleet(B.id, 'B 호송대', at(4000, 2500), ['hauler', 'destroyer', 'destroyer', 'corvette']);
  const hauler = sim.st.ships[conv.shipIds[0]]; hauler.cargo.metal = 300; hauler.cargo.electronics = 120; hauler.logisticsExcluded = true;
  const war = fleet(A.id, 'A 전투단', at(3000, 2500), ['destroyer', 'destroyer', 'destroyer', 'destroyer', 'destroyer', 'destroyer', 'frigate']);
  const cg = fleet(C.id, 'C 인양대', at(1500, -500), ['miner']);
  for (const co of [A.id, B.id, C.id]) sim.st.companies[co].credits = 1e6;
  file.world = JSON.parse(sim.serialize()); writeFileSync(save, JSON.stringify(file));
  const ids = { conv: conv.id, hauler: hauler.id, war: war.id, cg: cg.id, cship: cg.shipIds[0], astra: ast.id };
  facts.ids = ids; facts.cargoBefore = { metal: 300, electronics: 120 };

  await start(); await A.connect(); await B.connect(); await C.connect();
  check(B.snap().ships[ids.hauler]?.cargo?.metal === 300, '1: B\'s hauler carries 300 metal + 120 electronics with two destroyers and a corvette as escort');
  // 2. A attacks the convoy — a real P11 battle
  check(await A.command({ c: 'setOp', group: ids.war, op: { k: 'attack', group: ids.conv } }) === null, '2: A orders its battle group to attack B\'s convoy (declares hostility)');
  const eng = await until(() => { const s = A.snap(); return (s.battleLog ?? []).find((b: any) => b.sides?.some((x: any) => x.company === B.id))?.id ?? Object.values<any>(s.engagements).find(e => e.sides?.flat?.().includes(B.id))?.id; }, 'no battle', 300000);
  check(!!eng, '2: P11 engagement between A and B', { eng });
  const w0 = await until(() => wreckOfEng(A.snap(), eng)[0], 'no wreck from the battle', 300000);
  check(w0.known && w0.sources.every((s: any) => s.owner === B.id), '3: B\'s destroyed ships became a battlefield wreck (sources = real ships of B)', { name: w0.name, sources: w0.sources.map((s: any) => s.classId), units: w0.initial });
  // keep fighting a while so the hauler can be caught too; then stand down
  await until(() => !A.snap().ships[ids.hauler] || A.snap().groups[ids.conv]?.shipIds?.length === 1, 'escorts did not fall', 240000).catch(() => null);
  await delay(20000);
  const sunk = !A.snap().ships[ids.hauler];
  facts.haulerSunk = sunk;
  const all = wreckOfEng(A.snap(), eng).concat(Object.values<any>(A.snap().wrecks ?? {}).filter(w => w.sources.some((s: any) => s.ship === ids.hauler) && w.eng !== eng));
  const cargoLots = all.flatMap((w: any) => w.lots.filter((l: any) => l.k === 'cargo'));
  facts.cargoInWrecks = cargoLots.map((l: any) => [l.item, l.n]);
  // the escorts' wreck is what this scenario salvages; whether the hauler was sunk is only recorded here.
  // The cargo-to-wreck path on a real server is verified (strictly, no pass without a sinking) by p131-server-convoy.ts
  if (sunk) check(cargoLots.length > 0 && cargoLots.every((l: any) => l.n < (l.item === 'metal' ? 300 : 120)), '3: the hauler was sunk; part of its real cargo is in the wreck (the rest destroyed)', { sunk, cargo: facts.cargoInWrecks });
  else console.log('INFO 3: the hauler escaped in this run — not counted as a check (see p131-server-convoy.ts)');
  check(await A.command({ c: 'setOp', group: ids.war, op: { k: 'idle' } }) === null, '4: A stands its battle group down (idle) — automatic on-site salvage may now start');
  const target = all.sort((x: any, y: any) => units(y) - units(x))[0];
  // 5. C sends a zone salvage at the wreck
  check(await C.command({ c: 'setOp', group: ids.cg, op: { k: 'salvzone', at: target.pos, radius: 3000 } }) === null, '5: C sends its miner on a zone salvage over the battlefield');
  await until(() => sum(C.snap().wrecks?.[target.id]?.taken?.[C.id]) > 0 && sum(A.snap().wrecks?.[target.id]?.taken?.[A.id]) > 0, 'A and C did not both salvage', 400000);
  const wa = A.snap().wrecks[target.id], wc = C.snap().wrecks[target.id];
  const tA = sum(wa.taken[A.id]), tC = sum(wc.taken[C.id]);
  check(tA > 0 && tC > 0, '6: A (automatic on-site salvage) and C (zone salvage) both take from the same wreck', { initial: target.initial, A: wa.taken[A.id], C: wc.taken[C.id], left: units(wc) });
  check(Object.keys(wa.taken).length === 1 && Object.keys(wc.taken).length === 1, '6: each company sees only its own recovered amounts');
  check(!Object.keys(wa.taken[A.id]).some(k => k.startsWith('bpf:')) , '6: no blueprint fragments from a PMC hull');
  // 7. C's hold fills, it heads to a station; the server restarts on the way
  const going: any = await until(() => { const s = C.snap(), g = s.groups[ids.cg], sh = s.ships[ids.cship]; return g?.salv?.phase === 'unload' && sh?.state === 'space' && sum(sh.salvaged) > 0 ? { phase: g.salv.phase, station: g.salv.station, salvaged: { ...sh.salvaged }, pos: sh.pos, status: g.status } : null; }, 'C never went to unload', 400000);
  check(going.salvaged && sum(going.salvaged) >= 100, '7: C\'s hold is full of salvage; it is flying to a station to unload', going);
  await stop();
  { const fw = JSON.parse(readFileSync(save, 'utf8')).world.wrecks?.[target.id];
    const tk = Object.fromEntries(Object.entries<any>(fw?.taken ?? {}).map(([c, m]) => [c, sum(m)]));
    const tot = Object.values<number>(tk).reduce((a, n) => a + n, 0) + units(fw);
    facts.accounting = { initial: target.initial, taken: tk, left: units(fw) };
    check(fw && tot === target.initial && Object.keys(tk).every(c => c === A.id || c === C.id), '6: server save: A taken + C taken + remaining = what the wreck held, exactly (no duplication)', facts.accounting); }
  await start(); await A.connect(); await B.connect(); await C.connect();
  const back = C.snap(), bg = back.groups[ids.cg], bs = back.ships[ids.cship];
  check(bg?.op?.k === 'salvzone' && bg.salv?.phase === 'unload' && JSON.stringify(bs.salvaged) === JSON.stringify(going.salvaged) && Math.hypot(bs.pos.x - going.pos.x, bs.pos.z - going.pos.z) < 400, '7: after a server restart the order, phase, recovered cargo and position are restored', { salv: bg?.salv?.phase, salvaged: bs?.salvaged });
  // 8. unload, return, sell
  const stationId = bg.salv.station;
  const store0 = { ...(back.stations[stationId]?.storage?.[C.id] ?? {}) };
  const after = await until(() => { const s = C.snap(); return sum(s.ships[ids.cship]?.salvaged) === 0 && s.groups[ids.cg]?.salv?.phase !== 'unload' ? s : null; }, 'C did not unload', 300000);
  const store1 = after.stations[stationId].storage[C.id];
  const added = Object.fromEntries(Object.keys(going.salvaged).map(k => [k, (store1[k] ?? 0) - (store0[k] ?? 0)]));
  check(Object.keys(going.salvaged).every(k => Math.abs(added[k] - going.salvaged[k]) < 1e-6), '8: C docks and unloads exactly what it recovered into its storage', { added, carried: going.salvaged });
  await until(() => ['return', 'work', 'transit', 'hold'].includes(C.snap().groups[ids.cg]?.salv?.phase), 'C did not go back', 120000);
  check(true, '8: C returns to the salvage zone after unloading (the operation continues)', { phase: C.snap().groups[ids.cg].salv.phase });
  const sellItem = Object.keys(going.salvaged).sort((x, y) => going.salvaged[y] - going.salvaged[x])[0];
  const cr0 = C.snap().companies[C.id].credits;
  const sellAt = after.stations[stationId].market ? stationId : ids.astra;
  const amount = Math.floor(Math.min(going.salvaged[sellItem], C.snap().stations[sellAt]?.storage?.[C.id]?.[sellItem] ?? 0));
  const serr = await C.command({ c: 'sell', station: sellAt, res: sellItem, amount });
  await delay(1500);
  const cr1 = C.snap().companies[C.id].credits;
  check(serr === null && cr1 > cr0, '8: C sells recovered goods at the market for credits', { item: sellItem, amount, credits: cr1 - cr0, err: serr });
  // 9. lifetime: skip the clock to the wreck's expiry (server stopped), the remainder is destroyed and nobody follows it
  await stop();
  const f2 = JSON.parse(readFileSync(save, 'utf8'));
  const leftBefore = (f2.world.wrecks?.[target.id]?.lots ?? []).reduce((n: number, l: any) => n + l.n, 0);
  for (const w of Object.values<any>(f2.world.wrecks ?? {})) w.expires = f2.world.time + 3;
  writeFileSync(save, JSON.stringify(f2));
  await start(); await A.connect(); await C.connect();
  await until(() => !Object.keys(C.snap().wrecks ?? {}).length, 'wrecks did not expire', 60000);
  await until(() => C.snap().groups[ids.cg]?.salv?.phase === 'hold' || C.snap().groups[ids.cg]?.salv?.phase === 'unload', 'C did not stop following the gone wreck', 120000);
  check(true, '9: at expiry the wrecks are removed (remainder destroyed) and C stops following them (holds the zone / unloads)', { leftBefore, phase: C.snap().groups[ids.cg].salv.phase });
  // 10. accounting from the save: recovered + remaining + destroyed by decay never exceeds the wreck
  await stop();
  const f3 = JSON.parse(readFileSync(save, 'utf8'));
  check(!Object.keys(f3.world.wrecks ?? {}).length, '10: no wreck left in the save (no duplicate copy anywhere)');
  mkdirSync('artifacts/p131', { recursive: true });
  writeFileSync('artifacts/p131/server-results.json', JSON.stringify({ passed: checks.length, checks, facts, realWebSockets: 3, restarts: 3, seconds: Math.round((Date.now() - T0) / 1000) }, null, 2));
  console.log(JSON.stringify({ passed: checks.length, seconds: Math.round((Date.now() - T0) / 1000) }));
} finally { await stop(); }

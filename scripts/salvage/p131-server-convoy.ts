// P13.1 supplement — strict real-server proof of the whole cargo path: a loaded hauler is SUNK in a real P11
// battle, its surviving cargo becomes a wreck, A (on-site) and C (designated recover) take it into their real
// holds, the server restarts at several points, C docks and unloads, sells, and every unit is accounted for.
// `node dist-server/server.mjs` with SALVAGE_P131=1, three real WebSocket accounts. Starting ships are placed
// once with the server stopped (layout 'close' from p131-convoy-trials.ts: A 6 corvettes + 2 destroyers 300 m
// from B's convoy of a hauler + 2 destroyers + a corvette); after that only real commands and the server's
// simulation. Nothing in a battle or a save is edited. If the hauler is not sunk the run FAILS (no
// conditional pass).   Needs `npm run build` first.   npx vite-node scripts/salvage/p131-server-convoy.ts
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import WebSocket from 'ws';
import { WorldSim } from '../../src/world/sim';

const SEED = '9412';
const dir = mkdtempSync(path.join(tmpdir(), 'siderarium-p131c-'));
const save = path.join(dir, 'world.json'), analytics = path.join(dir, 'world.analytics.json');
const binary = path.resolve('dist-server/server.mjs'), staticDir = path.resolve('dist');
const probe = net.createServer();
await new Promise<void>(r => probe.listen(0, '127.0.0.1', () => r()));
const port = (probe.address() as net.AddressInfo).port; await new Promise(r => probe.close(r));
const base = `http://127.0.0.1:${port}`, checks: { label: string; extra?: unknown }[] = [], sockets: WebSocket[] = [], facts: Record<string, any> = { seed: SEED, layout: 'close' };
const T0 = Date.now();
let child: ChildProcess | undefined, restarts = 0;
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until<T>(fn: () => T | Promise<T>, reason: string, ms = 120000): Promise<NonNullable<T>> { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v as NonNullable<T>; await delay(150); } throw Error(reason); }
function check(ok: unknown, label: string, extra?: unknown) { if (!ok) throw Error('FAIL ' + label + (extra !== undefined ? ' ' + JSON.stringify(extra) : '')); checks.push({ label, ...(extra === undefined ? {} : { extra }) }); console.log(`PASS [${Math.round((Date.now() - T0) / 1000)}s]`, label, extra !== undefined ? JSON.stringify(extra) : ''); }
async function start() {
  let log = '';
  child = spawn('node', [binary], { cwd: dir, env: { ...process.env, PORT: String(port), STATIC_DIR: staticDir, SAVE_FILE: save, DATABASE_URL: '', WORLD_RESET: '', CONTENT_MIGRATE: '', WORLD_SEED: SEED, SAVE_INTERVAL_S: '.5', SALVAGE_P131: '1', AUTO_LOGISTICS_P125: '', FLEET_OPS_P12: '', COMBAT_P11: '' } });
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
const A = new Pilot('A 군사 PMC'), B = new Pilot('B 운송 PMC'), C = new Pilot('C 인양 PMC');
const sum = (o: any) => Object.values<number>(o ?? {}).reduce((a, n) => a + n, 0);
const ITEMS = ['metal', 'electronics'] as const;
const readWorld = () => JSON.parse(readFileSync(save, 'utf8')).world;
/** per item: what the wreck holds now in every lot + what every company has taken = what it was made with */
const wreckTotals = (w: any) => { const o: Record<string, number> = {}; for (const l of w.lots) o[l.item] = (o[l.item] ?? 0) + l.n; for (const m of Object.values<any>(w.taken)) for (const [k, v] of Object.entries<number>(m)) o[k] = (o[k] ?? 0) + v;
  // item order follows lot / taken order, which changes as goods are taken — compare per item, not by key order
  return Object.fromEntries(Object.keys(o).sort().map(k => [k, +o[k].toFixed(6)])); };
const cargoLots = (w: any, owner: string) => Object.fromEntries(ITEMS.map(k => [k, w.lots.filter((l: any) => l.k === 'cargo' && l.item === k && l.owner === owner).reduce((n: number, l: any) => n + l.n, 0)]));
const flowOf = () => { // the server's own event analytics (consume / to_wreck / recover / unload rows by company and item)
  if (!existsSync(analytics)) return null;
  const st = JSON.parse(readFileSync(analytics, 'utf8')).store;
  const rows = [...(st.hourly ?? []).flatMap((h: any) => h.rows ?? []), ...(st.current?.rows ?? [])];
  const f: Record<string, number> = {};
  for (const r of rows) if (r.item && ['consume', 'salvage', 'logistics'].includes(r.kind)) { const k = `${r.kind}/${r.reason}/${r.company ?? ''}/${r.item}`; f[k] = (f[k] ?? 0) + r.amount; }
  return f;
};
async function restart(label: string, verify: (before: any, after: any) => void) {
  await stop(); restarts++;
  const before = readWorld();
  await start(); await A.connect(); await B.connect(); await C.connect();
  await delay(1200);
  verify(before, readWorld());
  console.log(`-- restart ${restarts} (${label}) done`);
  return before;
}

try {
  // 0. three accounts on a fresh P13.1 server
  await start();
  await A.signup('p131c_a'); await B.signup('p131c_b'); await C.signup('p131c_c');
  await A.connect(); await B.connect(); await C.connect();
  const s0 = A.snap();
  check(s0.salvageV === 1 && s0.combatV === 2 && s0.opsV === 1 && s0.logisticsV === 1 && !s0.sites, '0: SALVAGE_P131=1 server, P13.1 world, three real accounts');
  await stop();
  // starting assets (server stopped): real ships, real cargo
  const file = JSON.parse(readFileSync(save, 'utf8'));
  const sim = new WorldSim(file.world, { migrateContent: false });
  for (const id of Object.keys(sim.st.ships)) delete sim.st.ships[id];
  for (const id of Object.keys(sim.st.groups)) delete sim.st.groups[id];
  for (const l of Object.values(sim.st.lairs)) { l.alive = false; l.respawnAt = 1e10; }
  const ast = sim.st.stations.astra, at = (dx: number, dz: number) => ({ x: ast.pos.x + dx, y: 0, z: ast.pos.z + dz });
  const fleet = (o: string, name: string, pos: any, comp: string[]) => { const g = sim.newGroup(o, name); g.commanderId = sim.newCommander(o, 2).id; comp.forEach((cl, i) => sim.spawnShip(o, cl, 'std', g.id, { x: pos.x + i * 40, y: 0, z: pos.z })); return g; };
  const conv = fleet(B.id, 'B 호송대', at(4000, 2500), ['hauler', 'destroyer', 'destroyer', 'corvette']);
  const hauler = sim.st.ships[conv.shipIds[0]]; hauler.cargo.metal = 300; hauler.cargo.electronics = 120; hauler.logisticsExcluded = true;
  const war = fleet(A.id, 'A 요격대', at(3700, 2500), ['corvette', 'corvette', 'corvette', 'corvette', 'corvette', 'corvette', 'destroyer', 'destroyer']);
  const cg = fleet(C.id, 'C 인양대', at(1500, -500), ['hauler']);
  for (const co of [A.id, B.id, C.id]) sim.st.companies[co].credits = 1e6;
  file.world = JSON.parse(sim.serialize()); writeFileSync(save, JSON.stringify(file));
  const ids = { conv: conv.id, hauler: hauler.id, war: war.id, cg: cg.id, cship: cg.shipIds[0] };
  facts.ids = ids; facts.fleets = { A: ['corvette×6', 'destroyer×2'], B: ['hauler (metal 300, electronics 120)', 'destroyer×2', 'corvette'], C: ['hauler'] }; facts.cargoBefore = { metal: 300, electronics: 120 };

  await start(); await A.connect(); await B.connect(); await C.connect();
  const hb = B.snap().ships[ids.hauler];
  check(hb?.cargo?.metal === 300 && hb?.cargo?.electronics === 120, '1: B\'s hauler carries metal 300 + electronics 120 (escort: 2 destroyers, 1 corvette)');
  // 2. A attacks the convoy — a real P11 battle
  check(await A.command({ c: 'setOp', group: ids.war, op: { k: 'attack', group: ids.conv } }) === null, '2: A orders its interceptors to attack B\'s convoy');
  await until(() => Object.values<any>(A.snap().engagements ?? {}).some(e => e.sides?.flat?.().includes(B.id)) || (A.snap().battleLog ?? []).some((b: any) => b.sides?.some((x: any) => x.company === B.id)), 'no battle', 300000);
  check(true, '2: a real P11 engagement A ↔ B started');
  // 3. the hauler must be really sunk (destroyed in a battle, not escaped / withdrawn)
  const sunkAt = await until(() => { const s = A.snap(); if (s.ships[ids.hauler]) return null; const w = Object.values<any>(s.wrecks ?? {}).find(w => w.sources?.some((x: any) => x.ship === ids.hauler)); return w ? { s, w } : null; }, 'the hauler was not sunk within 15 minutes (it escaped or no battle reached it) — real-server verification FAILED', 900000);
  const eng = sunkAt.w.eng;
  const blog = await until(() => (A.snap().battleLog ?? []).find((b: any) => b.id === eng), 'battle not logged', 60000);
  const bSide = blog.sides.findIndex((x: any) => x.company === B.id);
  facts.battle = { eng, start: blog.start, end: blog.end, summary: blog.summary, sides: blog.sides, losses: blog.losses };
  check(blog.losses[bSide] >= 1 && (blog.sides[bSide].status === 'destroyed' || blog.sides[bSide].status === 'routed' || blog.sides[bSide].status === 'withdrawn'), '3: the hauler was SUNK in a real battle (not escaped): it is gone from the world and is a source of a wreck of that battle', facts.battle);
  const w0 = sunkAt.w;
  check(w0.known && w0.sources.some((s: any) => s.ship === ids.hauler && s.owner === B.id && s.classId === 'hauler'), '3: the wreck records the hauler as a source with B as original owner', { wreck: w0.id, name: w0.name, sources: w0.sources.map((s: any) => `${s.classId}:${s.owner}`) });
  const cargo0 = cargoLots(w0, B.id);
  facts.cargoInWreck = cargo0;
  check(ITEMS.every(k => cargo0[k] > 0 && cargo0[k] < facts.cargoBefore[k]), '3: part of the real cargo is in the wreck as B-owned cargo lots, the rest was destroyed', cargo0);
  // restart 1: right after the battle and the wreck
  await restart('after battle, wreck created', (before, after) => {
    const wb = before.wrecks[w0.id], wa = after.wrecks[w0.id];
    check(wb && wa && JSON.stringify(wreckTotals(wb)) === JSON.stringify(wreckTotals(wa)) && !after.ships[ids.hauler], 'R1: after a restart right after the battle the wreck is the same (lots + taken) and the sunk hauler did not come back', { totals: wreckTotals(wa) });
  });
  // the server's own record of the sinking: destroyed + to_wreck = what the hauler carried
  const f1 = flowOf();
  const destroyed = Object.fromEntries(ITEMS.map(k => [k, f1?.[`consume/combat_cargo_loss/${B.id}/${k}`] ?? NaN]));
  const toWreck = Object.fromEntries(ITEMS.map(k => [k, f1?.[`salvage/to_wreck/${B.id}/${k}`] ?? NaN]));
  facts.sinking = { destroyed, toWreck };
  check(ITEMS.every(k => destroyed[k] + toWreck[k] === facts.cargoBefore[k] && toWreck[k] === cargo0[k]), 'B (condition): cargo at the sinking = destroyed + surviving in the wreck, per item, from the server\'s own event record', { before: facts.cargoBefore, destroyed, toWreck, lotsInWreck: cargo0 });
  const totals0 = wreckTotals(readWorld().wrecks[w0.id]);
  facts.wreckTotals = totals0;
  // 4. A stands down → automatic on-site salvage; C declares B hostile (B's cargo is then legal for C) and sends a designated recover
  check(await A.command({ c: 'setOp', group: ids.war, op: { k: 'idle' } }) === null, '4: A stands its group down (idle) — automatic on-site salvage may start');
  check(await C.command({ c: 'stance', target: B.id, v: -1 }) === null, '4: C declares B hostile (B\'s cargo becomes legal salvage for C)');
  check(await C.command({ c: 'setOp', group: ids.cg, op: { k: 'recover', wreck: w0.id } }) === null, '4: C orders its hauler to recover the wreck');
  const storeBefore = { ...(C.snap().stations?.astra?.storage?.[C.id] ?? {}) };
  // 5. both take B's cargo; nothing reaches C's storage before docking
  const part = await until(() => { const s = C.snap(), w = s.wrecks?.[w0.id], sh = s.ships[ids.cship]; return w && sum(w.taken?.[C.id]) > 0 && sum(sh?.salvaged) > 0 && sh.state === 'space' ? { w, sh } : null; }, 'C did not start recovering', 600000);
  const storeMid = C.snap().stations?.astra?.storage?.[C.id] ?? {};
  check(ITEMS.every(k => (storeMid[k] ?? 0) === (storeBefore[k] ?? 0)), 'D (condition): C\'s recovered goods are in its ship\'s hold, not in storage, before it docks', { hold: part.sh.salvaged, storage: Object.fromEntries(ITEMS.map(k => [k, storeMid[k] ?? 0])) });
  // restart 2: partial salvage
  await restart('partial salvage', (before, after) => {
    // the server keeps salvaging between the restart and this read: compare what cannot change, not a frozen copy
    const wb = before.wrecks[w0.id], wa = after.wrecks[w0.id];
    const tb = (c: string, k: string) => wb.taken[c]?.[k] ?? 0, ta = (c: string, k: string) => wa.taken[c]?.[k] ?? 0;
    const keys = [...new Set([...Object.keys(wb.taken[C.id] ?? {}), ...Object.keys(wa.taken[C.id] ?? {})])];
    const holdB = before.ships[ids.cship].salvaged ?? {}, holdA = after.ships[ids.cship].salvaged ?? {};
    check(after.groups[ids.cg].op.k === 'recover' && (after.groups[ids.cg].op as any).wreck === w0.id && !!after.groups[ids.cg].salv, 'R2 / E (condition): restart during salvage — C\'s recover order and salvage state are restored', { phase: after.groups[ids.cg].salv?.phase });
    check([A.id, C.id].every(c => keys.concat(Object.keys(wa.taken[c] ?? {})).every(k => ta(c, k) >= tb(c, k))) && keys.every(k => Math.abs((holdA[k] ?? 0) - (holdB[k] ?? 0) - (ta(C.id, k) - tb(C.id, k))) < 1e-6), 'R2 / E: nothing recovered before the restart was lost; what C took after it is exactly what was added to its hold', { before: { taken: wb.taken[C.id], hold: holdB }, after: { taken: wa.taken[C.id], hold: holdA } });
    check(JSON.stringify(wreckTotals(wa)) === JSON.stringify(totals0), 'R2: nothing taken was regenerated: lots + taken still equal what the wreck was made with', wreckTotals(wa));
  });

  await until(() => { const w = A.snap().wrecks?.[w0.id]; return w && sum(w.taken?.[A.id]) > 0; }, 'A\'s automatic on-site salvage took nothing', 300000);
  const ws = C.snap().wrecks?.[w0.id];
  check(sum(A.snap().wrecks[w0.id].taken[A.id]) > 0 && sum(ws.taken[C.id]) > 0, '5: A (automatic on-site) and C (designated recover) both recovered from the same wreck', { A: A.snap().wrecks[w0.id].taken[A.id], C: ws.taken[C.id] });
  // 6. C full (or the wreck has nothing more for it) → it flies to unload; restart on the way
  const going: any = await until(() => { const s = C.snap(), g = s.groups[ids.cg], sh = s.ships[ids.cship]; return g?.salv?.phase === 'unload' && sh?.state === 'space' && sum(sh.salvaged) > 0 ? { station: g.salv.station, salvaged: { ...sh.salvaged }, pos: sh.pos } : null; }, 'C never went to unload', 900000);
  check(sum(going.salvaged) > 0, '6: C carries its recovered goods to a station to unload', going);
  const storeBeforeUnload = { ...(C.snap().stations?.[going.station]?.storage?.[C.id] ?? {}) };
  await restart('carrying salvage to the station', (before, after) => {
    check(after.groups[ids.cg].salv?.phase === 'unload' && ITEMS.every(k => Math.abs((before.ships[ids.cship].salvaged?.[k] ?? 0) + (before.stations[going.station].storage?.[C.id]?.[k] ?? 0) - (after.ships[ids.cship].salvaged?.[k] ?? 0) - (after.stations[going.station].storage?.[C.id]?.[k] ?? 0)) < 1e-6), 'R3: restart while carrying — the unload phase is restored and hold + storage per item are unchanged', { hold: after.ships[ids.cship].salvaged, phase: after.groups[ids.cg].salv?.phase });
  });
  // try to catch the unload itself (docked with salvage still aboard); restart there too
  const docked = await until(() => { const s = C.snap(), sh = s.ships[ids.cship]; return sh?.state === 'docked' ? { salvaged: { ...(sh.salvaged ?? {}) } } : null; }, 'C did not dock', 600000);
  if (sum(docked.salvaged) > 0) {
    await restart('docked, unloading', (before, after) => {
      const k = (w: any) => ITEMS.map(i => (w.ships[ids.cship].salvaged?.[i] ?? 0) + (w.stations[going.station].storage[C.id]?.[i] ?? 0));
      check(JSON.stringify(k(before)) === JSON.stringify(k(after)), 'R4: restart while unloading — hold + storage per item unchanged (nothing lost, nothing doubled)', { holdPlusStorage: k(after) });
    });
  } else console.log('INFO R4: the unload finished within one tick of docking — no restart during the unload itself');
  const after = await until(() => { const s = C.snap(); return sum(s.ships[ids.cship]?.salvaged) === 0 ? s : null; }, 'C did not unload', 300000);
  const storeAfterUnload = after.stations[going.station].storage[C.id] ?? {};
  const added = Object.fromEntries(Object.keys(going.salvaged).map(k => [k, (storeAfterUnload[k] ?? 0) - (storeBeforeUnload[k] ?? 0)]));
  check(Object.keys(going.salvaged).every(k => Math.abs(added[k] - going.salvaged[k]) < 1e-6), '7: C docks and unloads exactly what it carried into its storage', { carried: going.salvaged, added });
  // 8. sell at the market
  const sellAt = after.stations[going.station].market ? going.station : 'astra';
  const sellItem = ITEMS.find(k => (C.snap().stations[sellAt]?.storage?.[C.id]?.[k] ?? 0) >= 1) ?? ITEMS[0];
  const amount = Math.floor(C.snap().stations[sellAt]?.storage?.[C.id]?.[sellItem] ?? 0);
  const cr0 = C.snap().companies[C.id].credits;
  const serr = await C.command({ c: 'sell', station: sellAt, res: sellItem, amount });
  await delay(1500);
  const sAfter = C.snap();
  const cr1 = sAfter.companies[C.id].credits;
  check(serr === null && amount > 0 && cr1 > cr0 && Math.abs((sAfter.stations[sellAt].storage[C.id]?.[sellItem] ?? 0) - 0) < 1, '8: C sells the recovered goods at the market: storage down, credits up', { station: sellAt, item: sellItem, amount, credits: Math.round((cr1 - cr0) * 100) / 100 });
  facts.sale = { station: sellAt, item: sellItem, amount, credits: cr1 - cr0 };
  // 9. final accounting from the server save
  await stop(); restarts++;
  const fw = readWorld(), wf = fw.wrecks?.[w0.id], fl = flowOf();
  const tot = wf ? wreckTotals(wf) : null;
  check(wf && JSON.stringify(tot) === JSON.stringify(totals0), 'C (condition): what the wreck was made with = left in it + taken by A + taken by C (+ others), per item, at the end', { made: totals0, left: Object.fromEntries(ITEMS.map(k => [k, wf.lots.filter((l: any) => l.item === k).reduce((n: number, l: any) => n + l.n, 0)])), taken: wf.taken });
  check(Object.keys(wf.taken).every(c => c === A.id || c === C.id), 'C: only A and C took anything from it');
  const recC = Object.fromEntries(ITEMS.map(k => [k, fl?.[`salvage/recover/${C.id}/${k}`] ?? 0]));
  const unC = Object.fromEntries(ITEMS.map(k => [k, fl?.[`logistics/salvage_unload/${C.id}/${k}`] ?? 0]));
  const holdC = fw.ships[ids.cship].salvaged ?? {};
  check(ITEMS.every(k => Math.abs(recC[k] - (wf.taken[C.id]?.[k] ?? 0)) < 1e-6 && Math.abs(recC[k] - unC[k] - (holdC[k] ?? 0)) < 1e-6), 'D: everything C took is either unloaded into its storage or still in its hold (server event record = wreck record)', { recovered: recC, unloaded: unC, hold: holdC });
  const holdA = Object.values<any>(fw.ships).filter(s => s.owner === A.id).reduce((m: Record<string, number>, s) => { for (const [k, v] of Object.entries<number>(s.salvaged ?? {})) m[k] = (m[k] ?? 0) + v; return m; }, {});
  const unA = Object.fromEntries(Object.keys(wf.taken[A.id] ?? {}).map(k => [k, fl?.[`logistics/salvage_unload/${A.id}/${k}`] ?? 0]));
  check(Object.entries<number>(wf.taken[A.id] ?? {}).every(([k, v]) => Math.abs(v - (holdA[k] ?? 0) - (unA[k] ?? 0)) < 1e-6), 'D: everything A took is in A\'s holds or unloaded', { taken: wf.taken[A.id], hold: holdA, unloaded: unA });
  check(!fw.ships[ids.hauler] && Object.values<any>(fw.wrecks).filter(w => w.sources.some((s: any) => s.ship === ids.hauler)).length === 1, 'no double sinking: the hauler is in exactly one wreck and nowhere else');
  // §2: every recorded battle's side status matches what happened to that side's ships (battle log of the save)
  const shipsOf = (n: any): number => (n.ships?.length ?? 0) + (n.children ?? []).reduce((a: number, c: any) => a + shipsOf(c), 0);
  facts.battleLog = (fw.battleLog ?? []).map((e: any) => ({ id: e.id, start: e.start, end: e.end, summary: e.summary, sides: e.sides.map((sd: any, k: number) => ({ company: sd.company, status: sd.status, ships: shipsOf(e.setup.fleets[k].root), lost: e.losses[k] })) }));
  check(facts.battleLog.length > 0 && facts.battleLog.every((e: any) => e.sides.every((sd: any) => sd.status !== 'destroyed' || sd.lost === sd.ships)), 'P11: a side recorded as destroyed lost every ship it brought; a side whose ships partly escaped is not "destroyed"', facts.battleLog.map((e: any) => `${e.id}: ` + e.sides.map((sd: any) => `${sd.status} ${sd.lost}/${sd.ships}`).join(' vs ')));
  const ledger = fw.companies[C.id].ops?.ledger;
  facts.ledgerC = ledger?.slice?.(-2);
  facts.creditsEnd = Object.fromEntries([A.id, B.id, C.id].map(c => [c, Math.round(fw.companies[c].credits)]));
  facts.storageC = Object.fromEntries(Object.entries<any>(fw.stations).map(([id, s]) => [id, s.storage?.[C.id]]).filter(([, v]) => v && Object.keys(v).length));
  console.log('ledger C (last hours):', JSON.stringify(facts.ledgerC));
  mkdirSync('artifacts/p131', { recursive: true });
  writeFileSync('artifacts/p131/server-convoy-results.json', JSON.stringify({ passed: checks.length, checks, facts, realWebSockets: 3, restarts, seconds: Math.round((Date.now() - T0) / 1000) }, null, 2));
  console.log(JSON.stringify({ passed: checks.length, restarts, seconds: Math.round((Date.now() - T0) / 1000) }));
} catch (e) {
  mkdirSync('artifacts/p131', { recursive: true });
  writeFileSync('artifacts/p131/server-convoy-results.json', JSON.stringify({ failed: String((e as Error).message ?? e), passed: checks.length, checks, facts, restarts, seconds: Math.round((Date.now() - T0) / 1000) }, null, 2));
  console.log(String((e as Error).message ?? e));
  process.exitCode = 1;
} finally { await stop(); }

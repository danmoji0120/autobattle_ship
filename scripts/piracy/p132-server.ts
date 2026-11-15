// P13.2 §16 on a real server process: `node dist-server/server.mjs` with PIRACY_P132=1 and three real
// WebSocket accounts — A raider, B hauling company (P12.5 automatic logistics + escorts), C third-party
// salvager. Starting assets are placed once with the server stopped (p132-scenarios.ts `place`); after that
// every step is a real command of one of the accounts or the server's own simulation. The four scenarios run
// at the same time in four separate areas. Afterwards the server is restarted once (containers, wrecks, raid
// book and policies must come back), and every unit of the scenario goods is accounted for from the server
// save and the server's own event analytics. Needs `npm run build` first.
//   npx vite-node scripts/piracy/p132-server.ts [attempt-label]
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import WebSocket from 'ws';
import { WorldSim } from '../../src/world/sim';
import { place, scenario1, scenario2, scenario3, scenario4, sum, type Driver } from './p132-scenarios';

const SEED = process.env.SEED ?? '9413';
const label = process.argv[2] ?? 'run';
const dir = mkdtempSync(path.join(tmpdir(), 'siderarium-p132-'));
const save = path.join(dir, 'world.json'), analytics = path.join(dir, 'world.analytics.json');
const binary = path.resolve('dist-server/server.mjs'), staticDir = path.resolve('dist');
const probe = net.createServer();
await new Promise<void>(r => probe.listen(0, '127.0.0.1', () => r()));
const port = (probe.address() as net.AddressInfo).port; await new Promise(r => probe.close(r));
const base = `http://127.0.0.1:${port}`, sockets: WebSocket[] = [];
const checks: { ok: boolean; label: string; extra?: unknown; t: number }[] = [], infos: { label: string; extra?: unknown }[] = [], facts: Record<string, any> = { seed: SEED, label };
const T0 = Date.now();
let child: ChildProcess | undefined;
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until<T>(fn: () => T | Promise<T>, reason: string, ms = 120000): Promise<NonNullable<T>> { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v as NonNullable<T>; await delay(150); } throw Error(reason); }
function check(ok: unknown, l: string, extra?: unknown) { checks.push({ ok: !!ok, label: l, ...(extra === undefined ? {} : { extra }), t: Math.round((Date.now() - T0) / 1000) }); console.log(ok ? 'PASS' : 'FAIL', `[${Math.round((Date.now() - T0) / 1000)}s]`, l, extra !== undefined ? JSON.stringify(extra) : ''); }
async function start() {
  let log = '';
  child = spawn('node', [binary], { cwd: dir, env: { ...process.env, PORT: String(port), STATIC_DIR: staticDir, SAVE_FILE: save, DATABASE_URL: '', WORLD_RESET: '', CONTENT_MIGRATE: '', WORLD_SEED: SEED, SAVE_INTERVAL_S: '.5', PIRACY_P132: '1', SALVAGE_P131: '', AUTO_LOGISTICS_P125: '', FLEET_OPS_P12: '', COMBAT_P11: '' } });
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
    const r = await fetch(base + '/api/auth/signup', { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ loginId, password: 'p132-test-password-123', confirm: 'p132-test-password-123' }) });
    this.cookie = r.headers.get('set-cookie')?.split(';')[0] ?? '';
    if (r.status !== 200 || !this.cookie) throw Error(`signup failed: ${r.status}`);
  }
  async connect() {
    this.messages = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { origin: base, cookie: this.cookie } }); this.ws = ws; sockets.push(ws);
    ws.on('message', raw => {
      const m = JSON.parse(String(raw));
      if (m.t === 'snap') this.messages = this.messages.filter(x => x.t !== 'snap');
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
  snap() { return this.messages.filter(m => m.t === 'snap').at(-1).state; }
}
const readWorld = () => JSON.parse(readFileSync(save, 'utf8')).world;
const flowOf = () => {
  if (!existsSync(analytics)) return {};
  const st = JSON.parse(readFileSync(analytics, 'utf8')).store;
  const rows = [...(st.hourly ?? []).flatMap((h: any) => h.rows ?? []), ...(st.current?.rows ?? []), ...(st.fine ?? []).flatMap((h: any) => h.rows ?? [])];
  const f: Record<string, number> = {};
  for (const r of rows) if (r.item && ['consume', 'salvage', 'logistics', 'piracy'].includes(r.kind)) { const k = `${r.kind}/${r.reason}/${r.company ?? ''}/${r.item}`; f[k] = (f[k] ?? 0) + r.amount; }
  return f;
};

const A = new Pilot('A 약탈 PMC'), B = new Pilot('B 운송 PMC'), C = new Pilot('C 인양 PMC');
const P = { A, B, C } as const;
try {
  await start();
  await A.signup('p132_a'); await B.signup('p132_b'); await C.signup('p132_c');
  await A.connect(); await B.connect(); await C.connect();
  const s0 = A.snap();
  check(s0.piracyV === 1 && s0.salvageV === 1 && s0.logisticsV === 1 && s0.opsV === 1 && s0.combatV === 2 && !s0.piracy, '0: PIRACY_P132=1 server creates a P13.2 world (P11+P12+P12.5+P13.1); the raid book is not sent to clients');
  await stop();
  // starting assets, placed once with the server stopped
  const file = JSON.parse(readFileSync(save, 'utf8'));
  const sim = new WorldSim(file.world, { migrateContent: false });
  const ids = place(sim, A.id, B.id, C.id);
  file.world = JSON.parse(sim.serialize()); writeFileSync(save, JSON.stringify(file));
  facts.ids = ids;
  await start(); await A.connect(); await B.connect(); await C.connect();
  const d: Driver = {
    cmd: (w, c) => P[w].command(c),
    view: w => P[w].snap(),
    time: () => A.snap().time,
    async wait(fn, why, s) { return until(() => { try { return fn(); } catch { return null; } }, why, (s + 30) * 1000); },
    log: (ok, l, extra) => check(ok, l, extra),
    info: (l, extra) => { infos.push({ label: l, ...(extra === undefined ? {} : { extra }) }); console.log('INFO', l, extra !== undefined ? JSON.stringify(extra) : ''); },
  };
  const runs = await Promise.allSettled([scenario1, scenario2, scenario3, scenario4].map(f => f(d, ids, A.id, B.id, C.id, facts)));
  runs.forEach((r, i) => { if (r.status === 'rejected') check(false, `scenario ${i + 1} ran to the end`, { error: String(r.reason).slice(0, 300) }); });
  // restart: containers, wrecks, raid book, policies come back
  await delay(2000);
  await stop();
  const w1 = readWorld();
  await start(); await A.connect(); await B.connect(); await C.connect();
  await delay(1500);
  await stop();
  const w2 = readWorld();
  const pick = (w: any) => ({ drops: Object.keys(w.drops ?? {}).sort(), dropLots: Object.values<any>(w.drops ?? {}).map(x => sum(Object.fromEntries(x.lots.map((l: any) => [l.id, l.n])))), wrecks: Object.keys(w.wrecks ?? {}).sort(), log: w.piracy?.log?.length, logIds: (w.piracy?.log ?? []).map((x: any) => x.id + ':' + x.kind), pol: [w.groups[ids.s1h]?.piracyPolicy, w.groups[ids.s2v]?.piracyPolicy] });
  const p1 = pick(w1), p2 = pick(w2);
  check(JSON.stringify(p1.drops) === JSON.stringify(p2.drops) && JSON.stringify(p1.wrecks) === JSON.stringify(p2.wrecks) && p1.log > 0 && JSON.stringify(p2.logIds.slice(0, p1.log)) === JSON.stringify(p1.logIds) && JSON.stringify(p1.pol) === JSON.stringify(p2.pol), 'restart: containers, wrecks, the raid book (saved entries are an exact prefix after the restart; the world keeps running) and the response policies are restored from the save', { before: { ...p1, logIds: undefined }, after: { ...p2, logIds: undefined }, newAfterRestart: p2.logIds.slice(p1.log) });
  // accounting from the save and the server's own event analytics
  const co = [A.id, B.id, C.id];
  const flows = flowOf(); facts.flows = flows;
  const held = (w: any, item: string) => {
    let n = 0;
    for (const s of Object.values<any>(w.ships)) if (co.includes(s.owner)) n += s.cargo?.[item] ?? 0;
    for (const st of Object.values<any>(w.stations)) for (const c of co) n += st.storage?.[c]?.[item] ?? 0;
    for (const x of Object.values<any>(w.drops ?? {})) n += x.lots.filter((l: any) => l.item === item).reduce((a: number, l: any) => a + l.n, 0);
    for (const x of Object.values<any>(w.wrecks ?? {})) n += x.lots.filter((l: any) => l.item === item && l.k === 'cargo').reduce((a: number, l: any) => a + l.n, 0);
    return n;
  };
  const gone = (item: string) => Object.entries(flows).filter(([k]) => /^consume\/(combat_cargo_loss|drop_decay|wreck_decay)\//.test(k) && co.some(c => k.endsWith(`/${c}/${item}`))).reduce((a, [, n]) => a + n, 0);
  const acct: Record<string, any> = {};
  for (const [item, start0] of [['ore', 900], ['metal', 300], ['electronics', 120], ['composite', 600], ['machinery', 2000]] as const) {
    const h = held(w2, item), g = gone(item);
    acct[item] = { start: start0, heldNow: +h.toFixed(3), destroyed: +g.toFixed(3) };
  }
  facts.accounting = acct;
  // ore/metal/electronics/composite: only these scenarios' companies hold them (S4's machinery may mix with the band's other loot in the lair)
  for (const item of ['ore', 'metal', 'electronics', 'composite']) check(Math.abs(acct[item].heldNow + acct[item].destroyed - acct[item].start) < 1e-6, `accounting ${item}: ships + storages + containers + wrecks + destroyed (server analytics) = what was placed, exactly`, acct[item]);
  const dr4 = Object.values<any>(w2.drops ?? {}).find(x => x.owner === B.id && x.by === 'pirates');
  if (dr4) { const t = Object.values<any>(dr4.taken).reduce((a, m) => a + (m.machinery ?? 0), 0); const left = dr4.lots.reduce((a: number, l: any) => a + l.n, 0); facts.s4acct = { initial: dr4.initial, taken: dr4.taken, left }; check(t + left === dr4.initial, 'S4-6: the pirates\' container in the save: taken (pirates, B) + left = what was jettisoned', facts.s4acct); }
  else infos.push({ label: 'S4 container gone from the save (exhausted or expired) — its totals are in the analytics', extra: Object.fromEntries(Object.entries(flows).filter(([k]) => k.endsWith('/machinery'))) });
  const lairHold = Object.values<any>(w2.lairs).map(l => l.hold).filter(Boolean);
  facts.lairHold = lairHold;
  const pirTook = Object.entries(flows).filter(([k]) => k.startsWith('salvage/recover/pirates/')).reduce((a, [, n]) => a + n, 0);
  const stored = Object.entries(flows).filter(([k]) => k.startsWith('piracy/lair_store/')).reduce((a, [, n]) => a + n, 0);
  facts.npc = { recoveredByPirates: pirTook, storedAtLair: stored };
  check(stored <= pirTook + 1e-6, 'S4-4/6: what reached the lair is never more than the pirates physically recovered (server analytics)', facts.npc);
  const nonDestructive = checks.find(c => c.label.startsWith('S1: no P11 engagement anywhere near the raid'))?.ok && checks.find(c => c.label.startsWith('S1-4/5/6/10'))?.ok;
  const forced = checks.find(c => c.label.startsWith('S2-6'))?.ok || checks.find(c => c.label.startsWith('S3-4'))?.ok;
  check(nonDestructive, 'REQUIRED: a plunder succeeded without any P11 battle (S1)');
  check(forced, 'REQUIRED: a plunder that turned into a real P11 battle and a sinking (S2 or S3)');
} catch (e) { check(false, 'run', { error: String((e as Error)?.stack ?? e).slice(0, 800) }); }
finally {
  await stop();
  mkdirSync('artifacts/p132', { recursive: true });
  const passed = checks.filter(c => c.ok).length, failed = checks.filter(c => !c.ok).length;
  writeFileSync(`artifacts/p132/server-${label}.json`, JSON.stringify({ passed, failed, checks, infos, facts, realWebSockets: 3, restarts: 2, seconds: Math.round((Date.now() - T0) / 1000) }, null, 2));
  console.log(JSON.stringify({ passed, failed, seconds: Math.round((Date.now() - T0) / 1000) }));
  process.exit(failed ? 1 : 0);
}

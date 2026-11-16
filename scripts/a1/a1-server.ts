// A-1 on a real server process (`node dist-server/server.mjs`, file storage, three real WebSocket accounts).
//   1 — no world flags at all: an empty storage creates the integrated standard world (P10 40 systems / 6 factions,
//       faction economy v2, P11..P14). Three accounts create companies with normal starting conditions.
//   2 — the world (rules, companies) survives a restart; legacy per-system flags set on that restart change nothing.
//   3 — WORLD_RESET with a stray legacy flag (COMBAT_P11=1): the new world has exactly the standard rules again, every
//       company is gone, the accounts survive and log in, and each gets "create your PMC" with the same starting
//       conditions as on the first start. The same token a second time does nothing.
//   4 — WORLD_PRESET=legacy on an empty storage still creates the old P9 world; an unknown WORLD_PRESET stops the server.
// Needs `npm run build` first.   npx vite-node scripts/a1/a1-server.ts [out.json]
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import WebSocket from 'ws';
import { worldRules } from '../../src/world/worldPreset';

const SEED = '41';
const out = process.argv[2] ?? 'a1-server.json';
const binary = path.resolve('dist-server/server.mjs'), staticDir = path.resolve('dist');
const probe = net.createServer();
await new Promise<void>(r => probe.listen(0, '127.0.0.1', () => r()));
const port = (probe.address() as net.AddressInfo).port; await new Promise(r => probe.close(r));
const base = `http://127.0.0.1:${port}`, sockets: WebSocket[] = [];
let child: ChildProcess | undefined;
const T0 = Date.now();
const checks: { ok: boolean; label: string; extra?: unknown; t: number }[] = [];
const facts: Record<string, any> = { seed: SEED };
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until<T>(f: () => T | null | undefined | false, why: string, ms = 30000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const v = f(); if (v) return v; if (Date.now() > end) throw Error(why); await delay(250); }
}
function check(ok: unknown, l: string, extra?: unknown) { checks.push({ ok: !!ok, label: l, ...(extra === undefined ? {} : { extra }), t: Math.round((Date.now() - T0) / 1000) }); console.log(ok ? 'PASS' : 'FAIL', l, extra !== undefined ? JSON.stringify(extra).slice(0, 600) : ''); }
let serverLog = '', allLog = '';
let dir = mkdtempSync(path.join(tmpdir(), 'siderarium-a1-'));
const saveOf = () => path.join(dir, 'world.json');
const NO_FLAGS = { ECON_PRICING: '', COMBAT_P11: '', FLEET_OPS_P12: '', AUTO_LOGISTICS_P125: '', SALVAGE_P131: '', PIRACY_P132: '', BLACKMARKET_P133: '', LAW_P134: '', REPUTATION_P14: '', REPUTATION_P14_MIGRATE: '', WORLD_PRESET: '' };
function spawnServer(env: Record<string, string>) {
  serverLog = '';
  const env2: Record<string, string | undefined> = { ...process.env, PORT: String(port), STATIC_DIR: staticDir, SAVE_FILE: saveOf(), DATABASE_URL: '', WORLD_RESET: '', CONTENT_MIGRATE: '', WORLD_SEED: SEED, SAVE_INTERVAL_S: '.5', ...NO_FLAGS, ...env };
  for (const k of Object.keys(env2)) if (env2[k] === '') delete env2[k]; // unset, exactly as an operator who never set it
  child = spawn('node', [binary], { cwd: dir, env: env2 as NodeJS.ProcessEnv });
  child.stdout!.on('data', d => { serverLog += d; allLog += d; }); child.stderr!.on('data', d => { serverLog += d; allLog += d; });
  return child;
}
async function start(env: Record<string, string> = {}) {
  spawnServer(env);
  await until(() => { if (child!.exitCode !== null) throw Error(serverLog); return serverLog.includes('listening on'); }, `server did not start: ${serverLog}`);
}
async function stop() {
  for (const s of sockets.splice(0)) s.close();
  if (child) { const p = child; child = undefined; if (p.exitCode === null && p.signalCode === null) await new Promise(r => { p.once('exit', r); p.kill('SIGTERM'); }); }
}
class Pilot {
  messages: any[] = []; seq = 1; ws!: WebSocket; cookie = ''; id = ''; sawNeedPmc = false; start: any;
  constructor(readonly name: string) {}
  async signup(loginId: string) {
    const r = await fetch(base + '/api/auth/signup', { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ loginId, password: 'a1-test-password-123', confirm: 'a1-test-password-123' }) });
    this.cookie = r.headers.get('set-cookie')?.split(';')[0] ?? '';
    if (r.status !== 200 || !this.cookie) throw Error(`signup failed: ${r.status}`);
  }
  async login(loginId: string) {
    const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ loginId, password: 'a1-test-password-123' }) });
    this.cookie = r.headers.get('set-cookie')?.split(';')[0] ?? '';
    return r.status;
  }
  async connect() {
    this.messages = []; this.sawNeedPmc = false;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { origin: base, cookie: this.cookie } }); this.ws = ws; sockets.push(ws);
    ws.on('message', raw => {
      const m = JSON.parse(String(raw));
      if (m.t === 'snap') this.messages = this.messages.filter(x => x.t !== 'snap');
      this.messages.push(m);
      if (m.t === 'needPmc') { this.sawNeedPmc = true; this.start = m.start; ws.send(JSON.stringify({ t: 'createPmc', name: this.name })); }
    });
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    ws.send(JSON.stringify({ t: 'hello', name: this.name }));
    this.id = (await this.wait(m => m.t === 'welcome')).company;
    await this.wait(m => m.t === 'snap');
  }
  wait(test: (m: any) => boolean, ms?: number) { return until(() => this.messages.find(test), `missing response for ${this.name}`, ms); }
  snap() { return this.messages.filter(m => m.t === 'snap').at(-1).state; }
}
const readFile = () => JSON.parse(readFileSync(saveOf(), 'utf8'));
const ALL_ON = { layout: 'p10', systems: 40, factions: 6, factionEcon: true, combat: true, ops: true, logistics: true, salvage: true, piracy: true, blackMarket: true, law: true, rep: true, econChain: false };
const rulesLine = () => { const m = /rules=(\{[^\n]*\})/.exec(serverLog); return m ? JSON.parse(m[1]) : null; };
const startOf = (w: any, id: string) => ({ credits: w.companies[id].credits, ships: Object.values<any>(w.ships).filter(s => s.owner === id).map(s => s.cls ?? s.hull ?? s.kind).sort(), rep: w.companies[id].rep, standing: w.companies[id].standing ?? {} });
const A = new Pilot('A 통합 PMC'), B = new Pilot('B 통합 PMC'), C = new Pilot('C 통합 PMC');
try {
  // ============ 1: first start with no flags
  await start();
  const r1 = rulesLine();
  check(JSON.stringify(r1) === JSON.stringify(ALL_ON) && serverLog.includes('world created'), '1-1: an empty storage with no world flags creates the integrated standard world', r1);
  await A.signup('a1_a'); await B.signup('a1_b'); await C.signup('a1_c');
  await A.connect(); await B.connect(); await C.connect();
  check(A.sawNeedPmc && B.sawNeedPmc && C.sawNeedPmc && new Set([A.id, B.id, C.id]).size === 3, '1-2: three accounts each create their own company', { A: A.id, B: B.id, C: C.id });
  const s = A.snap();
  check(!!s.factions && Object.keys(s.factions).length === 6 && s.repV === 1 && s.lawV === 1, '1-3: the client sees the P10 factions and the integrated rules', { factions: Object.keys(s.factions ?? {}), repV: s.repV, lawV: s.lawV });
  await delay(1500);
  let f = readFile();
  check(JSON.stringify(worldRules(f.world)) === JSON.stringify(ALL_ON), '1-4: the saved world carries the standard rules', worldRules(f.world));
  const first = Object.fromEntries([A, B, C].map(p => [p.name, startOf(f.world, p.id)]));
  facts.firstStart = first;
  check([A, B, C].every(p => first[p.name].credits > 0 && first[p.name].ships.length > 0 && first[p.name].rep === 0), '1-5: every company starts with credits, starter ships and neutral credit', first);
  check([A, B, C].every(p => p.start?.credits === first[p.name].credits && p.start?.station === f.world.stations.astra.name), '1-6: the company-creation prompt states the real starting funds and station', A.start);
  const accounts1 = { ...f.accounts };
  await stop();

  // ============ 2: restart (with legacy flags set by mistake): the world is restored, nothing converted
  await start({ COMBAT_P11: '1', LAW_P134: '1' });
  check(serverLog.includes('world restored') && JSON.stringify(rulesLine()) === JSON.stringify(ALL_ON), '2-1: a restart restores the same standard world', rulesLine());
  check(serverLog.includes('개별 기능 플래그'), '2-2: legacy per-system flags under the standard preset are reported as unused');
  await A.connect();
  check(!A.sawNeedPmc && A.snap().companies[A.id], '2-3: an existing account reconnects to its company', { id: A.id });
  await stop();

  // ============ 3: operator reset
  const oldIds = [A.id, B.id, C.id];
  await start({ WORLD_RESET: 'a1reset01', COMBAT_P11: '1' });
  check(serverLog.includes('WORLD RESET applied') && JSON.stringify(rulesLine()) === JSON.stringify(ALL_ON), '3-1: WORLD_RESET builds a world with exactly the standard rules', rulesLine());
  f = readFile();
  check(oldIds.every(id => !f.world.companies[id] || f.world.companies[id].kind !== 'player') && Object.keys(f.accounts ?? {}).length === 0, '3-2: companies and their links are gone after the reset', { accounts: f.accounts, players: Object.values<any>(f.world.companies).filter(c => c.kind === 'player').length });
  const st = [await A.login('a1_a'), await B.login('a1_b'), await C.login('a1_c')];
  check(st.every(x => x === 200), '3-3: every account still logs in after the reset', st);
  await A.connect(); await B.connect(); await C.connect();
  check(A.sawNeedPmc && B.sawNeedPmc && C.sawNeedPmc, '3-4: each account is asked to create a new company');
  await delay(1500);
  f = readFile();
  const second = Object.fromEntries([A, B, C].map(p => [p.name, startOf(f.world, p.id)]));
  facts.afterReset = second;
  const same = [A, B, C].every(p => JSON.stringify(second[p.name].ships) === JSON.stringify(first[p.name].ships) && Math.abs(second[p.name].credits - first[p.name].credits) / first[p.name].credits < 0.01 && second[p.name].rep === 0);
  check(same, '3-5: the new companies get the same starting conditions as on the first start', { first, second });
  await stop();
  await start({ WORLD_RESET: 'a1reset01' });
  check(serverLog.includes('초기화하지 않음') && serverLog.includes('world restored'), '3-6: the same reset token a second time changes nothing', /WORLD_RESET[^\n]*/.exec(serverLog)?.[0]);
  await stop();

  // ============ 4: legacy preset and a typo
  dir = mkdtempSync(path.join(tmpdir(), 'siderarium-a1-legacy-'));
  await start({ WORLD_PRESET: 'legacy' });
  const rl = rulesLine();
  check(rl?.layout === 'p9' && !rl.law && !rl.rep, '4-1: WORLD_PRESET=legacy still creates the old P9 world', rl);
  await stop();
  dir = mkdtempSync(path.join(tmpdir(), 'siderarium-a1-typo-'));
  const p = spawnServer({ WORLD_PRESET: 'standrad' });
  const code = await new Promise<number | null>(r => p.once('exit', c => r(c)));
  check(code === 1 && serverLog.includes('WORLD_PRESET 값 오류') && !existsSync(saveOf()), '4-2: an unknown WORLD_PRESET stops the server before any world is written', { code });
  child = undefined;
} catch (e) {
  check(false, `harness error: ${(e as Error).message.slice(0, 400)}`);
} finally {
  await stop();
}
const pass = checks.filter(c => c.ok).length;
writeFileSync(out, JSON.stringify({ pass, total: checks.length, checks, facts }, null, 1));
writeFileSync(out.replace(/\.json$/, '.log'), allLog);
console.log(`${pass}/${checks.length}`);
process.exit(pass === checks.length ? 0 : 1);

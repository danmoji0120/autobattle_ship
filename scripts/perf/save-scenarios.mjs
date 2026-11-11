// Persistence scenarios with real server processes and a throwaway PostgreSQL database (never production):
//   restart preservation, database outage and recovery, upgrade from / rollback to the previous server,
//   repeated restarts. Prints a JSON report.
//   PG_URL=postgres://postgres@127.0.0.1:55432/sidp0 node scripts/perf/save-scenarios.mjs <new dir> <old dir> [pg data dir for outage]
import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import WebSocket from 'ws';
import pg from 'pg';

const URL = process.env.PG_URL;
if (!URL || !/127\.0\.0\.1|localhost/.test(URL)) throw new Error('PG_URL must be a local throwaway database');
const NEW = path.resolve(process.argv[2] ?? '.'), OLD = path.resolve(process.argv[3] ?? '.');
const PGDATA = process.argv[4];
const PORT = 8341;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const db = new pg.Pool({ connectionString: URL, max: 2 });
db.on('error', () => {});
const report = [];
const check = (name, ok, detail) => { report.push({ name, ok: !!ok, detail }); if (!ok) console.error('FAIL', name, detail ?? ''); };

function start(dir, env = {}) {
  return new Promise((res, rej) => {
    const p = spawn(process.execPath, [path.join(dir, 'dist-server/server.mjs')], { env: { ...process.env, PORT: String(PORT), DATABASE_URL: URL, SIDERARIUM_REQUIRE_DB: '1', WORLD_SEED: '5', SAVE_INTERVAL_S: '2', ANALYTICS_SAVE_INTERVAL_S: '30', STATUS_LOG_S: '0', STATIC_DIR: path.join(dir, 'dist'), ...env } });
    let out = '';
    const exited = new Promise(r => p.on('exit', c => r(c)));
    const s = { p, log: () => out, exited };
    p.stdout.on('data', d => { out += d; if (out.includes('listening on')) res(s); });
    p.stderr.on('data', d => { out += d; });
    exited.then(c => rej(new Error(`exited ${c} before listening\n${out}`)));
    setTimeout(() => rej(new Error('start timeout\n' + out)), 60000);
  });
}
const stop = async s => { s.p.kill('SIGTERM'); return s.exited; };
const status = () => fetch(`${BASE}/status`).then(r => r.ok && r.headers.get('content-type')?.includes('json') ? r.json() : null, () => null);
const ready = () => fetch(`${BASE}/ready`).then(async r => ({ code: r.status, body: r.headers.get('content-type')?.includes('json') ? await r.json() : null }), () => null);
async function signup(i) {
  const r = await fetch(`${BASE}/api/auth/signup`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.5.0.${i}` }, body: JSON.stringify({ loginId: `save_${i}`, password: 'save-pass-1234', confirm: 'save-pass-1234' }) });
  return r.headers.get('set-cookie')?.split(';')[0];
}
async function login(i) {
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.5.1.${i}` }, body: JSON.stringify({ loginId: `save_${i}`, password: 'save-pass-1234' }) });
  return { status: r.status, cookie: r.headers.get('set-cookie')?.split(';')[0], body: await r.json() };
}
const me = cookie => fetch(`${BASE}/api/auth/me`, { headers: { cookie } }).then(r => r.json());
function enter(cookie, name, proto = 2) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { cookie } });
    ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', name: '', proto })));
    ws.on('message', raw => { const m = JSON.parse(String(raw)); if (m.t === 'needPmc') ws.send(JSON.stringify({ t: 'createPmc', name })); if (m.t === 'welcome') { ws.close(); res(m.company); } });
    ws.on('error', rej); setTimeout(() => rej(new Error('enter timeout')), 15000);
  });
}
const rows = async () => Object.fromEntries((await db.query("SELECT id, gen, length(data::text) AS bytes, (data ? 'analytics') AS has_analytics, (data->'world'->>'time')::float AS time FROM siderarium_world WHERE id IN ('main','analytics')")).rows.map(r => [r.id, r]));
const census = async () => { const r = await db.query("SELECT data->'world' AS w, data->'accounts' AS a FROM siderarium_world WHERE id = 'main'"); const w = r.rows[0].w; return { time: w.time, companies: Object.keys(w.companies).length, players: Object.values(w.companies).filter(c => c.kind === 'player').map(c => [c.name, Math.round(c.credits)]).sort(), ships: Object.keys(w.ships).length, accounts: Object.keys(r.rows[0].a ?? {}).length }; };

await db.query('DROP TABLE IF EXISTS siderarium_world, siderarium_accounts, siderarium_sessions CASCADE');

// 1. upgrade: the previous server creates the world, accounts and PMCs
let s = await start(OLD);
const cookies = [await signup(1), await signup(2)];
const companies = [await enter(cookies[0], 'Old One', undefined), await enter(cookies[1], 'Old Two', undefined)];
await sleep(5000);
await stop(s);
let r0 = await rows(), c0 = await census();
check('old server saved world with analytics inside', r0.main?.has_analytics === true, r0.main);

s = await start(NEW);
check('new server reads the old save (analytics from the world save)', s.log().includes('analytics history: 월드 저장 내 기록'), s.log().match(/analytics history[^\n]*/)?.[0]);
for (let i = 0; i < 2; i++) { const m = await me(cookies[i]); check(`session ${i + 1} still valid after upgrade`, m.company?.id === companies[i], m); }
await sleep(6000);
let r1 = await rows();
check('analytics stored separately, world rows without it', r1.analytics && r1.main && !r1.main.has_analytics, r1);
check('world row much smaller than before', r1.main.bytes < r0.main.bytes, { before: r0.main.bytes, after: r1.main.bytes, analytics: r1.analytics?.bytes });
let st = await status();
check('/status reports saves', st?.save?.ok > 0 && st.save.state === 'ok', st?.save);

// 2. database outage: saves fail, are reported, the game keeps running, and recover
if (PGDATA) {
  execFileSync('su', ['postgres', '-c', `/usr/lib/postgresql/16/bin/pg_ctl -D ${PGDATA} stop -m fast`]);
  const t0 = (await status()).time;
  await sleep(9000);
  st = await status(); const rd = await ready();
  check('outage: game keeps running', st && st.time > t0 + 5, { t0, t1: st?.time });
  check('outage: failures counted and reported', st?.save?.consecutiveFailures >= 2 && st.save.lastError, { failures: st?.save?.consecutiveFailures, error: st?.save?.lastError });
  check('outage: /ready says 503 save failing', rd?.code === 503 && rd.body?.save === 'failing', rd);
  check('outage: /health unchanged (200)', (await fetch(`${BASE}/health`)).status === 200);
  execFileSync('su', ['postgres', '-c', `/usr/lib/postgresql/16/bin/pg_ctl -D ${PGDATA} -o '-p 55432 -k ${path.dirname(PGDATA)}' -l ${path.dirname(PGDATA)}/log start -w`]);
  await sleep(8000);
  st = await status(); const rd2 = await ready();
  check('recovery: saves succeed again', st?.save?.consecutiveFailures === 0 && st.save.lastOkAgoS <= 4, st?.save && { ok: st.save.ok, failures: st.save.failures, lastOkAgoS: st.save.lastOkAgoS });
  check('recovery: /ready 200', rd2?.code === 200, rd2);
  check('recovery: log shows failure and recovery', s.log().includes('저장 실패') && s.log().includes('저장 복구'));
}

// 3. shutdown save and restart preservation (several times)
const tBefore = (await status()).time;
await stop(s);
check('shutdown saved', s.log().includes('종료 저장 완료'), s.log().match(/종료 저장[^\n]*/)?.[0]);
let cPrev = await census();
check('final save is the moment of shutdown', cPrev.time >= tBefore - 0.05 /* status rounds to 0.1 s */, { tBefore, saved: cPrev.time });
for (let k = 0; k < 4; k++) {
  s = await start(NEW);
  check(`restart ${k + 1}: analytics from the separate record`, s.log().includes('analytics history: 별도 기록'), s.log().match(/analytics history[^\n]*/)?.[0]);
  const st0 = await status();
  check(`restart ${k + 1}: world continues from the saved time`, Math.abs(st0.time - cPrev.time) < 1.5, { saved: cPrev.time, now: st0.time });
  const lg = await login(1 + (k % 2));
  check(`restart ${k + 1}: account login works and finds its PMC`, lg.status === 200 && lg.body.company?.id === companies[k % 2], lg.body);
  await sleep(3000);
  await stop(s);
  const c = await census();
  check(`restart ${k + 1}: players, credits order and ships preserved`, c.companies === cPrev.companies && c.accounts === cPrev.accounts && JSON.stringify(c.players.map(p => p[0])) === JSON.stringify(cPrev.players.map(p => p[0])), { before: cPrev, after: c });
  cPrev = c;
}

// 4. rollback: the previous server still loads what the new one wrote
s = await start(OLD);
for (let i = 0; i < 2; i++) { const lg = await login(i + 1); check(`rollback: old server, account ${i + 1} and PMC intact`, lg.status === 200 && lg.body.company?.id === companies[i], lg.body); }
await sleep(3000);
await stop(s);
const r2 = await rows();
check('rollback: old server writes analytics back into the world row; separate record untouched', r2.main.has_analytics && r2.analytics, r2);
// and forward again: the newer analytics copy (inside the world row) wins over the stale separate record
s = await start(NEW);
check('re-upgrade after rollback picks the newest analytics copy', /analytics history: 월드 저장 내 기록/.test(s.log()), s.log().match(/analytics history[^\n]*/)?.[0]);
await stop(s);
const cEnd = await census();
check('end: world never reset (time only moves forward)', cEnd.time >= c0.time && cEnd.companies === c0.companies, { start: c0, end: cEnd });

console.log(JSON.stringify({ passed: report.filter(r => r.ok).length, failed: report.filter(r => !r.ok).length, report }, null, 1));
await db.end();
process.exit(report.every(r => r.ok) ? 0 : 1);

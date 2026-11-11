// Real browser (protocol 2) against a legacy full-snapshot socket of the same account, on the built server:
// join, delta frames only, same visible entity sets and privacy, command round trip, movement, no page errors.
//   node scripts/perf/browser-p2.mjs .      (uses the preinstalled Chromium at /opt/pw-browsers/chromium or CHROMIUM_PATH)
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const DIR = path.resolve(process.argv[2]);
const require = createRequire(path.join(DIR, 'package.json'));
const { chromium } = require('playwright'); const WebSocket = require('ws');
const port = 8461, base = `http://localhost:${port}`, tmp = mkdtempSync(path.join(tmpdir(), 'p2b-'));
const delay = ms => new Promise(r => setTimeout(r, ms));
const results = []; const check = (ok, m, d) => { results.push({ ok: !!ok, m, d }); console.log(ok ? 'PASS' : 'FAIL', m, ok ? '' : JSON.stringify(d ?? '')); };
const srv = spawn(process.execPath, [path.join(DIR, 'dist-server/server.mjs')], { cwd: DIR, env: { ...process.env, PORT: String(port), SAVE_FILE: path.join(tmp, 'w.json'), DATABASE_URL: '', WORLD_SEED: '7', STATUS_LOG_S: '0' } });
let log = ''; srv.stdout.on('data', d => log += d); srv.stderr.on('data', d => log += d);
while (!log.includes('listening on')) await delay(100);
const signup = async (id) => { const r = await fetch(base + '/api/auth/signup', { method: 'POST', headers: { origin: base, 'content-type': 'application/json', 'x-forwarded-for': '10.9.0.' + id.length }, body: JSON.stringify({ loginId: id, password: 'p2-browser-pass-1', confirm: 'p2-browser-pass-1' }) }); return r.headers.get('set-cookie').split(';')[0]; };
const cA = await signup('p2_alpha'), cB = await signup('p2_bravo_x');
function legacy(cookie, name) {
  const ws = new WebSocket(`ws://localhost:${port}/ws`, { headers: { origin: base, cookie } }); const s = { ws, snap: null, company: null };
  ws.on('message', raw => { const m = JSON.parse(String(raw)); if (m.t === 'needPmc') ws.send(JSON.stringify({ t: 'createPmc', name })); if (m.t === 'welcome') s.company = m.company; if (m.t === 'snap') s.snap = m; });
  ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', name: '' })));
  return s;
}
const B = legacy(cB, '브라보 상사'); while (!B.snap) await delay(100);
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium', args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const [n, ...v] = cA.split('='); await ctx.addCookies([{ name: n, value: v.join('='), domain: 'localhost', path: '/', httpOnly: true }]);
const page = await ctx.newPage(); const errors = []; page.on('pageerror', e => errors.push(String(e)));
let sdFrames = 0, snapFrames = 0;
page.on('websocket', ws => ws.on('framereceived', f => { const p = String(f.payload); if (p.startsWith('{"t":"sd"')) sdFrames++; if (p.startsWith('{"t":"snap"')) snapFrames++; }));
await page.goto(base); await page.locator('#mpJoin').waitFor(); while (!(await page.locator('#mpJoin').isEnabled())) await delay(100); await page.locator('#mpJoin').click();
// new account: PMC creation dialog
await page.waitForFunction(() => window.siderarium?.client?.company || document.querySelector('input'), null, { timeout: 30000 });
const needName = await page.evaluate(() => !window.siderarium?.client?.company);
if (needName) await page.evaluate(() => window.siderarium.client.createPmc('알파 운송'));
await page.waitForFunction(() => window.siderarium?.client?.company && window.siderarium?.client?.state, null, { timeout: 30000 });
const me = await page.evaluate(() => window.siderarium.client.company);
check(true, 'browser joined multiplayer and created its PMC on protocol 2');
await delay(4000);
check(sdFrames >= 3 && snapFrames === 0, 'browser receives sd deltas, not full snapshots', { sdFrames, snapFrames });
// same account on a legacy socket: the reference view
const A = legacy(cA, ''); while (!A.snap) await delay(100);
const ids = st => Object.fromEntries(Object.entries(st).filter(([, v]) => v && typeof v === 'object' && !Array.isArray(v)).map(([k, v]) => [k, Object.keys(v).sort().join(',')]));
const bv = await page.evaluate(() => JSON.parse(JSON.stringify(window.siderarium.client.state)));
const lv = A.snap.state;
const cols = Object.keys(lv).filter(k => lv[k] && typeof lv[k] === 'object' && !Array.isArray(lv[k]));
const diffCols = cols.filter(k => ids(bv)[k] !== ids(lv)[k] && !['ships', 'battles', 'engagements', 'groups', 'listings', 'logisticsJobs'].includes(k));
check(diffCols.length === 0, 'browser state has the same entity sets as the legacy full snapshot (slow-changing collections)', diffCols);
const mine = s => Object.values(s.ships).filter(x => x.owner === me).map(x => x.id).sort().join(',');
check(mine(bv) === mine(lv) && mine(bv).length > 0, 'own ships identical in both views', { b: mine(bv), l: mine(lv) });
const priv = s => Object.values(s.stations).filter(st => st.storage && st.storage[B.company]).length;
check(priv(bv) === 0 && priv(lv) === 0, 'other company storage absent in both views');
const sameStation = Object.keys(lv.stations).every(id => JSON.stringify(Object.keys(bv.stations[id] ?? {}).sort()) === JSON.stringify(Object.keys(lv.stations[id]).sort()));
check(sameStation, 'station records carry the same fields');
check(JSON.stringify(bv.companies[me]) !== undefined && Math.abs(bv.companies[me].credits - lv.companies[me].credits) < 1e6, 'own company present with credits');
// movement: an own group moves, positions update in the browser
const g = Object.values(bv.groups).find(x => x.owner === me && x.name === '제1 채굴반') ?? Object.values(bv.groups).find(x => x.owner === me);
const err = await page.evaluate(gid => window.siderarium.client.cmd({ c: 'setOp', group: gid, op: { k: 'mine', field: 'kestrel', deliver: 'astra', sell: true } }), g.id);
check(err === null, 'command accepted from the browser', err);
await delay(1500);
const op = await page.evaluate(gid => window.siderarium.client.state.groups[gid].op, g.id);
check(op?.k === 'mine', 'command result visible in the browser state within 1.5 s', op);
const ship = Object.values(bv.ships).find(s => s.owner === me && s.groupId === g.id);
const p0 = await page.evaluate(id => ({ ...window.siderarium.client.state.ships[id].pos, st: window.siderarium.client.state.ships[id].state }), ship.id);
await delay(8000);
const p1 = await page.evaluate(id => ({ ...window.siderarium.client.state.ships[id].pos, st: window.siderarium.client.state.ships[id].state }), ship.id);
check(Math.hypot(p1.x - p0.x, p1.z - p0.z) > 1 || p0.st !== p1.st, 'own ship moves (or changes state) in the browser', { p0, p1 });
// after 15 s the incremental state still matches a fresh full snapshot of the same account
const A2 = legacy(cA, ''); while (!A2.snap) await delay(100);
const bv2 = await page.evaluate(() => JSON.parse(JSON.stringify(window.siderarium.client.state)));
const strip = st => { const c = structuredClone(st); for (const s of Object.values(c.ships)) { delete s.pos; delete s.vel; delete s.heading; } return c; };
const l2 = strip(A2.snap.state), b2 = strip(bv2);
const statDiff = Object.keys(l2.stations).filter(id => JSON.stringify(Object.keys(l2.stations[id].storage ?? {}).sort()) !== JSON.stringify(Object.keys(b2.stations[id]?.storage ?? {}).sort()));
check(statDiff.length === 0, 'station storage visibility matches after incremental updates', statDiff);
check(JSON.stringify(Object.keys(b2.groups).sort()) === JSON.stringify(Object.keys(l2.groups).sort()), 'group set matches after incremental updates');
check(errors.length === 0, 'no page errors', errors);
const st = await fetch(base + '/status').then(r => r.json());
check(st.tick?.conns?.proto2 >= 1 || st.conns?.proto2 >= 1 || JSON.stringify(st).includes('"proto2":1'), '/status counts the protocol-2 connection', st.conns ?? st.tick);
await browser.close(); for (const s of [A, B, A2]) s.ws.close(); srv.kill('SIGTERM'); await new Promise(r => srv.on('exit', r));
console.log(JSON.stringify({ passed: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length }));
process.exit(results.every(r => r.ok) ? 0 : 1);

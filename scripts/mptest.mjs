// Real WebSocket clients against the Node server, with accounts: sign-up / login over HTTP (HttpOnly
// cookie), authenticated WebSocket handshake, PMC creation, ownership, cross-visibility, logout and
// session revocation, wrong passwords, and persistence of accounts + PMCs across a server restart.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import WebSocket from 'ws';
const PORT = 8199, SAVE = 'data/mptest.json', ACCTS = 'data/accounts.json';
const BASE = `http://localhost:${PORT}`;
fs.rmSync(SAVE, { force: true }); fs.rmSync(ACCTS, { force: true });
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) process.exitCode = 1; };
const startServer = () => new Promise(res => {
  const p = spawn('node', ['dist-server/server.mjs'], { env: { ...process.env, PORT: String(PORT), SAVE_FILE: SAVE, WORLD_SEED: '5', DATABASE_URL: process.env.MPTEST_DATABASE_URL ?? '' } });
  let out = '';
  p.stdout.on('data', d => { const s = String(d); out += s; process.stdout.write('  [srv] ' + s); if (s.includes('listening')) res(p); });
  p.stderr.on('data', d => { out += String(d); process.stdout.write('  [srv!] ' + d); });
  p.log = () => out;
});
/** HTTP API with a cookie jar per "browser" */
class Browser {
  constructor() { this.cookie = ''; }
  async post(path, body, headers = {}) {
    const r = await fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE, cookie: this.cookie, ...headers }, body: JSON.stringify(body) });
    this.take(r); return { status: r.status, body: await r.json().catch(() => ({})), setCookie: r.headers.get('set-cookie') };
  }
  async get(path) { const r = await fetch(BASE + path, { headers: { cookie: this.cookie } }); this.take(r); return { status: r.status, body: await r.json().catch(() => ({})) }; }
  take(r) { const c = r.headers.get('set-cookie'); if (c) { const v = c.split(';')[0]; this.cookie = v.endsWith('=') ? '' : v; } }
}
class Client {
  constructor(browser, name) { this.browser = browser; this.name = name; this.snap = null; this.events = []; this.acks = new Map(); this.seq = 1; this.msgs = []; }
  /** resolves with 'welcome' | 'needPmc' | 'auth' | {rejected:status} | {closed:code} */
  open(headers = {}) { return new Promise(res => {
    this.ws = new WebSocket(`ws://localhost:${PORT}/ws`, { headers: { cookie: this.browser?.cookie ?? '', origin: BASE, ...headers } });
    this.ws.on('unexpected-response', (_req, r) => res({ rejected: r.statusCode }));
    this.ws.on('error', () => {});
    this.ws.on('open', () => this.ws.send(JSON.stringify({ t: 'hello', name: 'ignored', token: 'ignored' })));
    this.ws.on('close', (code, reason) => { this.closed = { code, reason: String(reason) }; res({ closed: code }); });
    this.ws.on('message', raw => {
      const m = JSON.parse(String(raw)); this.msgs.push(m.t);
      if (m.t === 'welcome') { this.company = m.company; res('welcome'); }
      if (m.t === 'needPmc' || m.t === 'auth') res(m.t);
      if (m.t === 'pmcErr') this.pmcErr = m.msg;
      if (m.t === 'snap') this.snap = m.state;
      if (m.t === 'mov') { this.movs = (this.movs || 0) + 1; for (const r of m.s) { const sh = this.snap?.ships[r[0]]; if (sh) { sh.pos.x = r[1]; sh.pos.z = r[3]; } } }
      if (m.t === 'events') this.events.push(...m.list);
      if (m.t === 'ack') this.acks.get(m.id)?.(m.err);
      if (m.t === 'binit' || m.t === 'error') (this.binits ??= []).push(m);
    });
  }); }
  createPmc(name) { return new Promise(res => { const t = setInterval(() => { if (this.company || this.pmcErr) { clearInterval(t); res(this.company ?? this.pmcErr); } }, 50); this.ws.send(JSON.stringify({ t: 'createPmc', name })); }); }
  cmd(cmd) { const id = this.seq++; return new Promise(r => { this.acks.set(id, r); this.ws.send(JSON.stringify({ t: 'cmd', id, cmd })); setTimeout(() => r('(no ack)'), 5000); }); }
  group(name) { return Object.values(this.snap.groups).find(g => g.owner === this.company && g.name === name); }
  close() { this.ws.close(); }
}
const wait = ms => new Promise(r => setTimeout(r, ms));
let srv = await startServer();
process.on('exit', () => { try { srv.kill(); } catch { /* */ } });
// ── accounts over HTTP ──
const ba = new Browser(), bb = new Browser();
{
  const anon = new Client(null); const r = await anon.open();
  ok(r.rejected === 401, `WebSocket without a session is refused at the handshake (${JSON.stringify(r)})`);
  const forged = new Client({ cookie: 'siderarium_sid=' + 'A'.repeat(43) }); ok((await forged.open()).rejected === 401, 'a forged session cookie is refused');
  ok((await ba.get('/api/auth/me')).status === 401, '/me without a session → 401');
  const su = await ba.post('/api/auth/signup', { loginId: 'Alpha_1', password: 'nova-lance-123', confirm: 'nova-lance-123' });
  ok(su.status === 200 && su.body.account.loginId === 'alpha_1' && /^[A-Z2-9-]{23}$/.test(su.body.recoveryCode), `A signs up (login id normalised, recovery code issued)`);
  ok(/HttpOnly/i.test(su.setCookie) && /SameSite=Lax/i.test(su.setCookie) && /Path=\//.test(su.setCookie), `session cookie is HttpOnly; SameSite=Lax (${su.setCookie.replace(/=[^;]+/, '=…')})`);
  ok(!JSON.stringify(su.body).includes(ba.cookie.split('=')[1]), 'the session id is not in any response body (cookie only)');
  globalThis.recoveryA = su.body.recoveryCode;
  ok((await bb.post('/api/auth/signup', { loginId: 'ALPHA_1', password: 'other-pass-123', confirm: 'other-pass-123' })).status === 409, 'duplicate login ID (case-insensitive) is refused');
  ok((await bb.post('/api/auth/signup', { loginId: 'beta', password: 'orbit-key-4567', confirm: 'orbit-key-456' })).status === 400, 'password confirmation mismatch is refused');
  ok((await bb.post('/api/auth/signup', { loginId: 'beta', password: 'orbit-key-4567', confirm: 'orbit-key-4567' })).status === 200, 'B signs up');
  const evil = await new Browser().post('/api/auth/login', { loginId: 'alpha_1', password: 'nova-lance-123' }, { origin: 'https://evil.example' });
  ok(evil.status === 403, 'cross-origin login POST is refused');
  const bad = await new Browser().post('/api/auth/login', { loginId: 'alpha_1', password: 'wrong-password' });
  ok(bad.status === 401 && /올바르지 않습니다/.test(bad.body.error), `wrong password → 401 "${bad.body.error}"`);
  const foreign = new Client(ba); ok((await foreign.open({ origin: 'https://evil.example' })).rejected === 403, 'WebSocket from a foreign origin is refused even with the cookie');
}
const a = new Client(ba), b = new Client(bb);
ok(await a.open() === 'needPmc', 'A (no PMC yet) is asked to create one');
// two tabs of A send createPmc at the same time → one company
const a1 = new Client(ba); await a1.open();
const [ca, ca1] = await Promise.all([a.createPmc('알파 PMC'), a1.createPmc('알파 중복')]);
ok(ca === ca1 && /^p/.test(ca), `concurrent PMC creation from two tabs → one company (${ca}, ${ca1})`);
a1.close();
ok(await b.open() === 'needPmc', 'B is asked to create a PMC');
await b.createPmc('베타 컴퍼니');
await wait(1600);
ok(a.company && b.company && a.company !== b.company, `two companies: ${a.company}, ${b.company}`);
ok(Object.values(a.snap.companies).filter(c => c.kind === 'player').length === 2, 'exactly two player companies exist');
ok(Object.values(a.snap.companies).some(c => c.id === b.company), 'A sees B in the shared world');
{
  const me = await ba.get('/api/auth/me');
  ok(me.status === 200 && me.body.company?.id === a.company, `/me reports A's PMC (${me.body.company?.name})`);
}
const mining = a.group('제1 채굴반');
const err = await a.cmd({ c: 'setOp', group: mining.id, op: { k: 'mine', field: 'kestrel', deliver: 'astra', sell: true } });
ok(err === null, 'A orders mining');
const bad = await b.cmd({ c: 'setOp', group: mining.id, op: { k: 'idle' } });
ok(bad !== null, `B cannot command A's group (${bad})`);
const before = Object.values(b.snap.ships).filter(s => s.owner === a.company).map(s => ({ ...s.pos }));
await wait(6000);
const after = Object.values(b.snap.ships).filter(s => s.owner === a.company);
const moved = after.filter((s, i) => Math.hypot(s.pos.x - before[i].x, s.pos.z - before[i].z) > 50).length;
ok(moved >= 2, `B observes A's miners moving (${moved} ships moved)`);
ok(a.events.some(e => e.text.includes('채굴 작전')), 'A received its commander radio');
ok(!b.events.some(e => e.company === a.company), "B doesn't receive A's private events");
// players in different systems: B's escort flies through the gate to Drake
ok((a.movs || 0) > 20, `compact motion packets stream between snapshots (${a.movs})`);
const esc = b.group('경비대');
ok(await b.cmd({ c: 'setOp', group: esc.id, op: { k: 'move', to: { ...b.snap.stations.drakeout.pos, x: b.snap.stations.drakeout.pos.x + 1500 } } }) === null, 'B orders its escort to another system (Drake)');
const sysOf = p => Math.round(p.x / 250000) + 2;
let inDrake = false;
for (let i = 0; i < 240 && !inDrake; i++) { await wait(1000); const ss = Object.values(b.snap.ships).filter(s => esc.shipIds.includes(s.id)); inDrake = ss.length > 0 && ss.every(s => sysOf(s.pos) === 2); }
ok(inDrake, 'B escort jumped through the gate and is in Drake');
await wait(1500);
ok(!Object.values(a.snap.ships).some(s => esc.shipIds.includes(s.id)), "A (viewing Astra) is not sent B's ships in Drake (interest management)");
ok(Object.values(a.snap.ships).some(s => s.owner === a.company), 'A still sees its own ships');
a.ws.send(JSON.stringify({ t: 'view', sys: 'drake' })); await wait(800);
ok(Object.values(a.snap.ships).some(s => esc.shipIds.includes(s.id)), "A switches view to Drake and sees B's escort there");
a.ws.send(JSON.stringify({ t: 'view', sys: 'astra' }));
// another browser / computer: same account → same PMC
const ba2 = new Browser();
ok((await ba2.post('/api/auth/login', { loginId: 'alpha_1', password: 'nova-lance-123' })).status === 200, 'A logs in from a second browser');
const a2 = new Client(ba2); ok(await a2.open() === 'welcome' && a2.company === a.company, 'second browser controls the same PMC');
await wait(600);
ok(await a2.cmd({ c: 'setOp', group: mining.id, op: { k: 'mine', field: 'kestrel', deliver: '', sell: false, auto: true } }) === null, 'A switches mining to automatic destination + storage (from browser 2)');
// logout in browser 1: its socket is closed at once, the cookie no longer opens a socket; browser 2 is unaffected
const oldCookieA = ba.cookie;
await ba.post('/api/auth/logout', {});
await wait(400);
ok(a.closed?.code === 4401, `logout closes browser 1's live socket (code ${a.closed?.code} ${a.closed?.reason})`);
{ const c = new Client({ cookie: oldCookieA }); ok((await c.open()).rejected === 401, 'the logged-out cookie cannot open a socket'); }
ok(await a2.cmd({ c: 'renameGroup', group: mining.id, name: '제1 채굴반' }) === null, 'browser 2 keeps playing after browser 1 logged out');
// password change from browser 2: other sessions are signed out
const ba3 = new Browser(); await ba3.post('/api/auth/login', { loginId: 'alpha_1', password: 'nova-lance-123' });
const a3s = new Client(ba3); await a3s.open();
const pc = await ba2.post('/api/auth/password', { current: 'nova-lance-123', next: 'nova-lance-NEW', confirm: 'nova-lance-NEW' });
await wait(400);
ok(pc.status === 200 && pc.body.signedOut === 1 && a3s.closed?.code === 4401, `password change signs out the other session (${pc.body.signedOut}, socket ${a3s.closed?.code})`);
ok((await new Browser().post('/api/auth/login', { loginId: 'alpha_1', password: 'nova-lance-123' })).status === 401, 'old password no longer works');
await wait(1200);
const t1 = a2.snap.time;
// restart server: accounts, links and assets persist
const shipsA = Object.values(a2.snap.ships).filter(s => s.owner === a.company).map(s => s.id).sort().join();
const creditsA = a2.snap.companies[a.company].credits;
a2.close(); b.close();
srv.kill('SIGTERM'); await new Promise(r => srv.on('exit', r));
ok(fs.existsSync(SAVE), 'world saved on shutdown');
ok(!srv.log().includes('nova-lance') && !srv.log().includes(oldCookieA.split('=')[1]), 'server log contains no passwords or session ids');
srv = await startServer();
ok(srv.log().includes('2 linked PMCs'), 'account ↔ PMC links restored from the save');
const ba4 = new Browser();
ok((await ba4.post('/api/auth/login', { loginId: 'alpha_1', password: 'nova-lance-NEW' })).status === 200, 'after restart: login with the new password');
const a3 = new Client(ba4); await a3.open(); await wait(700);
ok(a3.company === a.company && a3.snap.time >= t1 - 1, `after restart same PMC & world time continues (t=${a3.snap.time.toFixed(1)} ≥ ${t1.toFixed(1)})`);
ok(Object.values(a3.snap.ships).filter(s => s.owner === a.company).map(s => s.id).sort().join() === shipsA && Math.abs(a3.snap.companies[a.company].credits - creditsA) < 2000, 'after restart all of A\'s ships and its money are there');
{ const ok2 = await ba2.get('/api/auth/me'); ok(ok2.status === 200, 'browser 2 session survives the restart (cookie session in the store)'); }
{ const op = a3.group('제1 채굴반').op; ok(op.k === 'mine' && op.auto === true && op.sell === false && !!a3.snap.stations[op.deliver], `mining settings survive restart (auto → ${op.deliver}, store)`); }
// recovery code: resets the password and signs out everywhere
{
  const rb = new Browser();
  const r = await rb.post('/api/auth/recover', { loginId: 'alpha_1', code: globalThis.recoveryA, next: 'recovered-pass-9', confirm: 'recovered-pass-9' });
  await wait(400);
  ok(r.status === 200 && r.body.company?.id === a.company && a3.closed?.code === 4401, `recovery code resets the password, same PMC, other sessions closed (${a3.closed?.code})`);
  ok((await new Browser().post('/api/auth/recover', { loginId: 'alpha_1', code: globalThis.recoveryA, next: 'x-another-pass-1', confirm: 'x-another-pass-1' })).status === 401, 'a used recovery code does not work twice');
  ba4.cookie = rb.cookie;
}
const a3b = new Client(ba4); await a3b.open(); await wait(600);
// ── NPC battle spectating: everyone gets the same battle, spectators can't touch it ──
{
  const bc = new Browser(); await bc.post('/api/auth/signup', { loginId: 'watcher', password: 'watch-pass-777', confirm: 'watch-pass-777' });
  const c2 = new Client(bc); await c2.open(); await c2.createPmc('관전 PMC'); await wait(800);
  let e = null;
  for (let i = 0; i < 420 && !e; i++) {
    await wait(1000);
    e = Object.values(a3b.snap.engagements).find(x => !x.done && x.autoEnd === undefined && !x.sides[0].includes(a3b.company) && !x.sides[1].includes(a3b.company) && !x.sides[0].includes(c2.company) && !x.sides[1].includes(c2.company));
  }
  ok(!!e, `an NPC battle is fought live on the server (${e ? e.names?.join(' vs ') + ', ' + e.n + '척' : 'none in 7 min'})`);
  if (e) {
    ok(!!e.prog && e.prog.total[0] + e.prog.total[1] > 0, `live progress is broadcast (${JSON.stringify(e.prog)})`);
    a3b.ws.send(JSON.stringify({ t: 'bjoin', eng: e.id })); c2.ws.send(JSON.stringify({ t: 'bjoin', eng: e.id }));
    await wait(1500);
    const ia = a3b.binits?.find(m => m.eng === e.id), ib = c2.binits?.find(m => m.eng === e.id);
    ok(ia && ib && JSON.stringify(ia.setup) === JSON.stringify(ib.setup) && !ia.replay, 'two spectators receive the identical live battle (setup + seed)');
    const err = await new Promise(r => { const id = a3b.seq++; a3b.acks.set(id, r); a3b.ws.send(JSON.stringify({ t: 'border', id, eng: e.id, groupId: 1, order: null, opts: {} })); });
    ok(err !== null && err !== '부대 없음', `a spectator cannot order NPC ships (${err})`);
    // disconnecting a spectator mid-battle is harmless
    c2.close();
    let done = false;
    for (let i = 0; i < 600 && !done; i++) { await wait(1000); done = !!a3b.snap.engagements[e.id]?.done || !a3b.snap.engagements[e.id]; }
    ok(done, 'the battle finishes on the server with a spectator gone');
    const rec = (a3b.snap.battleLog ?? []).find(r => r.id === e.id);
    ok(!!rec && !('setup' in rec), `battle record listed (light: no setup in snapshots) — ${rec?.summary}`);
    a3b.binits = [];
    a3b.ws.send(JSON.stringify({ t: 'bjoin', eng: e.id })); await wait(1200);
    const rp = a3b.binits.find(m => m.eng === e.id);
    ok(rp?.replay === true && JSON.stringify(rp.setup) === JSON.stringify(ia?.setup), 'finished battle can be replayed from the same setup');
  }
}
a3b.close(); srv.kill('SIGTERM');

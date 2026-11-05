// Accounts against a real Postgres (the production storage path): autosave keeps the account links,
// a WORLD_RESET keeps the accounts but clears the links (→ new PMC flow), restoring the backup brings the
// old world back with its own links, and the account tables are not reachable by Supabase API roles.
//   PGTEST_URL=postgres://postgres@127.0.0.1:5499/postgres node scripts/pgaccounts.mjs
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import pg from 'pg';
const URL_ = process.env.PGTEST_URL ?? 'postgres://postgres@127.0.0.1:5499/postgres';
const PORT = 8310, BASE = `http://localhost:${PORT}`;
const db = new pg.Pool({ connectionString: URL_ });
const q = async (s, v) => (await db.query(s, v)).rows;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) process.exitCode = 1; };
const wait = ms => new Promise(r => setTimeout(r, ms));
await q('DROP TABLE IF EXISTS siderarium_sessions, siderarium_accounts, siderarium_world');
let log = '';
const start = (env = {}) => new Promise(res => {
  const p = spawn('node', ['dist-server/server.mjs'], { env: { ...process.env, PORT: String(PORT), DATABASE_URL: URL_, WORLD_SEED: '4', SAVE_FILE: 'data/pgtest-unused.json', ...env } });
  p.stdout.on('data', d => { log += d; process.stdout.write('  [srv] ' + d); if (String(d).includes('listening')) res(p); });
  p.stderr.on('data', d => { log += d; process.stdout.write('  [srv!] ' + d); });
});
const stop = p => new Promise(r => { p.on('exit', r); p.kill('SIGTERM'); });
const post = async (path, body, cookie = '') => { const r = await fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE, cookie }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json(), cookie: (r.headers.get('set-cookie') ?? '').split(';')[0] }; };
/** opens a socket; creates a PMC if asked to; resolves {company, snap} */
const play = (cookie, pmcName) => new Promise((res, rej) => {
  const ws = new WebSocket(`ws://localhost:${PORT}/ws`, { headers: { cookie, origin: BASE } });
  let company = null, asked = false;
  ws.on('unexpected-response', (_q, r) => rej(new Error('ws ' + r.statusCode)));
  ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', name: '' })));
  ws.on('message', raw => {
    const m = JSON.parse(String(raw));
    if (m.t === 'needPmc') { asked = true; ws.send(JSON.stringify({ t: 'createPmc', name: pmcName })); }
    if (m.t === 'welcome') company = m.company;
    if (m.t === 'snap' && company) { res({ company, asked, snap: m.state, ws }); }
  });
});

let srv = await start();
const su = await post('/api/auth/signup', { loginId: 'commander', password: 'deep-space-91', confirm: 'deep-space-91' });
ok(su.status === 200, 'sign-up stored in Postgres');
const acct = su.body.account.id;
const rows = await q('SELECT id, login_id, pw_hash, recovery_hash, email FROM siderarium_accounts');
ok(rows.length === 1 && rows[0].pw_hash.startsWith('scrypt$') && !rows[0].pw_hash.includes('deep-space') && rows[0].email === null, 'account row: scrypt hash only, no e-mail collected');
const sess = await q('SELECT id_hash FROM siderarium_sessions');
ok(sess.length === 1 && sess[0].id_hash !== su.cookie.split('=')[1] && /^[0-9a-f]{64}$/.test(sess[0].id_hash), 'session row holds the SHA-256 of the id, not the id');
const rls = await q("SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('siderarium_accounts','siderarium_sessions')");
ok(rls.length === 2 && rls.every(r => r.relrowsecurity), 'row-level security enabled on account tables (no policies → Supabase API roles see nothing)');
let p1 = await play(su.cookie, '오리온 경비');
ok(p1.asked && p1.snap.companies[p1.company].name === '오리온 경비', `PMC created (${p1.company})`);
// the creation is saved immediately with the link
await wait(1500);
let main = (await q("SELECT data->'accounts' AS a, gen FROM siderarium_world WHERE id = 'main'"))[0];
ok(main.a?.[acct] === p1.company, `link saved with the world right after creation (gen ${main.gen})`);
// autosave (30 s) keeps it
p1.ws.send(JSON.stringify({ t: 'cmd', id: 1, cmd: { c: 'renameCompany', name: '오리온 경비대' } }));
await wait(33000);
main = (await q("SELECT data->'accounts' AS a, data->'world'->'companies'->$1->>'name' AS n FROM siderarium_world WHERE id = 'main'", [p1.company]))[0];
ok(main.a?.[acct] === p1.company && main.n === '오리온 경비대', 'autosave keeps the link and the latest PMC state');
const oldCompany = p1.company;
p1.ws.close();
await stop(srv);

// world reset: accounts survive, links are cleared, the old world (with its link) is in the backup
log = '';
srv = await start({ WORLD_RESET: 'acct-test-1' });
ok(log.includes('WORLD RESET applied'), 'world reset applied');
ok((await q('SELECT count(*)::int AS n FROM siderarium_accounts'))[0].n === 1, 'the account still exists after the world reset');
const bk = (await q("SELECT data->'accounts' AS a FROM siderarium_world WHERE id = 'backup-reset-acct-test-1'"))[0];
ok(bk?.a?.[acct] === oldCompany, 'the reset backup keeps the old world together with its account link');
ok(log.includes('0 linked PMCs'), 'the fresh world has no links');
// existing session cookie still valid (sessions are not world data)
const p2 = await play(su.cookie, '오리온 재건');
ok(p2.asked && p2.snap.companies[p2.company].name === '오리온 재건', `after the reset the same account is asked for a new PMC and gets one (${p2.company})`);
ok(!Object.values(p2.snap.companies).some(c => c.name === '오리온 경비대'), 'the old PMC is not in the new world');
p2.ws.close();
await wait(800);
await stop(srv);

// restore the backup (operator procedure): its link comes back with it
await q("UPDATE siderarium_world SET data = (SELECT data FROM siderarium_world WHERE id = 'backup-reset-acct-test-1'), gen = gen + 1, updated = now() WHERE id = 'main'");
log = '';
srv = await start({ WORLD_RESET: 'acct-test-1' }); // same token still set: must not reset again
ok(log.includes('이미 적용된 초기화 토큰'), 'the reset token is not applied twice');
const login = await post('/api/auth/login', { loginId: 'commander', password: 'deep-space-91' });
const p3 = await play(login.cookie, '쓰이면 안 됨');
ok(!p3.asked && p3.company === oldCompany && p3.snap.companies[oldCompany].name === '오리온 경비대', 'after restoring the backup the account controls its old PMC again (no PMC prompt)');
ok(Object.values(p3.snap.companies).filter(c => c.kind === 'player').length === 1, 'exactly one player company in the restored world');
p3.ws.close();
await stop(srv);
ok(!log.includes('deep-space'), 'no password in the server log');
await db.end();

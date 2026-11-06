// Migration rehearsal (Postgres): seeds siderarium_world from a save, then dry run → apply → operator data
// rollback (backup row → main with gen+1, which fences the running instance) → restart → previous build
// on migrated data.   PGTEST_URL=postgres://… node scripts/rehearse-pg.mjs <previous server.mjs> <save.json>
// Never point PGTEST_URL at the production database: the script drops siderarium_world.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const pg = createRequire(process.cwd() + '/package.json')('pg');
const URL = process.env.PGTEST_URL ?? 'postgres://postgres@127.0.0.1:5499/postgres';
if (/supabase|render\.com|amazonaws/.test(URL)) { console.error('refusing to run against a hosted database'); process.exit(1); }
const NEW = process.cwd() + '/dist-server/server.mjs', OLD = process.argv[2];
const db = new pg.Client({ connectionString: URL }); await db.connect();
const q = (s, a) => db.query(s, a).then(r => r.rows);
const show = async label => console.log(`  [db ${label}]`, JSON.stringify(await q(`select id, gen, data->'world'->>'contentV' as cv, (select count(*) from jsonb_each(data->'world'->'ships') e where e.value ? 'hull') as hulls from siderarium_world where id not like 'meta%' order by id`)));
function server(bin, env = {}) {
  const p = spawn('node', [bin], { env: { ...process.env, PORT: '8392', DATABASE_URL: URL, SAVE_FILE: '/nonexistent/x.json', ...env } });
  p.log = ''; p.stdout.on('data', d => { p.log += d; }); p.stderr.on('data', d => { p.log += d; });
  p.ready = (async () => { const t = Date.now(); while (!/listening/.test(p.log) && Date.now() - t < 30000 && p.exitCode === null) await new Promise(r => setTimeout(r, 100)); })();
  p.stop = async () => { p.kill('SIGTERM'); await new Promise(r => p.exitCode !== null ? r() : p.on('exit', r)); };
  p.print = re => { for (const l of p.log.split('\n')) if (re.test(l)) console.log('    ' + l.slice(0, 260)); };
  return p;
}
const RE = /DRY|backup|migration|저장 거부|종료 저장|!!!|restored|created/;
await q('drop table if exists siderarium_world');
console.log('== a. old code creates the table'); let s = server(OLD); await s.ready; await s.stop();
await q("update siderarium_world set data = $1 where id = 'main'", [fs.readFileSync(process.argv[3], 'utf8')]); await show('seeded with the old save');
console.log('== b. new code, default = dry run'); s = server(NEW); await s.ready; await s.stop(); s.print(RE); await show('after dry run');
console.log('== c. new code, CONTENT_MIGRATE=apply (keeps running)'); s = server(NEW, { CONTENT_MIGRATE: 'apply' }); await s.ready; s.print(RE); await show('while running migrated');
console.log('== d. operator restores the backup into main and bumps gen (fences the running instance)');
await q("update siderarium_world set data = (select data from siderarium_world where id = 'backup-pre-v4.2.c0'), gen = gen + 1, updated = now() where id = 'main'");
await show('restored');
console.log('   waiting for the running instance\'s periodic save (≤ 35 s)…');
const t0 = Date.now(); while (!/저장 거부/.test(s.log) && Date.now() - t0 < 40000) await new Promise(r => setTimeout(r, 500));
await s.stop(); s.print(/저장 거부|종료 저장/); await show('after the stale instance stopped');
console.log('== e. restart (default mode) loads the restored world'); s = server(NEW); await s.ready; await s.stop(); s.print(RE); await show('final');
console.log('== f. code rollback on Postgres: migrate again, then the old build runs on it'); s = server(NEW, { CONTENT_MIGRATE: 'apply' }); await s.ready; await s.stop();
s = server(OLD); await s.ready; await s.stop(); s.print(/migration check|!!!|restored/); await show('old code on migrated data');
await db.end();

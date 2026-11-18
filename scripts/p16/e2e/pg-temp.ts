// P16.6 — the development carrier release on a real server backed by a DISPOSABLE local PostgreSQL (the production
// storage path), and the guards that keep the release off any other database.
//   PGURL=postgres://postgres@127.0.0.1:55432/p166 npx vite-node scripts/p16/e2e/pg-temp.ts
// 1. the dev server refuses a non-local DATABASE_URL, and a local one without P16_DEV_TEMP_DB=1
// 2. dev server on the temp DB: new world in siderarium_world is rules 3 with the carrier markets; a real account
//    signs up and buys an interceptor wing into its helios storage (market stock decrements)
// 3. restart: world, account, session cookie and the purchase survive; the world clock kept advancing
// 4. a production-mode server (no flag) on the same DB loads it (code rollback), new battles there are rules 2
import pg from 'pg';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Server, Pilot, freePort, delay, until } from './harness';

const PGURL = process.env.PGURL ?? 'postgres://postgres@127.0.0.1:55432/p166';
const dir = mkdtempSync(path.join(os.tmpdir(), 'p166pg-'));
const save = path.join(dir, 'unused.json');
const checks: string[] = [];
const t0 = Date.now();
function check(ok: unknown, label: string, extra?: unknown) { if (!ok) throw Error('FAIL ' + label + (extra !== undefined ? ' ' + JSON.stringify(extra) : '')); checks.push(label); console.log(`PASS [${Math.round((Date.now() - t0) / 1000)}s] ${label}`, extra !== undefined ? JSON.stringify(extra).slice(0, 300) : ''); }
const DEV = { NODE_ENV: 'development', P16_DEV_CARRIER_RELEASE: '1' };
const pool = new pg.Pool({ connectionString: PGURL });
await pool.query('DROP TABLE IF EXISTS siderarium_world, siderarium_accounts, siderarium_sessions');
const port = await freePort();

// 1. guards
for (const [env, label] of [[{ ...DEV, DATABASE_URL: 'postgres://u:p@db.example.com:5432/prod', P16_DEV_TEMP_DB: '1' }, 'a remote DATABASE_URL'], [{ ...DEV, DATABASE_URL: PGURL }, 'a local DATABASE_URL without P16_DEV_TEMP_DB=1']] as const) {
  let err = '';
  try { const x = new Server(port, save, undefined, env); await x.start(); await x.stop(); } catch (e) { err = String(e); }
  check(err.includes('임시 로컬 DB에서만'), `1: the dev carrier server refuses ${label}`);
}
const tables = (await pool.query(`SELECT count(*)::int n FROM information_schema.tables WHERE table_name LIKE 'siderarium_%'`)).rows[0].n;
check(tables === 0, '1: nothing was written to the database by the refused starts', { tables });

// 2. dev server on the temp DB
const srv = new Server(port, save, undefined, { ...DEV, DATABASE_URL: PGURL, P16_DEV_TEMP_DB: '1' });
await srv.start();
const A = new Pilot(srv, 'PG 항모 시험', 'security');
await A.signup('p166_pg_a'); await A.connect();
let s = A.snap();
check(s.carrierV === 1 && s.stations.helios.market.eq_wing_interceptor && s.stations.bastion.market.eq_wing_torpedo, '2: new world on the temp DB has the carrier gear markets');
const ship = Object.values<any>(s.ships).find(x => x.owner === A.id);
const stock0 = A.snap().stations.helios.market.eq_wing_interceptor.stock;
const buyErr = await A.command({ c: 'buy', station: 'helios', res: 'eq_wing_interceptor', amount: 1 });
await delay(1500); s = A.snap();
const stock1 = s.stations.helios.market.eq_wing_interceptor.stock;
const held = (s.stations.helios.storage?.[A.id]?.eq_wing_interceptor ?? 0);
check(buyErr === null && stock0 - stock1 > 0.9 && stock0 - stock1 < 1.1 && held === 1, '2: A buys an interceptor wing at helios (dev release: carrier gear is for sale)', { buyErr, stock0, stock1, held });
await delay(1500);
const time1 = s.time;
await srv.stop();
const row = (await pool.query(`SELECT id, (data->'world'->>'carrierV') v, (data->'world'->>'time')::float t FROM siderarium_world WHERE id = 'main'`)).rows;
const accts = (await pool.query('SELECT count(*)::int n FROM siderarium_accounts')).rows[0].n;
check(row.length === 1 && row[0].v === '1' && accts === 1, '2: the world and the account are in the temp DB (siderarium_world / siderarium_accounts)', { rows: row.length, carrierV: row[0]?.v, accts });

// 3. restart on the same DB: same cookie, same purchase
await srv.start();
await A.connect();
s = A.snap();
const held2 = (s.stations.helios.storage?.[A.id]?.eq_wing_interceptor ?? 0);
check(held2 === 1 && s.time >= time1, '3: after a restart the session, the world clock and the purchased wing are restored from the DB', { held2, time: [time1, s.time] });
await srv.stop();

// 4. production-mode server (no flag) on the same DB: it loads the migrated world; new battles stay rules 2
const psrv = new Server(port, save, undefined, { NODE_ENV: 'production', P16_DEV_CARRIER_RELEASE: '', DATABASE_URL: PGURL });
await psrv.start();
const P = new Pilot(psrv, 'PG 항모 시험', 'security'); P.cookie = A.cookie;
await P.connect();
const sp = P.snap();
check(sp.ships[ship.id] && !psrv.log.includes('Error'), '4: a production-mode server (no flag) loads the same DB (code-only rollback keeps working)');
const sell = await P.command({ c: 'buy', station: 'helios', res: 'eq_wing_interceptor', amount: 1 });
check(sell !== null, '4: …and carrier gear is not for sale there (production gate)', sell);
await psrv.stop();
await pool.end();
console.log(`\nALL ${checks.length} CHECKS PASSED`);

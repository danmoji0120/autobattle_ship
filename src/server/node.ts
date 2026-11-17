// SIDERARIUM multiplayer server: serves the built client and runs the authoritative world.
//   PORT          http port (default 8080)
//   DATABASE_URL  Postgres connection string → world persisted in table `siderarium_world`
//   SIDERARIUM_REQUIRE_DB  '1' means fail startup if PostgreSQL is unavailable (production safety)
//   SAVE_FILE     otherwise the world is saved to this JSON file (default ./data/world.json)
//   WORLD_SEED    seed for a brand-new world
//   WORLD_RESET   token: replace the world with a fresh one once per token (accounts are kept)
//   CONTENT_MIGRATE  'apply' moves an older save onto the content model (growth project); anything else
//                 (default) only dry-runs the migration on an in-memory copy and logs the result
//   ECON_MIGRATE  'apply' moves an eligible c4 save onto value-chain pricing (docs/ECONOMY_B_PLAN.md);
//                 anything else (default) only dry-runs it on an in-memory copy and logs the result
//   ECON_PRICING  'chain' makes a brand-new world (first start / WORLD_RESET) use value-chain pricing;
//                 default off (unapproved design decision)
//   SAVE_INTERVAL_S  seconds between autosaves (default 30)
//   SESSION_TTL_HOURS  idle lifetime of a sign-in session (default 336 = 14 days, renewed while used)
// Accounts (login ID + password, see accounts.ts) live in siderarium_accounts / siderarium_sessions
// (or data/accounts.json without a database). The WebSocket only opens for a valid session cookie.
import http from 'node:http';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { GameServer, type Conn } from './core';
import type { ClientMsg, SaveFile } from './protocol';
import { WorldSim } from '../world/sim';
import { newWorldOptions, worldRules, type WorldPreset } from '../world/worldPreset';
import { INDUSTRY_VERSION } from '../world/economy';
import { WORLD_VERSION } from '../world/worldgen';
import { CONTENT_VERSION, census, compareCensus, migrateContent } from '../world/migrate';
import { econEligible, migrateEconChain } from '../world/econMigrate';
import { AuthService, AuthError, memoryStore, pgAccountStore, type AccountStore } from './accounts';
import { DevCombatAuth } from './devCombatAuth';
import { ConnGuard, limitsFromEnv, parseClientMsg } from './wsguard';
import { Saver, pickAnalytics, type AnalyticsRecord } from './saver';

const PORT = Number(process.env.PORT ?? 8080);
const ROOT = path.resolve(process.env.STATIC_DIR ?? 'dist');
const SAVE_FILE = path.resolve(process.env.SAVE_FILE ?? 'data/world.json');
const ANALYTICS_FILE = SAVE_FILE.replace(/\.json$/, '') + '.analytics.json';
/** ANALYTICS_SEPARATE=0 keeps the analytics history inside every world save (the previous behaviour) */
const ANALYTICS_SEPARATE = process.env.ANALYTICS_SEPARATE !== '0';

interface Storage { load(): Promise<SaveFile | null>; name: string;
  /** write the world save (JSON text built once by GameServer.saveText) */
  save(text: string): Promise<void>;
  /** the analytics history, stored apart from the world and written less often (see saver.ts) */
  saveAnalytics?(text: string): Promise<void>;
  loadAnalytics?(): Promise<AnalyticsRecord | null>;
  /** world reset requested by token (WORLD_RESET): back up the current world, replace it with `fresh`,
   *  fence off every instance still holding the old one. Idempotent per token. */
  reset(token: string, fresh: () => SaveFile): Promise<{ done: boolean; backup?: string; why?: string }>;
  /** save migration as one step: lock the stored world, copy exactly that data to a backup key (never
   *  overwritten; an identical existing copy is reused), transform it, write the result under a new world
   *  generation so every instance still holding the old one can no longer save. `transform` returns null
   *  when the locked data needs nothing (another instance migrated it first); then nothing is written.
   *  Any error leaves the stored world untouched. */
  migrate(keyFor: (d: SaveFile) => string, transform: (d: SaveFile) => SaveFile | null): Promise<MigrateResult>;
  /** set once a save was refused because a newer world generation exists (this instance is stale) */
  fenced?: boolean }
type MigrateResult = { data: SaveFile; applied: boolean; backup?: string; reused?: boolean; gen?: number };
/** test hook: hold the migration transaction open this long (ms) so a concurrent save provably waits on it */
const holdMs = () => Number(process.env.SIDERARIUM_TEST_MIGRATE_HOLD_MS ?? 0);
const backupKeys = (base: string) => Array.from({ length: 9 }, (_, i) => i ? `${base}-${i + 1}` : base);

function fileStorage(): Storage {
  return {
    name: `file ${SAVE_FILE}`,
    async load() { try { return JSON.parse(fs.readFileSync(SAVE_FILE, 'utf8')); } catch { return null; } },
    async reset(tokenId, fresh) {
      const mark = SAVE_FILE + '.reset';
      if (fs.existsSync(mark) && fs.readFileSync(mark, 'utf8') === tokenId) return { done: false, why: '이미 적용된 초기화 토큰' };
      const key = `backup-reset-${tokenId}`;
      const f = SAVE_FILE.replace(/\.json$/, '') + `.${key}.json`;
      if (fs.existsSync(SAVE_FILE) && !fs.existsSync(f)) fs.copyFileSync(SAVE_FILE, f);
      if (fs.existsSync(SAVE_FILE) && fs.readFileSync(f, 'utf8') !== fs.readFileSync(SAVE_FILE, 'utf8')) return { done: false, why: '백업 검증 실패' };
      fs.mkdirSync(path.dirname(SAVE_FILE), { recursive: true });
      fs.writeFileSync(SAVE_FILE, JSON.stringify(fresh()));
      // the separately stored analytics belong to the old world: kept next to its backup
      if (fs.existsSync(ANALYTICS_FILE)) fs.renameSync(ANALYTICS_FILE, SAVE_FILE.replace(/\.json$/, '') + `.${key}.analytics.json`);
      fs.writeFileSync(mark, tokenId);
      return { done: true, backup: key };
    },
    async migrate(keyFor, transform) {
      const raw = fs.readFileSync(SAVE_FILE, 'utf8'); const cur: SaveFile = JSON.parse(raw);
      const out = transform(structuredClone(cur));
      if (!out) return { data: cur, applied: false };
      let backup = '', reused = false;
      for (const k of backupKeys(`backup-pre-v${keyFor(cur)}`)) {
        const f = SAVE_FILE.replace(/\.json$/, '') + `.${k}.json`;
        const existed = fs.existsSync(f);
        if (!existed) fs.writeFileSync(f, raw);
        if (fs.readFileSync(f, 'utf8') === raw) { backup = k; reused = existed; break; }
      }
      if (!backup) throw new Error('백업 키를 확보하지 못함 (9개 모두 다른 내용)');
      const tmp = SAVE_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(out)); fs.renameSync(tmp, SAVE_FILE);
      return { data: out, applied: true, backup, reused };
    },
    async save(text) {
      fs.mkdirSync(path.dirname(SAVE_FILE), { recursive: true });
      const tmp = SAVE_FILE + '.tmp';
      await fs.promises.writeFile(tmp, text);
      await fs.promises.rename(tmp, SAVE_FILE);
    },
    async saveAnalytics(text) {
      const f = ANALYTICS_FILE, tmp = f + '.tmp';
      await fs.promises.writeFile(tmp, text);
      await fs.promises.rename(tmp, f);
    },
    async loadAnalytics() { try { return JSON.parse(await fs.promises.readFile(ANALYTICS_FILE, 'utf8')); } catch { return null; } },
  };
}

async function pgPool(url: string) {
  const { default: pg } = await import('pg');
  // Supabase/Render URLs often carry ?sslmode=require, which recent pg versions treat as strict
  // verification against the provider's pooler certificate; TLS is configured explicitly instead.
  const clean = url.replace(/([?&])sslmode=[^&]*&?/, '$1').replace(/[?&]$/, '');
  const local = /localhost|127\.0\.0\.1/.test(clean);
  const pool = new pg.Pool({ connectionString: clean, ssl: local ? false : { rejectUnauthorized: false }, max: 4, connectionTimeoutMillis: 15000 });
  pool.on('error', e => console.error('[siderarium] postgres pool error', e.message));
  return { pool, host: new URL(clean).hostname };
}

async function pgStorage({ pool, host }: Awaited<ReturnType<typeof pgPool>>): Promise<Storage> {
  await pool.query('CREATE TABLE IF NOT EXISTS siderarium_world (id TEXT PRIMARY KEY, data JSONB NOT NULL, updated TIMESTAMPTZ NOT NULL DEFAULT now())');
  // world generation: bumped by a reset; a save only lands while the row still has the generation this
  // instance loaded, so an older instance (autosave, shutdown save during a deploy) can never write back
  await pool.query('ALTER TABLE siderarium_world ADD COLUMN IF NOT EXISTS gen BIGINT NOT NULL DEFAULT 0');
  let gen = 0;
  const st: Storage = {
    name: `postgres (${host})`,
    async load() { const r = await pool.query('SELECT data, gen FROM siderarium_world WHERE id = $1', ['main']); gen = Number(r.rows[0]?.gen ?? 0); return r.rows[0]?.data ?? null; },
    async reset(tokenId, fresh) {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        // the main row is locked: a concurrent autosave from the running instance waits, then misses
        const cur = await c.query('SELECT gen, md5(data::text) AS h FROM siderarium_world WHERE id = $1 FOR UPDATE', ['main']);
        const applied = await c.query("SELECT data->>'token' AS t FROM siderarium_world WHERE id = 'meta:reset'");
        if (applied.rows[0]?.t === tokenId) { await c.query('ROLLBACK'); return { done: false, why: '이미 적용된 초기화 토큰' }; }
        const key = `backup-reset-${tokenId}`;
        if (cur.rows.length) {
          await c.query('INSERT INTO siderarium_world (id, data, updated, gen) SELECT $1, data, now(), gen FROM siderarium_world WHERE id = $2 ON CONFLICT (id) DO NOTHING', [key, 'main']);
          const b = await c.query('SELECT md5(data::text) AS h FROM siderarium_world WHERE id = $1', [key]);
          if (b.rows[0]?.h !== cur.rows[0].h) { await c.query('ROLLBACK'); return { done: false, why: `백업 검증 실패 (${b.rows[0]?.h} ≠ ${cur.rows[0].h})` }; }
        }
        const next = Number(cur.rows[0]?.gen ?? 0) + 1;
        await c.query('INSERT INTO siderarium_world (id, data, updated, gen) VALUES ($1, $2, now(), $3) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated = now(), gen = EXCLUDED.gen', ['main', JSON.stringify(fresh()), next]);
        await c.query("INSERT INTO siderarium_world (id, data, updated) VALUES ('meta:reset', $1, now()) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated = now()", [JSON.stringify({ token: tokenId, backup: key, gen: next, at: new Date().toISOString() })]);
        await c.query('COMMIT');
        gen = next;
        return { done: true, backup: cur.rows.length ? key : undefined };
      } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
    },
    async migrate(keyFor, transform) {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        // lock the row: a save from any other instance now waits, and after COMMIT finds a newer
        // generation and is refused (UPDATE … WHERE gen = old re-checks the committed row)
        const cur = await c.query('SELECT data, gen, md5(data::text) AS h FROM siderarium_world WHERE id = $1 FOR UPDATE', ['main']);
        if (!cur.rows.length) throw new Error('월드 행이 없음');
        const curGen = Number(cur.rows[0].gen), data: SaveFile = cur.rows[0].data;
        const hold = holdMs(); if (hold) await new Promise(r => setTimeout(r, hold));
        const out = transform(structuredClone(data));
        if (!out) { await c.query('ROLLBACK'); gen = curGen; return { data, applied: false, gen: curGen }; }
        // backup = server-side copy of exactly the locked data, verified by hash
        let backup = '', reused = false;
        for (const k of backupKeys(`backup-pre-v${keyFor(data)}`)) {
          const ins = await c.query('INSERT INTO siderarium_world (id, data, updated, gen) SELECT $1, data, now(), gen FROM siderarium_world WHERE id = $2 ON CONFLICT (id) DO NOTHING', [k, 'main']);
          const b = await c.query('SELECT md5(data::text) AS h FROM siderarium_world WHERE id = $1', [k]);
          if (b.rows[0]?.h === cur.rows[0].h) { backup = k; reused = !ins.rowCount; break; }
        }
        if (!backup) throw new Error('백업 키를 확보하지 못함 (9개 모두 다른 내용)');
        const next = curGen + 1;
        const w = await c.query('UPDATE siderarium_world SET data = $2, updated = now(), gen = $3 WHERE id = $1 AND gen = $4', ['main', JSON.stringify(out), next, curGen]);
        if (w.rowCount !== 1) throw new Error('마이그레이션 결과 저장 실패');
        const rb = await c.query('SELECT data = $2::jsonb AS same FROM siderarium_world WHERE id = $1', ['main', JSON.stringify(out)]);
        if (!rb.rows[0]?.same) throw new Error('마이그레이션 결과 읽기 검증 실패');
        await c.query("INSERT INTO siderarium_world (id, data, updated) VALUES ('meta:migrate', $1, now()) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated = now()",
          [JSON.stringify({ backup, reused, fromGen: curGen, gen: next, at: new Date().toISOString() })]);
        await c.query('COMMIT');
        gen = next;
        return { data: out, applied: true, backup, reused, gen: next };
      } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
    },
    async save(text) {
      if (st.fenced) return;
      const r = await pool.query('UPDATE siderarium_world SET data = $2, updated = now() WHERE id = $1 AND gen = $3', ['main', text, gen]);
      if (r.rowCount) return;
      const ins = await pool.query('INSERT INTO siderarium_world (id, data, updated, gen) VALUES ($1, $2, now(), $3) ON CONFLICT (id) DO NOTHING', ['main', text, gen]);
      if (ins.rowCount) return;
      st.fenced = true;
      console.error(`[siderarium] !!! 저장 거부: 더 새로운 월드 세대가 있습니다 (이 인스턴스 gen=${gen}). 이 인스턴스는 더 이상 저장하지 않습니다.`);
    },
    // row 'analytics' in the same table; written only while this instance's world generation is current
    async saveAnalytics(text) {
      if (st.fenced) return;
      const u = await pool.query("UPDATE siderarium_world SET data = $1, updated = now(), gen = $2 WHERE id = 'analytics' AND (SELECT gen FROM siderarium_world WHERE id = 'main') = $2", [text, gen]);
      if (u.rowCount) return;
      const i = await pool.query("INSERT INTO siderarium_world (id, data, updated, gen) SELECT 'analytics', $1, now(), $2 WHERE (SELECT gen FROM siderarium_world WHERE id = 'main') = $2 ON CONFLICT (id) DO NOTHING", [text, gen]);
      if (!i.rowCount) throw new Error('분석 기록 저장 거부 (월드 세대 불일치 또는 동시 기록)');
    },
    async loadAnalytics() { const r = await pool.query("SELECT data FROM siderarium_world WHERE id = 'analytics'"); return r.rows[0]?.data ?? null; },
  };
  return st;
}

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.ico': 'image/x-icon', '.glb': 'model/gltf-binary', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.ktx2': 'image/ktx2' };

async function main() {
  if (process.env.SIDERARIUM_REQUIRE_DB === '1' && !process.env.DATABASE_URL) {
    throw new Error('SIDERARIUM_REQUIRE_DB=1 이지만 DATABASE_URL이 없습니다. 월드 파일 모드로 시작하지 않습니다.');
  }
  let storage: Storage = fileStorage();
  let saved: SaveFile | null = null;
  let accountStore: AccountStore | null = null;
  if (process.env.DATABASE_URL) {
    try {
      const pool = await pgPool(process.env.DATABASE_URL);
      const pgS = await pgStorage(pool);
      saved = await pgS.load();
      accountStore = await pgAccountStore(pool.pool);
      storage = pgS;
    } catch (e) {
      if (process.env.SIDERARIUM_REQUIRE_DB === '1') {
        console.error('[siderarium] !!! DATABASE_URL 연결 실패 — 운영 서버 시작 중단:', (e as Error).message);
        throw e;
      }
      accountStore = null;
      console.error('[siderarium] !!! DATABASE_URL 연결 실패 — 파일 저장으로 대체합니다 (재시작 시 세계가 사라질 수 있음):', (e as Error).message);
    }
  }
  if (storage.name.startsWith('file')) saved = await storage.load();
  if (!ANALYTICS_SEPARATE) { delete storage.saveAnalytics; delete storage.loadAnalytics; }
  // A-1: one set of creation rules for a first start (empty storage) and for an operator reset. WORLD_PRESET=standard
  // (the default) = the integrated P10 world; WORLD_PRESET=legacy = the old per-system opt-in flags below.
  const presetEnv = (process.env.WORLD_PRESET ?? 'standard').trim();
  if (presetEnv !== 'standard' && presetEnv !== 'legacy') { console.error(`[siderarium] !!! WORLD_PRESET 값 오류: ${presetEnv} (standard | legacy)`); process.exit(1); }
  const worldFlags = {
    worldPreset: presetEnv as WorldPreset, econNew: process.env.ECON_PRICING === 'chain', combatNew: process.env.COMBAT_P11 === '1', opsNew: process.env.FLEET_OPS_P12 === '1', logisticsNew: process.env.AUTO_LOGISTICS_P125 === '1',
    salvageNew: process.env.SALVAGE_P131 === '1', piracyNew: process.env.PIRACY_P132 === '1', blackMarketNew: process.env.BLACKMARKET_P133 === '1', lawNew: process.env.LAW_P134 === '1', repNew: process.env.REPUTATION_P14 === '1',
  };
  if (presetEnv === 'standard' && Object.entries(worldFlags).some(([k, v]) => k !== 'worldPreset' && v))
    console.log('[siderarium] WORLD_PRESET=standard — 개별 기능 플래그(COMBAT_P11 등)는 새 월드 생성에 쓰이지 않습니다');
  // operator-requested world reset (env WORLD_RESET=<token>): applied once per token
  const resetTok = (process.env.WORLD_RESET ?? '').trim();
  if (resetTok) {
    if (!/^[A-Za-z0-9_-]{4,40}$/.test(resetTok)) { console.error('[siderarium] !!! WORLD_RESET 토큰 형식 오류 (영숫자·_- 4~40자)'); process.exit(1); }
    const seed = Number(process.env.WORLD_SEED ?? 1);
    const r = await storage.reset(resetTok, () => ({ v: 1, world: JSON.parse(WorldSim.create(seed, newWorldOptions(worldFlags)).serialize()), auth: {}, accounts: {} }));
    // accounts are separate from the world: they survive; each account simply gets "create your PMC" again
    if (r.done) {
      console.log(`[siderarium] WORLD RESET applied (token ${resetTok}) — previous world kept as ${r.backup ?? '(없음)'}`);
      saved = await storage.load();
    } else console.log(`[siderarium] WORLD_RESET ${resetTok}: ${r.why} — 초기화하지 않음`);
  }
  // safe migration: the stored world is backed up, migrated and written back atomically (see
  // Storage.migrate); the migrated world must keep every player, credit, ship, station, stored good and
  // piece of equipment (plus exactly what the migration recorded as granted), and load back identically
  const applyContent = process.env.CONTENT_MIGRATE === 'apply';
  const applyEcon = process.env.ECON_MIGRATE === 'apply';
  // econ is due only for a save that is (or this run makes) c4 and has no value-chain pricing yet
  const econDue = (w: SaveFile['world']) => applyEcon && !w.econ && ((w.contentV ?? 0) >= 4 || applyContent);
  const due = (w: SaveFile['world']) => (w.version ?? 0) < WORLD_VERSION || (w.industryV ?? 0) < INDUSTRY_VERSION || (applyContent && (w.contentV ?? 0) < CONTENT_VERSION) || econDue(w);
  if (saved && due(saved.world)) {
    // backup → transform → verify → write is one transaction on the row as it is *now* (an old instance
    // may have saved since this one loaded), and bumps the world generation: the old instance's autosave
    // and shutdown save are refused from then on, so it can never write the old data over the new
    let rep = null as WorldSim['contentReport'];
    try {
      const r = await storage.migrate(
        d => `${d.world.version ?? 0}.${d.world.industryV ?? 0}${(d.world.contentV ?? 0) || applyContent ? `.c${d.world.contentV ?? 0}` : ''}${d.world.econ || applyEcon ? `.e${d.world.econ?.v ?? 0}` : ''}`,
        d => {
          if (!due(d.world)) return null;
          const b = census(d.world);
          const sim = new WorldSim(structuredClone(d.world), { migrateContent: applyContent, migrateEcon: applyEcon });
          const bad = compareCensus(b, census(sim.st));
          if (bad.length) throw new Error(`센서스 불일치 ${bad.join('; ')}`);
          if (applyEcon && sim.econReport && !sim.econReport.ok) console.log(`[siderarium] econ migration skipped: ${sim.econReport.why}`);
          const s1 = sim.serialize();
          if (new WorldSim(JSON.parse(s1), { migrateContent: applyContent, migrateEcon: applyEcon }).serialize() !== s1) throw new Error('복원 왕복 불일치');
          rep = sim.contentReport;
          return { ...d, world: JSON.parse(s1) };
        });
      saved = r.data;
      if (r.applied) console.log(`[siderarium] save migration committed: backup ${r.backup}${r.reused ? ' (기존 동일 사본 재사용)' : ''} verified · world gen ${r.gen ?? '-'}${rep && rep.from < rep.to ? ` · content c${rep.from}→c${rep.to} · ships ${rep.ships} · fitted ${rep.fitted} · returned ${rep.returned.length} · granted ${rep.granted.length}` : ''} (${JSON.stringify(census(saved.world))})`);
      else console.log('[siderarium] save migration: 다른 인스턴스가 이미 적용함 — 저장된 월드를 그대로 사용');
    } catch (e) {
      console.error('[siderarium] !!! 마이그레이션 실패 — 저장된 월드는 변경되지 않았습니다:', (e as Error).message); process.exit(1);
    }
  }
  let before: ReturnType<typeof census> | null = null;
  if (saved) {
    before = census(saved.world);
    const cv = saved.world.contentV ?? 0;
    if (cv < CONTENT_VERSION && !applyContent) {
      // dry run on a copy of the real save: nothing is written, the result is only logged
      try {
        const copy = structuredClone(saved.world);
        const sim = new WorldSim(copy, { migrateContent: true });
        const rep = sim.contentReport!;
        const bad = compareCensus(before, census(sim.st));
        const s1 = sim.serialize();
        const round = new WorldSim(JSON.parse(s1)).serialize() === s1;
        console.log(`[siderarium] content migration DRY RUN c${cv}→c${rep.to}: ships ${rep.ships} · builds ${rep.builds} · fitted ${rep.fitted} · converted ${rep.converted.reduce((a, c) => a + c.n, 0)} items · returned ${rep.returned.length} · unmapped ${rep.unmapped.length} · granted ${rep.granted.length} · census ${bad.length ? 'MISMATCH ' + bad.join('; ') : 'OK'} · round-trip ${round ? 'OK' : 'FAIL'} — 적용하지 않음 (CONTENT_MIGRATE=apply 로 적용)`);
        if (rep.unmapped.length) console.log(`[siderarium] dry run unmapped: ${rep.unmapped.slice(0, 20).join(', ')}`);
        if (rep.returned.length) console.log(`[siderarium] dry run returned to storage: ${rep.returned.slice(0, 20).map(r => `${r.ship}:${r.item}@${r.station}`).join(', ')}`);
      } catch (e) { console.error('[siderarium] content migration DRY RUN failed:', (e as Error).stack); }
    }
  }
  if (saved && !applyEcon && !econEligible(saved.world)) {
    // econ dry run on a copy: how many market bases value-chain pricing would change (nothing written)
    try {
      const copy = structuredClone(saved.world), b = census(copy), rep = migrateEconChain(copy);
      const bad = compareCensus(b, census(copy));
      console.log(`[siderarium] econ migration DRY RUN e0→e1: markets ${rep.markets} · goods ${rep.goods} · bases changed ${rep.changed} · census ${bad.length ? 'MISMATCH ' + bad.join('; ') : 'OK'} — 적용하지 않음 (ECON_MIGRATE=apply 로 적용)`);
    } catch (e) { console.error('[siderarium] econ migration DRY RUN failed:', (e as Error).message); }
  }
  if (!accountStore) {
    const f = path.join(path.dirname(SAVE_FILE), 'accounts.json');
    accountStore = memoryStore({ read: () => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } }, write: s => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f + '.tmp', s); fs.renameSync(f + '.tmp', f); } });
  }
  const auth = new AuthService(accountStore, { ttlMs: Number(process.env.SESSION_TTL_HOURS ?? 24 * 14) * 3600_000 });
  console.log(`[siderarium] accounts: ${accountStore.name} · ${Object.keys(saved?.accounts ?? {}).length} linked PMCs · ${Object.keys(saved?.auth ?? {}).length} legacy tokens`);
  let alertConfig: import('./analytics').AnalyticsOptions['alerts'];
  try { alertConfig = JSON.parse(process.env.ANALYTICS_ALERTS_JSON ?? '{}'); } catch { console.warn('[siderarium] invalid ANALYTICS_ALERTS_JSON; using defaults'); }
  const adminAccounts = (process.env.ANALYTICS_ADMIN_ACCOUNTS ?? '').split(',').map(s => s.trim()).filter(Boolean);
  // account-exclusive content (BB / BB-EX): the one verified account UUID that owns it. Anything that
  // is not a UUID is ignored — the content then stays ungranted ("설정 필요") rather than going to a guess.
  const bbOwnerRaw = (process.env.SIDERARIUM_BB_OWNER_ACCOUNT ?? '').trim().toLowerCase();
  const bbOwner = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(bbOwnerRaw) ? bbOwnerRaw : undefined;
  if (bbOwnerRaw && !bbOwner) console.warn('[siderarium] SIDERARIUM_BB_OWNER_ACCOUNT 는 계정 UUID 여야 합니다 — BB/BB-EX 미지급 상태로 시작합니다.');
  // analytics history: the separate record when it belongs to this world and is the newest copy
  if (saved && storage.loadAnalytics) {
    try {
      const pick = pickAnalytics(saved, await storage.loadAnalytics());
      if (pick.from === 'separate') saved = { ...saved, analytics: pick.store };
      console.log(`[siderarium] analytics history: ${pick.from === 'separate' ? '별도 기록' : pick.from === 'world' ? '월드 저장 내 기록' : '없음 (새로 시작)'}${pick.why ? ` (${pick.why})` : ''}`);
    } catch (e) { console.error('[siderarium] !!! 분석 기록을 읽지 못했습니다 — 월드 저장 내 기록을 사용합니다:', (e as Error).message); }
  }
  let saver: Saver | null = null;
  const game = new GameServer(saved, {
    singleplayer: false, accounts: true, migrateContent: applyContent, migrateEcon: applyEcon, ...worldFlags, repMigrate: process.env.REPUTATION_P14_MIGRATE === '1', derelictMigrate: process.env.DERELICTS_A32B_MIGRATE === '1', officerMigrate: process.env.OFFICERS_B1_MIGRATE === '1',
    // Verify migration conservation before the intentionally granted BB-EX changes the census.
    deferExclusiveGrant: true,
    adminAccounts, ...(bbOwner ? { exclusiveOwner: bbOwner } : {}),
    analytics: { enabled: process.env.ANALYTICS_ENABLED !== '0', snapshotSeconds: Number(process.env.ANALYTICS_INTERVAL_S ?? 600), maxBytes: Number(process.env.ANALYTICS_MAX_BYTES ?? 8388608), alerts: alertConfig }, snapInterval: 1.0, movInterval: 0.2, saveInterval: Number(process.env.SAVE_INTERVAL_S ?? 30),
    onSaveDue: () => saver?.due(),
    ...(Number(process.env.LOGISTICS_JOB_RETAIN) > 0 ? { logisticsJobRetain: Math.floor(Number(process.env.LOGISTICS_JOB_RETAIN)) } : {}),
  }, Number(process.env.WORLD_SEED ?? 1));
  saver = new Saver(storage, game, { analyticsEveryS: Math.max(30, Number(process.env.ANALYTICS_SAVE_INTERVAL_S ?? 300) || 300) });
  console.log(`[siderarium] world ${saved ? 'restored' : 'created'} (t=${game.sim.time.toFixed(0)}s) storage=${storage.name} rules=${JSON.stringify(worldRules(game.sim.st))}`);
  if (before) {
    const after = census(game.sim.st);
    const bad = compareCensus(before, after);
    if (bad.length) {
      console.error('[siderarium] !!! 마이그레이션 검증 실패 — 저장하지 않고 종료합니다', JSON.stringify({ bad, before, after })); process.exit(1);
    }
    if (game.sim.contentReport && game.sim.contentReport.from < game.sim.contentReport.to) console.log(`[siderarium] content migration applied c${game.sim.contentReport.from}→c${game.sim.contentReport.to}: ships ${game.sim.contentReport.ships} · builds ${game.sim.contentReport.builds} · fitted ${game.sim.contentReport.fitted} · returned ${game.sim.contentReport.returned.length} · granted ${game.sim.contentReport.granted.length}`);
    // restore check: the migrated world serializes and loads back identically
    const s1 = game.sim.serialize();
    const ok = new WorldSim(JSON.parse(s1), { migrateContent: applyContent, migrateEcon: applyEcon }).serialize() === s1;
    if (!ok) { console.error('[siderarium] !!! 복원 검증 실패 — 저장하지 않고 종료합니다'); process.exit(1); }
    console.log(`[siderarium] migration check OK ${JSON.stringify(after)} · restore round-trip identical`);
  }

  // Exclusive ownership is an intentional server grant, not a migration asset delta.
  // Wait until the restored world has passed conservation and serialization checks.
  if (bbOwner) {
    const grant = game.grantExclusive();
    console.log(`[siderarium] BB-EX exclusive grant: ${grant}`);
    if (grant === 'granted' || grant === 'repaired') {
      // Persist the immutable account ledger and unique ship before opening the server.
      if (!await saver.flush()) {
        console.error('[siderarium] !!! BB-EX 계정 귀속 저장 실패 — 서비스 시작을 중단합니다');
        process.exit(1);
      }
    }
  }

  // ── sessions: an HttpOnly cookie carries a random session id; scripts in the page never see it ──
  const COOKIE = 'siderarium_sid';
  const LAB_COOKIE = 'siderarium_devcombat';
  const lab = new DevCombatAuth(auth, { admins: () => adminAccounts, passwordHash: () => process.env.DEV_COMBAT_LAB_PASSWORD_HASH });
  const getCookie = (req: http.IncomingMessage, name: string) => {
    for (const part of (req.headers.cookie ?? '').split(';')) { const i = part.indexOf('='); if (i > 0 && part.slice(0, i).trim() === name) { try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return null; } } }
    return null;
  };
  const getSid = (req: http.IncomingMessage) => {
    return getCookie(req, COOKIE);
  };
  const https = (req: http.IncomingMessage) => String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() === 'https';
  const cookie = (req: http.IncomingMessage, sid: string | null) =>
    `${COOKIE}=${sid ?? ''}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${sid ? Math.floor(auth.ttl / 1000) : 0}${https(req) ? '; Secure' : ''}`;
  const labCookie = (req: http.IncomingMessage, token: string | null) =>
    `${LAB_COOKIE}=${token ?? ''}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${token ? Math.floor(lab.ttl / 1000) : 0}${https(req) ? '; Secure' : ''}`;
  const ipOf = (req: http.IncomingMessage) => String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || req.socket.remoteAddress || '?';
  // a browser always sends Origin on cross-site POSTs and WebSocket handshakes: it must be this host
  const originOk = (req: http.IncomingMessage) => { const o = req.headers.origin; if (!o) return true; try { return new URL(o).host === req.headers.host; } catch { return false; } };
  // Unlike legacy account routes, lab mutations require an explicit, exact Origin.
  const labOriginOk = (req: http.IncomingMessage, requireOrigin = false) => {
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin' && site !== 'none') return false;
    const origin = req.headers.origin;
    if (!origin) return !requireOrigin;
    try { const u = new URL(origin); return u.origin === `${https(req) ? 'https' : 'http'}://${req.headers.host}`; } catch { return false; }
  };

  // open sockets per session, so logout / password change / expiry close them at once
  const socketsBySession = new Map<string, Set<WebSocket>>();
  const closeSessions = (hashes: (string | null)[], why: string) => {
    for (const h of hashes) if (h) for (const ws of socketsBySession.get(h) ?? []) ws.close(4401, why);
  };

  const json = (res: http.ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra });
    res.end(JSON.stringify(body));
  };
  const readBody = (req: http.IncomingMessage) => new Promise<any>((resolve, reject) => {
    let size = 0; const chunks: Buffer[] = [];
    req.on('data', (d: Buffer) => { size += d.length; if (size > 4096) { reject(new AuthError('TOO_LARGE', '요청이 너무 큽니다', 413)); req.destroy(); } else chunks.push(d); });
    req.on('end', () => {
      try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); if (!v || typeof v !== 'object' || Array.isArray(v)) throw 0; resolve(v); } catch { reject(new AuthError('BAD_JSON', '잘못된 요청', 400)); }
    });
    req.on('error', reject);
  });
  const me = async (sid: string | null) => {
    const r = await auth.resolve(sid);
    if (!r) return null;
    const company = game.companyOf(r.account.id);
    return { account: r.account, company: company ? { id: company, name: game.sim.st.companies[company].name } : null };
  };

  async function api(req: http.IncomingMessage, res: http.ServerResponse, url: string) {
    try {
      if (url.startsWith('/api/dev-combat/')) {
        if (!labOriginOk(req, req.method !== 'GET')) return json(res, 403, { error: '허용되지 않은 요청 출처' });
        if (url === '/api/dev-combat/session' && req.method === 'GET') {
          return await lab.valid(getSid(req), getCookie(req, LAB_COOKIE)) ? json(res, 200, { ok: true }) : json(res, 401, { error: '전투 실험실 인증이 필요합니다' });
        }
        if (req.method !== 'POST') return json(res, 405, { error: 'method' });
        if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return json(res, 403, { error: '허용되지 않은 요청 출처' });
        const b = await readBody(req);
        if (url === '/api/dev-combat/login') {
          const grant = await lab.login(getSid(req), b.password, ipOf(req));
          return json(res, 200, { ok: true, expiresAt: grant.expiresAt }, { 'set-cookie': labCookie(req, grant.token) });
        }
        if (url === '/api/dev-combat/logout') {
          lab.logout(getCookie(req, LAB_COOKIE));
          return json(res, 200, { ok: true }, { 'set-cookie': labCookie(req, null) });
        }
        return json(res, 404, { error: 'not found' });
      }
      if (url === '/api/auth/me' && req.method === 'GET') {
        const m = await me(getSid(req));
        return m ? json(res, 200, m) : json(res, 401, { error: '로그인이 필요합니다', code: 'NO_SESSION' }, getSid(req) ? { 'set-cookie': cookie(req, null) } : {});
      }
      if (req.method !== 'POST') return json(res, 405, { error: 'method' });
      if (!originOk(req) || !String(req.headers['content-type'] ?? '').startsWith('application/json')) return json(res, 403, { error: '허용되지 않은 요청 출처' });
      const b = await readBody(req);
      const ip = ipOf(req);
      switch (url) {
        case '/api/auth/signup': {
          if (b.password !== b.confirm) throw new AuthError('CONFIRM', '비밀번호 확인이 일치하지 않습니다');
          const r = await auth.signup(b.loginId, b.password, ip);
          console.log(`[siderarium] account created: ${r.account.loginId}`);
          return json(res, 200, { account: r.account, company: null, recoveryCode: r.recoveryCode }, { 'set-cookie': cookie(req, r.sid) });
        }
        case '/api/auth/login': {
          const r = await auth.login(b.loginId, b.password, ip);
          return json(res, 200, await me(r.sid), { 'set-cookie': cookie(req, r.sid) });
        }
        case '/api/auth/logout': {
          const h = await auth.logout(getSid(req));
          closeSessions([h], 'logout');
          return json(res, 200, { ok: true }, { 'set-cookie': cookie(req, null) });
        }
        case '/api/auth/password': {
          if (b.next !== b.confirm) throw new AuthError('CONFIRM', '새 비밀번호 확인이 일치하지 않습니다');
          const sid = getSid(req);
          if (!sid) throw new AuthError('NO_SESSION', '세션이 만료되었습니다. 다시 로그인하세요', 401);
          const account = await auth.resolve(sid);
          const revoked = await auth.changePassword(sid, b.current, b.next);
          if (account) lab.revokeAccount(account.account.id);
          closeSessions(revoked, 'password');
          return json(res, 200, { ok: true, signedOut: revoked.length });
        }
        case '/api/auth/recover': {
          if (b.next !== b.confirm) throw new AuthError('CONFIRM', '새 비밀번호 확인이 일치하지 않습니다');
          const r = await auth.recover(b.loginId, b.code, b.next, ip);
          closeSessions(r.revoked, 'recovered');
          return json(res, 200, { ...(await me(r.sid)), recoveryCode: r.recoveryCode }, { 'set-cookie': cookie(req, r.sid) });
        }
      }
      return json(res, 404, { error: 'not found' });
    } catch (e) {
      if (e instanceof AuthError) return json(res, e.status, { error: e.message, code: e.code });
      console.error('[siderarium] auth api error', (e as Error).message); // never the request body
      return json(res, 500, { error: '서버 오류 — 잠시 후 다시 시도하세요' });
    }
  }

  // ── observability: /health (unchanged), /ready (public, coarse), /status (operator only) ──
  const loopDelay = monitorEventLoopDelay({ resolution: 20 });
  loopDelay.enable();
  const started = Date.now();
  let cpuMark = { at: performance.now(), usage: process.cpuUsage() }, cpuPct = 0;
  const saveEveryMs = Number(process.env.SAVE_INTERVAL_S ?? 30) * 1000;
  const health = () => {
    const st = game.status(), sv = saver!.stats;
    const saveState = sv.fenced ? 'fenced' : sv.consecutiveFailures >= 2 ? 'failing' : sv.lastOkAt && Date.now() - sv.lastOkAt > 4 * saveEveryMs ? 'stale' : 'ok';
    const lag = loopDelay.percentile(99) / 1e6;
    const overload = st.tick.p95 > 50 || lag > 250 || (game.speed > 0 && st.tick.samples >= 200 && st.tick.simRate < 0.9 * game.speed);
    return { st, sv, saveState, lag, overload };
  };
  // the full status is for the operator: from this machine directly (not through the reverse proxy, which
  // always adds forwarding headers), or for an administrator account signed in to the game
  const viaProxy = (req: http.IncomingMessage) => !!(req.headers['x-forwarded-for'] || req.headers['x-forwarded-proto'] || req.headers['x-forwarded-host'] || req.headers.forwarded || req.headers.via || req.headers['x-real-ip']);
  const loopback = (req: http.IncomingMessage) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '');
  const statusAllowed = async (req: http.IncomingMessage) => {
    if (loopback(req) && !viaProxy(req)) return true;
    if (!adminAccounts.length) return false;
    const r = await auth.resolve(getSid(req)).catch(() => null);
    return !!r && adminAccounts.includes(r.account.id);
  };
  const statusBody = () => {
    const h = health(), m = process.memoryUsage();
    return {
      ok: !h.overload && h.saveState === 'ok', overload: h.overload, uptimeS: Math.round((Date.now() - started) / 1000), node: process.version,
      memory: { rssMB: +(m.rss / 1048576).toFixed(1), heapUsedMB: +(m.heapUsed / 1048576).toFixed(1), heapTotalMB: +(m.heapTotal / 1048576).toFixed(1), externalMB: +(m.external / 1048576).toFixed(1), arrayBuffersMB: +(m.arrayBuffers / 1048576).toFixed(1) },
      cpuPct: +cpuPct.toFixed(1),
      eventLoop: { p50ms: +(loopDelay.percentile(50) / 1e6).toFixed(1), p99ms: +h.lag.toFixed(1), maxMs: +(loopDelay.max / 1e6).toFixed(1) },
      ...h.st,
      save: { state: h.saveState, storage: storage.name.replace(/\(.*\)/, '(…)'), ...h.sv, lastOkAgoS: h.sv.lastOkAt ? Math.round((Date.now() - h.sv.lastOkAt) / 1000) : null },
      limits,
    };
  };
  const statusLogS = Number(process.env.STATUS_LOG_S ?? 60);
  if (statusLogS > 0) setInterval(() => {
    const now = performance.now(), u = process.cpuUsage(cpuMark.usage);
    cpuPct = (u.user + u.system) / 1000 / (now - cpuMark.at) * 100; cpuMark = { at: now, usage: process.cpuUsage() };
    const h = health(), m = process.memoryUsage();
    console.log(`[siderarium] status tick p50/p95/p99/max ${h.st.tick.p50}/${h.st.tick.p95}/${h.st.tick.p99}/${h.st.tick.max}ms rate ${h.st.tick.simRate} · loop p99 ${h.lag.toFixed(0)}ms · cpu ${cpuPct.toFixed(0)}% · rss ${(m.rss / 1048576).toFixed(0)}MB heap ${(m.heapUsed / 1048576).toFixed(0)}MB · conns ${h.st.conns.total} · out ${(game.wsNet.outBytes / 1048576).toFixed(1)}MB · save ${h.saveState} ${h.sv.lastBytes ? (h.sv.lastBytes / 1048576).toFixed(2) + 'MB' : '-'} ${h.sv.lastSerializeMs.toFixed(0)}+${h.sv.lastWriteMs.toFixed(0)}ms${h.overload ? ' · OVERLOAD' : ''}`);
    loopDelay.reset();
  }, statusLogS * 1000).unref();

  const server = http.createServer((req, res) => {
    const url = (req.url ?? '/').split('?')[0];
    if (url === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, time: game.sim.time, players: game.conns.size })); return; }
    if (url === '/ready') {
      // public and coarse: enough for an uptime monitor, nothing about players or infrastructure
      const h = health(), ok = !h.overload && h.saveState === 'ok';
      res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok, save: h.saveState, overload: h.overload })); return;
    }
    if (url === '/status') {
      void statusAllowed(req).then(ok => {
        if (!ok) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return; }
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(statusBody()));
      }, () => { res.writeHead(500); res.end(); });
      return;
    }
    if (url.startsWith('/api/')) { void api(req, res, url); return; }
    let decoded: string;
    try { decoded = decodeURIComponent(url); } catch { res.writeHead(400); res.end(); return; }
    let file = path.join(ROOT, decoded);
    if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      // a missing asset is a 404 (the model loader then keeps the procedural hull), not the app page
      if (url.startsWith('/assets/')) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return; }
      file = path.join(ROOT, 'index.html');
    }
    const protectedLab = /^(?:devCombatLab|combatLabWorker)-[A-Za-z0-9_-]+\.js$/.test(path.basename(file));
    const sendFile = () => fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      const ext = path.extname(file);
      res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream', 'cache-control': protectedLab ? 'private, no-store' : ext === '.html' ? 'no-cache' : 'public, max-age=86400',
        'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'same-origin' });
      res.end(data);
    });
    // The production-only UI and worker chunks require the server grant, not a client flag.
    if (protectedLab) {
      if (!labOriginOk(req)) { res.writeHead(403, { 'cache-control': 'no-store' }); res.end(); return; }
      void lab.valid(getSid(req), getCookie(req, LAB_COOKIE)).then(ok => { if (ok) sendFile(); else { res.writeHead(403, { 'cache-control': 'no-store' }); res.end(); } }, () => { res.writeHead(503); res.end(); });
    } else sendFile();
  });

  // the WebSocket handshake itself is authenticated: no valid session cookie → 401, no game data at all
  const limits = limitsFromEnv();
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: { threshold: 1024 }, maxPayload: limits.maxPayload });
  server.on('upgrade', (req, socket, head) => {
    const deny = (code: number, text: string) => { socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); socket.destroy(); };
    // a socket error during the handshake must not reach the process (no listener = crash)
    socket.on('error', () => {});
    if ((req.url ?? '').split('?')[0] !== '/ws') return deny(404, 'Not Found');
    if (!originOk(req)) return deny(403, 'Forbidden');
    auth.resolve(getSid(req)).then(s => {
      if (!s) return deny(401, 'Unauthorized');
      if (socket.destroyed) return;
      wss.handleUpgrade(req, socket, head, ws => onSocket(ws, s.account.id, s.idHash));
    }, e => { console.error('[siderarium] ws auth error', (e as Error).message); deny(503, 'Service Unavailable'); });
  });
  let nextConn = 1;
  const socketsByAccount = new Map<string, Set<WebSocket>>();
  const alive = new WeakMap<WebSocket, boolean>();
  function onSocket(ws: WebSocket, account: string, idHash: string) {
    const id = `c${nextConn++}`;
    const guard = new ConnGuard(limits);
    const wsNet = game.wsNet;
    wsNet.opened++;
    const out = (j: string) => { if (ws.readyState !== ws.OPEN) return; conn.bytes! += j.length; wsNet.outBytes += j.length; wsNet.outMsgs++; ws.send(j); };
    const conn: Conn = {
      id, account, lastEvent: 0, battles: new Set(), bytes: 0,
      send: m => out(JSON.stringify(m)),
      // protocol 2 hands over the already serialized text (shared fragments, no second stringify)
      sendText: out,
      congested: () => {
        const s = guard.sendState(ws.bufferedAmount);
        if (s === 'terminate') { wsNet.slowTerminated++; console.warn(`[siderarium] ws ${id}: 전송 버퍼 ${(ws.bufferedAmount / 1048576).toFixed(1)}MB — 느린 연결 종료`); ws.terminate(); return true; }
        return s === 'congested';
      },
    };
    // several tabs are fine; a runaway number of sockets for one account is not (the oldest goes)
    let mine = socketsByAccount.get(account); if (!mine) socketsByAccount.set(account, mine = new Set());
    if (mine.size >= limits.socketsPerAccount) { const oldest = mine.values().next().value; if (oldest) { mine.delete(oldest); oldest.close(4409, 'too many connections'); } }
    mine.add(ws);
    let set = socketsBySession.get(idHash); if (!set) socketsBySession.set(idHash, set = new Set());
    set.add(ws);
    alive.set(ws, true);
    ws.on('pong', () => alive.set(ws, true));
    game.connect(conn);
    let closing = false;
    ws.on('message', (raw, isBinary) => {
      if (closing) return;
      const text = isBinary ? '' : String(raw);
      wsNet.inMsgs++; wsNet.inBytes += (raw as Buffer).length ?? text.length;
      const msg = parseClientMsg(text);
      const v = msg ? guard.admit(msg.t) : guard.bad();
      if (v === 'close') { wsNet.floodClosed++; console.warn(`[siderarium] ws ${id}: 요청 폭주 — 연결 종료 (drop ${guard.dropped}, malformed ${guard.malformed})`); closing = true; ws.close(1008, 'rate limit'); setTimeout(() => ws.terminate(), 2000).unref(); return; }
      if (v === 'drop' || !msg) {
        wsNet.dropped++;
        // a refused command still gets its answer, so the client never waits forever
        if (msg?.t === 'cmd' && typeof (msg as { id?: unknown }).id === 'number') conn.send({ t: 'ack', id: (msg as unknown as { id: number }).id, err: '요청이 너무 많습니다 — 잠시 후 다시 시도하세요' });
        return;
      }
      try { game.handle(id, msg as ClientMsg); } catch (e) { wsNet.handleErrors++; console.error('handle error', (e as Error).message); }
    });
    // protocol errors (oversized or invalid frames) close this socket only; without a listener they would crash the process
    ws.on('error', e => { wsNet.errors++; console.warn(`[siderarium] ws ${id} error: ${(e as Error).message}`); });
    ws.on('close', () => {
      wsNet.closed++;
      game.disconnect(id);
      set!.delete(ws); if (!set!.size) socketsBySession.delete(idHash);
      mine!.delete(ws); if (!mine!.size) socketsByAccount.delete(account);
    });
  }
  // dead peers (closed laptop, lost mobile network) never send a close: ping them and drop the silent ones
  setInterval(() => {
    for (const ws of wss.clients) {
      if (alive.get(ws) === false) { game.wsNet.heartbeatTerminated++; ws.terminate(); continue; }
      alive.set(ws, false);
      try { ws.ping(); } catch { /* closing */ }
    }
  }, limits.heartbeatS * 1000).unref();
  // long-lived sockets re-check their session: an expired or revoked one is closed (client re-authenticates)
  setInterval(() => {
    for (const h of [...socketsBySession.keys()]) auth.alive(h).then(ok => { if (!ok) closeSessions([h], 'expired'); }, () => {});
  }, 30_000);

  let last = performance.now();
  const loop = setInterval(() => {
    const now = performance.now();
    game.step((now - last) / 1000);
    last = now;
  }, 50);

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return; stopping = true;
    // freeze the world first: no tick or command may change it after the final snapshot
    clearInterval(loop);
    server.close();
    for (const ws of wss.clients) ws.close(1012, 'server restart');
    console.log('[siderarium] saving before exit…');
    if (storage.fenced) console.log('[siderarium] 새 월드 세대가 있어 종료 저장을 건너뜁니다');
    else {
      const ok = await saver!.flush(Number(process.env.SHUTDOWN_SAVE_TIMEOUT_S ?? 60) * 1000);
      console.log(ok ? `[siderarium] 종료 저장 완료 (${(saver!.stats.lastBytes / 1048576).toFixed(2)} MB)` : `[siderarium] !!! 종료 저장 실패: ${saver!.stats.lastError ?? '시간 초과'}`);
    }
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  server.listen(PORT, () => console.log(`[siderarium] listening on :${PORT}`));
}

main().catch(e => { console.error(e); process.exit(1); });

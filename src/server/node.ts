// SIDERARIUM multiplayer server: serves the built client and runs the authoritative world.
//   PORT          http port (default 8080)
//   DATABASE_URL  Postgres connection string → world persisted in table `siderarium_world`
//   SAVE_FILE     otherwise the world is saved to this JSON file (default ./data/world.json)
//   WORLD_SEED    seed for a brand-new world
//   WORLD_RESET   token: replace the world with a fresh one once per token (accounts are kept)
//   SESSION_TTL_HOURS  idle lifetime of a sign-in session (default 336 = 14 days, renewed while used)
// Accounts (login ID + password, see accounts.ts) live in siderarium_accounts / siderarium_sessions
// (or data/accounts.json without a database). The WebSocket only opens for a valid session cookie.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { GameServer, type Conn } from './core';
import type { ClientMsg, SaveFile } from './protocol';
import { WorldSim } from '../world/sim';
import { INDUSTRY_VERSION } from '../world/economy';
import { WORLD_VERSION } from '../world/worldgen';
import { AuthService, AuthError, memoryStore, pgAccountStore, type AccountStore } from './accounts';

/** what must survive any migration: players, their money, ships, stations and stored goods */
function census(w: any) {
  const players = Object.values<any>(w.companies ?? {}).filter(c => c.kind === 'player');
  const ids = new Set(players.map(c => c.id));
  const goods = (c: Record<string, number>) => Object.values(c ?? {}).reduce((a, v) => a + (Number(v) || 0), 0);
  return {
    players: players.length,
    credits: Math.round(players.reduce((a, c) => a + c.credits, 0)),
    ships: Object.values<any>(w.ships ?? {}).filter(s => ids.has(s.owner)).length,
    stations: Object.values<any>(w.stations ?? {}).filter(s => ids.has(s.owner)).length,
    modules: Object.values<any>(w.stations ?? {}).filter(s => ids.has(s.owner)).reduce((a, s) => a + s.modules.length, 0),
    stored: Math.round(Object.values<any>(w.stations ?? {}).reduce((a, s) => a + [...ids].reduce((b, id) => b + goods(s.storage?.[id]), 0), 0)),
  };
}

const PORT = Number(process.env.PORT ?? 8080);
const ROOT = path.resolve(process.env.STATIC_DIR ?? 'dist');
const SAVE_FILE = path.resolve(process.env.SAVE_FILE ?? 'data/world.json');

interface Storage { load(): Promise<SaveFile | null>; save(d: SaveFile): Promise<void>; name: string;
  /** keep a copy of a save under its own key (never overwritten); returns the stored copy read back */
  backup(key: string, d: SaveFile): Promise<SaveFile | null>;
  /** world reset requested by token (WORLD_RESET): back up the current world, replace it with `fresh`,
   *  fence off every instance still holding the old one. Idempotent per token. */
  reset(token: string, fresh: () => SaveFile): Promise<{ done: boolean; backup?: string; why?: string }>;
  /** set once a save was refused because a newer world generation exists (this instance is stale) */
  fenced?: boolean }

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
      fs.writeFileSync(mark, tokenId);
      return { done: true, backup: key };
    },
    async backup(key, d) {
      const f = SAVE_FILE.replace(/\.json$/, '') + `.${key}.json`;
      fs.mkdirSync(path.dirname(f), { recursive: true });
      if (!fs.existsSync(f)) fs.writeFileSync(f, JSON.stringify(d));
      return JSON.parse(fs.readFileSync(f, 'utf8'));
    },
    async save(d) {
      fs.mkdirSync(path.dirname(SAVE_FILE), { recursive: true });
      const tmp = SAVE_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(d));
      fs.renameSync(tmp, SAVE_FILE);
    },
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
    async backup(key, d) {
      await pool.query('INSERT INTO siderarium_world (id, data, updated) VALUES ($1, $2, now()) ON CONFLICT (id) DO NOTHING', [key, JSON.stringify(d)]);
      const r = await pool.query('SELECT data FROM siderarium_world WHERE id = $1', [key]); return r.rows[0]?.data ?? null;
    },
    async save(d) {
      if (st.fenced) return;
      const r = await pool.query('UPDATE siderarium_world SET data = $2, updated = now() WHERE id = $1 AND gen = $3', ['main', JSON.stringify(d), gen]);
      if (r.rowCount) return;
      const ins = await pool.query('INSERT INTO siderarium_world (id, data, updated, gen) VALUES ($1, $2, now(), $3) ON CONFLICT (id) DO NOTHING', ['main', JSON.stringify(d), gen]);
      if (ins.rowCount) return;
      st.fenced = true;
      console.error(`[siderarium] !!! 저장 거부: 더 새로운 월드 세대가 있습니다 (이 인스턴스 gen=${gen}). 이 인스턴스는 더 이상 저장하지 않습니다.`);
    },
  };
  return st;
}

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.ico': 'image/x-icon' };

async function main() {
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
      accountStore = null;
      console.error('[siderarium] !!! DATABASE_URL 연결 실패 — 파일 저장으로 대체합니다 (재시작 시 세계가 사라질 수 있음):', (e as Error).message);
    }
  }
  if (storage.name.startsWith('file')) saved = await storage.load();
  // operator-requested world reset (env WORLD_RESET=<token>): applied once per token
  const resetTok = (process.env.WORLD_RESET ?? '').trim();
  if (resetTok) {
    if (!/^[A-Za-z0-9_-]{4,40}$/.test(resetTok)) { console.error('[siderarium] !!! WORLD_RESET 토큰 형식 오류 (영숫자·_- 4~40자)'); process.exit(1); }
    const seed = Number(process.env.WORLD_SEED ?? 1);
    const r = await storage.reset(resetTok, () => ({ v: 1, world: JSON.parse(WorldSim.create(seed).serialize()), auth: {}, accounts: {} }));
    // accounts are separate from the world: they survive; each account simply gets "create your PMC" again
    if (r.done) {
      console.log(`[siderarium] WORLD RESET applied (token ${resetTok}) — previous world kept as ${r.backup ?? '(없음)'}`);
      saved = await storage.load();
    } else console.log(`[siderarium] WORLD_RESET ${resetTok}: ${r.why} — 초기화하지 않음`);
  }
  // safe migration: an older save is copied to its own backup key (read back and compared) before the
  // new code touches it; the migrated world must keep every player, credit, ship, station and stored good
  let before: ReturnType<typeof census> | null = null;
  if (saved) {
    before = census(saved.world);
    const old = `${saved.world.version ?? 0}.${saved.world.industryV ?? 0}`;
    if ((saved.world.version ?? 0) < WORLD_VERSION || (saved.world.industryV ?? 0) < INDUSTRY_VERSION) {
      const key = `backup-pre-v${old}`;
      const copy = await storage.backup(key, saved);
      if (!copy || JSON.stringify(copy.world.companies) !== JSON.stringify(saved.world.companies) || census(copy.world).stored !== before.stored) {
        console.error(`[siderarium] !!! 세이브 백업(${key}) 검증 실패 — 마이그레이션을 중단합니다`); process.exit(1);
      }
      console.log(`[siderarium] save backup ${key} written and verified (${JSON.stringify(census(copy.world))})`);
    }
  }
  if (!accountStore) {
    const f = path.join(path.dirname(SAVE_FILE), 'accounts.json');
    accountStore = memoryStore({ read: () => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } }, write: s => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f + '.tmp', s); fs.renameSync(f + '.tmp', f); } });
  }
  const auth = new AuthService(accountStore, { ttlMs: Number(process.env.SESSION_TTL_HOURS ?? 24 * 14) * 3600_000 });
  console.log(`[siderarium] accounts: ${accountStore.name} · ${Object.keys(saved?.accounts ?? {}).length} linked PMCs · ${Object.keys(saved?.auth ?? {}).length} legacy tokens`);
  let saving = false;
  const game = new GameServer(saved, {
    singleplayer: false, accounts: true, snapInterval: 1.0, movInterval: 0.2, saveInterval: 30,
    save: d => { if (saving) return; saving = true; storage.save(d).catch(e => console.error('save failed', e)).finally(() => { saving = false; }); },
  }, Number(process.env.WORLD_SEED ?? 1));
  console.log(`[siderarium] world ${saved ? 'restored' : 'created'} (t=${game.sim.time.toFixed(0)}s) storage=${storage.name}`);
  if (before) {
    const after = census(game.sim.st);
    const lost = (['players', 'ships', 'stations', 'modules'] as const).filter(k => after[k] < before![k]);
    if (lost.length || Math.abs(after.credits - before.credits) > 1 || after.stored < before.stored - 1) {
      console.error('[siderarium] !!! 마이그레이션 검증 실패 — 저장하지 않고 종료합니다', JSON.stringify({ before, after })); process.exit(1);
    }
    // restore check: the migrated world serializes and loads back identically
    const s1 = game.sim.serialize();
    const ok = new WorldSim(JSON.parse(s1)).serialize() === s1;
    if (!ok) { console.error('[siderarium] !!! 복원 검증 실패 — 저장하지 않고 종료합니다'); process.exit(1); }
    console.log(`[siderarium] migration check OK ${JSON.stringify(after)} · restore round-trip identical`);
  }

  // ── sessions: an HttpOnly cookie carries a random session id; scripts in the page never see it ──
  const COOKIE = 'siderarium_sid';
  const getSid = (req: http.IncomingMessage) => {
    for (const part of (req.headers.cookie ?? '').split(';')) { const i = part.indexOf('='); if (i > 0 && part.slice(0, i).trim() === COOKIE) return decodeURIComponent(part.slice(i + 1).trim()); }
    return null;
  };
  const https = (req: http.IncomingMessage) => String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() === 'https';
  const cookie = (req: http.IncomingMessage, sid: string | null) =>
    `${COOKIE}=${sid ?? ''}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${sid ? Math.floor(auth.ttl / 1000) : 0}${https(req) ? '; Secure' : ''}`;
  const ipOf = (req: http.IncomingMessage) => String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || req.socket.remoteAddress || '?';
  // a browser always sends Origin on cross-site POSTs and WebSocket handshakes: it must be this host
  const originOk = (req: http.IncomingMessage) => { const o = req.headers.origin; if (!o) return true; try { return new URL(o).host === req.headers.host; } catch { return false; } };

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
          const revoked = await auth.changePassword(sid, b.current, b.next);
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

  const server = http.createServer((req, res) => {
    const url = (req.url ?? '/').split('?')[0];
    if (url === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, time: game.sim.time, players: game.conns.size })); return; }
    if (url.startsWith('/api/')) { void api(req, res, url); return; }
    let file = path.join(ROOT, decodeURIComponent(url));
    if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(ROOT, 'index.html');
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      const ext = path.extname(file);
      res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream', 'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=86400',
        'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'same-origin' });
      res.end(data);
    });
  });

  // the WebSocket handshake itself is authenticated: no valid session cookie → 401, no game data at all
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: { threshold: 1024 } });
  server.on('upgrade', (req, socket, head) => {
    const deny = (code: number, text: string) => { socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); socket.destroy(); };
    if ((req.url ?? '').split('?')[0] !== '/ws') return deny(404, 'Not Found');
    if (!originOk(req)) return deny(403, 'Forbidden');
    auth.resolve(getSid(req)).then(s => {
      if (!s) return deny(401, 'Unauthorized');
      wss.handleUpgrade(req, socket, head, ws => onSocket(ws, s.account.id, s.idHash));
    }, e => { console.error('[siderarium] ws auth error', (e as Error).message); deny(503, 'Service Unavailable'); });
  });
  let nextConn = 1;
  function onSocket(ws: WebSocket, account: string, idHash: string) {
    const id = `c${nextConn++}`;
    const conn: Conn = { id, account, lastEvent: 0, battles: new Set(), bytes: 0, send: m => { if (ws.readyState !== ws.OPEN) return; const j = JSON.stringify(m); conn.bytes! += j.length; ws.send(j); } };
    let set = socketsBySession.get(idHash); if (!set) socketsBySession.set(idHash, set = new Set());
    set.add(ws);
    game.connect(conn);
    ws.on('message', raw => {
      let msg: ClientMsg;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      try { game.handle(id, msg); } catch (e) { console.error('handle error', e); }
    });
    ws.on('close', () => { game.disconnect(id); set!.delete(ws); if (!set!.size) socketsBySession.delete(idHash); });
  }
  // long-lived sockets re-check their session: an expired or revoked one is closed (client re-authenticates)
  setInterval(() => {
    for (const h of [...socketsBySession.keys()]) auth.alive(h).then(ok => { if (!ok) closeSessions([h], 'expired'); }, () => {});
  }, 30_000);

  let last = performance.now();
  setInterval(() => {
    const now = performance.now();
    game.step((now - last) / 1000);
    last = now;
  }, 50);

  const shutdown = async () => {
    console.log('[siderarium] saving before exit…');
    if (storage.fenced) console.log('[siderarium] 새 월드 세대가 있어 종료 저장을 건너뜁니다');
    else try { await storage.save(game.snapshotFile()); } catch (e) { console.error(e); }
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  server.listen(PORT, () => console.log(`[siderarium] listening on :${PORT}`));
}

main().catch(e => { console.error(e); process.exit(1); });

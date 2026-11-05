// SIDERARIUM multiplayer server: serves the built client and runs the authoritative world.
//   PORT          http port (default 8080)
//   DATABASE_URL  Postgres connection string → world persisted in table `siderarium_world`
//   SAVE_FILE     otherwise the world is saved to this JSON file (default ./data/world.json)
//   WORLD_SEED    seed for a brand-new world
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { GameServer, type Conn } from './core';
import type { ClientMsg, SaveFile } from './protocol';
import { WorldSim } from '../world/sim';
import { INDUSTRY_VERSION } from '../world/economy';
import { WORLD_VERSION } from '../world/worldgen';

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
  backup(key: string, d: SaveFile): Promise<SaveFile | null> }

function fileStorage(): Storage {
  return {
    name: `file ${SAVE_FILE}`,
    async load() { try { return JSON.parse(fs.readFileSync(SAVE_FILE, 'utf8')); } catch { return null; } },
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

async function pgStorage(url: string): Promise<Storage> {
  const { default: pg } = await import('pg');
  // Supabase/Render URLs often carry ?sslmode=require, which recent pg versions treat as strict
  // verification against the provider's pooler certificate; TLS is configured explicitly instead.
  const clean = url.replace(/([?&])sslmode=[^&]*&?/, '$1').replace(/[?&]$/, '');
  const local = /localhost|127\.0\.0\.1/.test(clean);
  const pool = new pg.Pool({ connectionString: clean, ssl: local ? false : { rejectUnauthorized: false }, max: 2, connectionTimeoutMillis: 15000 });
  pool.on('error', e => console.error('[siderarium] postgres pool error', e.message));
  await pool.query('CREATE TABLE IF NOT EXISTS siderarium_world (id TEXT PRIMARY KEY, data JSONB NOT NULL, updated TIMESTAMPTZ NOT NULL DEFAULT now())');
  return {
    name: `postgres (${new URL(clean).hostname})`,
    async load() { const r = await pool.query('SELECT data FROM siderarium_world WHERE id = $1', ['main']); return r.rows[0]?.data ?? null; },
    async backup(key, d) {
      await pool.query('INSERT INTO siderarium_world (id, data, updated) VALUES ($1, $2, now()) ON CONFLICT (id) DO NOTHING', [key, JSON.stringify(d)]);
      const r = await pool.query('SELECT data FROM siderarium_world WHERE id = $1', [key]); return r.rows[0]?.data ?? null;
    },
    async save(d) { await pool.query('INSERT INTO siderarium_world (id, data, updated) VALUES ($1, $2, now()) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated = now()', ['main', JSON.stringify(d)]); },
  };
}

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.ico': 'image/x-icon' };

async function main() {
  let storage: Storage = fileStorage();
  let saved: SaveFile | null = null;
  if (process.env.DATABASE_URL) {
    try {
      const pgS = await pgStorage(process.env.DATABASE_URL);
      saved = await pgS.load();
      storage = pgS;
    } catch (e) {
      console.error('[siderarium] !!! DATABASE_URL 연결 실패 — 파일 저장으로 대체합니다 (재시작 시 세계가 사라질 수 있음):', (e as Error).message);
    }
  }
  if (storage.name.startsWith('file')) saved = await storage.load();
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
  let saving = false;
  const game = new GameServer(saved, {
    singleplayer: false, snapInterval: 1.0, movInterval: 0.2, saveInterval: 30,
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

  const server = http.createServer((req, res) => {
    const url = (req.url ?? '/').split('?')[0];
    if (url === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, time: game.sim.time, players: game.conns.size })); return; }
    let file = path.join(ROOT, decodeURIComponent(url));
    if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(ROOT, 'index.html');
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      const ext = path.extname(file);
      res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream', 'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=86400' });
      res.end(data);
    });
  });

  const wss = new WebSocketServer({ server, path: '/ws', perMessageDeflate: { threshold: 1024 } });
  let nextConn = 1;
  wss.on('connection', (ws: WebSocket) => {
    const id = `c${nextConn++}`;
    const conn: Conn = { id, lastEvent: 0, battles: new Set(), bytes: 0, send: m => { if (ws.readyState !== ws.OPEN) return; const j = JSON.stringify(m); conn.bytes! += j.length; ws.send(j); } };
    game.connect(conn);
    ws.on('message', raw => {
      let msg: ClientMsg;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      try { game.handle(id, msg); } catch (e) { console.error('handle error', e); }
    });
    ws.on('close', () => game.disconnect(id));
  });

  let last = performance.now();
  setInterval(() => {
    const now = performance.now();
    game.step((now - last) / 1000);
    last = now;
  }, 50);

  const shutdown = async () => {
    console.log('[siderarium] saving before exit…');
    try { await storage.save(game.snapshotFile()); } catch (e) { console.error(e); }
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  server.listen(PORT, () => console.log(`[siderarium] listening on :${PORT}`));
}

main().catch(e => { console.error(e); process.exit(1); });

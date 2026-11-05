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

const PORT = Number(process.env.PORT ?? 8080);
const ROOT = path.resolve(process.env.STATIC_DIR ?? 'dist');
const SAVE_FILE = path.resolve(process.env.SAVE_FILE ?? 'data/world.json');

interface Storage { load(): Promise<SaveFile | null>; save(d: SaveFile): Promise<void>; name: string }

function fileStorage(): Storage {
  return {
    name: `file ${SAVE_FILE}`,
    async load() { try { return JSON.parse(fs.readFileSync(SAVE_FILE, 'utf8')); } catch { return null; } },
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
  const pool = new pg.Pool({ connectionString: url, ssl: url.includes('localhost') ? false : { rejectUnauthorized: false }, max: 2 });
  await pool.query('CREATE TABLE IF NOT EXISTS siderarium_world (id TEXT PRIMARY KEY, data JSONB NOT NULL, updated TIMESTAMPTZ NOT NULL DEFAULT now())');
  return {
    name: 'postgres',
    async load() { const r = await pool.query('SELECT data FROM siderarium_world WHERE id = $1', ['main']); return r.rows[0]?.data ?? null; },
    async save(d) { await pool.query('INSERT INTO siderarium_world (id, data, updated) VALUES ($1, $2, now()) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated = now()', ['main', JSON.stringify(d)]); },
  };
}

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.ico': 'image/x-icon' };

async function main() {
  const storage = process.env.DATABASE_URL ? await pgStorage(process.env.DATABASE_URL) : fileStorage();
  const saved = await storage.load();
  let saving = false;
  const game = new GameServer(saved, {
    singleplayer: false, snapInterval: 0.5, saveInterval: 30,
    save: d => { if (saving) return; saving = true; storage.save(d).catch(e => console.error('save failed', e)).finally(() => { saving = false; }); },
  }, Number(process.env.WORLD_SEED ?? 1));
  console.log(`[siderarium] world ${saved ? 'restored' : 'created'} (t=${game.sim.time.toFixed(0)}s) storage=${storage.name}`);

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
    const conn: Conn = { id, lastEvent: 0, battles: new Set(), send: m => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m)); } };
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

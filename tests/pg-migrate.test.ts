import { stepUpkeep } from '../src/world/upkeep';
// Real Postgres + real server processes: an old instance A (contentV 0) keeps autosaving while new
// instances apply the c0→c2 content migration — the deploy race on Render. Runs only with
// PG_TEST_URL (a throwaway database: its siderarium_* tables are dropped), e.g.
//   PG_TEST_URL=postgres://postgres@127.0.0.1:55432/postgres npm run test:pg
// The server binary is dist-server/server.mjs (run `npm run build:server` first) or SERVER_BIN.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import WebSocket from 'ws';
import { makeC0World } from './support/oldSave';
import { GameServer } from '../src/server/core';
import { publicCap } from '../src/world/storage';
import { WorldSim } from '../src/world/sim';
import { census, compareCensus, CONTENT_VERSION } from '../src/world/migrate';
import type { WorldState } from '../src/world/types';
import { integrationFixture, integrationRun, startIntegrationIndustry, startIntegrationProjects } from './support/integration';

const URL = process.env.PG_TEST_URL;
const BIN = path.resolve(process.env.SERVER_BIN ?? 'dist-server/server.mjs');
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

interface Srv { p: ChildProcess; log: () => string; port: number; exited: Promise<number | null> }
const procs: Srv[] = [];
function start(port: number, env: Record<string, string>): Promise<Srv> {
  return new Promise((res, rej) => {
    const p = spawn('node', [BIN], { env: { ...process.env, PORT: String(port), DATABASE_URL: URL!, WORLD_SEED: '11', ...env } });
    let out = '';
    const exited = new Promise<number | null>(r => p.on('exit', c => r(c)));
    const srv: Srv = { p, log: () => out, port, exited };
    procs.push(srv);
    const onData = (d: Buffer) => { out += String(d); if (out.includes('listening on')) res(srv); };
    p.stdout!.on('data', onData); p.stderr!.on('data', onData);
    exited.then(c => rej(new Error(`server :${port} exited (${c}) before listening:\n${out}`)));
  });
}
async function stop(s: Srv) { s.p.kill('SIGTERM'); return s.exited; }

class Browser {
  cookie = '';
  constructor(public port: number) {}
  get base() { return `http://localhost:${this.port}`; }
  async post(p: string, body: unknown) {
    const r = await fetch(this.base + p, { method: 'POST', headers: { 'content-type': 'application/json', origin: this.base, cookie: this.cookie }, body: JSON.stringify(body) });
    const c = r.headers.get('set-cookie'); if (c) this.cookie = c.split(';')[0];
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }
  async get(p: string) { const r = await fetch(this.base + p, { headers: { cookie: this.cookie } }); return { status: r.status, body: await r.json().catch(() => ({})) }; }
  /** opens the game socket; creates the PMC when asked; resolves with the company id */
  company(pmcName?: string): Promise<string> {
    return new Promise((res, rej) => {
      const ws = new WebSocket(`ws://localhost:${this.port}/ws`, { headers: { cookie: this.cookie, origin: this.base } });
      ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', name: 'x', token: 'x' })));
      ws.on('message', raw => {
        const m = JSON.parse(String(raw));
        if (m.t === 'needPmc') { if (!pmcName) { ws.close(); rej(new Error('needPmc')); } else ws.send(JSON.stringify({ t: 'createPmc', name: pmcName })); }
        if (m.t === 'welcome') { ws.close(); res(m.company); }
      });
      ws.on('error', rej);
    });
  }
}

describe.skipIf(!URL)('content migration against a live old instance (real Postgres)', () => {
  let pg: import('pg').Pool;
  const row = async (id = 'main') => (await pg.query('SELECT data, gen, md5(data::text) AS h FROM siderarium_world WHERE id = $1', [id])).rows[0] as { data: { world: WorldState; accounts: Record<string, string>; auth: Record<string, string> }; gen: string; h: string } | undefined;

  beforeAll(async () => {
    const { default: PG } = await import('pg');
    pg = new PG.Pool({ connectionString: URL });
    await pg.query('DROP TABLE IF EXISTS siderarium_world, siderarium_accounts, siderarium_sessions CASCADE');
    await pg.query('CREATE TABLE siderarium_world (id TEXT PRIMARY KEY, data JSONB NOT NULL, updated TIMESTAMPTZ NOT NULL DEFAULT now(), gen BIGINT NOT NULL DEFAULT 0)');
    const { st } = makeC0World();
    await pg.query("INSERT INTO siderarium_world (id, data) VALUES ('main', $1)", [JSON.stringify({ v: 1, world: st, auth: {}, accounts: {} })]);
  });
  afterAll(async () => { for (const s of procs) s.p.kill('SIGKILL'); await pg?.end(); });

  it('A cannot write c0 over the migrated c2 world; companies, ships, equipment and account links survive', async () => {
    // ── old instance A: contentV 0, autosaving every 0.5 s, with a player who signs up and founds a PMC ──
    const A = await start(8311, { SAVE_INTERVAL_S: '0.5' });
    const pilot = new Browser(8311);
    expect((await pilot.post('/api/auth/signup', { loginId: 'pilot_a', password: 'nova-lance-123', confirm: 'nova-lance-123' })).status).toBe(200);
    const cA = await pilot.company('알파 윙');
    await wait(1500);
    const pre = (await row())!;
    expect(Number(pre.gen)).toBe(0);
    expect(pre.data.world.contentV ?? 0).toBe(0);
    expect(pre.data.world.companies[cA]).toBeTruthy();
    expect(Object.values(pre.data.accounts)).toContain(cA);

    // ── new instances B and C start at the same time with CONTENT_MIGRATE=apply; the migration transaction
    //    is held open 3 s, so A's autosaves (every 0.5 s) provably wait on the row lock meanwhile ──
    const env = { CONTENT_MIGRATE: 'apply', SAVE_INTERVAL_S: '600', SIDERARIUM_TEST_MIGRATE_HOLD_MS: '3000' };
    const [B, C] = await Promise.all([start(8312, env), start(8313, env)]);
    const committed = [B, C].filter(s => s.log().includes('save migration committed'));
    expect(committed.length).toBe(1);                                       // exactly one instance migrated
    // the other one either waited on the lock and found the world already migrated, or loaded it migrated
    const other = [B, C].find(s => !committed.includes(s))!;
    expect(other.log()).not.toMatch(/마이그레이션 실패|저장 거부/);
    const mid = (await row())!;
    expect(Number(mid.gen)).toBe(1);
    expect(mid.data.world.contentV).toBe(CONTENT_VERSION);

    // the backup is exactly the c0 world under the lock (it includes A's PMC), and the only backup
    const backups = (await pg.query("SELECT id FROM siderarium_world WHERE id LIKE 'backup-%'")).rows.map(r => r.id);
    expect(backups).toEqual(['backup-pre-v4.2.c0']);
    const bk = (await row('backup-pre-v4.2.c0'))!;
    expect(bk.data.world.contentV ?? 0).toBe(0);
    expect(bk.data.world.companies[cA]).toBeTruthy();
    const meta = (await row('meta:migrate'))!.data as unknown as { backup: string; fromGen: number; gen: number };
    expect(meta).toMatchObject({ backup: 'backup-pre-v4.2.c0', fromGen: 0, gen: 1 });

    // the stored c2 world is exactly the migration of the backup, nothing lost or duplicated
    const expected = JSON.parse(new WorldSim(structuredClone(bk.data.world), { migrateContent: true }).serialize());
    expect(mid.data.world).toEqual(expected);
    expect(compareCensus(census(bk.data.world), census(mid.data.world))).toEqual([]);
    expect(mid.data.accounts).toEqual(bk.data.accounts);
    expect(mid.data.auth).toEqual(bk.data.auth);
    expect(Object.keys(mid.data.world.companies).sort()).toEqual(Object.keys(bk.data.world.companies).sort());
    const playerShips = (w: WorldState) => Object.values(w.ships).filter(s => w.companies[s.owner]?.kind === 'player');
    expect(playerShips(mid.data.world).map(s => s.id).sort()).toEqual(playerShips(bk.data.world).map(s => s.id).sort());
    expect(playerShips(mid.data.world).length).toBeGreaterThan(0);
    for (const s of playerShips(mid.data.world)) expect(s.fitting, s.id).toBeTruthy();

    // ── A keeps running (Render keeps the old instance until the new one is live): its saves are refused ──
    await wait(3000);
    expect(A.log()).toMatch(/저장 거부: 더 새로운 월드 세대/);
    expect((await row())!.h).toBe(mid.h);
    // A is stopped: its shutdown save must not land either
    expect(await stop(A)).toBe(0);
    expect(A.log()).toMatch(/종료 저장을 건너뜁니다/);
    const afterA = (await row())!;
    expect(afterA.h).toBe(mid.h);
    expect(Number(afterA.gen)).toBe(1);

    // ── B and C shut down and save (same generation): still c2 ──
    await Promise.all([stop(B), stop(C)]);
    const afterBC = (await row())!;
    expect(Number(afterBC.gen)).toBe(1);
    expect(afterBC.data.world.contentV).toBe(CONTENT_VERSION);
    expect(B.log() + C.log()).not.toMatch(/저장 거부/);

    // ── restart with CONTENT_MIGRATE still set: nothing is migrated again, the account finds its PMC ──
    const D = await start(8314, { CONTENT_MIGRATE: 'apply', SAVE_INTERVAL_S: '0.5' });
    expect(D.log()).not.toMatch(/save migration/);
    const again = new Browser(8314);
    const login = await again.post('/api/auth/login', { loginId: 'pilot_a', password: 'nova-lance-123' });
    expect(login.status).toBe(200);
    expect(login.body.company?.id).toBe(cA);
    expect(await again.company()).toBe(cA);
    await wait(1200);
    expect(await stop(D)).toBe(0);
    const fin = (await row())!;
    expect(Number(fin.gen)).toBe(1);
    expect(fin.data.world.contentV).toBe(CONTENT_VERSION);
    expect(fin.data.accounts).toEqual(bk.data.accounts);
    expect(playerShips(fin.data.world).map(s => s.id).sort()).toEqual(playerShips(bk.data.world).map(s => s.id).sort());
    expect((await pg.query("SELECT count(*)::int AS n FROM siderarium_world WHERE id LIKE 'backup-%'")).rows[0].n).toBe(1);
  }, 120_000);

  it('a failing migration rolls back completely: world, generation and backup rows untouched', async () => {
    // a c0 world again (a rolled-back production), slightly different from the existing backup …
    await pg.query("UPDATE siderarium_world SET data = jsonb_set((SELECT data FROM siderarium_world WHERE id = 'backup-pre-v4.2.c0'), '{world,time}', '12345'), gen = gen + 1 WHERE id = 'main'");
    // … and every free backup key already holds something else, so no verified backup can be made
    for (let i = 2; i <= 9; i++) await pg.query("INSERT INTO siderarium_world (id, data) VALUES ($1, '{\"other\": true}')", [`backup-pre-v4.2.c0-${i}`]);
    const before = (await row())!;
    const rows = async () => (await pg.query("SELECT id, md5(data::text) AS h, gen FROM siderarium_world ORDER BY id")).rows;
    const snapshot = await rows();
    const E = spawn('node', [BIN], { env: { ...process.env, PORT: '8315', DATABASE_URL: URL!, CONTENT_MIGRATE: 'apply' } });
    let out = ''; E.stdout!.on('data', d => { out += d; }); E.stderr!.on('data', d => { out += d; });
    const code = await new Promise(r => E.on('exit', r));
    expect(code).toBe(1);
    expect(out).toMatch(/마이그레이션 실패 — 저장된 월드는 변경되지 않았습니다/);
    expect(out).not.toMatch(/listening on/);
    expect(await rows()).toEqual(snapshot);
    expect((await row())!.data.world.contentV ?? 0).toBe(0);
    expect((await row())!.gen).toBe(before.gen);
  }, 60_000);
  it('persists analytics, prepaid leases and recovery assets through real PostgreSQL server restarts', async () => {
    const local = new GameServer(null, { singleplayer: false, snapInterval: 1 }, 923);
    const id = local.sim.addPlayer('PG 통계 검증');
    const co = local.sim.st.companies[id], st = local.sim.st.stations.astra;
    expect(local.sim.command(id, { c: 'lease', station: st.id, blocks: 1 })).toBeNull();
    st.storage[id].ore = publicCap(co, st);
    (local.sim as any).salvageWrecks(co, Array.from({ length: 12 }, () => ({ eq_laser: 2 })), 1, st.pos);
    expect(Object.keys(co.pendingLoot?.astra ?? {}).length).toBeGreaterThan(0);
    const overdue = local.sim.addPlayer('PG 체납 검증'), late = local.sim.st.companies[overdue];
    for (const [sid, ship] of Object.entries(local.sim.st.ships)) if (ship.owner === overdue) delete local.sim.st.ships[sid];
    late.credits = 0; late.leases = { rustport: 1 }; delete late.upkeep;
    local.sim.st.stations.rustport.storage[overdue].ore = 4100;
    local.sim.st.time += 3600; stepUpkeep(local.sim.st, late, 3600);
    expect(late.upkeep!.debtU).toBe('45000000000');
    const file = local.snapshotFile();
    await pg.query("UPDATE siderarium_world SET data = $1::jsonb, gen = gen + 1 WHERE id = 'main'", [JSON.stringify(file)]);
    for (const port of [8316, 8317]) {
      const srv = await start(port, { CONTENT_MIGRATE: '', SAVE_INTERVAL_S: '60' });
      expect(await stop(srv)).toBe(0);
      const data = (await row())!.data as typeof file;
      expect(data.world.companies[id].leasePaidUntil).toEqual(co.leasePaidUntil);
      expect(data.world.companies[id].pendingLoot).toEqual(co.pendingLoot);
      expect(data.world.companies[overdue].upkeep!.debtU).toBe('45000000000');
      expect(data.world.companies[overdue].upkeep!.rent!.cancelled).toEqual({ t: 3600, blocks: { rustport: 1 } });
      expect(data.world.companies[overdue].leases).toEqual({});
      expect(data.world.stations.rustport.storage[overdue].ore).toBe(4100);
      expect(data.analytics?.started).toBe(file.analytics!.started);
      expect(data.analytics?.openingSupply).toBe(file.analytics!.openingSupply);
      const creation = [...data.analytics!.fine, data.analytics!.current].flatMap(b => b.rows).filter(r => r.kind === 'income' && r.company === id && r.reason === 'company_creation');
      expect(creation.reduce((n, r) => n + r.amount, 0)).toBe(12000);
      expect(srv.log()).not.toMatch(/save failed|마이그레이션 실패/);
    }
  }, 60_000);

  it('preserves an in-flight managed route and its exact manifest through PostgreSQL process restarts', async () => {
    const local = new GameServer(null, { singleplayer: false, snapInterval: 1 }, 949);
    const p = local.sim.addPlayer('PG 물류'), sim = local.sim, a = sim.st.stations.astra;
    const depot = { ...structuredClone(a), id: 'pg_depot', name: 'PG 물류항', public: false, owner: p, pos: { ...a.pos, x: a.pos.x + 6000 }, market: null, funds: undefined, fundsMax: undefined, shipStock: undefined, storage: { [p]: { ore: 20000 } }, modules: [{ kind: 'core', slot: 0, progress: 1, built: true }] };
    sim.st.stations[depot.id] = depot;
    const g = sim.newGroup(p, 'PG 운송반'), ship = sim.spawnShip(p, 'hauler', 'std', g.id, a.pos); (sim as any).dockShip(ship, a);
    expect(sim.command(p, { c: 'buy', station: a.id, res: 'ore', amount: 100 })).toBeNull();
    expect(sim.command(p, { c: 'putRoute', group: g.id, config: { name: '재시작 운송', from: a.id, to: depot.id, item: 'ore', mode: 'transfer', amount: 20, repeat: true } })).toBeNull();
    sim.tick(0); const route = Object.values(sim.st.logistics!)[0];
    expect(route.manifests[ship.id].amount).toBe(20); expect(a.storage[p].ore).toBe(80);
    await pg.query("UPDATE siderarium_world SET data = $1::jsonb, gen = gen + 1 WHERE id = 'main'", [JSON.stringify(local.snapshotFile())]);
    for (const port of [8320, 8321]) {
      const srv = await start(port, { CONTENT_MIGRATE: '', SAVE_INTERVAL_S: '60' }); expect(await stop(srv)).toBe(0);
      const data = (await row())!.data.world, r = data.logistics![route.id];
      expect(r.owner).toBe(p); expect(r.state).toBe('running'); expect(r.stats.loaded).toBe(20);
      expect(r.manifests[ship.id].amount).toBe(20); expect(data.ships[ship.id].cargo.ore).toBe(20);
      expect(data.stations.astra.storage[p].ore).toBe(80); expect(data.stations.pg_depot.storage[p].ore).toBe(20000);
      expect(data.ships[ship.id].owner).toBe(p); expect(srv.log()).not.toMatch(/save failed|마이그레이션 실패/);
    }
  }, 60_000);

  it('restores combined P8 fittings, research, construction and live logistics through two PostgreSQL restarts', async () => {
    const f = integrationFixture(975); startIntegrationIndustry(f); startIntegrationProjects(f); integrationRun(f.server, 5);
    const file = f.server.snapshotFile();
    expect(file.world.companies[f.p].research![0].started).toBe(true);
    expect(file.world.stations[f.factory.id].builds![0].started).toBe(true);
    expect(file.world.stations[f.factory.id].modules.some(m => m.kind === 'warehouse' && !m.built && m.progress > 0)).toBe(true);
    await pg.query("UPDATE siderarium_world SET data = $1::jsonb, gen = gen + 1 WHERE id = 'main'", [JSON.stringify(file)]);
    for (const port of [8322, 8323]) {
      const srv = await start(port, { CONTENT_MIGRATE: '', SAVE_INTERVAL_S: '60' }); expect(await stop(srv)).toBe(0);
      const data = (await row())!.data as typeof file;
      expect(data.world.companies[f.p].credits).toBe(file.world.companies[f.p].credits);
      expect(data.world.companies[f.p].research).toEqual(file.world.companies[f.p].research);
      expect(data.world.stations[f.factory.id].builds).toEqual(file.world.stations[f.factory.id].builds);
      expect(data.world.stations[f.factory.id].modules).toEqual(file.world.stations[f.factory.id].modules);
      expect(data.world.stations[f.factory.id].storage).toEqual(file.world.stations[f.factory.id].storage);
      expect(data.world.logistics).toEqual(file.world.logistics);
      for (const id of [f.carrier.id, f.miner.id, f.product.id]) expect(data.world.ships[id]).toEqual(file.world.ships[id]);
      expect(data.analytics).toEqual(file.analytics);
      expect(srv.log()).not.toMatch(/save failed|마이그레이션 실패/);
    }
  }, 60_000);
});

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
import { publicCap, storeUsed } from '../src/world/storage';
import { WorldSim } from '../src/world/sim';
import { FACILITIES, RECIPES, TECHS } from '../src/world/industry';
import { allocate } from '../src/world/construction';
import { buildSpec, stepProduction } from '../src/world/production';
import { grantBlueprint, hullBlueprint } from '../src/world/blueprints';
import { census, compareCensus, CONTENT_VERSION } from '../src/world/migrate';
import type { Station, WorldState } from '../src/world/types';
import { integrationFixture, integrationRun, startIntegrationIndustry, startIntegrationProjects } from './support/integration';
import { planProcurement } from '../src/world/procurement';
import { dispatchPool } from '../src/world/autonomousLogistics';

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

  it('preserves P9.5 founding escrow, purchase receipts and a construction shipment through PostgreSQL restarts', async () => {
    const local = new GameServer(null, { singleplayer: false, snapInterval: 1 }, 951), sim = local.sim;
    const p = sim.addPlayer('PG 건설 물류'); sim.st.companies[p].credits = 500_000;
    (sim as any).npcSlow = () => {};
    for (const lair of Object.values(sim.st.lairs)) { lair.alive = false; lair.respawnAt = 1e10; }
    const quiet = sim.st.systems.quiet, at = { x: quiet.origin.x + 10000, y: 0, z: 0 };
    const builders = sim.newGroup(p, '공작반'), builder = sim.spawnShip(p, 'constructor', 'std', builders.id, at);
    builder.cargo.alloy = 100; // isolated fixture: a partial load already aboard the founding ship
    expect(sim.command(p, { c: 'setOp', group: builders.id, op: { k: 'found', at, name: 'PG 현장' } })).toBeNull();
    for (let i = 0; i < 20 && !Object.values(sim.st.stations).some(s => s.owner === p); i++) sim.update(.25);
    const site = Object.values(sim.st.stations).find(s => s.owner === p)!;
    expect(site).toBeTruthy();
    const purchase = { c: 'buy', station: 'astra', res: 'alloy', amount: 300, request: { seq: 1, id: 'p95_pg_purchase_1' } } as const;
    expect(sim.command(p, purchase)).toBeNull();
    const freight = sim.newGroup(p, '수송반'), ship = sim.spawnShip(p, 'hauler', 'std', freight.id, sim.st.stations.astra.pos);
    (sim as any).dockShip(ship, sim.st.stations.astra);
    expect(sim.command(p, { c: 'putRoute', group: freight.id, config: { name: '현장 공급', from: 'astra', to: site.id, item: 'alloy', mode: 'construction', amount: 300, repeat: true } })).toBeNull();
    const route = Object.values(sim.st.logistics!).find(r => r.group === freight.id)!;
    for (let i = 0; i < 4800 && !(route.manifests[ship.id] && sim.sysOf(ship.pos)?.id !== 'astra'); i++) sim.update(.25);
    expect(route.manifests[ship.id]?.amount).toBe(300);
    expect(sim.sysOf(ship.pos)?.id).not.toBe('astra');
    expect(sim.command(p, { c: 'routeControl', routes: [route.id], action: 'pause' })).toBeNull();
    const pending = sim.newGroup(p, '출발 공작반'); sim.spawnShip(p, 'constructor', 'std', pending.id, sim.st.stations.astra.pos);
    const rime = sim.st.systems.rime;
    expect(sim.command(p, { c: 'setOp', group: pending.id, op: { k: 'found', at: { x: rime.origin.x + 10000, y: 0, z: 0 }, name: '선납 검증' } })).toBeNull();
    // A P9.6 in-flight order had no material snapshot; its prepayment identifies the old terms.
    const legacy = sim.newGroup(p, '이전 XL 공작반'), legacyAt = { x: rime.origin.x + 12000, y: 0, z: 1000 };
    const legacyShip = sim.spawnShip(p, 'constructor', 'std', legacy.id, sim.st.stations.astra.pos);
    legacy.op = { k: 'found', at: legacyAt, name: '이전 XL 기지', size: 'XL', escrowed: true }; legacy.override = true;
    sim.st.companies[p].credits -= 120_000; sim.st.companies[p].foundingEscrow![legacy.id] = 120_000;
    const file = local.snapshotFile(), receipt = structuredClone(sim.st.companies[p].lastPurchase);
    await pg.query("UPDATE siderarium_world SET data = $1::jsonb, gen = gen + 1 WHERE id = 'main'", [JSON.stringify(file)]);
    for (const port of [8324, 8325]) {
      const srv = await start(port, { CONTENT_MIGRATE: '', SAVE_INTERVAL_S: '60' }); expect(await stop(srv)).toBe(0);
      const world = (await row())!.data.world, saved = world.logistics![route.id];
      expect(world.companies[p].foundingEscrow?.[pending.id]).toBe(16000);
      expect(world.groups[pending.id].op).toMatchObject({ k: 'found', size: 'S', foundationMats: { alloy: 600 } });
      expect(world.companies[p].foundingEscrow?.[legacy.id]).toBe(120_000);
      expect(world.stations[site.id].modules[0]).toMatchObject({ paid: 16_000, materials: { alloy: 600 }, reserved: { alloy: 100 } });
      expect(world.companies[p].lastPurchase).toEqual(receipt);
      expect(saved.state).toBe('paused'); expect(saved.manifests[ship.id]?.amount).toBe(300);
      expect(world.ships[ship.id].cargo.alloy).toBe(300);
      expect(world.stations[site.id].storage[p].alloy ?? 0).toBe(0);
      const restored = new WorldSim(structuredClone(world), { migrateContent: false });
      const credits = restored.st.companies[p].credits, stock = restored.st.stations.astra.market!.alloy.stock;
      expect(restored.command(p, purchase)).toBeNull();
      expect(restored.st.companies[p].credits).toBe(credits);
      expect(restored.st.stations.astra.market!.alloy.stock).toBe(stock);
      expect(restored.st.ships[ship.id].cargo.alloy).toBe(300);
      restored.st.ships[legacyShip.id].pos = { ...legacyAt }; restored.update(.25);
      const legacySite = Object.values(restored.st.stations).find(s => s.owner === p && s.name === '이전 XL 기지');
      expect(legacySite?.modules[0]).toMatchObject({ paid: 120_000, materials: { alloy: 3_000, structure: 200, machinery: 80, electronics: 30 } });
      expect(srv.log()).not.toMatch(/save failed|마이그레이션 실패/);
    }
  }, 60_000);

  it('restores a sized station, a running production batch and pending physical cargo handling through PostgreSQL restarts', async () => {
    const local = new GameServer(null, { singleplayer: false, snapInterval: 1 }, 969), sim = local.sim;
    const p = sim.addPlayer('PG 정거장 시설'); sim.st.companies[p].credits = 500_000;
    (sim as any).npcSlow = () => {};
    for (const lair of Object.values(sim.st.lairs)) { lair.alive = false; lair.respawnAt = 1e10; }
    const sys = sim.st.systems.quiet, at = { x: sys.origin.x + 10000, y: 0, z: 0 };
    const builders = sim.newGroup(p, '공작반'), builder = sim.spawnShip(p, 'constructor', 'std', builders.id, at);
    builder.cargo.alloy = 300;
    const support = sim.spawnShip(p, 'hauler', 'std', builders.id, at); support.cargo.alloy = 300;
    expect(sim.command(p, { c: 'setOp', group: builders.id, op: { k: 'found', at, name: 'PG 소형 기지', size: 'S' } })).toBeNull();
    for (let i = 0; i < 800 && !Object.values(sim.st.stations).some(s => s.owner === p && s.modules[0].built); i++) sim.update(.25);
    const site = Object.values(sim.st.stations).find(s => s.owner === p)!;
    expect(site.modules[0].built).toBe(true); expect(site.size).toBe('S');
    site.storage[p].alloy = 500;
    site.storage[p].machinery = 10;
    expect(sim.command(p, { c: 'queueModule', station: site.id, kind: 'refinery' })).toBeNull();
    for (let i = 0; i < 1200 && !site.modules.some(m => m.kind === 'refinery' && m.built); i++) sim.update(.25);
    expect(site.modules.some(m => m.kind === 'refinery' && m.built)).toBe(true);
    site.storage[p].ore = 40;
    expect(sim.command(p, { c: 'prodOrder', station: site.id, recipe: 'metal', mode: 'count', n: 1 })).toBeNull();
    expect(site.jobs).toHaveLength(1);
    const freight = sim.newGroup(p, '하역반'), ship = sim.spawnShip(p, 'hauler', 'std', freight.id, site.pos);
    ship.cargo.alloy = 120; expect((sim as any).dockShip(ship, site)).toBe(true);
    expect(sim.command(p, { c: 'unloadCargo', ship: ship.id })).toBeNull();
    for (let i = 0; i < 8; i++) sim.update(.25);
    expect(ship.cargoWork!.done).toBeGreaterThan(0); expect(ship.cargo.alloy).toBe(120);
    const file = local.snapshotFile(), work = structuredClone(ship.cargoWork), jobs = structuredClone(site.jobs);
    await pg.query("UPDATE siderarium_world SET data = $1::jsonb, gen = gen + 1 WHERE id = 'main'", [JSON.stringify(file)]);
    for (const port of [8326, 8327]) {
      const srv = await start(port, { CONTENT_MIGRATE: '', SAVE_INTERVAL_S: '60' }); expect(await stop(srv)).toBe(0);
      const world = (await row())!.data.world, saved = world.stations[site.id];
      expect(saved.size).toBe('S'); expect(saved.modules).toEqual(file.world.stations[site.id].modules);
      expect(saved.jobs).toEqual(jobs); expect(saved.storage[p].ore ?? 0).toBe(0);
      expect(world.ships[ship.id].cargo.alloy).toBe(120); expect(world.ships[ship.id].cargoWork).toEqual(work);
      expect(srv.log()).not.toMatch(/save failed|마이그레이션 실패/);
    }
  }, 60_000);

  it('preserves an old-tier ship plan, a new-tier snapshot and returned overflow across PostgreSQL restarts', async () => {
    const local = new GameServer(null, { singleplayer: false, snapInterval: 1 }, 9631), sim = local.sim;
    const p = sim.addPlayer('PG 조선·초과 재고'), co = sim.st.companies[p]; co.credits = 50_000_000; co.tech = Object.keys(TECHS);
    (sim as any).npcSlow = () => {};
    const base = sim.st.stations.astra;
    const site: Station = { ...structuredClone(base), id: 'pg_p9631', name: 'PG 초과 보관 기지', owner: p, public: false, size: 'XL', market: null,
      storage: { [p]: { alloy: 70_000 } }, modules: ['core', 'yard_l', 'power', 'power', 'hull_works', 'machine_shop', 'armor_plant', 'electronics_fab', 'hangar', 'dock'].map((kind, slot) => ({ kind, slot, built: true, progress: 1 })) };
    sim.st.stations[site.id] = site;
    expect(sim.command(p, { c: 'queueModule', station: site.id, kind: 'yard_xl' })).toBeNull();
    Object.assign(site.storage[p], { ...FACILITIES.yard_xl.mats, alloy: 0 }); allocate(site, site.storage[p]);
    const plan = site.modules.find(m => m.kind === 'yard_xl')!;
    expect(sim.command(p, { c: 'planOp', station: site.id, plan: plan.id!, op: 'cancel' })).toBeNull();
    expect(storeUsed(site.storage[p])).toBe(81_850);
    site.builds = [{ id: 'legacy-battleship', classId: 'battleship', loadoutId: 'std', hull: 'battleship_mk1', variant: 'battleship_mk1_std', preset: 'battleship_std', fit: [], left: 23040, total: 57600, started: true, paid: 433200 }];
    expect(grantBlueprint(sim.st, co, hullBlueprint('miner_l')!, 'test', sim.time)).toBe(true);
    expect(sim.command(p, { c: 'buildShip', station: site.id, classId: 'miner', loadoutId: '', hull: 'miner_l' })).toBeNull();
    const current = site.builds.find(b => b.hull === 'miner_l')!; expect(current.requiredYard).toBe(3);
    const file = local.snapshotFile();
    await pg.query("UPDATE siderarium_world SET data = $1::jsonb, gen = gen + 1 WHERE id = 'main'", [JSON.stringify(file)]);
    for (const port of [8328, 8329]) {
      const srv = await start(port, { CONTENT_MIGRATE: '', SAVE_INTERVAL_S: '60' }); expect(await stop(srv)).toBe(0);
      const world = (await row())!.data.world, saved = world.stations[site.id];
      expect(saved.storage[p]).toEqual(file.world.stations[site.id].storage[p]); expect(storeUsed(saved.storage[p])).toBe(81_850);
      const legacy = saved.builds!.find(b => b.id === 'legacy-battleship')!, next = saved.builds!.find(b => b.id === current.id)!;
      expect(legacy.requiredYard).toBeUndefined(); expect(buildSpec(legacy).yard).toBe(3); expect(legacy.left).toBe(23040);
      expect(next.requiredYard).toBe(3); expect(next.paid).toBe(current.paid);
      const restored = new WorldSim(structuredClone(world), { migrateContent: false });
      expect(restored.room(restored.st.stations[site.id], p)).toBe(0);
      expect(srv.log()).not.toMatch(/save failed|마이그레이션 실패/);
    }
  }, 60_000);

  it('preserves committed trade identity and inventory across PostgreSQL process restarts', async () => {
    const local = new GameServer(null, { singleplayer: false, snapInterval: 1 }, 9632), sim = local.sim;
    const p = sim.addPlayer('PG 거래 재전송'), station = sim.st.stations.astra;
    station.storage[p].ore = 30;
    const command = { c: 'sell', station: station.id, res: 'ore', amount: 10, request: { seq: 1, id: 'pg-p9632-sale01' } } as const;
    expect(sim.command(p, command)).toBeNull();
    const credits = sim.st.companies[p].credits, stock = station.market!.ore.stock;
    const file = local.snapshotFile();
    await pg.query("UPDATE siderarium_world SET data = $1::jsonb, gen = gen + 1 WHERE id = 'main'", [JSON.stringify(file)]);
    for (const port of [8330, 8331]) {
      const srv = await start(port, { CONTENT_MIGRATE: '', SAVE_INTERVAL_S: '60' }); expect(await stop(srv)).toBe(0);
      const world = (await row())!.data.world;
      expect(world.companies[p].lastTrade).toEqual(file.world.companies[p].lastTrade);
      expect(world.companies[p].credits).toBe(credits); expect(world.stations.astra.storage[p].ore).toBe(20);
      expect(world.stations.astra.market!.ore.stock).toBe(stock);
      const restored = new WorldSim(structuredClone(world), { migrateContent: false });
      expect(restored.command(p, command)).toBeNull();
      expect(restored.st.companies[p].credits).toBe(credits); expect(restored.st.stations.astra.storage[p].ore).toBe(20);
      expect(restored.st.stations.astra.market!.ore.stock).toBe(stock);
      expect(srv.log()).not.toMatch(/save failed|마이그레이션 실패/);
    }
  }, 60_000);

  it('preserves regional deposits, company inventories and running special production across PostgreSQL restarts', async () => {
    const local = new GameServer(null, { singleplayer: false, snapInterval: 1 }, 970), sim = local.sim;
    const p = sim.addPlayer('PG 지역 생산'), q = sim.addPlayer('PG 다른 회사');
    sim.st.companies[p].tech = ['rare_processing'];
    const base = sim.st.stations.astra;
    const site: Station = { ...structuredClone(base), id: 'pg_p97', name: 'PG 지역 생산 시험', owner: p, public: false, size: 'L', market: null,
      storage: { [p]: { dense_titanium_ore: 40, titanium: 10, metal: 10 }, [q]: { resonant_crystal: 7 } },
      modules: ['core', 'power', 'smelter'].map((kind, slot) => ({ kind, slot, built: true, progress: 1 })), orders: [], jobs: [] };
    sim.st.stations[site.id] = site;
    expect(sim.command(p, { c: 'prodOrder', station: site.id, recipe: 'dense_alloy', mode: 'count', n: 1 })).toBeNull();
    expect(site.jobs).toHaveLength(1); expect(site.storage[p].dense_titanium_ore ?? 0).toBe(0);
    const group = sim.newGroup(p, 'PG 지역 운송'), ship = sim.spawnShip(p, 'hauler', 'std', group.id, site.pos);
    ship.cargo.unstable_isotope = 11;
    sim.st.fields.p97_anvil_dense.amount = 1234.5;
    const file = local.snapshotFile(), jobs = structuredClone(site.jobs);
    await pg.query("UPDATE siderarium_world SET data = $1::jsonb, gen = gen + 1 WHERE id = 'main'", [JSON.stringify(file)]);
    for (const port of [8332, 8333]) {
      const srv = await start(port, { CONTENT_MIGRATE: '', SAVE_INTERVAL_S: '60' }); expect(await stop(srv)).toBe(0);
      const world = (await row())!.data.world, saved = world.stations[site.id];
      expect(world.regionalV).toBe(1); expect(world.fields.p97_anvil_dense.amount).toBe(1234.5);
      expect(saved.jobs).toEqual(jobs); expect(saved.storage[q].resonant_crystal).toBe(7);
      expect(world.ships[ship.id].cargo.unstable_isotope).toBe(11);
      const restored = new WorldSim(structuredClone(world), { migrateContent: false });
      stepProduction(restored.st.stations[site.id], restored.st.companies[p], 180, restored.st);
      expect(restored.st.stations[site.id].storage[p].dense_alloy).toBe(12);
      expect(restored.st.stations[site.id].storage[q].resonant_crystal).toBe(7);
      expect(srv.log()).not.toMatch(/save failed|마이그레이션 실패/);
    }
  }, 60_000);

  it('preserves concurrent P9.8 dispatch reservations and cargo through PostgreSQL server restarts', async () => {
    const local = new GameServer(null, { singleplayer: false, snapInterval: 1 }, 981), sim = local.sim;
    const p = sim.addPlayer('PG 공용 물류'); sim.st.companies[p].credits = 1e7;
    for (const l of Object.values(sim.st.lairs)) { l.alive = false; l.respawnAt = 1e10; }
    for (const system of Object.values(sim.st.systems)) system.security = 100;
    const source = sim.st.stations.astra; source.storage[p].ore = 100;
    const target: Station = { ...structuredClone(source), id: 'pg_p981', name: 'PG 물류항', owner: p, public: false, pos: { ...source.pos, x: source.pos.x + 4000 }, market: null, storage: { [p]: {} }, modules: ['core', 'power', 'logistics'].map((kind, slot) => ({ kind, slot, built: true, progress: 1 })) };
    sim.st.stations[target.id] = target;
    const g = sim.newGroup(p, 'PG 공용 수송'), s1 = sim.spawnShip(p, 'hauler', 'std', g.id, source.pos), s2 = sim.spawnShip(p, 'hauler', 'std', g.id, target.pos);
    (sim as any).dockShip(s1, source);
    expect(sim.command(p, { c: 'poolShips', ships: [s1.id, s2.id], on: true })).toBeNull();
    for (let i = 0; i < 2; i++) expect(sim.command(p, { c: 'poolCreate', request: { from: source.id, to: target.id, item: 'ore', kind: 'transfer', amount: 20, priority: 5, repeat: false } })).toBeNull();
    for (let i = 0; i < 5; i++) sim.update(.25);
    const jobs = Object.values(sim.st.logisticsJobs!); expect(jobs.reduce((n, j) => n + j.reserved, 0)).toBe(20); expect(jobs.reduce((n, j) => n + j.carried, 0)).toBe(20);
    const file = local.snapshotFile(); await pg.query("UPDATE siderarium_world SET data = $1::jsonb, gen = gen + 1 WHERE id = 'main'", [JSON.stringify(file)]);
    const first = await start(8336, { CONTENT_MIGRATE: '', SAVE_INTERVAL_S: '60' }); expect(await stop(first)).toBe(0);
    let world = (await row())!.data.world; expect(world.logisticsJobs).toEqual(file.world.logisticsJobs);
    const restored = new WorldSim(structuredClone(world), { migrateContent: false });
    for (let i = 0; i < 3000 && Object.values(restored.st.logisticsJobs!).some(j => j.state !== 'complete'); i++) restored.update(.25);
    expect(Object.values(restored.st.logisticsJobs!).map(j => j.delivered)).toEqual([20, 20]);
    expect((restored.st.stations[source.id].storage[p].ore ?? 0) + (restored.st.stations[target.id].storage[p].ore ?? 0) + (restored.st.ships[s1.id].cargo.ore ?? 0) + (restored.st.ships[s2.id].cargo.ore ?? 0)).toBe(100);
    const next = { ...file, world: JSON.parse(restored.serialize()) }; await pg.query("UPDATE siderarium_world SET data = $1::jsonb, gen = gen + 1 WHERE id = 'main'", [JSON.stringify(next)]);
    const second = await start(8337, { CONTENT_MIGRATE: '', SAVE_INTERVAL_S: '60' }); expect(await stop(second)).toBe(0);
    world = (await row())!.data.world; expect(Object.values(world.logisticsJobs!).map(j => j.delivered)).toEqual([20, 20]); expect(world.stations[target.id].storage[p].ore).toBe(40);
  }, 60_000);

  it('restores purchased procurement plans, reserved stock and physical cargo through PostgreSQL restarts', async () => {
    const local = new GameServer(null, { singleplayer: false, snapInterval: 1 }, 982), sim = local.sim, p = sim.addPlayer('PG 자율 조달');
    sim.st.companies[p].credits = 1e7;
    for (const l of Object.values(sim.st.lairs)) { l.alive = false; l.respawnAt = 1e10; }
    for (const system of Object.values(sim.st.systems)) system.security = 100;
    const source = sim.st.stations.astra; source.storage[p] = {};
    const target = (id: string, x: number): Station => ({ ...structuredClone(source), id, name: id, owner: p, public: false, pos: { ...source.pos, x: source.pos.x + x }, market: null, storage: { [p]: {} }, modules: ['core', 'power', 'refinery', 'logistics'].map((kind, slot) => ({ kind, slot, built: true, progress: 1 })), builds: [], orders: [], jobs: [], listings: [] });
    const a = target('pg982_a', 600), b = target('pg982_b', 3000); sim.st.stations[a.id] = a; sim.st.stations[b.id] = b;
    const g = sim.newGroup(p, 'PG 조달 수송'), s1 = sim.spawnShip(p, 'hauler', 'std', g.id, source.pos), s2 = sim.spawnShip(p, 'hauler', 'std', g.id, b.pos); (sim as any).dockShip(s1, source);
    expect(sim.command(p, { c: 'poolShips', ships: [s1.id, s2.id], on: true })).toBeNull();
    for (const station of [a, b]) expect(sim.command(p, { c: 'prodOrder', station: station.id, recipe: 'alloy_direct', mode: 'count', n: 1 })).toBeNull();
    const price = sim.price(source, 'ore', 'buy'), before = sim.st.companies[p].credits, market = source.market!.ore.stock;
    expect(sim.command(p, { c: 'procPolicy', settings: { enabled: true, autoBuy: true, budget: price * 240, minCredits: 0, maxRisk: 100, priceItem: 'ore', maxUnitPrice: price * 2 } })).toBeNull();
    planProcurement(sim); const spent = sim.st.companies[p].procurement!.spent; expect(spent).toBeGreaterThan(0); expect(source.market!.ore.stock).toBe(market - 120); expect(sim.st.companies[p].credits).toBeCloseTo(before - spent);
    dispatchPool(sim); for (let i = 0; i < 5; i++) sim.update(.25);
    const jobs = Object.values(sim.st.logisticsJobs!).filter(j => !!j.procurement); expect(jobs.some(j => j.carried > 0)).toBe(true); expect(jobs.some(j => j.reserved > 0)).toBe(true);
    const file = local.snapshotFile(); await pg.query("UPDATE siderarium_world SET data = $1::jsonb, gen = gen + 1 WHERE id = 'main'", [JSON.stringify(file)]);
    const first = await start(8338, { CONTENT_MIGRATE: '', SAVE_INTERVAL_S: '60' }); expect(await stop(first)).toBe(0);
    let world = (await row())!.data.world;
    expect(world.procurementPlans).toEqual(file.world.procurementPlans); expect(world.logisticsJobs).toEqual(file.world.logisticsJobs); expect(world.companies[p].procurement).toEqual(file.world.companies[p].procurement);
    const restored = new WorldSim(structuredClone(world), { migrateContent: false });
    for (let i = 0; i < 10000 && (restored.st.stations[a.id].orders!.length || restored.st.stations[b.id].orders!.length); i++) restored.update(.25);
    expect(restored.st.stations[a.id].storage[p].alloy).toBe(14); expect(restored.st.stations[b.id].storage[p].alloy).toBe(14);
    expect(restored.st.companies[p].procurement!.spent).toBeCloseTo(spent); expect(Object.values(restored.st.logisticsJobs!).filter(j => !!j.procurement)).toHaveLength(2);
    await pg.query("UPDATE siderarium_world SET data = $1::jsonb, gen = gen + 1 WHERE id = 'main'", [JSON.stringify({ ...file, world: JSON.parse(restored.serialize()) })]);
    const second = await start(8339, { CONTENT_MIGRATE: '', SAVE_INTERVAL_S: '60' }); expect(await stop(second)).toBe(0);
    world = (await row())!.data.world; expect(world.companies[p].procurement!.spent).toBeCloseTo(spent); expect(world.stations[a.id].storage[p].alloy + world.stations[b.id].storage[p].alloy).toBe(28);
  }, 60_000);

  it('restores a paid legacy batch but applies regional inputs to the next stock batch', async () => {
    const local = new GameServer(null, { singleplayer: false, snapInterval: 1 }, 971), sim = local.sim;
    const p = sim.addPlayer('PG 구형 주문'); sim.st.companies[p].tech = ['railguns'];
    const base = sim.st.stations.astra;
    const site: Station = { ...structuredClone(base), id: 'pg_p971', name: 'PG 주문 전환', owner: p, public: false, size: 'L', market: null,
      storage: { [p]: Object.fromEntries(Object.entries(RECIPES.eq_rail_cannon.in).map(([k, n]) => [k, n * 3])) },
      modules: ['core', 'power', 'weapons_factory'].map((kind, slot) => ({ kind, slot, built: true, progress: 1 })), orders: [], jobs: [] };
    sim.st.stations[site.id] = site;
    delete sim.st.regionalV;
    expect(sim.command(p, { c: 'prodOrder', station: site.id, recipe: 'eq_rail_cannon', mode: 'stock', n: 2 })).toBeNull();
    sim.st.regionalV = 1; site.orders![0].legacyRecipe = true;
    const file = local.snapshotFile(), paid = structuredClone(site.storage[p]), job = structuredClone(site.jobs);
    await pg.query("UPDATE siderarium_world SET data = $1::jsonb, gen = gen + 1 WHERE id = 'main'", [JSON.stringify(file)]);
    for (const port of [8334, 8335]) {
      const srv = await start(port, { CONTENT_MIGRATE: '', SAVE_INTERVAL_S: '60' }); expect(await stop(srv)).toBe(0);
      const world = (await row())!.data.world, saved = world.stations[site.id];
      expect(saved.storage[p]).toEqual(paid); expect(saved.jobs).toEqual(job);
      expect(saved.orders![0].legacyRecipe).toBeUndefined(); expect(saved.orders![0].n).toBe(2);
      const restored = new WorldSim(structuredClone(world), { migrateContent: false });
      const current = restored.st.stations[site.id];
      stepProduction(current, restored.st.companies[p], 3000, restored.st);
      expect(current.storage[p].eq_rail_cannon).toBe(1); expect(current.jobs).toHaveLength(0);
      expect(current.orders![0].done).toBe(1); expect(current.orders![0].why).toContain('고강도 특수 합금');
    }
  }, 60_000);

  it('econ value-chain migration: one instance applies it with a verified backup row; the old instance cannot write old prices back; restart is idempotent; the backup restores', async () => {
    const local = new GameServer(null, { singleplayer: false, snapInterval: 1 }, 4402), sim = local.sim;
    const p = sim.addPlayer('PG 경제 이관'); sim.st.companies[p].credits = 2e6;
    const a = sim.st.stations.astra;
    const site: Station = { ...structuredClone(a), id: 'pg_econ', name: 'PG 경제', owner: p, public: false, market: null, funds: undefined, fundsMax: undefined, shipStock: undefined,
      storage: { [p]: { ore: 3000 } }, builds: [], orders: [], jobs: [], listings: [], modules: ['core', 'power', 'refinery'].map((kind, slot) => ({ kind, slot, built: true, progress: 1 })) };
    sim.st.stations[site.id] = site;
    expect(sim.command(p, { c: 'prodOrder', station: site.id, recipe: 'alloy_direct', mode: 'count', n: 20 })).toBeNull();
    sim.tick(1); expect(site.jobs).toHaveLength(1);
    const file = local.snapshotFile();
    expect(file.world.contentV).toBe(CONTENT_VERSION); expect(file.world.econ).toBeUndefined();
    await pg.query("DELETE FROM siderarium_world WHERE id LIKE 'backup-pre-v4.2.c4.e%'");
    await pg.query("UPDATE siderarium_world SET data = $1::jsonb, gen = gen + 1 WHERE id = 'main'", [JSON.stringify(file)]);
    const gen0 = Number((await row())!.gen);
    // old instance: no flag — only a dry run is logged, and it keeps autosaving
    const A = await start(8341, { SAVE_INTERVAL_S: '0.5' });
    expect(A.log()).toMatch(/econ migration DRY RUN e0→e1: .*census OK — 적용하지 않음/);
    await wait(1200);
    const pre = (await row())!; expect(pre.data.world.econ).toBeUndefined();
    // new instance with ECON_MIGRATE=apply (transaction held open while A keeps trying to save)
    const B = await start(8342, { ECON_MIGRATE: 'apply', SAVE_INTERVAL_S: '600', SIDERARIUM_TEST_MIGRATE_HOLD_MS: '2000' });
    expect(B.log()).toMatch(/save migration committed: backup backup-pre-v4\.2\.c4\.e0 verified/);
    const mid = (await row())!;
    expect(Number(mid.gen)).toBe(gen0 + 1);
    expect(mid.data.world.econ).toMatchObject({ v: 1, how: 'migrated' });
    const bk = (await row('backup-pre-v4.2.c4.e0'))!;
    expect(bk.data.world.econ).toBeUndefined();
    expect(compareCensus(census(bk.data.world), census(mid.data.world))).toEqual([]);
    expect(mid.data.accounts).toEqual(bk.data.accounts);
    // only market prices moved; the running batch kept its terms; stock, credits and storage are the backup's
    expect(mid.data.world.stations[site.id].jobs).toEqual(bk.data.world.stations[site.id].jobs);
    expect(mid.data.world.stations[site.id].storage).toEqual(bk.data.world.stations[site.id].storage);
    for (const [id, c] of Object.entries(bk.data.world.companies)) expect(mid.data.world.companies[id].credits).toBe(c.credits);
    expect(mid.data.world.stations.astra.market!.metal.base).not.toBe(bk.data.world.stations.astra.market!.metal.base);
    expect(mid.data.world.stations.astra.market!.metal.stock).toBe(bk.data.world.stations.astra.market!.metal.stock);
    // the old instance's saves (old prices) are refused from now on, including its shutdown save
    await wait(2000);
    expect(A.log()).toMatch(/저장 거부: 더 새로운 월드 세대/);
    expect(await stop(A)).toBe(0);
    expect((await row())!.h).toBe(mid.h);
    expect(await stop(B)).toBe(0);
    // restart with the flag still set: nothing is migrated again, no new backup
    const C = await start(8343, { ECON_MIGRATE: 'apply', SAVE_INTERVAL_S: '600' });
    expect(C.log()).not.toMatch(/save migration/);
    expect(await stop(C)).toBe(0);
    const fin = (await row())!;
    expect(Number(fin.gen)).toBe(gen0 + 1); expect(fin.data.world.econ?.how).toBe('migrated');
    expect((await pg.query("SELECT count(*)::int AS n FROM siderarium_world WHERE id LIKE 'backup-pre-v4.2.c4.e%'")).rows[0].n).toBe(1);
    // data rollback: the verified backup row restored over main, server without the flag → old prices
    await pg.query("UPDATE siderarium_world SET data = (SELECT data FROM siderarium_world WHERE id = 'backup-pre-v4.2.c4.e0'), gen = gen + 1 WHERE id = 'main'");
    const D = await start(8344, { SAVE_INTERVAL_S: '600' }); expect(await stop(D)).toBe(0);
    const back = (await row())!;
    expect(back.data.world.econ).toBeUndefined();
    expect(back.data.world.stations.astra.market!.metal.base).toBe(bk.data.world.stations.astra.market!.metal.base);
  }, 90_000);
});

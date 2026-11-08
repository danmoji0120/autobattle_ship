import { describe, it, expect, vi } from 'vitest';
import { takec, addc } from '../src/world/types';
import { stepResearch } from '../src/world/research';
import { stepProduction } from '../src/world/production';
import { TECHS, RECIPES } from '../src/world/industry';
import { GameServer, type Conn } from '../src/server/core';
import { WorldSim } from '../src/world/sim';
import { Analytics } from '../src/server/analytics';
import { emit, moneySupply, watchMoney } from '../src/world/observe';
import type { SaveFile, ServerMsg } from '../src/server/protocol';

function saved(): SaveFile {
  const sim = WorldSim.create(719);
  const a = sim.addPlayer('분석 A'), b = sim.addPlayer('비공개 B');
  for (const co of Object.values(sim.st.companies)) if (co.kind === 'player') co.credits = 100000;
  sim.st.stations.astra.storage[a].ore = 100;
  sim.st.stations.astra.storage[b].ore = 12345;
  return { v: 1, world: JSON.parse(sim.serialize()), auth: { a, b }, accounts: { admin: a, player: b } };
}
const rows = (a: Analytics, kind: string) => a.query('admin', '').totals.filter(r => r.kind === kind);
const sumMetric = (rows: import('../src/server/analytics').Metric[], kind: string) => rows.filter(r => r.kind === kind).reduce((n, r) => n + r.amount, 0);
const total = (a: Analytics, kind: string) => rows(a, kind).reduce((n, r) => n + r.amount, 0);

describe('authoritative analytics', () => {
  it('counts budget-backed trade and player payments as transfers; records only actual money creation/destruction', () => {
    const server = new GameServer(saved(), { singleplayer: false, snapInterval: 1 });
    const sim = server.sim, a = server.analytics!, id = server.auth.a;
    const before = moneySupply(sim.st);
    expect(sim.command(id, { c: 'buy', station: 'astra', res: 'alloy', amount: 10 })).toBeNull();
    expect(sim.command(id, { c: 'sell', station: 'astra', res: 'ore', amount: 20 })).toBeNull();
    expect(total(a, 'currency.transfer')).toBeGreaterThan(0);
    expect(total(a, 'currency.create')).toBe(0);
    expect(moneySupply(sim.st) - before).toBeCloseTo(-total(a, 'currency.destroy'), 7);
    expect(a.query('admin', '').health.reconciliation).toBeCloseTo(0, 7);
    expect(total(a, 'market')).toBe(30);
    // Nested operations must not double-count gross flows.
    const income = total(a, 'income');
    watchMoney(sim.st, 'outer', {}, () => watchMoney(sim.st, 'inner', {}, () => { sim.st.companies[id].credits += 25; }));
    expect(total(a, 'income') - income).toBe(25);
    expect(total(a, 'currency.create')).toBe(25);
  });

  it('persists buckets and in-flight research across restart without re-emitting records', () => {
    const server = new GameServer(saved(), { singleplayer: false, snapInterval: 1, analytics: { snapshotSeconds: 300 } });
    const id = server.auth.a;
    emit(server.sim.st, { kind: 'research', reason: 'start', amount: 1, company: id, item: 'mining1', ref: 'r123' });
    server.sim.st.time += 350; server.analytics!.step();
    const file = server.snapshotFile();
    const restored = new GameServer(structuredClone(file), { singleplayer: false, snapInterval: 1 });
    expect(restored.analytics!.data.projects[`${id}:r123`].start).toBe(file.analytics!.projects[`${id}:r123`].start);
    restored.sim.st.time += 50;
    emit(restored.sim.st, { kind: 'research', reason: 'complete', amount: 1, company: id, item: 'mining1', ref: 'r123' });
    expect(total(restored.analytics!, 'research.duration')).toBe(400);
    expect(total(restored.analytics!, 'research')).toBe(2);
    expect(file.analytics!.projects[`${id}:r123`]).toBeDefined(); // snapshot is immutable
    const again = new GameServer(restored.snapshotFile(), { singleplayer: false, snapInterval: 1 });
    expect(total(again.analytics!, 'research.duration')).toBe(400);
  });

  it('compacts old intervals, bounds bytes and metadata, and explicitly reports retention loss', () => {
    const sim = WorldSim.create(11), a = new Analytics(sim, undefined, { snapshotSeconds: 300, fineBuckets: 2, hourlyBuckets: 2, dailyBuckets: 2, maxBytes: 262144 });
    for (let i = 0; i < 2000; i++) {
      sim.st.time += 300;
      emit(sim.st, { kind: 'produce', amount: 2, item: 'ore', company: 'a', reason: 'mining' }); a.step();
    }
    const snapshot = a.snapshot();
    expect(snapshot.fine.length).toBeLessThanOrEqual(2);
    expect(snapshot.hourly.length).toBeLessThanOrEqual(2);
    expect(snapshot.daily.length).toBeLessThanOrEqual(2);
    expect(new TextEncoder().encode(JSON.stringify(snapshot)).byteLength).toBeLessThanOrEqual(262144);
    expect(snapshot.truncatedBefore).toBeGreaterThan(0);
    expect(a.query('admin', '', { hours: 8760 }).totals.find(r => r.kind === 'produce')!.amount).toBeGreaterThan(0);
  });

  it('enforces admin identity and filters all private company data before transmission', () => {
    const server = new GameServer(saved(), { singleplayer: false, accounts: true, snapInterval: 1, adminAccounts: ['admin'] });
    const sent: Record<string, ServerMsg[]> = { admin: [], player: [], anon: [] };
    for (const account of ['admin', 'player', 'anon']) {
      const c: Conn = { id: account, ...(account === 'anon' ? {} : { account }), lastEvent: 0, battles: new Set(), send: m => sent[account].push(JSON.parse(JSON.stringify(m))) };
      server.connect(c); server.handle(account, { t: 'hello', name: 'forged', token: 'a' });
    }
    const a = server.accounts.admin, b = server.accounts.player;
    emit(server.sim.st, { kind: 'produce', amount: 42, company: a, item: 'SECRET_ASSET' });
    emit(server.sim.st, { kind: 'produce', amount: 7, company: b, item: 'ore' });
    server.handle('player', { t: 'analytics', id: 1, scope: 'admin' });
    expect(sent.player.at(-1)).toMatchObject({ t: 'analytics', error: expect.stringMatching(/권한/) });
    server.handle('anon', { t: 'analytics', id: 2, scope: 'admin' });
    expect(sent.anon.at(-1)).toMatchObject({ t: 'analytics', error: expect.any(String) });
    server.handle('player', { t: 'analytics', id: 3, scope: 'player' });
    const reply = sent.player.at(-1) as Extract<ServerMsg, { t: 'analytics' }>;
    expect(JSON.stringify(reply)).not.toContain('SECRET_ASSET');
    expect(reply.data!.current.companies.map(c => c.id)).toEqual([b]);
    server.handle('admin', { t: 'analytics', id: 4, scope: 'admin' });
    expect(JSON.stringify(sent.admin.at(-1))).toContain('SECRET_ASSET');
    const snap = sent.player.find(m => m.t === 'snap') as Extract<ServerMsg, { t: 'snap' }>;
    expect(snap.state.companies[a].credits).toBe(0);
    expect(snap.state.stations.astra.storage[a]).toBeUndefined();
    expect((snap.state as any).analytics).toBeUndefined();
  });

  it('collecting statistics does not change c0 or growth simulation state or RNG', () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    try {
      for (const growth of [false, true]) {
        const file = saved(); if (!growth) delete file.world.contentV;
        const off = new GameServer(structuredClone(file), { singleplayer: false, snapInterval: 1000, migrateContent: false, analytics: { enabled: false } });
        const on = new GameServer(structuredClone(file), { singleplayer: false, snapInterval: 1000, migrateContent: false });
        for (let i = 0; i < 240; i++) { off.step(.25); on.step(.25); }
        expect(on.sim.serialize()).toBe(off.sim.serialize());
        expect(on.analytics!.query('admin', '').health.reconciliation).toBeCloseTo(0, 6);
      }
    } finally { clock.mockRestore(); }
  });
  it('records real research start/pause/completion and actual industry input/output, with no shortened test conditions', () => {
    const file = saved(), p = file.auth.a, st = structuredClone(file.world.stations.astra);
    st.id = 'lab'; st.owner = p; st.public = false; st.market = null;
    st.modules = ['core', 'power', 'lab_basic', 'refinery'].map((kind, slot) => ({ kind, slot, progress: 1, built: true }));
    st.storage = { [p]: { ...TECHS.process_control.cost, ore: 1000, crystal: 1000, machinery: 1000, electronics: 1000 } };
    file.world.stations.lab = st;
    const server = new GameServer(file, { singleplayer: false, snapInterval: 1 });
    const sim = server.sim, co = sim.st.companies[p], analytics = server.analytics!;
    expect(sim.command(p, { c: 'research', station: st.id, tech: 'process_control' })).toBeNull();
    const project = co.research![0], needed = project.total;
    expect(project.started).toBe(true);
    expect(sim.command(p, { c: 'researchOp', project: project.id, op: 'pause' })).toBeNull();
    for (let i = 0; i < 100; i++) { sim.st.time++; stepResearch(sim.st, co, 1); }
    expect(project.left).toBe(needed);
    expect(sim.command(p, { c: 'researchOp', project: project.id, op: 'resume' })).toBeNull();
    while (co.research!.length) { sim.st.time++; stepResearch(sim.st, co, 1); }
    expect(co.tech).toContain('process_control');
    expect(total(analytics, 'research.duration')).toBe(needed + 100);
    expect(rows(analytics, 'research').filter(r => r.reason === 'complete').reduce((n, r) => n + r.amount, 0)).toBe(1);
    const recipe = Object.values(RECIPES).find(r => r.fac === 'refinery' && !r.tech)!;
    expect(sim.command(p, { c: 'prodOrder', station: st.id, recipe: recipe.id, mode: 'count', n: 1 })).toBeNull();
    stepProduction(sim.st.stations.lab, co, recipe.time * 2, sim.st);
    for (const [item, n] of Object.entries(recipe.out)) expect(rows(analytics, 'produce').find(r => r.item === item && r.reason === 'industry')!.amount).toBe(n);
    for (const [item, n] of Object.entries(recipe.in)) expect(rows(analytics, 'consume').find(r => r.item === item && r.reason === 'industry')!.amount).toBe(n);
  });

  it('does not duplicate player-exchange volume and records seller receipts without exposing the buyer history', () => {
    const file = saved(); file.world.stations.astra.storage[file.auth.a].alloy = 100; file.world.stations.astra.storage[file.auth.b].ore = 0;
    const server = new GameServer(file, { singleplayer: false, snapInterval: 1 });
    const sim = server.sim, a = file.auth.a, b = file.auth.b;
    expect(sim.command(a, { c: 'list', station: 'astra', item: 'alloy', qty: 10, price: 20 })).toBeNull();
    const listing = sim.st.stations.astra.listings![0];
    expect(sim.command(b, { c: 'buyListing', station: 'astra', listing: listing.id, qty: 10 })).toBeNull();
    expect(total(server.analytics!, 'market')).toBe(10);
    expect(sumMetric(server.analytics!.query('player', a).totals, 'market')).toBe(10);
    expect(sumMetric(server.analytics!.query('player', b).totals, 'market')).toBe(10);
    expect(server.analytics!.query('admin', '').health.reconciliation).toBeCloseTo(0, 6);
  });

  it('retains history while collection is disabled and explicitly reports the unobserved interval on resume', () => {
    const first = new GameServer(saved(), { singleplayer: false, snapInterval: 1 });
    expect(first.sim.command(first.auth.a, { c: 'buy', station: 'astra', res: 'alloy', amount: 1 })).toBeNull();
    const recorded = total(first.analytics!, 'market');
    const off = new GameServer(first.snapshotFile(), { singleplayer: false, snapInterval: 1, analytics: { enabled: false } });
    expect(off.sim.command(off.auth.a, { c: 'buy', station: 'astra', res: 'alloy', amount: 1 })).toBeNull();
    off.step(1);
    expect(off.snapshotFile().analytics).toBeDefined();
    const resumed = new GameServer(off.snapshotFile(), { singleplayer: false, snapInterval: 1 });
    expect(total(resumed.analytics!, 'market')).toBe(recorded);
    expect(resumed.analytics!.query('admin', '').health.gaps).toHaveLength(1);
    expect(resumed.analytics!.query('admin', '').health.reconciliation).toBeCloseTo(0, 6);
  });

  it('keeps asset assessment unchanged for cargo transfers and listing escrow; analysis queries are read-only', () => {
    const file = saved(), p = file.auth.a;
    file.world.stations.astra.storage[p].alloy = 100;
    const server = new GameServer(file, { singleplayer: false, snapInterval: 1 });
    const sim = server.sim, asset = () => server.analytics!.query('player', p).current.companies[0].assets;
    const before = asset(), ship = Object.values(sim.st.ships).find(s => s.owner === p)!;
    addc(ship.cargo, 'alloy', takec(sim.st.stations.astra.storage[p], 'alloy', 25));
    expect(asset()).toBe(before);
    expect(sim.command(p, { c: 'list', station: 'astra', item: 'alloy', qty: 10, price: 999 })).toBeNull();
    expect(asset()).toBe(before); // asking price never manufactures assessed wealth
    const state = JSON.stringify(server.analytics!.data);
    server.analytics!.query('admin', '', { hours: 8760 }); server.analytics!.query('player', p);
    expect(JSON.stringify(server.analytics!.data)).toBe(state);
  });

  it('counts online time once per company across simultaneous authenticated tabs', () => {
    const server = new GameServer(saved(), { singleplayer: false, accounts: true, snapInterval: 100 });
    for (const id of ['tab1', 'tab2']) { server.connect({ id, account: 'admin', lastEvent: 0, battles: new Set(), send: () => {} }); server.handle(id, { t: 'hello', name: 'ignored' }); }
    server.step(1); server.step(1);
    const p = server.accounts.admin;
    expect(server.analytics!.query('player', p).current.companies[0].played).toBe(2);
    server.disconnect('tab1'); server.step(1);
    expect(server.analytics!.query('player', p).current.companies[0].played).toBe(3);
    server.disconnect('tab2'); server.step(1);
    expect(server.analytics!.query('player', p).current.companies[0].played).toBe(3);
  });

});

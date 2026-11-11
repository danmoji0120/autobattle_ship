// P0 save path: one serialization per save, the analytics history stored apart from the world,
// failure tracking, no overlapping saves, and compatibility with saves written by the previous server.
import { describe, expect, it } from 'vitest';
import { GameServer } from '../src/server/core';
import { WorldSim } from '../src/world/sim';
import { Saver, pickAnalytics, type AnalyticsRecord } from '../src/server/saver';
import { emit, moneySupply } from '../src/world/observe';
import type { SaveFile } from '../src/server/protocol';

function world(seed = 4242) {
  const sim = WorldSim.create(seed);
  const a = sim.addPlayer('저장 A'), b = sim.addPlayer('저장 B');
  sim.st.companies[a].credits = 123456;
  sim.st.stations.astra.storage[b].ore = 777;
  return { v: 1, world: JSON.parse(sim.serialize()), auth: { tokA: a }, accounts: { 'acc-a': a, 'acc-b': b } } as SaveFile;
}
const run = (g: GameServer, seconds: number) => { for (let i = 0; i < seconds * 20; i++) g.step(0.05); };
/** a store that keeps what was written (as the database does: JSON in, JSON out) */
function memStore(opts: { separate?: boolean; fail?: () => boolean; delayMs?: number } = {}) {
  const st = {
    world: null as string | null, analytics: null as string | null, writes: 0, concurrent: 0, maxConcurrent: 0, fenced: false,
    async save(text: string) {
      st.concurrent++; st.maxConcurrent = Math.max(st.maxConcurrent, st.concurrent);
      try {
        if (opts.delayMs) await new Promise(r => setTimeout(r, opts.delayMs));
        if (opts.fail?.()) throw new Error('connection terminated unexpectedly');
        JSON.parse(text); st.world = text; st.writes++;
      } finally { st.concurrent--; }
    },
    saveAnalytics: undefined as undefined | ((t: string) => Promise<void>),
  };
  if (opts.separate !== false) st.saveAnalytics = async (t: string) => { if (opts.fail?.()) throw new Error('timeout'); JSON.parse(t); st.analytics = t; };
  return st;
}
const silent = { analyticsEveryS: 300, log: () => {} };

describe('save text', () => {
  it('is exactly the JSON of the save file (with analytics), built without a parse/stringify round-trip', () => {
    const g = new GameServer(world(), { singleplayer: false, snapInterval: 1 });
    run(g, 120);
    expect(g.saveText()).toBe(JSON.stringify(g.snapshotFile()));
    const off = new GameServer(world(), { singleplayer: false, snapInterval: 1, analytics: { enabled: false } });
    expect(off.saveText()).toBe(JSON.stringify(off.snapshotFile()));
  });

  it('restores the same world, accounts and analytics (and keeps loading saves of the previous format)', () => {
    const g = new GameServer(world(), { singleplayer: false, snapInterval: 1 });
    run(g, 300);
    const text = g.saveText(), file = JSON.parse(text) as SaveFile;
    // the previous server wrote JSON.stringify(snapshotFile()): identical text, so old saves load unchanged
    const old = JSON.parse(JSON.stringify(g.snapshotFile())) as SaveFile;
    for (const save of [file, old]) {
      const r = new GameServer(save, { singleplayer: false, snapInterval: 1 });
      expect(r.sim.serialize()).toBe(g.sim.serialize());
      expect(r.accounts).toEqual(g.accounts);
      expect(r.auth).toEqual(g.auth);
      expect(r.analytics!.data.started).toBe(g.analytics!.data.started);
      expect(r.saveText()).toBe(text);
    }
  });

  it('survives many restarts without drift or growth beyond the world itself', () => {
    let g = new GameServer(world(), { singleplayer: false, snapInterval: 1 });
    const sizes: number[] = [];
    for (let i = 0; i < 6; i++) {
      run(g, 60);
      const text = g.saveText({ analytics: false });
      const atext = g.analyticsText()!;
      sizes.push(text.length);
      const save = JSON.parse(text) as SaveFile;
      const pick = pickAnalytics(save, { v: 1, seed: save.world.seed ?? null, time: g.sim.time, store: JSON.parse(atext) });
      expect(pick.from).toBe('separate');
      const before = g.sim.serialize();
      g = new GameServer({ ...save, analytics: pick.store }, { singleplayer: false, snapInterval: 1 });
      expect(g.sim.serialize()).toBe(before);
      // same moment: no gap is recorded
      expect(g.analytics!.data.gaps ?? []).toEqual([]);
    }
    expect(Math.max(...sizes) / Math.min(...sizes)).toBeLessThan(1.5);
  });
});

describe('separately stored analytics', () => {
  it('a world restored from a later save records the unobserved interval as a gap and still reconciles', () => {
    const g = new GameServer(world(), { singleplayer: false, snapInterval: 1 });
    run(g, 60);
    const rec: AnalyticsRecord = { v: 1, seed: g.sim.st.seed ?? null, time: g.sim.time, store: JSON.parse(g.analyticsText()!) };
    // the world keeps changing (money moves) after the analytics record was written
    run(g, 90);
    const id = Object.values(g.sim.st.companies).find(c => c.kind === 'player')!.id;
    g.sim.st.companies[id].credits += 5000;
    const save = JSON.parse(g.saveText({ analytics: false })) as SaveFile;
    const pick = pickAnalytics(save, rec);
    expect(pick.from).toBe('separate');
    const r = new GameServer({ ...save, analytics: pick.store }, { singleplayer: false, snapInterval: 1 });
    const gaps = r.analytics!.data.gaps!;
    expect(gaps).toHaveLength(1);
    expect(gaps[0].start).toBeCloseTo(rec.time, 6);
    expect(gaps[0].end).toBeCloseTo(save.world.time, 6);
    expect(r.analytics!.query('admin', '').health.reconciliation).toBeCloseTo(0, 6);
    expect(moneySupply(r.sim.st)).toBeCloseTo(moneySupply(g.sim.st), 6);
  });

  it('is ignored for a different or reset world, and an older copy loses to the one inside the world save', () => {
    const g = new GameServer(world(), { singleplayer: false, snapInterval: 1 });
    run(g, 120);
    const rec: AnalyticsRecord = { v: 1, seed: g.sim.st.seed ?? null, time: g.sim.time, store: JSON.parse(g.analyticsText()!) };
    const fresh = world();                       // a reset: same seed, time starts again
    expect(pickAnalytics(fresh, rec).from).not.toBe('separate');
    expect(pickAnalytics(world(999), rec).from).not.toBe('separate');
    // an older server (rollback) kept writing analytics into the world save: the newer copy wins
    run(g, 700);
    emit(g.sim.st, { kind: 'produce', amount: 1, item: 'ore', company: 'x', reason: 'mining' });
    const withInside = JSON.parse(g.saveText()) as SaveFile;
    expect(pickAnalytics(withInside, rec).from).toBe('world');
    // no separate record yet (first start after the upgrade): the copy inside the world save is used
    expect(pickAnalytics(withInside, null).from).toBe('world');
  });
});

describe('Saver', () => {
  it('writes the world with analytics until the separate record exists, then without; analytics on its own interval', async () => {
    const g = new GameServer(world(), { singleplayer: false, snapInterval: 1 });
    let now = 0;
    const store = memStore();
    const s = new Saver(store, g, { ...silent, now: () => now });
    s.due(); await s.flush(1000);
    expect(JSON.parse(store.analytics!).store.version).toBe(1);
    const first = store.writes;
    now += 30_000; run(g, 30); s.due(); await new Promise(r => setTimeout(r, 0)); await s.flush(1000);
    expect(store.writes).toBeGreaterThan(first);
    expect(JSON.parse(store.world!).analytics).toBeUndefined();     // world rows no longer carry the history
    expect(s.stats.analytics.ok).toBeGreaterThanOrEqual(1);
    const aBefore = s.stats.analytics.ok;
    now += 30_000; s.due(); await new Promise(r => setTimeout(r, 10));
    expect(s.stats.analytics.ok).toBe(aBefore);                       // not due yet (300 s)
    now += 300_000; s.due(); await new Promise(r => setTimeout(r, 10));
    expect(s.stats.analytics.ok).toBe(aBefore + 1);
  });

  it('keeps analytics inside the world save when the storage has no separate record (ANALYTICS_SEPARATE=0)', async () => {
    const g = new GameServer(world(), { singleplayer: false, snapInterval: 1 });
    const store = memStore({ separate: false });
    const s = new Saver(store, g, silent);
    s.due(); await s.flush(1000);
    expect(JSON.parse(store.world!).analytics).toBeDefined();
    expect(store.world).toBe(JSON.stringify(g.snapshotFile()));
  });

  it('reports failures, retries at the next interval and recovers; never overlaps writes', async () => {
    const g = new GameServer(world(), { singleplayer: false, snapInterval: 1 });
    let down = true;
    const lines: string[] = [];
    const store = memStore({ fail: () => down, delayMs: 20 });
    const s = new Saver(store, g, { analyticsEveryS: 300, log: l => lines.push(l) });
    s.due(); s.due(); s.due();                                      // overlapping requests while one is running
    await s.flush(2000);
    expect(store.maxConcurrent).toBe(1);
    expect(s.stats.skippedBusy).toBe(2);
    expect(s.stats.consecutiveFailures).toBeGreaterThanOrEqual(2);
    expect(s.stats.lastError).toContain('connection terminated');
    expect(s.stats.lastOkAt).toBeNull();
    expect(lines.some(l => l.includes('저장 실패'))).toBe(true);
    down = false;
    s.due(); await s.flush(2000);
    expect(s.stats.consecutiveFailures).toBe(0);
    expect(s.stats.lastOkAt).not.toBeNull();
    expect(lines.some(l => l.includes('저장 복구'))).toBe(true);
    // the data written after recovery is the current world
    expect(new GameServer(JSON.parse(store.world!), { singleplayer: false, snapInterval: 1 }).sim.serialize()).toBe(g.sim.serialize());
  });

  it('does not write once the storage is fenced (a newer world generation exists)', async () => {
    const g = new GameServer(world(), { singleplayer: false, snapInterval: 1 });
    const store = memStore();
    store.fenced = true;
    const s = new Saver(store, g, silent);
    s.due(); await s.flush(500);
    expect(store.writes).toBe(0);
    expect(s.stats.fenced).toBe(true);
  });

  it('a final save waits for the running one and then stores the current moment', async () => {
    const g = new GameServer(world(), { singleplayer: false, snapInterval: 1 });
    const store = memStore({ delayMs: 50 });
    const s = new Saver(store, g, silent);
    s.due();
    run(g, 5);
    expect(await s.flush(2000)).toBe(true);
    expect(store.maxConcurrent).toBe(1);
    const restored = new GameServer(JSON.parse(store.world!), { singleplayer: false, snapInterval: 1 });
    expect(restored.sim.serialize()).toBe(g.sim.serialize());
  });
});

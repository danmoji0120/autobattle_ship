import { describe, it, expect } from 'vitest';
import { GameServer } from '../src/server/core';
import { census, compareCensus, migrateContent } from '../src/world/migrate';
import { WorldSim } from '../src/world/sim';
import { integrationFixture, integrationRun, startIntegrationIndustry, startIntegrationProjects } from './support/integration';
import { makeC0World } from './support/oldSave';

describe('integrated P8, logistics and analytics', () => {
  it('runs actual P8 mining with a separate P8 hauler, sells and records real income without currency drift', () => {
    const f = integrationFixture();
    f.must(f.sim.command(f.p, { c: 'moveShip', ship: f.carrier.id, group: f.mine.id }));
    f.must(f.sim.command(f.p, { c: 'setOp', group: f.mine.id, op: { k: 'mine', field: 'kestrel', deliver: 'astra', sell: true, auto: false } }));
    let carried = false;
    for (let t = 0; t < 1500; t += .25) { f.server.step(.25); carried ||= Object.values(f.carrier.cargo).some(n => n > 0); }
    expect(carried).toBe(true); expect(f.co.stats.mined).toBeGreaterThan(0); expect(f.co.stats.earned).toBeGreaterThan(0);
    const report = f.server.analytics!.query('player', f.p, { hours: 24 });
    expect(report.totals.some(r => r.kind === 'market' && r.reason === 'sell' && r.amount > 0)).toBe(true);
    expect(f.server.analytics!.query('admin', '').health.reconciliation).toBeCloseTo(0, 5);
  });
  it('supplies real production and exports it with L-berth P8 hulls, preserving ownership and analytics', () => {
    const f = integrationFixture(872); startIntegrationIndustry(f); integrationRun(f.server, 600);
    expect(f.depot.storage[f.p].alloy).toBeGreaterThanOrEqual(42);
    const routes = Object.values(f.sim.st.logistics!);
    expect(routes.every(r => r.stats.delivered > 0 && r.stats.sold === 0 && r.owner === f.p)).toBe(true);
    expect(f.server.analytics!.query('player', f.p).totals.some(r => r.kind === 'produce' && r.item === 'alloy')).toBe(true);
    expect(f.server.analytics!.query('admin', '').health.reconciliation).toBeCloseTo(0, 5);
  });
  it('round-trips research, construction, P8 build, fitted ships and live route manifests without resubmission', () => {
    const f = integrationFixture(873); startIntegrationIndustry(f); startIntegrationProjects(f); integrationRun(f.server, 5);
    expect(f.co.research![0].started).toBe(true); expect(f.co.research![0].left).toBeGreaterThan(0);
    expect(f.factory.builds![0]).toMatchObject({ hull: 'patrol_pathfinder', started: true });
    expect(f.factory.modules.find(m => m.kind === 'warehouse')!.built).toBe(false);
    const file = f.server.snapshotFile(), restored = new GameServer(structuredClone(file), { singleplayer: false, snapInterval: 1 });
    expect(restored.sim.st.companies[f.p].research).toEqual(f.co.research);
    expect(restored.sim.st.stations[f.factory.id].builds).toEqual(f.factory.builds);
    expect(restored.sim.st.stations[f.factory.id].modules).toEqual(f.factory.modules);
    expect(restored.sim.st.logistics).toEqual(f.sim.st.logistics);
    expect(restored.sim.st.ships[f.carrier.id]).toEqual(f.carrier);
    expect(restored.analytics!.snapshot()).toEqual(file.analytics);
    integrationRun(restored, 40);
    expect(restored.sim.st.companies[f.p].research![0].left).toBeLessThan(f.co.research![0].left);
    expect(restored.sim.st.stations[f.factory.id].builds![0].left).toBeLessThan(f.factory.builds![0].left);
    expect(restored.analytics!.query('admin', '').health.reconciliation).toBeCloseTo(0, 5);
  });
  it('dry-runs a synthetic c0 copy without touching its source and conserves its migration census', () => {
    const { st } = makeC0World(874), before = JSON.stringify(st), copy = structuredClone(st), old = census(copy);
    const report = migrateContent(copy);
    expect(report.unmapped).toEqual([]); expect(compareCensus(old, census(copy))).toEqual([]);
    expect(JSON.stringify(st)).toBe(before); expect(st.contentV).toBeUndefined();
    const roundtrip = new WorldSim(JSON.parse(new WorldSim(copy, { migrateContent: false }).serialize()), { migrateContent: false });
    expect(compareCensus(census(copy), census(roundtrip.st))).toEqual([]);
    const p8 = new Set(['patrol_pathfinder', 'destroyer_lancet', 'miner_quarry', 'hauler_meridian', 'cruiser_vigil']);
    expect(Object.values(roundtrip.st.ships).every(s => !p8.has(s.hull ?? ''))).toBe(true);
  });
});

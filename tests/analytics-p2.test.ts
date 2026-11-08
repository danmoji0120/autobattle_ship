import { describe, it, expect } from 'vitest';
import { WorldSim } from '../src/world/sim';
import { Analytics } from '../src/server/analytics';
import { emit, emitMetric, metricBatch, observeWorld } from '../src/world/observe';

describe('analytics optimization retains actual data', () => {
  it('scalar fast path preserves every quantity and event count across snapshots and restart', () => {
    const sim = WorldSim.create(173), other = WorldSim.create(173);
    let fast = new Analytics(sim, undefined, { snapshotSeconds: 300 });
    const normal = new Analytics(other, undefined, { snapshotSeconds: 300 });
    const identity = { kind: 'market.net_supply', amount: 0, item: 'ore', reason: 'npc_economy', station: 'astra' };
    const budget = { kind: 'currency.create', reason: 'regional_budget', amount: 0, to: 'st:astra', station: 'astra' };
    for (let i = 1; i <= 1400; i++) {
      sim.st.time = other.st.time = i;
      sim.st.stations.astra.funds! += .125; other.st.stations.astra.funds! += .125;
      metricBatch(sim.st, () => { emitMetric(sim.st, identity, .375); emitMetric(sim.st, budget, .125); });
      emit(other.st, { ...identity, amount: .375 }); emit(other.st, { ...budget, amount: .125 }); fast.step(); normal.step();
      if (i === 651) fast = new Analytics(sim, fast.snapshot(), { snapshotSeconds: 300 });
    }
    expect(fast.snapshot()).toEqual(normal.snapshot());
    expect(fast.query('admin', '').totals.find(r => r.kind === identity.kind)).toMatchObject({ amount: 525, count: 1400 });
  });
  it('byte pressure compresses old frames before expiring their flow history', () => {
    const sim = WorldSim.create(92), a = new Analytics(sim, undefined, { snapshotSeconds: 300, maxBytes: 262144 });
    for (let i = 1; i <= 40; i++) { sim.st.time = i * 300; emit(sim.st, { kind: 'produce', amount: 2, company: 'test', item: 'ore' }); a.step(); }
    const saved = a.snapshot();
    expect(Buffer.byteLength(JSON.stringify(saved))).toBeLessThanOrEqual(262144);
    expect(saved.hourly.length + saved.daily.length).toBeGreaterThan(0);
    expect(a.query('admin', '', { hours: 24 }).totals.find(r => r.kind === 'produce')!.amount).toBe(80);
    expect(saved.truncatedBefore).toBeUndefined(); expect(saved.dropped).toBe(0);
  });
  it('fallback observers receive independent immutable scalar events', () => {
    const sim = WorldSim.create(13), events: number[] = []; const held: any[] = [];
    observeWorld(sim.st, e => { events.push(e.amount); held.push(e); });
    const identity = { kind: 'market.net_consumption', amount: 0, item: 'ore', station: 'astra' };
    metricBatch(sim.st, () => { emitMetric(sim.st, identity, 2); emitMetric(sim.st, identity, 3); });
    expect(events).toEqual([2, 3]); expect(held[0].amount).toBe(2); expect(identity.amount).toBe(0);
  });
});

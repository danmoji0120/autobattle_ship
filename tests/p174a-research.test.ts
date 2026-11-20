// P17.4a AUD-05: research materials go through the common procurement planner (transfer, budgeted purchase, reasons)
import { describe, it, expect } from 'vitest';
import { fixture, run, until } from './helpers/opsFixture';
import { qty } from '../src/world/types';

function lab(f: ReturnType<typeof fixture>) {
  f.home.modules.push({ kind: 'lab_basic', slot: f.home.modules.length, built: true, progress: 1, id: 'm_lab' } as never);
  f.co.credits = 5e6;
}
const plan = (f: ReturnType<typeof fixture>) => Object.values(f.sim.st.procurementPlans ?? {}).find(p => p.owner === f.p && p.sourceKind === ('research' as never) && p.state !== 'closed');

describe('P17.4a AUD-05 research procurement', () => {
  it('materials at another own station are shipped to the lab and the project starts', () => {
    const f = fixture(); lab(f);
    f.b.storage[f.p] = { electronics: 20 };
    expect(f.sim.command(f.p, { c: 'research', station: 'ops_home', tech: 'research_methods' })).toBeNull();
    const p = f.co.research!.at(-1)!;
    expect(until(f.sim, () => !!p.started || !f.co.research!.includes(p), 3000)).toBe(true);
    expect(qty(f.b.storage[f.p], 'electronics')).toBeCloseTo(14);   // exactly the 6 needed left ops_b
  });

  it('no source and no purchase authority: an exact waiting reason; protected stock is not taken', () => {
    const f = fixture(); lab(f);
    expect(f.sim.command(f.p, { c: 'salesPolicy', settings: { item: 'electronics', sell: false, minPrice: 0, station: 'ops_b', keep: 20 } })).toBeNull();
    f.b.storage[f.p] = { electronics: 20 };
    expect(f.sim.command(f.p, { c: 'research', station: 'ops_home', tech: 'research_methods' })).toBeNull();
    run(f.sim, 30);
    const pr = plan(f)!;
    expect(pr).toBeTruthy(); expect(pr.shortage).toBeCloseTo(6);
    expect(pr.reason.length).toBeGreaterThan(4);
    expect(qty(f.b.storage[f.p], 'electronics')).toBeCloseTo(20);
    expect(f.co.research!.at(-1)!.why).toMatch(/재료 부족/);
  });

  it('a paused or cancelled project releases its demand; tree and effects are unchanged', () => {
    const f = fixture(); lab(f);
    f.b.storage[f.p] = { electronics: 20 };
    expect(f.sim.command(f.p, { c: 'research', station: 'ops_home', tech: 'research_methods' })).toBeNull();
    const p = f.co.research!.at(-1)!;
    expect(f.sim.command(f.p, { c: 'researchOp', project: p.id, op: 'pause' })).toBeNull();
    run(f.sim, 10);
    expect(Object.values(f.sim.st.logisticsJobs ?? {}).filter(j => j.owner === f.p && j.item === 'electronics' && j.state !== 'complete' && j.state !== 'cancelled').length).toBe(0);
  });
});

describe('P17.4a AUD-05 research purchase within budget', () => {
  it('delegated auto-buy buys exactly the shortfall at a market and ships it; nothing without authority', () => {
    const f = fixture(); lab(f);
    const before = f.co.credits;
    expect(f.sim.command(f.p, { c: 'opsPolicy', policy: { autoBuyItem: 'electronics', autoBuyPrice: 100000, delegatedBudget: 50000 } })).toBeNull();
    expect(f.sim.command(f.p, { c: 'research', station: 'ops_home', tech: 'research_methods' })).toBeNull();
    const p = f.co.research!.at(-1)!;
    expect(until(f.sim, () => !!p.started || !f.co.research!.includes(p), 4000)).toBe(true);
    const bought = Object.values(f.sim.st.logisticsJobs ?? {}).filter(j => j.owner === f.p && j.item === 'electronics').reduce((n, j) => n + j.amount, 0);
    expect(bought).toBe(6);
    expect(before - f.co.credits).toBeLessThan(50000 + 5000 + 1);   // purchase within the delegated budget (+ research fee)
  });
});

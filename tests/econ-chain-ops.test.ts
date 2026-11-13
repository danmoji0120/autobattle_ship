// Company operations under value-chain pricing (econChain.ts): approved prices, budgets, policy limits
// and recurring-trade economics must hold when market prices move with the new rule.
import { describe, expect, it } from 'vitest';
import { qty } from '../src/world/types';
import { migrateEconChain } from '../src/world/econMigrate';
import { tradeHaulCost } from '../src/world/operations';
import { fixture, run, until, works, approvals, goal } from './helpers/opsFixture';

const chain = (f: ReturnType<typeof fixture>) => { const r = migrateEconChain(f.sim.st); expect(r.ok).toBe(true); return r; };
const purchases = (f: ReturnType<typeof fixture>) => (f.co.ops?.ledger ?? []).reduce((n, h) => n + (h.exp.purchase ?? 0), 0);

describe('auto-buy after a price rise', () => {
  it('a goal approved at the old unit price stops buying and asks again instead of paying the new price', () => {
    const f = fixture(1301);
    const old = f.sim.price(f.a, 'electronics', 'buy'), cap = Math.ceil(old * 1.15);
    // the economy changes; the company's goal still carries the unit price it approved before
    chain(f);
    const now = f.sim.price(f.a, 'electronics', 'buy'); expect(now).toBeGreaterThan(cap);
    const spent0 = purchases(f);
    expect(f.sim.command(f.p, { c: 'workCreate', goal: { k: 'stockpile', station: f.home.id, item: 'electronics', target: 60, maintain: false, buy: true, produce: false }, budget: 1e6, maxPrice: cap })).toBeNull();
    const g = goal(f.sim, f.p);
    run(f.sim, 120);
    expect(purchases(f)).toBe(spent0);                     // nothing bought above the approved unit price
    expect(g.budget!.spent).toBeLessThanOrEqual(g.budget!.limit);
    const ap = approvals(f.sim, f.p).find(a => a.work === g.id); expect(ap?.kind).toBe('budget');
    expect(ap!.reason + ap!.situation).toMatch(/단가|비쌉니다/);
  }, 30000);
  it('total budget, hourly limit and minimum credits still cap spending at the new prices', () => {
    const f = fixture(1302); chain(f);
    expect(f.sim.command(f.p, { c: 'opsPolicy', policy: { autonomy: 'auto', minCredits: f.co.credits - 40_000, hourlyLimit: 30_000 } })).toBeNull();
    expect(f.sim.command(f.p, { c: 'workCreate', goal: { k: 'stockpile', station: f.home.id, item: 'machinery', target: 2000, maintain: false, buy: true, produce: false }, budget: 25_000 })).toBeNull();
    const g = goal(f.sim, f.p), c0 = f.co.credits;
    run(f.sim, 900);
    expect(g.budget!.spent).toBeLessThanOrEqual(25_000 + 1e-6);
    expect(purchases(f)).toBeLessThanOrEqual(25_000 + 1e-6);
    expect(c0 - f.co.credits).toBeLessThan(40_000);
    expect(qty(f.home.storage[f.p], 'machinery')).toBeLessThan(2000);
  }, 30000);
});

describe('recurring trade under value-chain prices', () => {
  it('counts an estimated hauling cost in its go/no-go and in each cycle profit; legacy worlds count none', () => {
    const f0 = fixture(1303, 60), ship = f0.ships[0];
    expect(tradeHaulCost(f0.sim, ship, 2, 400)).toBe(0);
    const f = fixture(1303, 60); chain(f);
    const haul = tradeHaulCost(f.sim, f.ships[0], 2, 400); expect(haul).toBeGreaterThan(0);
    // a destination short of machinery: the route pays even after hauling
    const d = f.sim.st.stations.cinderco; d.market!.machinery.stock = d.market!.machinery.target * 0.2;
    const buy = f.sim.price(f.a, 'machinery', 'buy');
    expect(f.sim.command(f.p, { c: 'workCreate', goal: { k: 'trade', item: 'machinery', from: 'astra', to: 'cinderco', amount: 100, maxBuy: buy * 2, minSell: 0, minProfit: 0, cycles: 1 }, budget: 1e6 })).toBeNull();
    const g = goal(f.sim, f.p);
    expect(g.rt?.phase).toBe('move'); expect(g.rt!.cycleHaul).toBeGreaterThan(0);
    expect(until(f.sim, () => g.state === 'done' || (g.rt?.cycles ?? 0) >= 1, 8000)).toBe(true);
    const sold = Object.values(f.sim.st.logisticsJobs!).filter(j => works(f.sim, f.p).some(k => k.parent === g.id && k.ref.job === j.id)).reduce((n, j) => n + j.earned, 0);
    expect(g.rt!.profit).toBeCloseTo(sold - g.cost - g.rt!.cycleHaul!, 3);
    expect(g.log.map(l => l.text).join('\n')).toContain('운송비 추정');
  }, 60000);
  it('a price rise above maxBuy makes it wait (no unconditional purchase); same-market trade is refused', () => {
    const f = fixture(1304, 60); chain(f);
    const buy = f.sim.price(f.a, 'alloy', 'buy');
    expect(f.sim.command(f.p, { c: 'workCreate', goal: { k: 'trade', item: 'alloy', from: 'astra', to: 'drakeout', amount: 200, maxBuy: buy * 0.9, minSell: 0, minProfit: 0, cycles: 0 }, budget: 1e6 })).toBeNull();
    const g = goal(f.sim, f.p); run(f.sim, 120);
    expect(g.cost).toBe(0); expect(g.reason).toContain('상한');
    expect(f.sim.command(f.p, { c: 'workCreate', goal: { k: 'trade', item: 'alloy', from: 'astra', to: 'astra', amount: 10, maxBuy: 1e6, minSell: 0, minProfit: 0, cycles: 0 } })).toMatch(/서로 다른 시장/);
  }, 30000);
});

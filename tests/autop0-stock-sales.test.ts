// AUTO-P0: minimum stock, excess-stock sales and the common protection rule shared by every automatic sale path.
import { describe, expect, it } from 'vitest';
import { WorldSim } from '../src/world/sim';
import { STANDARD_WORLD } from '../src/world/worldPreset';
import { addc, qty } from '../src/world/types';
import { sellableStock, stockFloor, createGoal } from '../src/world/operations';
import { planSales } from '../src/world/procurement';

const run = (sim: WorldSim, s: number) => { for (let i = 0; i < s; i++) sim.update(1); };
/** a miner start at anvil; the hauler is moved to its own idle group (a pool hauler) unless `keepHauler` */
function start(keepHauler = false) {
  const sim = WorldSim.create(21, { ...STANDARD_WORLD });
  const me = sim.addPlayer('재고 정책', 'miner'), co = sim.st.companies[me];
  const port = sim.st.stations.p9_anvil_port;
  const g = Object.values(sim.st.groups).find(x => x.owner === me)!;
  const hauler = sim.subtreeShips(g).find(s => s.classId === 'hauler')!;
  if (!keepHauler) expect(sim.command(me, { c: 'newGroup', name: '판매 수송반', ships: [hauler.id] })).toBeNull();
  return { sim, me, co, port, g, hauler, store: () => sim.storage(port, me) };
}
const totalOf = (sim: WorldSim, me: string, item: string) => {
  let n = 0;
  for (const st of Object.values(sim.st.stations)) n += qty(st.storage[me], item);
  for (const s of Object.values(sim.st.ships)) if (s.owner === me) n += qty(s.cargo, item);
  return n;
};
const soldOf = (sim: WorldSim, me: string, item: string) => Object.values(sim.st.logisticsJobs ?? {}).filter(j => j.owner === me && j.item === item && j.kind === 'sell').reduce((n, j) => n + j.delivered, 0);

describe('AUTO-P0 common stock floor', () => {
  it('the floor adds the minimum stock and stockpile goals; only the rest is sellable', () => {
    const { sim, me, port, store } = start();
    addc(store(), 'ore', 900);
    expect(sim.command(me, { c: 'salesPolicy', settings: { item: 'ore', sell: false, station: port.id, keep: 500 } })).toBeNull();
    expect(stockFloor(sim, me, port, 'ore')).toBe(500);
    expect(sellableStock(sim, me, port, 'ore')).toBe(400);
    expect(createGoal(sim, me, { k: 'stockpile', station: port.id, item: 'ore', target: 300, maintain: true, buy: false, produce: false })).toBeNull();
    expect(stockFloor(sim, me, port, 'ore')).toBe(800);
    expect(sellableStock(sim, me, port, 'ore')).toBe(100);
    // keep 0 clears it
    expect(sim.command(me, { c: 'salesPolicy', settings: { item: 'ore', sell: false, station: port.id, keep: 0 } })).toBeNull();
    expect(stockFloor(sim, me, port, 'ore')).toBe(300);
  });

  it('a miner selling at the dock first fills the store up to the floor, then sells the rest', () => {
    const { sim, me, co, port, store, g } = start();
    expect(sim.command(me, { c: 'salesPolicy', settings: { item: 'ore', sell: false, station: port.id, keep: 500 } })).toBeNull();
    expect(sim.command(me, { c: 'setOp', group: g.id, op: { k: 'mine', field: 'p9_anvil_ore', deliver: port.id, sell: true } })).toBeNull();
    run(sim, 1800);
    expect(co.stats.mined).toBeGreaterThan(600);
    expect(qty(store(), 'ore')).toBeCloseTo(500, 3);   // kept exactly, never sold below it
    expect(co.ops?.ledger.some(b => (b.sales?.ore ?? 0) > 0)).toBe(true);   // the excess was sold
  });

  it('a condition sale and a manual pool sale leave the floor in the store', () => {
    const { sim, me, port, store } = start();
    addc(store(), 'ore', 700);
    expect(sim.command(me, { c: 'salesPolicy', settings: { item: 'ore', sell: false, station: port.id, keep: 500 } })).toBeNull();
    expect(createGoal(sim, me, { k: 'condition', station: port.id, item: 'ore', side: 'sell', price: 0.01, amount: 1000, repeat: false })).toBeNull();
    expect(qty(store(), 'ore')).toBeCloseTo(500, 6);
    addc(store(), 'ore', 100);
    expect(sim.command(me, { c: 'poolCreate', request: { from: port.id, to: 'p9_ceres_works', item: 'ore', kind: 'sell', amount: 600, priority: 5, repeat: false } })).toBeNull();
    run(sim, 30);
    const j = Object.values(sim.st.logisticsJobs!).find(x => x.owner === me && x.kind === 'sell')!;
    expect(j.reserved + j.carried + j.delivered).toBeLessThanOrEqual(100 + 1e-6);
    expect(qty(store(), 'ore')).toBeGreaterThanOrEqual(500 - 1e-6);
  });
});

describe('AUTO-P0 excess-stock sales', () => {
  it('silicate nobody at anvil buys is shipped to another market and sold; goods are conserved', () => {
    const { sim, me, co, store } = start();
    addc(store(), 'silicate', 900);
    const c0 = co.credits;
    expect(sim.command(me, { c: 'salesPolicy', settings: { item: 'silicate', sell: true, minPrice: 5 } })).toBeNull();
    run(sim, 20);
    const j = Object.values(sim.st.logisticsJobs!).find(x => x.owner === me && x.sale)!;
    expect(j).toBeTruthy();
    expect(sim.st.stations[j.to].market?.silicate).toBeTruthy();
    run(sim, 3000);
    const sold = soldOf(sim, me, 'silicate');
    expect(sold).toBeGreaterThan(400);
    expect(sold + totalOf(sim, me, 'silicate')).toBeCloseTo(900, 3);   // nothing created or lost
    expect(co.credits).toBeGreaterThan(c0);
    expect(co.ops?.ledger.reduce((n, b) => n + (b.sales?.silicate ?? 0), 0)).toBeGreaterThan(0);
  });

  it('a station whose own market pays the floor price sells the excess there, keeping the minimum', () => {
    const { sim, me, port, store } = start();
    addc(store(), 'ore', 800);
    expect(sim.command(me, { c: 'salesPolicy', settings: { item: 'ore', sell: true, minPrice: 1, station: port.id, keep: 500 } })).toBeNull();
    planSales(sim);
    expect(qty(store(), 'ore')).toBeCloseTo(500, 6);
    expect(Object.values(sim.st.logisticsJobs ?? {}).filter(j => j.owner === me && j.sale)).toHaveLength(0);
  });

  it('no pool hauler (the hauler stays in the mining fleet): no shipment, the stock stays, the reason is shown', () => {
    const { sim, me, co, store, g, port } = start(true);
    addc(store(), 'silicate', 600);
    expect(sim.command(me, { c: 'setOp', group: g.id, op: { k: 'mine', field: 'p9_anvil_ore', deliver: port.id, sell: true } })).toBeNull();
    expect(sim.command(me, { c: 'salesPolicy', settings: { item: 'silicate', sell: true, minPrice: 5 } })).toBeNull();
    run(sim, 60);
    expect(Object.values(sim.st.logisticsJobs ?? {}).filter(j => j.owner === me && j.sale)).toHaveLength(0);
    expect(qty(store(), 'silicate')).toBe(600);
    expect(co.procurement!.salesStatus!.silicate.reason).toMatch(/공용 수송선 없음/);
  });

  it('every market closed: the stock is preserved and retried; a stuck shipment moves on to another market', () => {
    const { sim, me, co, store } = start();
    addc(store(), 'silicate', 600);
    const markets = Object.values(sim.st.stations).filter(s => s.market?.silicate);
    const saved = markets.map(s => [s, s.market!.silicate] as const);
    for (const s of markets) delete s.market!.silicate;
    expect(sim.command(me, { c: 'salesPolicy', settings: { item: 'silicate', sell: true, minPrice: 5 } })).toBeNull();
    run(sim, 60);
    expect(qty(store(), 'silicate')).toBe(600);
    expect(co.procurement!.salesStatus!.silicate.reason).toMatch(/매입 시장 없음/);
    // markets reopen: a shipment goes out; its market's budget is then emptied before arrival
    for (const [s, m] of saved) s.market!.silicate = m;
    run(sim, 20);
    const j = Object.values(sim.st.logisticsJobs!).find(x => x.owner === me && x.sale)!;
    // the chosen market stops buying silicate before the hauler arrives: the shipment waits with its cargo, then moves on
    const first = j.to; delete sim.st.stations[first].market!.silicate;
    for (let i = 0; i < 2400 && j.to === first; i++) sim.update(1);
    expect(j.to).not.toBe(first);
    expect(j.carried).toBeGreaterThan(0);
    run(sim, 2400);
    expect(soldOf(sim, me, 'silicate') + totalOf(sim, me, 'silicate')).toBeCloseTo(600, 3);
    expect(j.delivered).toBeGreaterThan(0);
  });

  it('a company-wide stockpile goal caps what is sold, and turning the policy off stops queued shipments', () => {
    const { sim, me, co, store } = start(true);
    addc(store(), 'silicate', 500);
    expect(createGoal(sim, me, { k: 'stockpile', station: 'p9_anvil_port', item: 'silicate', target: 450, maintain: true, buy: false, produce: false, scope: 'company' })).toBeNull();
    // the hauler joins the pool only now, so nothing moved before the goal existed
    const h = sim.subtreeShips(Object.values(sim.st.groups).find(x => x.owner === me)!).find(s => s.classId === 'hauler')!;
    expect(sim.command(me, { c: 'newGroup', name: '판매 수송반', ships: [h.id] })).toBeNull();
    expect(sim.command(me, { c: 'salesPolicy', settings: { item: 'silicate', sell: true, minPrice: 5 } })).toBeNull();
    run(sim, 700);   // a part load waits up to 10 minutes
    const jobs = Object.values(sim.st.logisticsJobs ?? {}).filter(j => j.owner === me && j.sale);
    expect(jobs.reduce((n, j) => n + j.amount, 0)).toBeLessThanOrEqual(50);
    // more stock: a full load is planned at once; turning the policy off cancels it before it is loaded
    addc(store(), 'silicate', 900);
    planSales(sim);
    const queued = Object.values(sim.st.logisticsJobs ?? {}).filter(j => j.owner === me && j.sale && j.state === 'queued');
    expect(queued.length).toBeGreaterThan(0);
    expect(sim.command(me, { c: 'salesPolicy', settings: { item: 'silicate', sell: false } })).toBeNull();
    expect(co.procurement!.sales!.silicate).toBeUndefined();
    for (const j of queued) expect(j.state).toBe('cancelled');
    expect(totalOf(sim, me, 'silicate') + soldOf(sim, me, 'silicate')).toBeCloseTo(1400, 3);
  });
});

describe('AUTO-P0 regression: the recurring trade goal quotes what the walked purchase really costs', () => {
  it('quote = paid, so authorisation and budget match the money spent', async () => {
    const { buyCost } = await import('../src/world/market');
    const sim = WorldSim.create(21, { ...STANDARD_WORLD });
    const me = sim.addPlayer('반복 무역', 'hauler'), co = sim.st.companies[me];
    const m = sim.st.stations.astra.market!.alloy;
    const expected = buyCost(m, 100, true), flat = 100 * sim.price(sim.st.stations.astra, 'alloy', 'buy');
    expect(expected).toBeGreaterThan(flat);   // the old quote (first unit's price × amount) under-stated it
    const { opsOf } = await import('../src/world/operations');
    opsOf(co).policy.maxRisk = 100;   // the drakeout route is 'risky' (53): allowed for this check
    const c0 = co.credits;
    expect(sim.command(me, { c: 'workCreate', goal: { k: 'trade', item: 'alloy', from: 'astra', to: 'drakeout', amount: 100, maxBuy: 1000, minSell: 0, minProfit: 0, cycles: 1 }, budget: 100000 })).toBeNull();
    const w = Object.values(sim.st.works!).find(x => x.owner === me && x.goal?.k === 'trade')!;
    expect(w.rt!.cycleCost).toBeCloseTo(expected, 3);
    expect(c0 - co.credits).toBeCloseTo(expected, 3);
    expect(w.budget!.spent).toBeCloseTo(expected, 3);
    // a budget between the old flat quote and the real cost: the goal asks for approval instead of overspending
    const sim2 = WorldSim.create(21, { ...STANDARD_WORLD });
    const me2 = sim2.addPlayer('반복 무역2', 'hauler'), co2 = sim2.st.companies[me2]; opsOf(co2).policy.maxRisk = 100;
    const c2 = co2.credits;
    expect(sim2.command(me2, { c: 'workCreate', goal: { k: 'trade', item: 'alloy', from: 'astra', to: 'drakeout', amount: 100, maxBuy: 1000, minSell: 0, minProfit: 0, cycles: 1 }, budget: Math.round((flat + expected) / 2) })).toBeNull();
    const w2 = Object.values(sim2.st.works!).find(x => x.owner === me2 && x.goal?.k === 'trade')!;
    expect(co2.credits).toBe(c2);
    expect(w2.reason).toMatch(/결재/);
  });
});

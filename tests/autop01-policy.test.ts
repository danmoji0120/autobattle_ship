// AUTO-P0.1: one stock-protection and price policy over every automatic sale path.
import { describe, expect, it } from 'vitest';
import { WorldSim } from '../src/world/sim';
import { STANDARD_WORLD } from '../src/world/worldPreset';
import { addc, qty, type Station } from '../src/world/types';
import { companyHolding, companySaleCap, createGoal, reserveLevel, sellableStock, stockFloor } from '../src/world/operations';
import { planSales, saleQuote } from '../src/world/procurement';
import { priceOf } from '../src/world/market';

const run = (sim: WorldSim, s: number, each?: () => void) => { for (let i = 0; i < s; i++) { sim.update(1); each?.(); } };
function start(keepHauler = false) {
  const sim = WorldSim.create(21, { ...STANDARD_WORLD });
  const me = sim.addPlayer('정책 일관성', 'miner'), co = sim.st.companies[me];
  const port = sim.st.stations.p9_anvil_port;
  const g = Object.values(sim.st.groups).find(x => x.owner === me)!;
  const hauler = sim.subtreeShips(g).find(s => s.classId === 'hauler')!;
  if (!keepHauler) expect(sim.command(me, { c: 'newGroup', name: '판매 수송반', ships: [hauler.id] })).toBeNull();
  return { sim, me, co, port, g, hauler };
}
const sold = (co: { ops?: { ledger: { sales?: Record<string, number> }[] } }, item: string) => (co.ops?.ledger ?? []).reduce((n, b) => n + (b.sales?.[item] ?? 0), 0);
const allOf = (sim: WorldSim, me: string, item: string) => {
  let n = 0;
  for (const st of Object.values(sim.st.stations)) n += qty(st.storage[me], item);
  for (const s of Object.values(sim.st.ships)) if (s.owner === me) n += qty(s.cargo, item);
  return n;
};
const saleOut = (sim: WorldSim, me: string, item: string) => Object.values(sim.st.logisticsJobs ?? {}).filter(j => j.owner === me && j.item === item && j.kind === 'sell').reduce((n, j) => n + j.delivered, 0);

describe('AUTO-P0.1 company-wide reserve on every automatic sale path', () => {
  it('a 500 company target over several stores and ship holds: mining direct sales and pool sales never cut into it', () => {
    const { sim, me, co, port, g } = start();
    const other = Object.values(sim.st.stations).filter(s => s.public && s.id !== port.id && s.market?.ore).sort((a, b) => a.id.localeCompare(b.id))[0];
    addc(sim.storage(port, me), 'ore', 150); addc(sim.storage(other, me), 'ore', 250);   // 400 spread, under the target
    expect(createGoal(sim, me, { k: 'stockpile', station: port.id, item: 'ore', target: 500, maintain: true, buy: false, produce: false, scope: 'company' })).toBeNull();
    expect(sim.command(me, { c: 'salesPolicy', settings: { item: 'ore', sell: true, minPrice: 0 } })).toBeNull();
    expect(sim.command(me, { c: 'setOp', group: g.id, op: { k: 'mine', field: 'p9_anvil_ore', deliver: port.id, sell: true } })).toBeNull();
    let peak = companyHolding(sim, me, 'ore'), worst = Infinity;
    run(sim, 2400, () => { const h = companyHolding(sim, me, 'ore'); peak = Math.max(peak, h); worst = Math.min(worst, h - Math.min(500, peak)); });
    expect(co.stats.mined).toBeGreaterThan(600);
    expect(worst).toBeGreaterThanOrEqual(-1e-6);                 // never below min(500, the most it has had)
    expect(companyHolding(sim, me, 'ore')).toBeGreaterThanOrEqual(500 - 1e-6);
    expect(sold(co, 'ore')).toBeGreaterThan(0);                  // the excess over 500 was sold
    expect(companySaleCap(sim, me, 'ore')).toBeLessThan(400);   // and the excess did not pile up
  });

  it('the units being unloaded count toward the target: 300 stored + 300 unloaded sells exactly 100', () => {
    const { sim, me, co, port, g } = start(true);
    addc(sim.storage(port, me), 'ore', 300);
    expect(createGoal(sim, me, { k: 'stockpile', station: port.id, item: 'ore', target: 500, maintain: true, buy: false, produce: false, scope: 'company' })).toBeNull();
    const miner = sim.subtreeShips(g).find(s => s.classId === 'miner')!;
    expect(companySaleCap(sim, me, 'ore', 300)).toBe(100);
    for (const k of Object.keys(miner.cargo)) delete miner.cargo[k];
    addc(miner.cargo, 'ore', 300);
    (sim as any).dockShip(miner, port);
    const c0 = co.credits;
    (sim as any).unload(miner, port, true);
    expect(qty(sim.storage(port, me), 'ore')).toBeCloseTo(500, 6);
    expect(qty(miner.cargo, 'ore')).toBeCloseTo(0, 6);
    expect(co.credits).toBeGreaterThan(c0);
  });

  it('several company targets for one item share one stock (the largest applies, not their sum)', () => {
    const { sim, me, port } = start(true);
    addc(sim.storage(port, me), 'ore', 1000);
    expect(createGoal(sim, me, { k: 'stockpile', station: port.id, item: 'ore', target: 500, maintain: true, buy: false, produce: false, scope: 'company' })).toBeNull();
    // a second goal can no longer be created, but an older save may hold two: they share one stock
    const w = Object.values(sim.st.works!).find(x => x.owner === me && x.goal?.k === 'stockpile')!;
    const twin = structuredClone(w); twin.id = `${w.id}_twin`; (twin.goal as { target: number }).target = 300; sim.st.works![twin.id] = twin;
    expect(companySaleCap(sim, me, 'ore')).toBe(500);
  });
});

describe('AUTO-P0.1 minimum sale price on every automatic sale path', () => {
  it('a mining direct sale stops at the minimum net price (after tax, walk and market budget); the rest is stored', () => {
    const { sim, me, co, port } = start(true);
    const m = port.market!.ore, net = () => sim.price(port, 'ore', 'sell') * (1 - (port.tax ?? 0));
    const minPrice = priceOf({ ...m, stock: m.stock + 1000 }, 'sell', true) * (1 - (port.tax ?? 0));   // the price after ~1000 sold
    expect(sim.command(me, { c: 'salesPolicy', settings: { item: 'ore', sell: true, minPrice } })).toBeNull();
    const miner = Object.values(sim.st.ships).find(s => s.owner === me && s.classId === 'miner')!;
    for (const k of Object.keys(miner.cargo)) delete miner.cargo[k];
    addc(miner.cargo, 'ore', 2000);
    const q = saleQuote(sim, port, 'ore', 2000, minPrice);
    expect(q.sold).toBeGreaterThan(0); expect(q.sold).toBeLessThan(2000);
    const c0 = co.credits, stock0 = m.stock;
    (sim as any).dockShip(miner, port);
    (sim as any).unload(miner, port, true);
    expect(m.stock - stock0).toBeCloseTo(q.sold, 6);                     // exactly what the price floor allows
    expect(co.credits - c0).toBeCloseTo(q.value, 3);
    expect((co.credits - c0) / q.sold).toBeGreaterThanOrEqual(minPrice - 1e-9);
    expect(qty(sim.storage(port, me), 'ore') + qty(miner.cargo, 'ore')).toBeCloseTo(2000 - q.sold, 6);   // kept (store, or aboard when full), not dumped
    expect(net()).toBeLessThan(minPrice + 1e-9);
  });

  it('below the minimum price nothing is sold automatically; a manual sale by the player is still free', () => {
    const { sim, me, co, port } = start(true);
    expect(sim.command(me, { c: 'salesPolicy', settings: { item: 'ore', sell: true, minPrice: 1e6 } })).toBeNull();
    const miner = Object.values(sim.st.ships).find(s => s.owner === me && s.classId === 'miner')!;
    for (const k of Object.keys(miner.cargo)) delete miner.cargo[k];
    addc(miner.cargo, 'ore', 200);
    const c0 = co.credits;
    (sim as any).dockShip(miner, port);
    (sim as any).unload(miner, port, true);
    expect(co.credits).toBe(c0);
    expect(qty(sim.storage(port, me), 'ore')).toBeCloseTo(200, 6);
    planSales(sim);
    expect(co.credits).toBe(c0);
    expect(Object.values(sim.st.logisticsJobs ?? {}).filter(j => j.owner === me && j.sale)).toHaveLength(0);
    expect(sim.command(me, { c: 'sell', station: port.id, res: 'ore', amount: 200 })).toBeNull();
    expect(co.credits).toBeGreaterThan(c0);
    expect(qty(sim.storage(port, me), 'ore')).toBeLessThan(1e-6);
  });

  it('a sale shipment whose market is under the minimum price on arrival keeps its cargo and sells only when the price allows', () => {
    const { sim, me, co, port } = start();
    addc(sim.storage(port, me), 'silicate', 600);
    expect(sim.command(me, { c: 'salesPolicy', settings: { item: 'silicate', sell: true, minPrice: 5 } })).toBeNull();
    run(sim, 20);
    const j = Object.values(sim.st.logisticsJobs!).find(x => x.owner === me && x.sale)!;
    const target = sim.st.stations[j.to];
    // the player raises the floor above every market before the hauler arrives
    expect(sim.command(me, { c: 'salesPolicy', settings: { item: 'silicate', sell: true, minPrice: 1e4 } })).toBeNull();
    const before = target.market!.silicate.stock;
    for (let i = 0; i < 3000 && j.code !== 'price'; i++) sim.update(1);
    expect(j.code).toBe('price');
    expect(j.carried).toBeGreaterThan(0);
    expect(j.delivered).toBe(0);
    expect(target.market!.silicate.stock).toBe(before);   // nothing sold under the floor
    // the floor comes back down: the waiting shipment sells
    expect(sim.command(me, { c: 'salesPolicy', settings: { item: 'silicate', sell: true, minPrice: 5 } })).toBeNull();
    run(sim, 2400);
    expect(j.delivered).toBeGreaterThan(0);
    expect(j.earned / j.delivered).toBeGreaterThanOrEqual(5 - 1e-6);
    expect(saleOut(sim, me, 'silicate') + allOf(sim, me, 'silicate')).toBeCloseTo(600, 3);
    expect(co.credits).toBeGreaterThan(0);
  });
});

describe('AUTO-P0.1 reserve semantics', () => {
  function ownStation(sim: WorldSim, me: string, near: Station): Station {
    const st: Station = { ...structuredClone(near), id: 'p01_own', name: '자사 정련소', public: false, owner: me, pos: { ...near.pos, x: near.pos.x + 600 }, market: null, funds: undefined, fundsMax: undefined, shipStock: undefined, storage: { [me]: {} }, builds: [], orders: [], jobs: [], listings: [], modules: ['core', 'power', 'refinery', 'warehouse'].map((kind, slot) => ({ kind, slot, built: true, progress: 1 })) };
    sim.st.stations[st.id] = st; return st;
  }
  it('minimum stock and a station goal are one reserve; a production reservation is added on top', () => {
    const { sim, me, port } = start();
    const own = ownStation(sim, me, port);
    addc(own.storage[me], 'ore', 1500);
    expect(sim.command(me, { c: 'salesPolicy', settings: { item: 'ore', sell: false, station: own.id, keep: 300 } })).toBeNull();
    expect(createGoal(sim, me, { k: 'stockpile', station: own.id, item: 'ore', target: 500, maintain: true, buy: false, produce: false })).toBeNull();
    expect(reserveLevel(sim, me, own, 'ore')).toBe(500);
    expect(sim.command(me, { c: 'prodOrder', station: own.id, recipe: 'metal', mode: 'count', n: 10 })).toBeNull();
    const hold = stockFloor(sim, me, own, 'ore') - 500;
    expect(hold).toBeGreaterThan(0);                                // the order's ore is reserved separately
    expect(hold).toBeLessThanOrEqual(400 + 1e-6);
    expect(sellableStock(sim, me, own, 'ore')).toBeCloseTo(qty(own.storage[me], 'ore') - 500 - hold, 6);
    // the sale planner ships only that excess
    expect(sim.command(me, { c: 'salesPolicy', settings: { item: 'ore', sell: true, minPrice: 0 } })).toBeNull();
    (sim.st as { time: number }).time += 700; planSales(sim);
    const out = Object.values(sim.st.logisticsJobs ?? {}).filter(j => j.owner === me && j.sale).reduce((n, j) => n + j.amount, 0);
    expect(out).toBeGreaterThan(0);
    expect(out).toBeLessThanOrEqual(qty(own.storage[me], 'ore') + out - 500 - hold + 1e-6);
  });

  it('repeated transport, save and restore: the reserve and the goods are preserved', () => {
    const { sim, me, co, port, g } = start();
    addc(sim.storage(port, me), 'ore', 900); addc(sim.storage(port, me), 'silicate', 900);
    expect(sim.command(me, { c: 'salesPolicy', settings: { item: 'ore', sell: true, minPrice: 0, station: port.id, keep: 500 } })).toBeNull();
    expect(createGoal(sim, me, { k: 'stockpile', station: port.id, item: 'ore', target: 500, maintain: true, buy: false, produce: false })).toBeNull();
    expect(sim.command(me, { c: 'salesPolicy', settings: { item: 'silicate', sell: true, minPrice: 5 } })).toBeNull();
    expect(sim.command(me, { c: 'setOp', group: g.id, op: { k: 'mine', field: 'p9_anvil_ore', deliver: port.id, sell: true } })).toBeNull();
    run(sim, 900);
    const live = Object.values(sim.st.logisticsJobs ?? {}).filter(j => j.owner === me && j.sale && j.state !== 'complete');
    const before = { sil: saleOut(sim, me, 'silicate') + allOf(sim, me, 'silicate') };
    const saved = new WorldSim(JSON.parse(sim.serialize()), { migrateContent: false });
    const me2 = me, co2 = saved.st.companies[me2], port2 = saved.st.stations[port.id];
    expect(co2.procurement!.sales!.silicate.minPrice).toBe(5);
    expect(co2.procurement!.protectedStock[port.id].ore).toBe(500);
    expect(Object.values(saved.st.logisticsJobs ?? {}).filter(j => j.owner === me2 && j.sale && j.state !== 'complete')).toHaveLength(live.length);
    expect(saleOut(saved, me2, 'silicate') + allOf(saved, me2, 'silicate')).toBeCloseTo(before.sil, 6);
    let low = Infinity;
    for (let i = 0; i < 2400; i++) { saved.update(1); low = Math.min(low, qty(port2.storage[me2], 'ore')); }
    expect(low).toBeGreaterThanOrEqual(500 - 1e-6);                 // one 500 reserve, never sold under
    expect(saleOut(saved, me2, 'silicate') + allOf(saved, me2, 'silicate')).toBeCloseTo(900, 3);
    expect(saleOut(saved, me2, 'silicate')).toBeGreaterThanOrEqual(saleOut(sim, me, 'silicate'));
    expect(saleOut(saved, me2, 'silicate')).toBeGreaterThan(400);
    expect(co2.credits).toBeGreaterThan(co.credits - 1e5);
  });
});

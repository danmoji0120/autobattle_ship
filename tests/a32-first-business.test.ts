// A-3.2a: the first business of a hauler or miner start — the guide's estimates match what the server settles,
// no money or cargo is created, the round-trip market exploit is closed, the milestone and the guide status.
import { describe, expect, it } from 'vitest';
import { WorldSim } from '../src/world/sim';
import { STANDARD_WORLD } from '../src/world/worldPreset';
import { buyCost, priceOf, tradeChunk } from '../src/world/market';
import { fieldOptions, firstBusinessOn, firstBusinessStatus, relocationOptions, sellWalk, tradeOpportunities } from '../src/world/firstBusiness';
import { qty } from '../src/world/types';

const run = (sim: WorldSim, s: number) => { for (let i = 0; i < s; i++) sim.update(1); };
const store = (sim: WorldSim, st: string, me: string) => sim.storage(sim.st.stations[st], me);

describe('A-3.2a market: a sale and a buy-back never make money', () => {
  it('selling equipment and buying it back at the same station loses money (the old market paid +44k over three cycles)', () => {
    const sim = WorldSim.create(21, { ...STANDARD_WORLD });
    const me = sim.addPlayer('왕복', 'hauler'), co = sim.st.companies[me];
    const st = sim.st.stations.drakeout, m = st.market!.eq_torpedo;
    expect(m).toBeTruthy();
    st.funds = 400000; co.credits = 200000; m.stock = Math.max(m.stock, 60);
    // the company holds 30 launchers at the station (bought there, paid in full)
    expect(sim.command(me, { c: 'buy', station: 'drakeout', res: 'eq_torpedo', amount: 30 })).toBeNull();
    const c0 = co.credits;
    for (let i = 0; i < 3; i++) {
      expect(sim.command(me, { c: 'sell', station: 'drakeout', res: 'eq_torpedo', amount: 30 })).toBeNull();
      expect(sim.command(me, { c: 'buy', station: 'drakeout', res: 'eq_torpedo', amount: 30 })).toBeNull();
    }
    expect(qty(store(sim, 'drakeout', me), 'eq_torpedo')).toBe(30);
    expect(co.credits).toBeLessThan(c0);
  });

  it('a purchase walks the price up the same way a sale walks it down', () => {
    const m = { base: 100, stock: 40, target: 40 } as any;
    expect(tradeChunk(m)).toBe(1);
    const flat = 30 * priceOf(m, 'buy', true), walked = buyCost(m, 30, true);
    expect(walked).toBeGreaterThan(flat);
    // bulk goods keep chunks of up to 50 units
    expect(tradeChunk({ target: 4000 })).toBe(50);
  });
});

describe('A-3.2a hauler start: the guide shows real trades and they settle as estimated', () => {
  const sim = WorldSim.create(21, { ...STANDARD_WORLD });
  const me = sim.addPlayer('운송 첫사업', 'hauler'), co = sim.st.companies[me];

  it('lists trades from where the haulers are, limited by credits, hold and destination demand', () => {
    expect(firstBusinessOn(co)).toBe(true);
    const ops = tradeOpportunities(sim.st, me);
    expect(ops.length).toBeGreaterThan(3);
    for (const o of ops) {
      expect(o.from).toBe('astra');
      expect(o.cost).toBeLessThanOrEqual(co.credits + 1e-6);
      expect(o.amount).toBeLessThanOrEqual(900);   // two haulers' free hold
      expect(o.profit).toBeGreaterThan(0);
      expect(o.revenue).toBeCloseTo(sellWalk(sim.st, sim.st.stations[o.to], o.item, o.amount).value, 6);
      expect(o.risk).toBeGreaterThanOrEqual(0);
    }
  });

  it('buy + pool sale: the money received is the estimate, cargo is conserved, P&L shows upkeep', () => {
    const o = tradeOpportunities(sim.st, me).find(x => x.risk <= 55)!;
    const c0 = co.credits;
    expect(sim.command(me, { c: 'buy', station: o.from, res: o.item, amount: o.amount })).toBeNull();
    expect(co.credits).toBeCloseTo(c0 - o.cost, 3);
    expect(sim.command(me, { c: 'poolCreate', request: { from: o.from, to: o.to, item: o.item, kind: 'sell', amount: o.amount, priority: 5, repeat: false } })).toBeNull();
    const dest = sim.st.stations[o.to];
    const est = sellWalk(sim.st, dest, o.item, o.amount).value;   // the destination does not change before arrival in this check
    run(sim, 1200);
    const job = Object.values(sim.st.logisticsJobs!).find(j => j.owner === me)!;
    expect(job.state).toBe('complete');
    expect(job.delivered).toBe(o.amount);
    expect(job.earned).toBeGreaterThan(est * 0.85);   // other traders and drift move the market a little meanwhile
    const s = firstBusinessStatus(sim.st, me)!;
    expect(s.stored[o.item] ?? 0).toBe(0);
    expect(s.aboard[o.item] ?? 0).toBe(0);
    expect(s.pnl.income.sales).toBeCloseTo(job.earned, 0);
    expect(s.pnl.expense.purchase).toBeCloseTo(o.cost, 0);
    expect(s.pnl.expense.upkeep).toBeGreaterThan(0);
    expect(s.cash).toBeCloseTo(co.credits - 30000, 6);
    expect(s.steps.every(x => x.done)).toBe(co.milestones.includes('first_profit'));
    if (job.earned - o.cost > s.pnl.expense.upkeep) expect(co.milestones).toContain('first_profit');
  });

  it('offers to move empty haulers when nothing pays from where they are', () => {
    const rel = relocationOptions(sim.st, me);
    for (const r of rel) { expect(r.risk).toBeLessThanOrEqual(55); expect(r.best.from).toBe(r.station); expect(r.best.profit).toBeGreaterThan(0); }
  });
});

describe('A-3.2a miner start', () => {
  it('lists the home fields with delivery choices, and flags goods nobody buys', () => {
    const sim = WorldSim.create(21, { ...STANDARD_WORLD });
    const me = sim.addPlayer('채굴 첫사업', 'miner');
    const fs = fieldOptions(sim.st, me);
    const ore = fs.find(f => f.field === 'p9_anvil_ore')!, dense = fs.find(f => f.field === 'p97_anvil_dense')!;
    expect(ore.jumps).toBe(0);
    expect(ore.deliveries.some(d => d.station === 'p9_anvil_port' && d.unsold === 0)).toBe(true);
    expect(dense.deliveries.every(d => d.unsold >= 30)).toBe(true);   // dense titanium ore: no market buys it
    const far = ore.deliveries[0];
    expect(far.per100).toBeGreaterThanOrEqual(ore.deliveries.find(d => d.station === 'p9_anvil_port')!.per100);
  });

  it('a mining op from the guide earns real money: sales booked, ore mined, first profit after upkeep', () => {
    const sim = WorldSim.create(21, { ...STANDARD_WORLD });
    const me = sim.addPlayer('채굴 첫사업', 'miner'), co = sim.st.companies[me];
    const g = Object.values(sim.st.groups).find(x => x.owner === me && sim.subtreeShips(x).some(s => s.classId === 'miner'))!;
    expect(sim.command(me, { c: 'setOp', group: g.id, op: { k: 'mine', field: 'p9_anvil_ore', deliver: 'p9_anvil_port', sell: true } })).toBeNull();
    expect(firstBusinessStatus(sim.st, me)!.steps[0].done).toBe(true);
    run(sim, 1800);
    const s = firstBusinessStatus(sim.st, me)!;
    expect(co.stats.mined).toBeGreaterThan(0);
    expect(s.pnl.income.sales ?? 0).toBeGreaterThan(0);
    expect(s.pnl.expense.upkeep ?? 0).toBeGreaterThan(0);
    expect(s.cash).toBeGreaterThan(0);
    expect(co.milestones).toContain('first_profit');
    // the ledger and the cash agree: what the company has gained is exactly its booked net
    expect(s.pnl.net).toBeCloseTo(s.cash, 0);
  });

  it('other backgrounds and legacy companies get no guide', () => {
    const sim = WorldSim.create(21, { ...STANDARD_WORLD });
    const sec = sim.addPlayer('경비', 'security'), legacy = sim.addPlayer('구형');
    expect(firstBusinessStatus(sim.st, sec)).toBeNull();
    expect(firstBusinessStatus(sim.st, legacy)).toBeNull();
  });
});

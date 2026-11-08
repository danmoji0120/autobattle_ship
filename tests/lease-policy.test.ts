import { describe, it, expect, vi } from 'vitest';
import { WorldSim } from '../src/world/sim';
import { stepUpkeep } from '../src/world/upkeep';
import { advanceRent, setLease, publicCap, serviceOf } from '../src/world/storage';
import { moneyUnits, moneyNumber, payDebt, addDebt } from '../src/world/money';
import { observeWorld, moneySupply, type Observation } from '../src/world/observe';
import { GameServer } from '../src/server/core';

function fixture(station = 'rustport', credits = 0) {
  const sim = WorldSim.create(829), p = sim.addPlayer('임대 정책');
  const co = sim.st.companies[p], st = sim.st.stations[station];
  for (const id of Object.keys(sim.st.ships)) delete sim.st.ships[id];
  co.credits = credits; co.leases = { [station]: 1 }; delete co.leasePaidUntil; delete co.upkeep;
  return { sim, p, co, st };
}
function advance(f: ReturnType<typeof fixture>, seconds: number, dt = .25) {
  const end = f.sim.st.time + seconds;
  while (f.sim.st.time < end - 1e-9) { const h = Math.min(dt, end - f.sim.st.time); f.sim.st.time += h; stepUpkeep(f.sim.st, f.co, h); }
}
function restore(f: ReturnType<typeof fixture>) {
  const sim = new WorldSim(JSON.parse(f.sim.serialize()), { migrateContent: false });
  return { sim, p: f.p, co: sim.st.companies[f.p], st: sim.st.stations[f.st.id] };
}

describe('approved exact warehouse arrears policy', () => {
  it('shipless zero-credit 45cr/h accounts owe exactly 45 after one hour for every caller interval, then stop charging without losing goods', () => {
    for (const dt of [.25, 1, 7, 60, 3600]) {
      const f = fixture(); f.st.storage[f.p].ore = publicCap(f.co, f.st) + 100;
      advance(f, 3600, dt);
      expect(f.co.upkeep!.debtU).toBe('45000000000'); expect(f.co.upkeep!.debt).toBe(45);
      expect(f.co.upkeep!.rent!.accruedU).toBe('45000000000'); expect(f.co.credits).toBe(0);
      expect(f.co.leases).toEqual({}); expect(f.co.upkeep!.rent!.cancelled).toEqual({ t: 3600, blocks: { rustport: 1 } });
      expect(f.st.storage[f.p].ore).toBe(4100); expect(f.sim.room(f.st, f.p)).toBe(0);
      advance(f, 7200, dt); expect(f.co.upkeep!.debt).toBe(45); expect(f.st.storage[f.p].ore).toBe(4100);
      expect(setLease(f.sim.st, f.co, f.st, 1)).toMatch(/미납금/);
    }
  });

  it('retains sub-credit debt, never overdraws, and partial payment does not reset the grace period', () => {
    const f = fixture('rustport', .5); advance(f, 60);
    expect(f.co.upkeep!.debtU).toBe('250000000'); expect(f.co.credits).toBe(0);
    expect(f.co.upkeep!.rent!.sinceMs).toBe(40000);
    f.co.credits = .1; expect(payDebt(f.sim.st, f.co, 'manual')).toBe(.1);
    expect(f.co.upkeep!.debt).toBe(.15); expect(f.co.upkeep!.rent!.sinceMs).toBe(40000);
    advance(f, 3580); expect(f.co.upkeep!.rent!.cancelled!.t).toBe(3640);
    expect(f.co.upkeep!.rent!.accruedU).toBe('45500000000'); expect(f.co.upkeep!.debt).toBe(44.9);
  });

  it('complete mid-period payment clears the old grace period; a later unpaid interval starts a new one', () => {
    const f = fixture(); advance(f, 60); expect(f.co.upkeep!.debt).toBe(.75);
    f.co.credits = 1; expect(f.sim.command(f.p, { c: 'payArrears' })).toBeNull();
    expect(f.co.credits).toBe(.25); expect(f.co.upkeep!.debt).toBe(0); expect(f.co.upkeep!.rent!.sinceMs).toBeUndefined();
    advance(f, 20); expect(f.co.upkeep!.debt).toBe(0);
    advance(f, 1); expect(f.co.upkeep!.rent!.sinceMs).toBe(80000);
    advance(f, 3599); expect(f.co.upkeep!.rent!.cancelled!.t).toBe(3680);
    expect(f.co.upkeep!.total.credits).toBe(46); expect(f.co.upkeep!.total.paid).toBe(1); expect(f.co.upkeep!.debt).toBe(45);
  });

  it('first-hour prepayment is charged once; the next unpaid hour terminates at 7200 and survives reload', () => {
    let f = fixture('rustport', 45); f.co.leases = {};
    expect(setLease(f.sim.st, f.co, f.st, 1)).toBeNull(); expect(f.co.credits).toBe(0);
    advance(f, 3600, 60); expect(f.co.upkeep!.debt).toBe(0); expect(f.co.upkeep!.total.credits).toBe(45);
    expect(f.co.leases!.rustport).toBe(1);
    advance(f, 61, 1); f = restore(f); advance(f, 3539, 7);
    expect(f.co.upkeep!.debtU).toBe('45000000000'); expect(f.co.upkeep!.total.credits).toBe(90); expect(f.co.upkeep!.total.paid).toBe(45);
    expect(f.co.upkeep!.rent!.cancelled!.t).toBe(7200);
    f = restore(f); advance(f, 300, 1); expect(f.co.upkeep!.debt).toBe(45);
  });

  it('independent prepayments, mid-period returns and changes flush only actual elapsed usage', () => {
    const f = fixture('rustport', 1000); f.co.leases = {};
    expect(setLease(f.sim.st, f.co, f.st, 1)).toBeNull(); advance(f, 1800, 60);
    expect(setLease(f.sim.st, f.co, f.st, 2)).toBeNull(); advance(f, 2700, 60);
    expect(f.co.upkeep!.total.credits).toBe(101.25);
    expect(setLease(f.sim.st, f.co, f.st, 1)).toBeNull(); advance(f, 900, 60);
    expect(f.co.upkeep!.total.credits).toBe(112.5); expect(f.co.credits).toBe(887.5);
    expect(f.co.leasePaidUntil!.rustport).toEqual([3600]);
  });

  it('rational remainders persist across repeated serialization and mixed tick lengths without changing total charges', () => {
    let f = fixture('drakeout'); advance(f, 1, .25);
    expect(f.co.upkeep!.debtU).toBe('13888888'); expect(BigInt(f.co.upkeep!.rent!.remainder)).toBeGreaterThan(0n);
    f = restore(f); advance(f, 122, 1); f = restore(f); advance(f, 3477, 7);
    expect(f.co.upkeep!.debtU).toBe('50000000000'); expect(f.co.upkeep!.rent!.remainder).toBe('0');
    expect(f.co.upkeep!.rent!.cancelled!.t).toBe(3600);
    expect(moneyNumber(moneyUnits(90000000.125))).toBe(90000000.125);
  });

  it('legacy known accrued rent and fractional debt migrate exactly once without retroactive prepay assumptions', () => {
    let f = fixture();
    f.co.upkeep = { debt: .1, stage: 0, since: 0, acc: 2.75, leaseAcc: .75, supplies: {}, last: 0, total: { credits: 3, supplies: 0, paid: 0 } };
    advance(f, 60, 60); expect(f.co.upkeep!.debt).toBe(3.6); expect(f.co.upkeep!.total.credits).toBe(6.5);
    expect(f.co.upkeep!.leaseAcc).toBe(0); expect(f.co.upkeep!.acc).toBe(0);
    f = restore(f); advance(f, 60, 60); expect(f.co.upkeep!.debt).toBe(4.35); expect(f.co.upkeep!.total.credits).toBe(7.25);
  });

  it('over-cap stored goods can be sold; proceeds repay debt first with gross transfer and repayment recorded separately', () => {
    const f = fixture(); f.st.storage[f.p].ore = 4100; advance(f, 3600, 60);
    const events: Observation[] = []; observeWorld(f.sim.st, e => events.push(e));
    const beforeSupply = moneySupply(f.sim.st), before = f.st.storage[f.p].ore;
    expect(f.sim.command(f.p, { c: 'sell', station: f.st.id, res: 'ore', amount: 1 })).toBeNull();
    const sale = events.find(e => e.kind === 'market' && e.reason === 'sell')!;
    const repayment = events.find(e => e.kind === 'currency.destroy' && e.reason === 'arrears_payment')!;
    expect(sale.amount).toBe(1); expect(repayment.amount).toBeCloseTo(Math.min(45, sale.value!), 8);
    expect(f.co.upkeep!.debt).toBeCloseTo(Math.max(0, 45 - sale.value!), 8);
    expect(events.find(e => e.kind === 'currency.transfer' && e.to === `co:${f.p}`)!.amount).toBeCloseTo(sale.value!, 8);
    expect(f.st.storage[f.p].ore).toBe(before - 1);
    const created = events.filter(e => e.kind === 'currency.create').reduce((n, e) => n + e.amount, 0), destroyed = events.filter(e => e.kind === 'currency.destroy').reduce((n, e) => n + e.amount, 0);
    expect(moneySupply(f.sim.st) - beforeSupply).toBeCloseTo(created - destroyed, 7);
    f.co.credits = 100; expect(f.sim.command(f.p, { c: 'payArrears' })).toBeNull();
    expect(setLease(f.sim.st, f.co, f.st, 1)).toBeNull();
  });

  it('player goods and ship sales also prioritize arrears without charging the buyer twice', () => {
    const f = fixture(); f.st.storage[f.p].ore = 100; advance(f, 60, 60);
    const buyer = f.sim.addPlayer('상품 구매사'), b = f.sim.st.companies[buyer]; b.credits = 1000;
    expect(f.sim.command(f.p, { c: 'list', station: f.st.id, item: 'ore', qty: 1, price: 1 })).toBeNull();
    expect(f.sim.command(buyer, { c: 'buyListing', station: f.st.id, listing: f.st.listings![0].id, qty: 1 })).toBeNull();
    expect(b.credits).toBe(999); expect(f.co.upkeep!.debt).toBe(0);
    expect(f.co.credits).toBeCloseTo(1 - (f.st.tax ?? .02) - .75, 9);
    const sim = WorldSim.create(39), seller = sim.addPlayer('함선 판매사'), purchaser = sim.addPlayer('함선 구매사');
    const co = sim.st.companies[seller], other = sim.st.companies[purchaser], st = sim.st.stations.helios;
    const ship = Object.values(sim.st.ships).find(s => s.owner === seller)!;
    ship.state = 'docked'; ship.task = { k: 'docked', station: st.id, berth: 0 }; ship.cargo = {};
    co.credits = 0; other.credits = 1000; addDebt(co, moneyUnits(.75), 0);
    expect(sim.command(seller, { c: 'listShip', ship: ship.id, price: 100 })).toBeNull();
    expect(sim.command(purchaser, { c: 'buyShipListing', station: st.id, listing: st.shipListings![0].id })).toBeNull();
    expect(other.credits).toBe(900); expect(ship.owner).toBe(purchaser); expect(co.upkeep!.debt).toBe(0);
    expect(co.credits).toBeCloseTo(100 * (1 - (st.tax ?? .02)) - .75, 9);
  });

  it('sale repayment and rent preserve identical state with collection disabled/enabled and reconcile real cash', () => {
    const f = fixture(); f.st.storage[f.p].ore = 4100; advance(f, 60, 60);
    const file = { v: 1 as const, world: JSON.parse(f.sim.serialize()), auth: {} };
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    try {
      const off = new GameServer(structuredClone(file), { singleplayer: false, snapInterval: 1, analytics: { enabled: false } });
      const on = new GameServer(structuredClone(file), { singleplayer: false, snapInterval: 1 });
      for (const s of [off, on]) { expect(s.sim.command(f.p, { c: 'sell', station: f.st.id, res: 'ore', amount: 1 })).toBeNull(); for (let i = 0; i < 100; i++) s.step(.25); }
      expect(on.sim.serialize()).toBe(off.sim.serialize());
      expect(on.analytics!.query('admin', '').health.reconciliation).toBeCloseTo(0, 6);
    } finally { clock.mockRestore(); }
  });

  it('records payment of the smallest fixed-point obligation instead of filtering it as rounding noise', () => {
    const f = fixture(); f.co.leases = {}; f.co.credits = 1e-9;
    addDebt(f.co, 1n, 0); const events: Observation[] = []; observeWorld(f.sim.st, e => events.push(e));
    expect(f.sim.command(f.p, { c: 'payArrears' })).toBeNull();
    expect(f.co.upkeep!.debtU).toBe('0'); expect(f.co.upkeep!.paidU).toBe('1'); expect(f.co.credits).toBe(0);
    expect(events.find(e => e.kind === 'currency.destroy')!.amount).toBe(1e-9);
  });

  it('c0 upkeep and arrears commands leave legacy gameplay unchanged', () => {
    const f = fixture(); delete f.sim.st.contentV; const before = f.sim.serialize();
    expect(stepUpkeep(f.sim.st, f.co, 3600)).toEqual([]); expect(advanceRent(f.sim.st, f.co, 0)).toBeUndefined();
    expect(f.sim.command(f.p, { c: 'payArrears' })).toMatch(/없습니다/);
    expect(setLease(f.sim.st, f.co, f.st, 2)).toMatch(/없습니다/); expect(f.sim.serialize()).toBe(before);
  });
});

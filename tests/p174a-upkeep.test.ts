// P17.4a AUD-07 / AUD-08: consumable supply source and emergency purchase
import { describe, it, expect } from 'vitest';
import { WorldSim } from '../src/world/sim';
import { STANDARD_WORLD } from '../src/world/worldPreset';
import { supplyStores, supplyOutlook, SETTLE_DT, EMERGENCY_MUL } from '../src/world/upkeep';
import { itemPrice } from '../src/world/industry';
import { qty } from '../src/world/types';

/** a company owing 10 units of `item`, its ships near astra, a far own store holding the item */
function setup(policy: 'legacy' | 'local') {
  const sim = WorldSim.create(7, STANDARD_WORLD as never), p = sim.addPlayer('보급');
  const co = sim.st.companies[p], u = co.upkeep!;
  if (policy === 'legacy') delete u.policy;
  const astra = sim.st.stations.astra, near = sim.sysOf(astra.pos)!;
  const far = Object.values(sim.st.stations).find(s => s.public && sim.sysOf(s.pos) !== near && s.id !== co.homeStation)!;
  for (const s of Object.values(sim.st.ships)) if (s.owner === p) { s.pos = { ...astra.pos }; }
  return { sim, p, co, u, astra, far };
}
const settleNow = (sim: WorldSim, u: { last: number }) => { u.last = sim.time - SETTLE_DT - 1; sim.update(1); };

describe('P17.4a AUD-07 supply source', () => {
  it('new worlds: a remote store does not supply a fleet elsewhere; the legacy rule is kept for saves', () => {
    const a = setup('local');
    expect(a.u.policy?.source).toBe('local');
    a.far.storage[a.p] = { ...(a.far.storage[a.p] ?? {}), chemicals: 50 };
    expect(supplyStores(a.sim.st, a.co).some(s => s.id === a.far.id)).toBe(false);
    a.u.supplies = { chemicals: 10 }; settleNow(a.sim, a.u);
    expect(qty(a.far.storage[a.p], 'chemicals')).toBe(50);
    expect(a.u.bill!.stores?.[a.far.id]).toBeUndefined();

    const b = setup('legacy');
    expect(b.u.policy).toBeUndefined();
    b.far.storage[b.p] = { ...(b.far.storage[b.p] ?? {}), chemicals: 50 };
    b.co.homeStation = b.far.id;   // legacy: the home store is always a source
    b.u.supplies = { chemicals: 10 }; settleNow(b.sim, b.u);
    expect(qty(b.far.storage[b.p], 'chemicals')).toBe(40);
    expect(b.u.bill!.stores?.[b.far.id]?.chemicals).toBe(10);
  });

  it("a store in the fleet's own system is used and reported by station", () => {
    const a = setup('local');
    a.astra.storage[a.p] = { ...(a.astra.storage[a.p] ?? {}), chemicals: 30 };
    a.u.supplies = { chemicals: 10 }; settleNow(a.sim, a.u);
    expect(qty(a.astra.storage[a.p], 'chemicals')).toBe(20);
    expect(a.u.bill!.stores?.astra?.chemicals).toBe(10);
  });
});

describe('P17.4a AUD-08 emergency purchase', () => {
  /** no market stocks chemicals: every unit not in a store is an emergency purchase */
  const rare = 'chemicals';   // the common hull consumable; markets are emptied of it below
  function noMarket(a: ReturnType<typeof setup>) { for (const s of Object.values(a.sim.st.stations)) { if (s.market) delete s.market[rare]; if (s.storage[a.p]) delete s.storage[a.p][rare]; } }

  it('forbid: nothing bought, shortfall reported, wear penalty flagged; allow: 2× base price, reason recorded', () => {
    const a = setup('local'); noMarket(a);
    expect(a.sim.command(a.p, { c: 'supplyPolicy', policy: { emergency: 'forbid' } })).toBeNull();
    a.u.supplies = { [rare]: 10 }; settleNow(a.sim, a.u);
    expect(a.u.bill!.emergency?.[rare]).toBeUndefined();
    expect(a.u.bill!.lacking?.[rare]).toBe(10);
    expect(a.u.supplyShort).toBe(true);
    expect(a.u.bill!.supplies).toBe(0);

    expect(a.sim.command(a.p, { c: 'supplyPolicy', policy: { emergency: 'allow' } })).toBeNull();
    a.u.supplies = { [rare]: 10 }; settleNow(a.sim, a.u);
    const e = a.u.bill!.emergency![rare];
    expect(e.n).toBe(10); expect(e.unit).toBeCloseTo(itemPrice(rare) * EMERGENCY_MUL); expect(e.why).toMatch(/시장/);
    expect(a.u.supplyShort).toBeUndefined();
  });

  it('cap: emergency spend stops at the hourly cap; the outlook predicts the same split', () => {
    const a = setup('local'); noMarket(a);
    const unit = itemPrice(rare) * EMERGENCY_MUL;
    expect(a.sim.command(a.p, { c: 'supplyPolicy', policy: { emergency: 'cap', capPerHour: unit * 4 } })).toBeNull();
    a.u.supplies = { [rare]: 10 }; settleNow(a.sim, a.u);
    expect(a.u.bill!.emergency![rare].n).toBe(4); expect(a.u.bill!.lacking![rare]).toBe(6);
    a.u.supplies = { [rare]: 3 }; settleNow(a.sim, a.u);
    expect(a.u.bill!.emergency?.[rare]).toBeUndefined();   // cap used up within the hour
    expect(a.sim.command(a.p, { c: 'supplyPolicy', policy: { emergency: 'bogus' as never } })).toMatch(/올바르지/);
    const o = supplyOutlook(a.sim.st, a.co);
    for (const r of o) { expect(r.store + r.market + r.emergency + r.lacking).toBe(r.perHour); }
  });

  it('old saves keep their rule across save/restore; no policy is invented', () => {
    const b = setup('legacy');
    const r = new WorldSim(JSON.parse(b.sim.serialize()), { migrateContent: false });
    expect(r.st.companies[b.p].upkeep!.policy).toBeUndefined();
  });
});

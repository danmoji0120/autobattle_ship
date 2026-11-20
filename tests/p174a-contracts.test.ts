// P17.4a: direct contract delivery from the store (AUD-03) and contract outcome in works (AUD-14)
import { describe, it, expect } from 'vitest';
import { fixture, run, works } from './helpers/opsFixture';
import { deliveryQuote } from '../src/world/contractDelivery';
import { qty } from '../src/world/types';
import { WorldSim } from '../src/world/sim';

function deliveryAt(f: ReturnType<typeof fixture>, res = 'ore', amount = 200, reward = 9000) {
  const k = f.sim.offerContract({ stationId: 'astra', kind: 'delivery', title: `t ${res}`, desc: '', reward, rep: 2, res, amount } as never);
  const id = (k as { id?: string } | undefined)?.id ?? Object.keys(f.sim.st.contracts).at(-1)!;
  expect(f.sim.command(f.p, { c: 'accept', contract: id })).toBeNull();
  return f.sim.st.contracts[id];
}
const contractWork = (f: ReturnType<typeof fixture>, id: string) => works(f.sim, f.p).find(w => w.kind === 'contract' && w.ref.contract === id)!;

describe('P17.4a AUD-03 direct delivery from the store', () => {
  it('delivers free stock once, pays once, replays do nothing', () => {
    const f = fixture(); const k = deliveryAt(f);
    f.a.storage[f.p] = { ore: 500 };
    const c0 = f.co.credits;
    expect(f.sim.command(f.p, { c: 'deliverStock', contract: k.id, upTo: 200 })).toBeNull();
    expect(k.done).toBe(true); expect(k.outcome).toBe('complete');
    expect(qty(f.a.storage[f.p], 'ore')).toBeCloseTo(300);
    expect(f.co.credits - c0).toBeCloseTo(9000);
    // replay / double click: refused, nothing taken, nothing paid
    expect(f.sim.command(f.p, { c: 'deliverStock', contract: k.id, upTo: 200 })).toMatch(/종료/);
    expect(qty(f.a.storage[f.p], 'ore')).toBeCloseTo(300);
    expect(f.co.credits - c0).toBeCloseTo(9000);
    run(f.sim, 2);
    const w = contractWork(f, k.id);
    expect(w.state).toBe('done'); expect(w.result).toMatch(/완수/);
  });

  it('partial delivery is idempotent by target progress; protected stock is never used', () => {
    const f = fixture(); const k = deliveryAt(f);
    f.a.storage[f.p] = { ore: 150 };
    expect(f.sim.command(f.p, { c: 'salesPolicy', settings: { item: 'ore', sell: false, minPrice: 0, station: 'astra', keep: 100 } })).toBeNull();   // minimum stock at astra
    const q = deliveryQuote(f.sim, f.p, k);
    expect(q.usable).toBe(50); expect(q.why).toMatch(/보호/);
    expect(f.sim.command(f.p, { c: 'deliverStock', contract: k.id, upTo: 50 })).toBeNull();
    expect(f.sim.command(f.p, { c: 'deliverStock', contract: k.id, upTo: 50 })).toBeNull();   // replay
    expect(k.progress).toBeCloseTo(50); expect(qty(f.a.storage[f.p], 'ore')).toBeCloseTo(100);
    // nothing free left: refused with a reason, protected 100 untouched
    expect(f.sim.command(f.p, { c: 'deliverStock', contract: k.id })).toMatch(/보호/);
    expect(qty(f.a.storage[f.p], 'ore')).toBeCloseTo(100); expect(k.done).toBe(false);
  });

  it('stock at another station or another company is not used; salvage contracts refuse', () => {
    const f = fixture(); const k = deliveryAt(f);
    f.home.storage[f.p] = { ore: 500 };
    expect(f.sim.command(f.p, { c: 'deliverStock', contract: k.id })).toMatch(/없음/);
    const other = f.sim.addPlayer('other');
    expect(f.sim.command(other, { c: 'deliverStock', contract: k.id })).toMatch(/수주한 계약이 아님/);
    const s = f.sim.offerContract({ stationId: 'astra', kind: 'salvage', title: 's', desc: '', reward: 1, rep: 1, res: 'ore', amount: 10 } as never);
    const sid = (s as { id?: string } | undefined)?.id ?? Object.keys(f.sim.st.contracts).at(-1)!;
    f.sim.st.contracts[sid].takenBy = f.p;
    expect(f.sim.command(f.p, { c: 'deliverStock', contract: sid })).toMatch(/인양/);
  });

  it('ship unloading and direct delivery share one settlement (no double completion)', () => {
    const f = fixture(); const k = deliveryAt(f, 'ore', 100, 5000);
    f.a.storage[f.p] = { ore: 60 };
    const c0 = f.co.credits;
    expect(f.sim.command(f.p, { c: 'deliverStock', contract: k.id })).toBeNull();
    expect(k.progress).toBeCloseTo(60);
    const s = f.ships[0]; s.cargo = { ore: 80 };
    (f.sim as any).unload(s, f.a, false);
    expect(k.done).toBe(true); expect(f.co.credits - c0).toBeCloseTo(5000);
    expect(qty(s.cargo, 'ore') + qty(f.a.storage[f.p], 'ore')).toBeCloseTo(40);   // only the 40 owed were consumed
  });
});

describe('P17.4a AUD-14 contract outcome in works', () => {
  it('expiry is a failure, not a success; a vanished record is not a success', () => {
    const f = fixture(); const k = deliveryAt(f);
    run(f.sim, 1);
    expect(contractWork(f, k.id).state).toBe('running');
    k.expires = f.sim.time + 1; run(f.sim, 6);
    expect(k.outcome).toBe('expired');
    const w = contractWork(f, k.id);
    expect(w.state).toBe('failed'); expect(w.result).toMatch(/만료/);
    // a contract deleted before its outcome was observed
    const k2 = deliveryAt(f); run(f.sim, 1);
    delete f.sim.st.contracts[k2.id]; run(f.sim, 1);
    expect(contractWork(f, k2.id).state).toBe('cancelled');
    expect(contractWork(f, k2.id).result).toMatch(/확인할 수 없음/);
  });

  it('save/restore keeps one work per contract and its outcome', () => {
    const f = fixture(); const k = deliveryAt(f); f.a.storage[f.p] = { ore: 500 };
    expect(f.sim.command(f.p, { c: 'deliverStock', contract: k.id })).toBeNull();
    run(f.sim, 1);
    const r = new WorldSim(JSON.parse(f.sim.serialize()), { migrateContent: false });
    for (let t = 0; t < 2; t += .25) r.update(.25);
    const ws = Object.values(r.st.works ?? {}).filter(w => w.ref.contract === k.id);
    expect(ws.length).toBe(1); expect(ws[0].state).toBe('done');
  });
});

describe('P17.4a AUD-18 buy-here-deliver-here arbitrage', () => {
  it('a delivery contract whose lot the local market can sell pays no more than the local purchase cost', async () => {
    const { STANDARD_WORLD } = await import('../src/world/worldPreset');
    const { buyCost } = await import('../src/world/market');
    const sim = WorldSim.create(11, STANDARD_WORLD as never);
    const seen = new Set<string>(); let local = 0, other = 0;
    for (let t = 0; t < 900; t++) {
      sim.update(1);
      for (const k of Object.values(sim.st.contracts)) {
        if (k.kind !== 'delivery' || seen.has(k.id)) continue; seen.add(k.id);
        const m = sim.st.stations[k.stationId].market?.[k.res!];
        if (m && m.stock >= k.amount!) { local++; expect(k.reward).toBeLessThanOrEqual(buyCost(m, k.amount!, true) + 1); }
        else other++;
      }
    }
    expect(local).toBeGreaterThan(5); expect(other).toBeGreaterThan(0);   // contracts are still posted for both kinds
  }, 120000);
});

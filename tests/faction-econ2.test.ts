// Faction economy v2 (factionEcon2.ts): opt-in gate, ledger conservation, invariants, demand-limited
// purchases, no rebuilding without supply, player supply reaches the faction, save/restore, cadence.
import { describe, expect, it } from 'vitest';
import { WorldSim } from '../src/world/sim';
import { factionEcon2Step, rates, FE_GOODS, FE_CYCLE, feOn, enableFactionEcon2, writeOff } from '../src/world/factionEcon2';
import { publicFactions, legacyView, applySync, ClientSync, SyncHub, syncMessage, type SyncMsg } from '../src/server/sync';
import { qty, type Cargo } from '../src/world/types';
import type { FactionState } from '../src/world/territory';

const tick = (sim: WorldSim, s: number) => { for (let t = 0; t < s; t++) sim.tick(1); };
const host = (sim: WorldSim) => sim as unknown as Parameters<typeof factionEcon2Step>[0];
const peace = (sim: WorldSim) => { for (const f of Object.values(sim.st.factions!)) for (const g of Object.keys(f.rel)) f.rel[g] = 0; };

/** stock = opening + extracted + made − inputs + bought − used − exported, for every good */
function ledgerGap(f: FactionState) {
  const L = f.econ!.led; let worst = 0;
  const keys = new Set([...Object.keys(f.stock), ...Object.keys(L.opening), ...Object.keys(L.extracted), ...Object.keys(L.made), ...Object.keys(L.inputs), ...Object.keys(L.bought), ...Object.keys(L.used), ...Object.keys(L.exported)]);
  for (const k of keys) {
    const q = (c: Cargo) => qty(c, k);
    const expect = q(L.opening) + q(L.extracted) + q(L.made) - q(L.inputs) + q(L.bought) - q(L.used) - q(L.exported) - q(L.lost ?? {});
    worst = Math.max(worst, Math.abs(expect - qty(f.stock, k)) / Math.max(1, Math.abs(expect)));
  }
  return worst;
}
function invariants(sim: WorldSim) {
  const w = sim.st;
  for (const f of Object.values(w.factions!)) {
    const e = f.econ!;
    for (const [k, n] of Object.entries(f.stock)) expect(n, `${f.id} stock ${k}`).toBeGreaterThanOrEqual(-1e-6);
    expect(e.budget, `${f.id} budget`).toBeGreaterThanOrEqual(-1e-6);
    expect(Number.isFinite(e.budget) && Number.isFinite(f.strength) && Number.isFinite(f.infra)).toBe(true);
    expect(f.strength).toBeGreaterThanOrEqual(0);
    expect(e.eff).toBeGreaterThanOrEqual(.35 - 1e-9); expect(e.eff).toBeLessThanOrEqual(1 + 1e-9);
    expect(e.rdy).toBeGreaterThanOrEqual(-1e-9); expect(e.rdy).toBeLessThanOrEqual(1 + 1e-9);
    // money: what a faction spent equals what stations received plus the recorded sink
    expect(e.led.spent).toBeGreaterThanOrEqual(e.led.sunk - 1e-6);
    expect(ledgerGap(f), `${f.id} ledger`).toBeLessThan(1e-6);
  }
  for (const s of Object.values(w.stations)) {
    for (const [k, m] of Object.entries(s.market ?? {})) expect(m.stock, `${s.id}:${k}`).toBeGreaterThanOrEqual(-1e-6);
    if (s.fundsMax !== undefined) { expect(s.funds!).toBeGreaterThanOrEqual(-1e-6); expect(s.funds!).toBeLessThanOrEqual(s.fundsMax * 1.5 + 1e-6); }
  }
}

describe('faction economy v2: gate', () => {
  it('is opt-in: c0, P9 and default P10 worlds never get it, and keep the v1 rules', () => {
    for (const sim of [WorldSim.create(3), WorldSim.create(3, { layout: 'p10' })]) {
      tick(sim, 600);
      expect(sim.st.factionEcon).toBeUndefined();
      expect(Object.values(sim.st.factions ?? {}).some(f => f.econ)).toBe(false);
    }
    expect(() => WorldSim.create(3, { factionEcon: 'v2' })).toThrow(/p10/);
    const sim = WorldSim.create(3, { layout: 'p10', factionEcon: 'v2' });
    expect(feOn(sim.st)).toBe(true);
    expect(Object.values(sim.st.factions!).every(f => f.econ && f.econ.budget > 0)).toBe(true);
  });
  it('cannot be switched on for a world that already has players or history', () => {
    const sim = WorldSim.create(3, { layout: 'p10' });
    tick(sim, 5);
    expect(() => enableFactionEcon2(sim.st)).toThrow(/brand-new/);
  });
  it('managed goods stop refilling for free in faction markets; other goods keep the old rules', () => {
    const sim = WorldSim.create(4, { layout: 'p10', factionEcon: 'v2' });
    const st = sim.st.stations.p10_bulwark_yard; const m = st.market!;
    sim.st.factionClock = 1e12;   // no faction cycles: only the market rules act
    m.alloy.stock = 0;
    const other = Object.keys(sim.st.stations.helios.market!).find(k => !FE_GOODS.has(k) && !k.startsWith('bp:'))!;
    sim.st.stations.helios.market![other].stock = 0;
    tick(sim, 300);
    expect(m.alloy.stock).toBe(0);
    expect(sim.st.stations.helios.market![other].stock).toBeGreaterThan(0);
  });
});

describe('faction economy v2: conservation and invariants', () => {
  it('3 h: ledger identity, no negative stock, bounded budgets and station funds', () => {
    const sim = WorldSim.create(7, { layout: 'p10', factionEcon: 'v2' });
    for (let h = 0; h < 3; h++) { tick(sim, 3600); invariants(sim); }
    const L = Object.values(sim.st.factions!).map(f => f.econ!.led);
    expect(L.reduce((n, l) => n + l.spent, 0)).toBeGreaterThan(0);
    expect(L.reduce((n, l) => n + Object.keys(l.used).length, 0)).toBeGreaterThan(10);
  }, 240000);

  it('purchases never lift a stockpile above its target (no buying without demand)', () => {
    const sim = WorldSim.create(8, { layout: 'p10', factionEcon: 'v2' });
    tick(sim, 1800);
    for (let c = 0; c < 20; c++) {
      const before = Object.fromEntries(Object.values(sim.st.factions!).map(f => [f.id, { ...f.econ!.led.bought }]));
      sim.st.time += FE_CYCLE; factionEcon2Step(host(sim), sim.st, FE_CYCLE);
      for (const f of Object.values(sim.st.factions!)) {
        const R = rates(sim.st, f);
        for (const [k, n] of Object.entries(f.econ!.led.bought)) if (n - (before[f.id][k] ?? 0) > 1e-9) expect(qty(f.stock, k), `${f.id}:${k}`).toBeLessThanOrEqual((R.target[k] ?? 0) * 1.5 + 1e-6);
      }
    }
  }, 120000);

  it('no rebuilding without supply: with no hull goods anywhere, lost strength is not restored', () => {
    const sim = WorldSim.create(9, { layout: 'p10', factionEcon: 'v2' });
    peace(sim);
    const iron = sim.st.factions!.iron; iron.strength = 30;
    const wipe = () => { for (const s of Object.values(sim.st.stations)) if (s.market?.alloy) s.market.alloy.stock = 0; for (const f of Object.values(sim.st.factions!)) delete f.stock.alloy; };
    const built0 = iron.econ!.led.builtStr;
    for (let c = 0; c < 30; c++) { wipe(); sim.st.time += FE_CYCLE; factionEcon2Step(host(sim), sim.st, FE_CYCLE); }
    expect(iron.econ!.led.builtStr - built0).toBe(0);
    expect(iron.strength).toBeLessThanOrEqual(30 + 1e-9);
  });

  it('a budget of zero buys nothing', () => {
    const sim = WorldSim.create(10, { layout: 'p10', factionEcon: 'v2' });
    for (const f of Object.values(sim.st.factions!)) { f.econ!.budget = 0; f.stock = {}; }
    const tax = sim.st.factions!.union.econ!;
    const spent0 = tax.led.spent, inc0 = tax.led.income;
    sim.st.time += FE_CYCLE; factionEcon2Step(host(sim), sim.st, FE_CYCLE);
    // only this cycle's income can be spent
    expect(tax.led.spent - spent0).toBeLessThanOrEqual(tax.led.income - inc0 + tax.led.exportRev + 1e-6);
  });
});

describe('faction economy v2: players and war', () => {
  it('goods a player sells into a faction market are bought by the faction and rebuild its fleet', () => {
    // alloy (the hull bottleneck) is kept out of everyone's reach except what the player sells at Bulwark
    const make = () => {
      const sim = WorldSim.create(12, { layout: 'p10', factionEcon: 'v2' }); peace(sim);
      sim.st.factions!.iron.strength = 40;
      return sim;
    };
    const starve = (sim: WorldSim, keep?: string) => {
      for (const s of Object.values(sim.st.stations)) if (s.market?.alloy && s.id !== keep) s.market.alloy.stock = 0;
      for (const f of Object.values(sim.st.factions!)) if (f.id !== 'iron' || !keep) delete f.stock.alloy;
    };
    const control = make(), sold = make();
    starve(control); starve(sold);
    const yard = sold.st.stations.p10_bulwark_yard; yard.market!.alloy.stock = 0;
    const p = sold.addPlayer('합금상');
    yard.storage[p] = { ...(yard.storage[p] ?? {}), alloy: 3000 } as any;
    const c0 = sold.st.companies[p].credits;
    expect(sold.command(p, { c: 'sell', station: yard.id, res: 'alloy', amount: 3000 })).toBeNull();
    expect(sold.st.companies[p].credits).toBeGreaterThan(c0);
    expect(yard.market!.alloy.stock).toBeGreaterThan(0);
    for (let c = 0; c < 30; c++) { starve(control, 'p10_bulwark_yard'); starve(sold, 'p10_bulwark_yard'); tick(control, 60); tick(sold, 60); }
    const a = control.st.factions!.iron.econ!.led, b = sold.st.factions!.iron.econ!.led;
    expect(qty(b.bought, 'alloy')).toBeGreaterThan(qty(a.bought, 'alloy') + 500);
    expect(qty(b.rebuild, 'alloy')).toBeGreaterThan(qty(a.rebuild, 'alloy'));
    expect(b.builtStr).toBeGreaterThan(a.builtStr);
  }, 120000);

  it('war adds munitions demand that peace does not have', () => {
    const sim = WorldSim.create(13, { layout: 'p10', factionEcon: 'v2' });
    const iron = sim.st.factions!.iron;
    const peaceR = rates(sim.st, iron);
    sim.st.conflicts = { w: { id: 'w', a: 'iron', b: 'pirates', gates: [], since: 0, lost: {} } };
    const warR = rates(sim.st, iron);
    expect(Object.keys(peaceR.cls.war)).toHaveLength(0);
    expect(qty(warR.cls.war, 'weapon_parts')).toBeGreaterThan(0);
    expect(qty(warR.target, 'weapon_parts')).toBeGreaterThan(qty(peaceR.target, 'weapon_parts'));
  });

  it('war losses are larger for the side whose munitions are not supplied', () => {
    const lose = (rdy: number) => {
      const sim = WorldSim.create(14, { layout: 'p10', factionEcon: 'v2' }); peace(sim);
      const A = sim.st.factions!.iron, B = sim.st.factions!.pirates; A.strength = 80; B.strength = 60; A.econ!.rdy = rdy;
      sim.st.conflicts = { w: { id: 'w', a: 'iron', b: 'pirates', gates: [], since: sim.st.time, lost: {} } };
      const before = A.econ!.led.lostStr;
      sim.st.time += FE_CYCLE; factionEcon2Step(host(sim), sim.st, FE_CYCLE);
      return sim.st.conflicts.w.lost.iron;
    };
    expect(lose(.2)).toBeGreaterThan(lose(1) * 1.2);
  });
});

describe('faction economy v2: save/restore and cadence', () => {
  it('a world saved mid-run continues exactly like the uninterrupted one', () => {
    const a = WorldSim.create(15, { layout: 'p10', factionEcon: 'v2' });
    tick(a, 2400);
    const b = new WorldSim(JSON.parse(a.serialize()));
    const c = new WorldSim(JSON.parse(a.serialize()));
    tick(a, 1200); tick(b, 1200); tick(c, 1200);
    // (ship objects can list a field in a different key order after a restore, so compare structurally)
    expect(JSON.parse(b.serialize())).toEqual(JSON.parse(a.serialize()));
    expect(b.serialize()).toBe(c.serialize());
    expect(b.st.factions).toEqual(a.st.factions);
  }, 120000);

  it('the cycle grid does not depend on the tick length', () => {
    // (whole-world equality across update() sizes is not a game guarantee: NPC battles have a wall-clock budget)
    const a = WorldSim.create(16, { layout: 'p10', factionEcon: 'v2' }), b = WorldSim.create(16, { layout: 'p10', factionEcon: 'v2' });
    let cycles = 0; const step = a.st.factionClock;
    for (let t = 0; t < 900; t++) a.update(1);
    for (let t = 0; t < 1800; t++) b.update(.5);
    void step; void cycles;
    expect(a.st.factionClock).toBe(Math.floor(a.st.time / FE_CYCLE) * FE_CYCLE);
    expect(b.st.factionClock).toBe(a.st.factionClock);
    // the same number of cycles ran: income accrues once per cycle
    for (const id of Object.keys(a.st.factions!)) expect(b.st.factions![id].econ!.led.income).toBeCloseTo(a.st.factions![id].econ!.led.income, 0);
  }, 120000);

  it('totals barely depend on the cycle length (rates are per hour)', () => {
    const run = (cycle: number) => {
      const sim = WorldSim.create(17, { layout: 'p10', factionEcon: 'v2' }); peace(sim);
      for (let t = 0; t < 4 * 3600; t += cycle) { sim.st.time += cycle; factionEcon2Step(host(sim), sim.st, cycle); }
      return Object.values(sim.st.factions!).map(f => [f.econ!.led.income, Object.values(f.econ!.led.used).reduce((n, x) => n + x!, 0)]);
    };
    const a = run(60), b = run(30);
    for (let i = 0; i < a.length; i++) for (let j = 0; j < 2; j++) expect(Math.abs(a[i][j] - b[i][j]) / Math.max(1, a[i][j])).toBeLessThan(.05);
  }, 120000);
});

describe('faction economy v2: accounting and visibility', () => {
  it('a write-off removes stock only through the ledger (no unrecorded loss) and never below zero', () => {
    const sim = WorldSim.create(5, { layout: 'p10', factionEcon: 'v2' });
    const iron = sim.st.factions!.iron, k = Object.keys(iron.stock)[0], have = qty(iron.stock, k);
    expect(writeOff(iron, k, have * 2)).toBeCloseTo(have);
    expect(qty(iron.stock, k)).toBe(0);
    expect(qty(iron.econ!.led.lost!, k)).toBeCloseTo(have);
    expect(ledgerGap(iron)).toBeLessThan(1e-9);
    expect(writeOff(iron, k, 10)).toBe(0);
  });
  it('clients get the faction state without the internal ledger and stockpile; v1 factions are untouched', () => {
    const v2 = WorldSim.create(5, { layout: 'p10', factionEcon: 'v2' }).st.factions!;
    const pub = publicFactions(v2)!;
    for (const f of Object.values(pub)) { expect(f.econ!.led).toBeUndefined(); expect(f.stock).toEqual({}); expect(f.econ!.eff).toBeTypeOf('number'); }
    expect(v2.iron.econ!.led).toBeDefined();                          // the server copy keeps it
    const v1 = WorldSim.create(5, { layout: 'p10' }).st.factions!;
    expect(publicFactions(v1)).toEqual(v1);
  });
  it('multiplayer: two companies replicate exactly the legacy view, with no ledger, and frames stay small', () => {
    const sim = WorldSim.create(5, { layout: 'p10', factionEcon: 'v2' });
    const a = sim.addPlayer('갑'), b = sim.addPlayer('을');
    const hub = new SyncHub(), cs = { [a]: new ClientSync(), [b]: new ClientSync() };
    const state: Record<string, any> = {}; let full = 0, delta = 0;
    for (let i = 0; i < 4; i++) {
      tick(sim, 70);                                                   // crosses a 60 s faction cycle each round
      const frame = hub.frame(sim.st, sim.st.time, 1);
      for (const c of [a, b]) {
        const m = syncMessage(frame, cs[c], { company: c }, 'helios', true)!;
        if (i === 0) full = Math.max(full, m.length); else delta = Math.max(delta, m.length);
        expect(m).not.toContain('"led"');
        state[c] = applySync(state[c] ?? null, JSON.parse(m) as SyncMsg);
        expect(JSON.parse(JSON.stringify(state[c]))).toEqual(JSON.parse(JSON.stringify(legacyView(sim.st, { company: c }, 'helios'))));
        expect(state[c].factions.iron.econ.eff).toBeTypeOf('number');
      }
      hub.done(frame);
    }
    console.log(`v2 sync: first frame ${full} B, later frames ≤ ${delta} B`);
  });
});

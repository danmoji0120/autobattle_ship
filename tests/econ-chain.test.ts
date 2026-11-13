// Value-chain ("B") pricing: opt-in per world, one formula for every creation path, and a safe,
// idempotent, reversible migration for existing c4 saves (econChain.ts / econMigrate.ts).
import { describe, expect, it } from 'vitest';
import { WorldSim } from '../src/world/sim';
import { newWorld } from '../src/world/worldgen';
import { PROFILES } from '../src/world/economy';
import { recipeFor, RECIPES, EQUIPMENT } from '../src/world/industry';
import { census, compareCensus } from '../src/world/migrate';
import { chainValue, chainPriced, chainOn, fitServiceUnit } from '../src/world/econChain';
import { migrateEconChain, rollbackEconChain, econEligible } from '../src/world/econMigrate';
import type { WorldState } from '../src/world/types';
import { fixture, run } from './helpers/opsFixture';

const c4Save = (seed = 5): WorldState => {
  const st = newWorld(seed); delete (st as { contentV?: number }).contentV;
  const c0 = new WorldSim(st, { migrateContent: false });
  return JSON.parse(new WorldSim(JSON.parse(c0.serialize()), { migrateContent: true }).serialize());
};
const markets = (w: WorldState) => Object.values(w.stations).filter(s => s.public && s.market);
const snapMarkets = (w: WorldState) => JSON.stringify(markets(w).map(s => [s.id, s.market, s.funds, s.fundsMax]));
const expectChainPriced = (w: WorldState) => {
  let n = 0;
  for (const s of markets(w)) for (const [k, e] of Object.entries(s.market!)) {
    if (!chainPriced(k)) continue;
    expect(e.base, `${s.id}:${k}`).toBeCloseTo(Math.round(chainValue(k, w.econ!.eq) * (PROFILES[s.id]?.mult ?? 1) * 10) / 10, 6); n++;
  }
  return n;
};

describe('opt-in: worlds without the option keep their prices', () => {
  it('default P9/P10 creation has no econ state and the c4 recipes', () => {
    for (const w of [WorldSim.create(5), WorldSim.create(5, { layout: 'p10' })]) {
      expect(w.st.econ).toBeUndefined();
      expect(recipeFor(w.st, 'alloy_direct')!.out.alloy).toBe(14);
      expect(fitServiceUnit(w.st, 'eq_medium_gun')).toBe(RECIPES.alloy_direct ? fitServiceUnit(undefined, 'eq_medium_gun') : 0);
    }
  });
  it('a c0 save is refused and left byte-identical; loading a c4 save without the flag changes nothing', () => {
    const c0 = newWorld(5); delete (c0 as { contentV?: number }).contentV;
    const s0 = JSON.stringify(c0);
    expect(econEligible(c0)).toMatch(/c4 저장만/);
    const rep = migrateEconChain(c0); expect(rep.ok).toBe(false); expect(rep.changed).toBe(0);
    expect(JSON.stringify(c0)).toBe(s0);
    const c4 = c4Save(), m0 = snapMarkets(c4);
    const sim = new WorldSim(structuredClone(c4));
    expect(sim.st.econ).toBeUndefined(); expect(snapMarkets(sim.st)).toBe(m0);
  });
});

describe('one formula whatever created the world or market', () => {
  it('new P9, new P10 and a migrated c4 save price every shared market good identically', () => {
    const p9 = WorldSim.create(5, { econ: 'chain' }).st, p10 = WorldSim.create(5, { layout: 'p10', econ: 'chain' }).st;
    const mig = c4Save(); expect(migrateEconChain(mig).ok).toBe(true);
    for (const w of [p9, p10, mig]) { expect(chainOn(w)).toBe(true); expect(expectChainPriced(w)).toBeGreaterThan(50); }
    // the same station in all three: identical bases
    for (const id of ['helios', 'astra', 'bastion']) for (const [k, e] of Object.entries(p9.stations[id].market!))
      if (chainPriced(k) && mig.stations[id].market![k]) { expect(mig.stations[id].market![k].base).toBe(e.base); expect(p10.stations[id].market![k].base).toBe(e.base); }
    // blueprints keep their own price rule
    for (const w of [p9, mig]) for (const s of markets(w)) for (const [k, e] of Object.entries(s.market!)) if (k.startsWith('bp:')) expect(e.base).toBeGreaterThan(1000);
  });
  it('processed goods earn more than their inputs at every main step (value chain holds)', () => {
    for (const id of ['metal', 'alloy', 'machinery', 'electronics', 'weapon_parts', 'engine', 'reactor', 'sensor']) {
      const r = RECIPES[id], [o, n] = Object.entries(r.out)[0];
      const inV = Object.entries(r.in).reduce((a, [k, q]) => a + chainValue(k) * q, 0);
      expect(chainValue(o) * n * 0.855, id).toBeGreaterThan(inV * 1.121);
    }
  });
});

describe('c4 save migration', () => {
  it('changes only market bases; stock, target, funds, credits, storage, queues and census stay', () => {
    const st = c4Save(), before = census(st), b = structuredClone(st);
    const rep = migrateEconChain(st);
    expect(rep.ok).toBe(true); expect(rep.changed).toBeGreaterThan(0);
    expect(compareCensus(before, census(st))).toEqual([]);
    for (const s of markets(st)) for (const [k, e] of Object.entries(s.market!)) {
      const o = b.stations[s.id].market![k]; expect(e.stock).toBe(o.stock); expect(e.target).toBe(o.target);
    }
    for (const s of markets(st)) { expect(s.funds).toBe(b.stations[s.id].funds); expect(s.fundsMax).toBe(b.stations[s.id].fundsMax); }
    for (const c of Object.values(st.companies)) expect(c.credits).toBe(b.companies[c.id].credits);
    for (const s of Object.values(st.stations)) { expect(s.storage).toEqual(b.stations[s.id].storage); expect(s.orders).toEqual(b.stations[s.id].orders); expect(s.builds).toEqual(b.stations[s.id].builds); }
    expect(st.ships).toEqual(b.ships);
  });
  it('is idempotent, survives restart (no reprice on reload), and rolls back exactly', () => {
    const st = c4Save(), m0 = snapMarkets(st);
    migrateEconChain(st); const m1 = snapMarkets(st);
    expect(migrateEconChain(st).changed).toBe(0); expect(snapMarkets(st)).toBe(m1);
    const s1 = new WorldSim(st).serialize();
    const re = new WorldSim(JSON.parse(s1), { migrateEcon: true });
    expect(re.econReport!.changed).toBe(0); expect(re.serialize()).toBe(s1);
    const back = JSON.parse(s1) as WorldState;
    const rb = rollbackEconChain(back); expect(rb.ok).toBe(true);
    expect(back.econ).toBeUndefined(); expect(snapMarkets(back)).toBe(m0);
    expect(recipeFor(back, 'alloy_direct')!.out.alloy).toBe(14);
  });
  it('server path: the constructor flag migrates once; a census of a constructor run matches', () => {
    const st = c4Save(), b = census(st);
    const sim = new WorldSim(st, { migrateEcon: true });
    expect(sim.econReport!.ok).toBe(true); expect(compareCensus(b, census(sim.st))).toEqual([]);
    const s1 = sim.serialize(); expect(new WorldSim(JSON.parse(s1), { migrateEcon: true }).serialize()).toBe(s1);
  });
});

describe('direct alloy fallback and running jobs', () => {
  it('chain worlds run alloy_direct at the recorded output; a batch started before migration keeps its terms', () => {
    const f = fixture(), { sim, p, home } = f;
    // the fixture world is a fresh growth world (c4): make it chain-eligible exactly like a save
    home.storage[p].ore = 600;
    expect(sim.command(p, { c: 'prodOrder', station: home.id, recipe: 'alloy_direct', mode: 'count', n: 2 })).toBeNull();
    sim.tick(1); expect(home.jobs!.length).toBe(1); expect(home.jobs![0].out).toBeUndefined();
    const census0 = census(sim.st);
    expect(migrateEconChain(sim.st).ok).toBe(true);
    expect(compareCensus(census0, census(sim.st))).toEqual([]);
    const a0 = home.storage[p].alloy ?? 0;
    run(sim, 62);       // the old batch completes at its old terms (14), the next starts at the world output (7)
    expect((home.storage[p].alloy ?? 0) - a0).toBe(14);
    expect(home.jobs![0].out).toEqual({ alloy: 7 });
    run(sim, 62);
    expect((home.storage[p].alloy ?? 0) - a0).toBe(21);
    // and it survives save/restore mid-batch
    const s1 = sim.serialize(); expect(new WorldSim(JSON.parse(s1)).serialize()).toBe(s1);
  });
  it('recipeFor returns the world output; static recipe table is never mutated', () => {
    const w = WorldSim.create(5, { econ: 'chain', alloyDirect: 6 }).st;
    expect(recipeFor(w, 'alloy_direct')!.out.alloy).toBe(6);
    expect(RECIPES.alloy_direct.out.alloy).toBe(14);
  });
});

describe('refit service price never undercuts the market', () => {
  it('chain world: buying through the fitting service costs at least the local ask and 1.2 × chain value', () => {
    const w = WorldSim.create(5, { econ: 'chain' });
    for (const s of markets(w.st)) for (const k of Object.keys(s.market!)) if (EQUIPMENT[k]) {
      const ask = w.price(s, k, 'buy'), bid = w.price(s, k, 'sell');
      const unit = fitServiceUnit(w.st, k, ask);
      expect(unit).toBeGreaterThanOrEqual(ask); expect(unit).toBeGreaterThan(bid);
      expect(unit).toBeGreaterThanOrEqual(chainValue(k) * 1.2 - 1e-9);
    }
  });
});

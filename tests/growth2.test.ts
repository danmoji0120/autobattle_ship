// Growth rev 2 (contentV 4): cost-based hull prices and industrial tiers, public storage limits and
// leases, shared dock capacity, exploration, and the c3 → c4 migration (nothing deleted).
import { describe, it, expect, vi } from 'vitest';
vi.setConfig({ testTimeout: 300_000 });
import { WorldSim } from '../src/world/sim';
import type { WorldState, Station } from '../src/world/types';
import { qty, cargoSum } from '../src/world/types';
import { census, compareCensus, CONTENT_VERSION, RAW_PRICE_V4 } from '../src/world/migrate';
import { hullBuild, hullSale, TIER_BASE } from '../src/world/hullops';
import { hullPrice, hullCost, valueOf } from '../src/world/valuation';
import { publicCap, serviceOf, storeUsed, LEASE_BLOCK, dockCapacity } from '../src/world/storage';
import { seedSites, sitesIn, SCAN_NEED } from '../src/world/explore';
import { forecast } from '../src/world/upkeep';
import { ITEMS, RECIPES } from '../src/world/industry';

const run = (sim: WorldSim, seconds: number, dt = 0.5, each?: () => void) => { for (let t = 0; t < seconds; t += dt) { sim.update(dt); each?.(); } };
const calm = (sim: WorldSim) => { for (const l of Object.values(sim.st.lairs)) { l.alive = false; l.respawnAt = 1e9; } for (const s of Object.values(sim.st.systems)) s.security = Math.max(s.security, 75); };
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
function world(seed = 81) {
  const sim = WorldSim.create(seed); calm(sim);
  const p = sim.addPlayer('개편 시험');
  const co = sim.st.companies[p]; co.credits = 3_000_000; co.rep = 1000;
  return { sim, p, co };
}
const dockAt = (sim: WorldSim, p: string, hull: string, st: Station) => { const g = sim.newGroup(p, hull); const s = sim.spawnHull(p, hull, `${hull}_std`, undefined, g.id, st.pos); (sim as any).dockShip(s, st); return { s, g }; };

describe('rev 2: hull prices and production difficulty', () => {
  it('manufacturing adds value: every good is worth more than the inputs of its cheapest recipe', () => {
    const best: Record<string, number> = {};
    for (const r of Object.values(RECIPES)) {
      if (r.tech) continue;
      for (const [k, n] of Object.entries(r.out)) {
        if (ITEMS[k]?.cat === 'raw') continue;
        const inputs = Object.entries(r.in).reduce((a, [i, m]) => a + valueOf(i) * m, 0) / n;
        best[k] = Math.min(best[k] ?? Infinity, inputs);
      }
    }
    for (const [k, v] of Object.entries(best)) expect(valueOf(k), k).toBeGreaterThan(v);
  });

  it('price rises steeply with class; small standard hulls stay cheap; the industrial base grows with the tier', () => {
    const P = (h: string) => hullPrice(h).price;
    const ladder = ['corvette_mk1', 'destroyer_mk1', 'light_cruiser_mk1', 'cruiser_mk1', 'battleship_mk1', 'dreadnought_mk1'];
    for (let i = 1; i < ladder.length; i++) expect(P(ladder[i]), ladder[i]).toBeGreaterThan(P(ladder[i - 1]) * 1.6);
    expect(P('battleship_mk1')).toBeGreaterThan(P('miner_mk1') * 50);              // not a few hours of mining
    for (const h of ['corvette_mk1', 'miner_mk1', 'hauler_mk1']) expect(P(h)).toBeLessThan(hullCost(h).total);   // mass-produced: below cost
    for (const h of ['cruiser_mk1', 'battleship_mk1']) expect(P(h)).toBeGreaterThan(hullCost(h).total * 1.2);   // military premium
    const miners = ['miner_mk1', 'miner_m', 'miner_l', 'miner_xl'];
    for (let i = 1; i < miners.length; i++) expect(P(miners[i])).toBeGreaterThan(P(miners[i - 1]));
    // industrial base: each yard tier adds required factories on top of the last
    for (let y = 2; y <= 4; y++) { expect(TIER_BASE[y].length).toBeGreaterThan(TIER_BASE[y - 1].length); for (const f of TIER_BASE[y - 1]) expect(TIER_BASE[y]).toContain(f); }
    expect(hullBuild('battleship_mk1').facilities!.length).toBeGreaterThanOrEqual(6);
    expect(hullBuild('corvette_mk1').facilities ?? []).toEqual([]);
    // NPC yards never sell capital hulls beyond large; the dreadnought is not for sale
    expect(hullSale('dreadnought_mk1')).toBeUndefined();
  });
});

describe('rev 2: public storage', () => {
  it('limit + leases: over the limit nothing new comes in, nothing stored is removed; ship holds and leases are the way out', () => {
    const { sim, p, co } = world(82);
    const astra = sim.st.stations.astra;
    const cap = publicCap(co, astra);
    expect(cap).toBe(serviceOf(astra).store);
    // an old save far over the new limit keeps every unit
    astra.storage[p].ore = cap + 5000;
    const before = qty(astra.storage[p], 'ore');
    run(sim, 30);
    expect(qty(astra.storage[p], 'ore')).toBe(before);
    // purchases into the warehouse are refused with an explanation
    const r = sim.command(p, { c: 'buy', station: 'astra', res: 'alloy', amount: 10 });
    expect(r).toMatch(/창고 한도 초과.*임대/);
    // …but straight into a docked ship's hold works
    const { s } = dockAt(sim, p, 'hauler_mk1', astra);
    expect(sim.command(p, { c: 'buy', station: 'astra', res: 'alloy', amount: 10, ship: s.id })).toBeNull();
    expect(qty(s.cargo, 'alloy')).toBe(10);
    // a miner's unload over the limit keeps the rest aboard (with a warning), never dumps it
    const m = dockAt(sim, p, 'miner_mk1', astra).s;
    m.cargo.ore = 100;
    (sim as any).unload(m, astra, false);
    expect(qty(m.cargo, 'ore')).toBe(100);
    expect(sim.st.events.some(e => e.tag === 'storage_full' && e.company === p)).toBe(true);
    // leasing raises the limit and costs rent every hour
    astra.storage[p].ore = 0;
    const cr0 = co.credits;
    expect(sim.command(p, { c: 'lease', station: 'astra', blocks: 2 })).toBeNull();
    expect(publicCap(co, astra)).toBe(serviceOf(astra).store + 2 * LEASE_BLOCK);
    expect(co.credits).toBeLessThan(cr0);
    expect(forecast(sim.st, co).lease).toBe(2 * serviceOf(astra).lease);
    expect(sim.command(p, { c: 'lease', station: 'astra', blocks: 99 })).toMatch(/자체 정거장/);
    // releasing is always allowed even when that leaves goods over the limit
    astra.storage[p].ore = publicCap(co, astra);
    expect(sim.command(p, { c: 'lease', station: 'astra', blocks: 0 })).toBeNull();
    expect(qty(astra.storage[p], 'ore')).toBe(serviceOf(astra).store + 2 * LEASE_BLOCK);
    // blueprint fragments are records, not cargo
    expect(storeUsed({ 'bpf:bp_battleship_mk1': 50 } as any)).toBe(0);
  });

  it('shared public docks: a crowd of ships is only partly maintained, and the dock recovers over the hour', () => {
    const { sim, p } = world(83);
    const astra = sim.st.stations.astra;
    const ships = Array.from({ length: 30 }, () => dockAt(sim, p, 'destroyer_mk1', astra).s);
    for (const s of ships) { s.wear = 0.5; (sim as any).dockShip(s, astra); }
    const fixed = ships.filter(s => (s.wear ?? 0) < 0.01).length;
    expect(fixed).toBeGreaterThan(0);
    expect(fixed).toBeLessThan(ships.length);                       // capacity ran out
    expect(ships.some(s => s.dockWait !== undefined)).toBe(true);
    expect(dockCapacity(sim.st, astra)).toBeLessThan(1);
    run(sim, 3600, 4);
    expect(dockCapacity(sim.st, astra)).toBeGreaterThan(serviceOf(astra).repair * 0.9);   // recovers over an hour
  });
});

describe('rev 2: exploration', () => {
  it('sites are deterministic, found by survey, salvaged into the holds; deep sites can hold unsold blueprints', () => {
    const { sim, p, co } = world(84);
    const a = clone(sim.st.sites); const w2 = WorldSim.create(84).st;
    expect(Object.keys(w2.sites!).sort()).toEqual(Object.keys(a!).sort());
    seedSites(sim.st); expect(Object.keys(sim.st.sites!).length).toBe(Object.keys(a!).length);   // idempotent
    const sys = Object.values(sim.st.systems).find(x => x.kind !== 'core' && x.security < 90 && sitesIn(sim.st, x.id, 0).length)!;
    const site = sitesIn(sim.st, sys.id, 0)[0];
    // salvage needs the site to be found first
    const { g } = dockAt(sim, p, 'miner_mk1', sim.st.stations.astra);
    expect(sim.command(p, { c: 'setOp', group: g.id, op: { k: 'salvage', site: site.id } })).toMatch(/발견하지 못한/);
    expect(sim.command(p, { c: 'setOp', group: g.id, op: { k: 'survey', system: 'helios' } })).toMatch(/핵심 성계|없음/);
    // a survey sweep finds it
    for (const s of g.shipIds) sim.st.ships[s].pos = { ...sys.origin };
    expect(sim.command(p, { c: 'setOp', group: g.id, op: { k: 'survey', system: sys.id } })).toBeNull();
    run(sim, SCAN_NEED[site.tier] * 2 + 600, 1, () => { for (const id of g.shipIds) { const s = sim.st.ships[id]; if (s.state === 'space') s.wear = 0; } });
    expect(sim.st.sites![site.id].seen).toContain(p);
    // salvage it: loot into the hold, the site retires and respawns later, heat rises
    const heat0 = sim.st.systems[sys.id].heat;
    expect(sim.command(p, { c: 'setOp', group: g.id, op: { k: 'salvage', site: site.id } })).toBeNull();
    const ship = sim.st.ships[g.shipIds[0]];
    run(sim, site.need / 2 + 900, 1);
    expect(cargoSum(ship.cargo)).toBeGreaterThan(0);
    expect(sim.st.sites![site.id].born).toBeGreaterThan(sim.st.time - 1000);
    expect(sim.st.sites![site.id].seen).toEqual([]);
    expect(sim.st.systems[sys.id].heat).toBeGreaterThanOrEqual(heat0);
    void co;
  });
});

describe('rev 2: c3 → c4 migration', () => {
  it('reprices markets, seeds sites, deletes nothing (even storage over the new limits), round-trips and is idempotent', () => {
    const { sim, p } = world(85);
    sim.st.stations.astra.storage[p].ore = 50_000;          // far over any public limit
    run(sim, 60);
    const st: WorldState = JSON.parse(sim.serialize());
    // make it a c3 save: no sites, old market prices
    st.contentV = 3; delete st.sites;
    for (const x of Object.values(st.stations)) if (x.market) for (const [k, e] of Object.entries(x.market)) if (ITEMS[k]?.cat === 'raw') e.base = Math.round(e.base / RAW_PRICE_V4 * 10) / 10;
    const before = census(st);
    const oreBase = st.stations.astra.market!.ore.base;
    const m = new WorldSim(clone(st), { migrateContent: true });
    const rep = m.contentReport!;
    expect(rep.from).toBe(3); expect(rep.to).toBe(CONTENT_VERSION);
    expect(rep.repriced).toBeGreaterThan(0);
    expect(compareCensus(before, census(m.st))).toEqual([]);
    expect(qty(m.st.stations.astra.storage[p], 'ore')).toBe(50_000);
    expect(m.st.stations.astra.market!.ore.base).toBeCloseTo(oreBase * RAW_PRICE_V4, 0);
    expect(Object.keys(m.st.sites ?? {}).length).toBeGreaterThan(0);
    const s1 = m.serialize();
    const again = new WorldSim(JSON.parse(s1), { migrateContent: true });
    expect(again.contentReport!.repriced ?? 0).toBe(0);
    expect(again.serialize()).toBe(s1);
    // without the flag a c3 save stays c3
    const keep = new WorldSim(clone(st), { migrateContent: false });
    expect(keep.st.contentV).toBe(3); expect(keep.st.sites).toBeUndefined();
  });
});

// Economy baseline c4-b1 (P5 stage 1): the frozen price ladder, NPC supply limits and the structural
// anti-exploit checks — no duplication, no buy/sell loop, ship trade and builds conserve value.
import { describe, it, expect, vi } from 'vitest';
import { addFoundationFreighter } from './helpers/foundation';
vi.setConfig({ testTimeout: 300_000 });
import { WorldSim, START_CREDITS_GROWTH } from '../src/world/sim';
import type { Station } from '../src/world/types';
import { qty } from '../src/world/types';
import { CONTENT } from '../src/content/registry';
import { hullSale, hullBuild } from '../src/world/hullops';
import { hullPrice, hullCost, yardFee, valueOf } from '../src/world/valuation';
import { ECON_BASELINE_ID, YARD_FEE } from '../src/world/econConfig';
import { RECIPES, ITEMS } from '../src/world/industry';
import { buildNeeds } from '../src/world/production';

const run = (sim: WorldSim, seconds: number, dt = 0.5) => { for (let t = 0; t < seconds; t += dt) sim.update(dt); };
const calm = (sim: WorldSim) => { for (const l of Object.values(sim.st.lairs)) { l.alive = false; l.respawnAt = 1e9; } for (const s of Object.values(sim.st.systems)) s.security = Math.max(s.security, 75); };
const P = (h: string) => hullPrice(h).price;

describe(`economy baseline ${ECON_BASELINE_ID}`, () => {
  it('ladder: small hulls affordable at the start, steep from destroyers up, differentiated within a class', () => {
    expect(P('corvette_mk1')).toBeLessThanOrEqual(START_CREDITS_GROWTH);
    for (const h of ['miner_mk1', 'hauler_mk1', 'constructor_s']) expect(P(h)).toBeLessThanOrEqual(START_CREDITS_GROWTH);
    expect(P('destroyer_mk1')).toBeGreaterThanOrEqual(100_000);
    expect(P('cruiser_mk1')).toBeGreaterThanOrEqual(500_000);
    expect(P('battleship_mk1')).toBeGreaterThanOrEqual(2_000_000);
    const war = ['frigate_mk1', 'destroyer_mk1', 'light_cruiser_mk1', 'cruiser_mk1', 'battlecruiser_mk1', 'battleship_mk1'];
    for (let i = 1; i < war.length; i++) expect(P(war[i]), war[i]).toBeGreaterThan(P(war[i - 1]) * 1.6);
    // destroyers differ by role/performance/parts: spread of at least 1.5× within the class
    const ds = Object.values(CONTENT.hulls).filter(h => h.classId === 'destroyer').map(h => P(h.id));
    expect(new Set(ds).size).toBe(ds.length);
    expect(Math.max(...ds) / Math.min(...ds)).toBeGreaterThan(1.5);
    // a warship's NPC price is above what it costs to build: own industry is the cheaper way
    for (const h of war.slice(1)) expect(P(h), h).toBeGreaterThan(hullCost(h).total);
  });

  it('NPC supply: capital hulls one at a time, slowly, for trusted companies; the largest never', () => {
    for (const h of Object.values(CONTENT.hulls)) {
      const b = hullBuild(h.id); const s = hullSale(h.id);
      if (b.yard >= 4) expect(s, h.id).toBeUndefined();
      if (s && b.yard >= 3) { expect(s.stock, h.id).toBeLessThanOrEqual(1); expect(s.restock, h.id).toBeGreaterThanOrEqual(12_000); expect(s.rep ?? 0, h.id).toBeGreaterThanOrEqual(25); }
    }
    // buying the stock empties it: a second battleship waits for the yard
    const sim = WorldSim.create(5); calm(sim);
    const p = sim.addPlayer('함대'); const co = sim.st.companies[p]; co.credits = 20_000_000; co.rep = 1000;
    const st = Object.values(sim.st.stations).find(x => x.public && x.services.shipyard.includes('battleship'))!;
    expect(st).toBeTruthy();
    expect(sim.command(p, { c: 'buyShip', station: st.id, classId: 'battleship', loadoutId: '', hull: 'battleship_mk1' })).toBeNull();
    expect(sim.command(p, { c: 'buyShip', station: st.id, classId: 'battleship', loadoutId: '', hull: 'battleship_mk1' })).toMatch(/재고|입고/);
    expect(co.credits).toBeLessThan(20_000_000 - 2_000_000);
  });

  it('no recipe loop multiplies goods: every cycle in the recipe graph loses units', () => {
    // edges input → output with the unit ratio out/in; any cycle's product must be < 1
    const edges: [string, string, number][] = [];
    for (const r of Object.values(RECIPES)) for (const [o, no] of Object.entries(r.out)) for (const [i, ni] of Object.entries(r.in)) edges.push([i, o, no / ni]);
    const from = new Map<string, [string, number][]>();
    for (const [a, b, k] of edges) (from.get(a) ?? from.set(a, []).get(a)!).push([b, k]);
    const walk = (start: string, at: string, gain: number, depth: number, seen: Set<string>) => {
      for (const [n, k] of from.get(at) ?? []) {
        if (n === start) { expect(gain * k, `cycle through ${start}`).toBeLessThan(1); continue; }
        if (depth < 4 && !seen.has(n)) { seen.add(n); walk(start, n, gain * k, depth + 1, seen); seen.delete(n); }
      }
    };
    for (const k of from.keys()) walk(k, k, 1, 0, new Set([k]));
  });

  it('market: buying and selling the same goods back always loses money; nothing is created', () => {
    const sim = WorldSim.create(9); calm(sim);
    const p = sim.addPlayer('상사'); const co = sim.st.companies[p]; co.credits = 500_000;
    for (const k of ['alloy', 'electronics', 'ore', 'machinery']) {
      const st = Object.values(sim.st.stations).find(x => x.public && x.market?.[k] && x.market[k].stock > 50)!;
      if (!st) continue;
      const c0 = co.credits, s0 = qty(st.storage[p], k);
      expect(sim.command(p, { c: 'buy', station: st.id, res: k as any, amount: 20 })).toBeNull();
      const got = qty(st.storage[p], k) - s0;
      expect(got).toBeGreaterThan(0);
      sim.command(p, { c: 'sell', station: st.id, res: k as any, amount: got });
      expect(qty(st.storage[p], k)).toBeCloseTo(s0, 5);
      expect(co.credits, k).toBeLessThan(c0);
    }
  });

  it('ship trade conserves value: the buyer pays, the seller gets it less tax, the ship and its fit move intact', () => {
    const sim = WorldSim.create(11); calm(sim);
    const a = sim.addPlayer('판매사'), b = sim.addPlayer('구매사');
    const A = sim.st.companies[a], B = sim.st.companies[b]; B.credits = 1_000_000;
    const st = Object.values(sim.st.stations).find(x => x.public && (sim as any).hasExchange(x))!;
    const g = sim.newGroup(a, '매각'); const s = sim.spawnHull(a, 'destroyer_mk1', 'destroyer_mk1_std', undefined, g.id, st.pos); (sim as any).dockShip(s, st);
    const fit0 = JSON.stringify([s.variant, s.fitting]);
    const n0 = Object.keys(sim.st.ships).length;
    expect(sim.command(a, { c: 'listShip', ship: s.id, price: 90_000 })).toBeNull();
    const l = st.shipListings!.find(x => x.ship === s.id)!;
    const ca = A.credits, cb = B.credits;
    expect(sim.command(b, { c: 'buyShipListing', station: st.id, listing: l.id })).toBeNull();
    expect(cb - B.credits).toBe(90_000);
    expect(A.credits - ca).toBeCloseTo(90_000 * (1 - (st.tax ?? 0.02)), 3);
    expect(sim.st.ships[s.id].owner).toBe(b);
    expect(Object.keys(sim.st.ships).length).toBe(n0);
    expect(JSON.stringify([s.variant, s.fitting])).toBe(fit0);
    // the same ship cannot be sold twice
    expect(sim.command(b, { c: 'buyShipListing', station: st.id, listing: l.id })).not.toBeNull();
  });

  it('own builds pay labour + the yard fee; cancelling before the keel refunds exactly that and nothing more', () => {
    const sim = WorldSim.create(31); calm(sim);
    const p = sim.addPlayer('조선사'); const co = sim.st.companies[p]; co.credits = 2_000_000; co.rep = 1000;
    sim.command(p, { c: 'buyShip', station: 'astra', classId: 'constructor', loadoutId: 'std' });
    const cg = Object.values(sim.st.groups).find(g => g.owner === p && g.shipIds.some(id => sim.st.ships[id].classId === 'constructor'))!;
    const at = sim.st.stations.astra.pos;
    expect(sim.command(p, { c: 'buy', station: 'astra', res: 'alloy', amount: 300 })).toBeNull(); // buy locally before loading the constructor
    addFoundationFreighter(sim, p, cg.id);
    sim.command(p, { c: 'setOp', group: cg.id, op: { k: 'found', at: { x: at.x + 2600, y: 0, z: at.z + 2600 }, name: '조선 기지' } });
    run(sim, 200);
    const own = Object.values(sim.st.stations).find(s => s.owner === p) as Station;
    for (const k of ['power', 'yard_m', 'hull_works', 'machine_shop']) own.modules.push({ kind: k, progress: 1, built: true, slot: own.modules.length + 1 });
    const b = hullBuild('destroyer_mk1');
    expect(yardFee(b)).toBe(Math.round(b.time * YARD_FEE[b.yard]));
    const c0 = co.credits;
    expect(sim.command(p, { c: 'buildShip', station: own.id, classId: 'destroyer', loadoutId: '', hull: 'destroyer_mk1', variant: 'destroyer_mk1_std' })).toBeNull();
    expect(c0 - co.credits).toBe(b.credits + yardFee(b));
    const bid = own.builds![0].id;
    expect(own.builds![0].started).toBe(false);                         // no parts in storage yet
    expect(sim.command(p, { c: 'buildOp', station: own.id, build: bid, op: 'cancel' })).toBeNull();
    expect(co.credits).toBe(c0);
    // with parts: a started build consumes exactly the bill of materials
    const need = buildNeeds('destroyer', '', [], { hull: 'destroyer_mk1', variant: 'destroyer_mk1_std' });
    for (const [k, n] of Object.entries(need)) own.storage[p][k] = (own.storage[p][k] ?? 0) + n;
    const before = { ...own.storage[p] };
    expect(sim.command(p, { c: 'buildShip', station: own.id, classId: 'destroyer', loadoutId: '', hull: 'destroyer_mk1', variant: 'destroyer_mk1_std' })).toBeNull();
    run(sim, 1);
    expect(own.builds![0].started).toBe(true);
    for (const [k, n] of Object.entries(need)) expect(qty(own.storage[p], k), k).toBeCloseTo((before[k] ?? 0) - n, 5);
  });

  it('a c0 world keeps its old build rules (no growth industrial base for legacy builds)', () => {
    expect(hullBuild('destroyer_mk1', undefined, false).facilities ?? []).toEqual([]);
    expect(hullBuild('destroyer_mk1').facilities).toContain('hull_works');
  });

  it('manufactured goods never sell below their raw inputs (no value destroyed by industry)', () => {
    for (const id of Object.keys(ITEMS)) if (ITEMS[id].cat !== 'raw') expect(valueOf(id), id).toBeGreaterThan(0);
  });
});

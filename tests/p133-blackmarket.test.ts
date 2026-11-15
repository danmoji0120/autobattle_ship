// P13.3 black markets and smuggling (blackMarketV worlds). Every check reads real ship holds, storage, black-market
// budgets and company credits — not command results alone.
import { afterEach, describe, expect, it } from 'vitest';
import { WorldSim } from '../src/world/sim';
import { qty, type V, type WShip, type WGroup, type Cargo, type Station } from '../src/world/types';
import { BM, bmAt, bmQuote, hotKey, isHot, parseHot, recoveredKey, restrictedAt, inspect, inspectChance, discover, refPrice, seedBlackMarkets, type BlackMarket } from '../src/world/blackmarket';
import { legacyView } from '../src/server/sync';
import { itemName, itemPrice } from '../src/world/industry';
import { sysAt } from '../src/world/geom';

const base = { ...BM };
afterEach(() => { Object.assign(BM, base); });

function fixture(seed = 133, sec = 10) {
  const sim = WorldSim.create(seed, { blackMarket: 'p133' });
  const [A, B, C] = ['약탈 PMC', '피해 PMC', '밀수 PMC'].map(n => sim.addPlayer(n));
  for (const id of Object.keys(sim.st.ships)) delete sim.st.ships[id];
  for (const id of Object.keys(sim.st.groups)) delete sim.st.groups[id];
  for (const l of Object.values(sim.st.lairs)) { l.alive = false; l.respawnAt = 1e10; }
  for (const sys of Object.values(sim.st.systems)) sys.security = sec;
  for (const c of [A, B, C]) sim.st.companies[c].credits = 1e7;
  const a = sim.st.stations.astra;
  const at = (dx: number, dz: number): V => ({ x: a.pos.x + dx, y: 0, z: a.pos.z + dz });
  return { sim, A, B, C, a, at };
}
type F = ReturnType<typeof fixture>;
function fleet(f: F, owner: string, pos: V, comp: string[]): WGroup {
  const g = f.sim.newGroup(owner, `${owner} 편대`);
  g.commanderId = f.sim.newCommander(owner, 2).id;
  comp.forEach((cl, i) => f.sim.spawnShip(owner, cl, 'std', g.id, { x: pos.x + i * 40, y: 0, z: pos.z }));
  return g;
}
const ships = (f: F, g: WGroup) => g.shipIds.map(id => f.sim.st.ships[id]).filter(Boolean) as WShip[];
const until = (sim: WorldSim, cond: () => boolean, seconds = 1500) => { for (let t = 0; t < seconds && !cond(); t += .5) sim.update(.5); return cond(); };
const hostile = (f: F) => expect(f.sim.command(f.A, { c: 'stance', target: f.B, v: -1 })).toBeNull();
function convoy(f: F, cargo: Cargo, pos = f.at(10000, -25000)) {
  const g = fleet(f, f.B, pos, ['hauler']);
  const h = ships(f, g)[0]; Object.assign(h.cargo, cargo); h.logisticsExcluded = true;
  expect(f.sim.command(f.B, { c: 'setOp', group: g.id, op: { k: 'move', to: { x: pos.x - 6000, y: 0, z: pos.z } } })).toBeNull();
  return { g, h };
}
/** every unit of an item (plain and stolen) anywhere: ships, storage, containers, wrecks, lair holds */
function world(f: F, item: string) {
  let n = 0;
  const of = (c: Cargo | undefined) => Object.entries(c ?? {}).reduce((a, [k, v]) => a + (k === item || parseHot(k)?.item === item ? v : 0), 0);
  for (const s of Object.values(f.sim.st.ships)) if ([f.A, f.B, f.C, 'pirates'].includes(s.owner)) n += of(s.cargo);
  for (const st of Object.values(f.sim.st.stations)) for (const c of [f.A, f.B, f.C]) n += of(st.storage[c]);
  for (const d of Object.values(f.sim.st.drops ?? {})) n += d.lots.filter(l => l.item === item || parseHot(l.item)?.item === item).reduce((a, l) => a + l.n, 0);
  for (const w of Object.values(f.sim.st.wrecks ?? {})) n += w.lots.filter(l => l.k === 'cargo' && (l.item === item || parseHot(l.item)?.item === item)).reduce((a, l) => a + l.n, 0);
  for (const l of Object.values(f.sim.st.lairs)) n += of(l.hold);
  return n;
}
const storeOf = (f: F, co: string, key: string) => Object.values(f.sim.st.stations).reduce((a, st) => a + qty(st.storage[co], key), 0);
const bm = (f: F, tier = 'lawless') => f.sim.st.blackMarkets![`bm_${tier}`];
const req = (n: number) => ({ seq: n, id: `req-${String(n).padStart(6, '0')}` });
/** A plunders B's hauler (P13.2 engine) — returns the stolen units that reached A's storage */
function plunder(f: F, cargo: Cargo) {
  hostile(f);
  const v = convoy(f, cargo);
  const ga = fleet(f, f.A, f.at(10000, -21000), ['destroyer', 'frigate', 'hauler']);
  expect(f.sim.command(f.A, { c: 'setOp', group: ga.id, op: { k: 'plunder', group: v.g.id, policy: 'nonlethal' } })).toBeNull();
  expect(until(f.sim, () => !ga.plx && ga.op.k === 'idle', 1500)).toBe(true);
  return { v, ga };
}
function dockHauler(f: F, owner: string, st: Station, cargo: Cargo = {}) {
  const g = fleet(f, owner, { x: st.pos.x + 300, y: 0, z: st.pos.z }, ['hauler']);
  const s = ships(f, g)[0]; s.logisticsExcluded = true; Object.assign(s.cargo, cargo);
  return { g, s };
}

describe('P13.3 A — provenance and conservation', () => {
  it('A01: plundered cargo is stolen goods of its owner (own key), conserved exactly through recovery and unloading', () => {
    const f = fixture();
    const { v } = plunder(f, { ore: 400, alloy: 100 });
    const hotOre = hotKey('ore', f.B), hotAlloy = hotKey('alloy', f.B);
    const got = storeOf(f, f.A, hotOre) + storeOf(f, f.A, hotAlloy);
    expect(got).toBeGreaterThan(0);
    expect(storeOf(f, f.A, 'ore') + storeOf(f, f.A, 'alloy')).toBe(0);           // nothing arrived as plain goods
    expect(qty(v.h.cargo, 'ore') + qty(v.h.cargo, 'alloy')).toBe(500 - got);     // the victim lost exactly that
    expect(world(f, 'ore')).toBe(400); expect(world(f, 'alloy')).toBe(100);
    expect(itemName(hotOre)).toContain('장물'); expect(itemPrice(hotAlloy)).toBe(itemPrice('alloy'));
  });
  it('A02: normal and stolen units stay apart — 100 normal + 40 stolen sell as 100 at a normal market', () => {
    const f = fixture(); const st = f.a; const store = f.sim.storage(st, f.A);
    store.ore = 100; store[hotKey('ore', f.B)] = 40;
    const cr = f.sim.st.companies[f.A].credits;
    expect(f.sim.command(f.A, { c: 'sell', station: st.id, res: 'ore', amount: 140 })).toBeNull();
    expect(qty(store, 'ore')).toBe(0); expect(qty(store, hotKey('ore', f.B))).toBe(40);
    expect(f.sim.st.companies[f.A].credits).toBeGreaterThan(cr);
    expect(f.sim.command(f.A, { c: 'sell', station: st.id, res: hotKey('ore', f.B), amount: 40 })).toBe('거래 불가');
    expect(qty(store, hotKey('ore', f.B))).toBe(40);
  });
  it('A03: laundering paths are closed — exchange listing, automatic logistics, production keys', () => {
    const f = fixture(); const store = f.sim.storage(f.a, f.A); const k = hotKey('alloy', f.B); store[k] = 50;
    expect(f.sim.command(f.A, { c: 'list', station: f.a.id, item: k, qty: 10, price: 100 })).toMatch(/장물|거래소/);
    expect(f.sim.command(f.A, { c: 'poolCreate', request: { from: f.a.id, to: 'helios', item: k, kind: 'transfer', amount: 10, priority: 5, repeat: false } })).not.toBeNull();
    expect(qty(store, k)).toBe(50);
  });
  it('A04: the owner taking its goods back gets plain goods; pirates’ cargo and wreck scrap are never stolen', () => {
    const f = fixture();
    expect(recoveredKey(f.sim.st, f.B, { k: 'cargo', item: 'ore', owner: f.B })).toBe('ore');
    expect(recoveredKey(f.sim.st, f.B, { k: 'cargo', item: hotKey('ore', f.B), owner: f.A })).toBe('ore');
    expect(recoveredKey(f.sim.st, f.C, { k: 'cargo', item: hotKey('ore', f.B), owner: f.A })).toBe(hotKey('ore', f.B));   // provenance stays with the first victim
    expect(recoveredKey(f.sim.st, f.A, { k: 'cargo', item: 'ore', owner: 'pirates' })).toBe('ore');
    expect(recoveredKey(f.sim.st, f.A, { k: 'hull', item: 'metal', owner: f.B })).toBe('metal');
    expect(recoveredKey(f.sim.st, f.A, { k: 'cargo', item: 'bpf:x', owner: f.B })).toBe('bpf:x');
  });
  it('A05: a restart keeps stolen keys, black-market state and recorded inspections exactly', () => {
    const f = fixture(); plunder(f, { alloy: 120 });
    const b = bm(f); b.glut.alloy = 33;
    const s0 = Object.values(f.sim.st.ships)[0]; s0.insp = { 'st:x#1': 'pass' };
    const copy = new WorldSim(JSON.parse(f.sim.serialize()), { migrateContent: false });
    expect(storeOf({ ...f, sim: copy }, f.A, hotKey('alloy', f.B))).toBe(storeOf(f, f.A, hotKey('alloy', f.B)));
    expect(copy.st.blackMarkets).toEqual(f.sim.st.blackMarkets);
    expect(copy.st.ships[s0.id].insp).toEqual({ 'st:x#1': 'pass' });
  });
});

describe('P13.3 B — black-market trades', () => {
  it('B01: an undiscovered market refuses; docking there discovers it; a sale pays only what was taken, from its budget', () => {
    const f = fixture(); const b = bm(f); const st = f.sim.st.stations[b.station];
    const k = hotKey('alloy', f.B); f.sim.storage(st, f.A)[k] = 60;
    expect(f.sim.command(f.A, { c: 'bmSell', station: st.id, res: k, amount: 60 })).toMatch(/암시장/);
    const { s } = dockHauler(f, f.A, st); f.sim.dockShip(s, st);
    expect(f.sim.st.companies[f.A].bm?.known).toContain(b.id);
    const cr = f.sim.st.companies[f.A].credits, funds = b.funds, q = bmQuote(f.sim.st, b, k, 60);
    expect(f.sim.command(f.A, { c: 'bmSell', station: st.id, res: k, amount: 60, request: req(1) })).toBeNull();
    expect(qty(f.sim.storage(st, f.A), k)).toBe(60 - q.sold);
    expect(f.sim.st.companies[f.A].credits - cr).toBeCloseTo(q.net, 6);
    expect(funds - b.funds).toBeCloseTo(q.net, 6);
    expect(q.net).toBeLessThan(q.sold * refPrice(f.sim.st, 'alloy'));       // stolen goods are discounted
    // duplicate request: no second sale
    f.sim.storage(st, f.A)[k] = 10;
    expect(f.sim.command(f.A, { c: 'bmSell', station: st.id, res: k, amount: 60, request: req(1) })).toBeNull();
    expect(qty(f.sim.storage(st, f.A), k)).toBe(10);
  });
  it('B02: price falls with what the market absorbed; a short budget buys part, an empty one refuses', () => {
    const f = fixture(); const b = bm(f); const st = f.sim.st.stations[b.station];
    discover(f.sim, f.A, b, 'test');
    const k = hotKey('alloy', f.B);
    const p0 = bmQuote(f.sim.st, b, k, 10).net; b.glut.alloy = 200; const p1 = bmQuote(f.sim.st, b, k, 10).net;
    expect(p1).toBeLessThan(p0);
    b.glut = {}; b.funds = p0 * 2.5; f.sim.storage(st, f.A)[k] = 100;
    expect(f.sim.command(f.A, { c: 'bmSell', station: st.id, res: k, amount: 100 })).toBeNull();
    const left = qty(f.sim.storage(st, f.A), k);
    expect(left).toBeGreaterThan(0); expect(left).toBeLessThan(100); expect(b.funds).toBeGreaterThanOrEqual(-1e-6);
    b.funds = 0;
    expect(f.sim.command(f.A, { c: 'bmSell', station: st.id, res: k, amount: 10 })).toMatch(/자금/);
    expect(qty(f.sim.storage(st, f.A), k)).toBe(left);
  });
  it('B03: invalid requests change nothing — normal goods, bad amounts, goods not there, selling twice', () => {
    const f = fixture(); const b = bm(f); const st = f.sim.st.stations[b.station]; discover(f.sim, f.A, b, 'test');
    const store = f.sim.storage(st, f.A); store.alloy = 50; const k = hotKey('alloy', f.B); store[k] = 20;
    const cr = f.sim.st.companies[f.A].credits;
    expect(f.sim.command(f.A, { c: 'bmSell', station: st.id, res: 'alloy', amount: 50 })).toMatch(/정상 화물/);
    for (const amount of [-5, 0, NaN, Infinity]) expect(f.sim.command(f.A, { c: 'bmSell', station: st.id, res: k, amount })).toMatch(/수량/);
    expect(f.sim.command(f.A, { c: 'bmSell', station: st.id, res: '__proto__', amount: 1 })).not.toBeNull();
    expect(f.sim.command(f.A, { c: 'bmSell', station: st.id, res: hotKey('ore', f.B), amount: 1 })).toMatch(/없습니다/);
    expect(f.sim.st.companies[f.A].credits).toBe(cr);
    expect(f.sim.command(f.A, { c: 'bmSell', station: st.id, res: k, amount: 20 })).toBeNull();
    const after = f.sim.st.companies[f.A].credits;
    expect(f.sim.command(f.A, { c: 'bmSell', station: st.id, res: k, amount: 20 })).toMatch(/없습니다/);
    expect(f.sim.st.companies[f.A].credits).toBe(after);
    expect(qty(store, 'alloy')).toBe(50);
  });
  it('B04: buying restricted goods takes real stock and credits; out of stock and short of money refuse', () => {
    const f = fixture(); const b = bm(f); const st = f.sim.st.stations[b.station]; discover(f.sim, f.C, b, 'test');
    const stock0 = b.stock.mod_ecm.n, cr = f.sim.st.companies[f.C].credits;
    expect(f.sim.command(f.C, { c: 'bmBuy', station: st.id, res: 'mod_ecm', amount: 5 })).toBeNull();
    expect(b.stock.mod_ecm.n).toBe(stock0 - 5); expect(qty(f.sim.storage(st, f.C), 'mod_ecm')).toBe(5);
    expect(cr - f.sim.st.companies[f.C].credits).toBeGreaterThan(0);
    b.stock.mod_ecm.n = 0;
    expect(f.sim.command(f.C, { c: 'bmBuy', station: st.id, res: 'mod_ecm', amount: 1 })).toMatch(/재고/);
    b.stock.mod_ecm.n = 5; f.sim.st.companies[f.C].credits = 1;
    expect(f.sim.command(f.C, { c: 'bmBuy', station: st.id, res: 'mod_ecm', amount: 1 })).toMatch(/자금/);
    expect(f.sim.command(f.C, { c: 'bmBuy', station: st.id, res: 'ore', amount: 1 })).toMatch(/팔지 않/);
  });
  it('B05: the budget is moved from the host station’s public budget, never created', () => {
    const f = fixture(); const b = bm(f); const host = f.sim.st.stations[b.station];
    b.funds = 0; const total0 = b.funds + (host.funds ?? 0);
    const regen = (host.fundsMax ?? 0) * 0.15 / 3600;
    f.sim.update(0.5);
    // the host also regenerates its own public budget (fundsStep); the black market only moves money out of it
    expect(b.funds).toBeGreaterThan(0);
    expect(b.funds + (host.funds ?? 0)).toBeLessThanOrEqual(total0 + regen * 0.5 + 1e-6);
  });
});

describe('P13.3 C — inspections and smuggling', () => {
  it('C01: no law, own station, or only normal cargo → no inspection at all', () => {
    const f = fixture(133, 10);
    const st = f.sim.st.stations.helios; const sys = sysAt(f.sim.st.systems, st.pos)!;
    const { s } = dockHauler(f, f.A, st, { [hotKey('alloy', f.B)]: 50 });
    expect(inspect(f.sim, s, 'dock', sys, st)).toBeNull();                       // security 10: the law does not reach
    sys.security = 100;
    const clean = dockHauler(f, f.C, st, { alloy: 200, mod_ecm: 0 }).s;
    expect(inspect(f.sim, clean, 'dock', sys, st)).toBeNull();                  // normal cargo is never checked
    expect(inspectChance(f.sim.st, f.A, sys, 'dock', { [hotKey('alloy', f.B)]: 50 }, { ...st, public: false, owner: f.A } as Station)).toBe(0);
    expect(inspectChance(f.sim.st, f.A, sys, 'dock', { [hotKey('alloy', f.B)]: 50 }, st)).toBeGreaterThan(0);
    expect(restrictedAt(f.sim.st, st)).toEqual(expect.arrayContaining(['mod_ecm', 'eq_heavy_cannon']));
  });
  it('C02: a seizure takes exactly the illicit units, returns stolen goods to their owner, fines; normal cargo stays', () => {
    const f = fixture(133, 100); BM.dockBase = 10; BM.maxChance = 1;
    const st = f.sim.st.stations.helios; const k = hotKey('alloy', f.B);
    const { s } = dockHauler(f, f.A, st, { [k]: 70, alloy: 30, mod_ecm: 4 });
    const home = f.sim.st.stations[f.sim.st.companies[f.B].homeStation];
    const back0 = qty(home.storage[f.B], 'alloy'), cr = f.sim.st.companies[f.A].credits, funds0 = st.funds ?? 0, rep0 = f.sim.st.companies[f.A].rep;
    f.sim.dockShip(s, st);
    expect(qty(s.cargo, k)).toBe(0); expect(qty(s.cargo, 'mod_ecm')).toBe(0); expect(qty(s.cargo, 'alloy')).toBe(30);
    expect(qty(home.storage[f.B], 'alloy') - back0).toBe(70);
    const fine = cr - f.sim.st.companies[f.A].credits;
    expect(fine).toBeGreaterThan(0); expect((st.funds ?? 0) - funds0).toBeCloseTo(fine * 0.7, 3);
    expect(f.sim.st.companies[f.A].rep).toBeLessThanOrEqual(rep0);
    expect(f.sim.st.companies[f.A].bm?.log?.some(e => e.k === 'seize')).toBe(true);
    expect(f.sim.st.companies[f.B].bm?.log?.some(e => e.k === 'return')).toBe(true);
    expect(world(f, 'alloy')).toBe(100);
  });
  it('C03: undock/redock and restart in the same window replay the recorded outcome (no new roll)', () => {
    const f = fixture(133, 100); BM.dockBase = 1e-6;
    const st = f.sim.st.stations.helios; const k = hotKey('alloy', f.B);
    const { s } = dockHauler(f, f.A, st, { [k]: 40 });
    f.sim.dockShip(s, st);
    expect(Object.values(s.insp ?? {})).toEqual(['pass']);
    BM.dockBase = 10; BM.maxChance = 1;                                             // even a certain catch now …
    f.sim.undock(s); f.sim.dockShip(s, st);
    expect(qty(s.cargo, k)).toBe(40);                                               // … replays the recorded pass
    const copy = new WorldSim(JSON.parse(f.sim.serialize()), { migrateContent: false });
    const s2 = copy.st.ships[s.id]; copy.undock(s2); copy.dockShip(s2, copy.st.stations.helios);
    expect(qty(s2.cargo, k)).toBe(40);
    // a seizure, retried in the same window, seizes again (no free second attempt)
    f.sim.st.time += BM.window; f.sim.undock(s); f.sim.dockShip(s, st);
    expect(qty(s.cargo, k)).toBe(0);
    s.cargo[k] = 10; f.sim.undock(s); f.sim.dockShip(s, st);
    expect(qty(s.cargo, k)).toBe(0);
  });
  it('C04: higher security means a higher chance (same cargo, same standing)', () => {
    const f = fixture(); const st = f.sim.st.stations.helios; const sys = sysAt(f.sim.st.systems, st.pos)!;
    const c = { [hotKey('alloy', f.B)]: 100 };
    const ps = [30, 60, 90].map(sec => { sys.security = sec; return inspectChance(f.sim.st, f.A, sys, 'dock', c, st); });
    expect(ps[0]).toBeLessThan(ps[1]); expect(ps[1]).toBeLessThan(ps[2]);
    sys.security = 90;
    expect(inspectChance(f.sim.st, f.A, sys, 'gate', c)).toBeLessThan(ps[2]);
  });
  it('C05/PASS: plunder → stolen goods unloaded → physical smuggling run → sold at the black market; exact credits and units', () => {
    const f = fixture();
    plunder(f, { alloy: 200 });
    const k = hotKey('alloy', f.B);
    const from = Object.values(f.sim.st.stations).find(st => qty(st.storage[f.A], k) > 0)!;
    const stolen = qty(from.storage[f.A], k);
    const b = bm(f); const dest = f.sim.st.stations[b.station];
    discover(f.sim, f.A, b, 'test');
    const g = fleet(f, f.A, { x: from.pos.x + 400, y: 0, z: from.pos.z }, ['hauler']);
    ships(f, g)[0].logisticsExcluded = true;
    const cr0 = f.sim.st.companies[f.A].credits, funds0 = b.funds;
    expect(f.sim.command(f.A, { c: 'setOp', group: g.id, op: { k: 'smuggle', from: from.id, to: dest.id, sell: true } })).toBeNull();
    expect(until(f.sim, () => g.op.k === 'idle', 6000)).toBe(true);
    const sold = b.took, paid = b.paid;
    expect(sold).toBeGreaterThan(0);
    const aboard = qty(ships(f, g)[0].cargo, k);
    expect(sold + aboard + qty(from.storage[f.A], k)).toBe(stolen);                 // every stolen unit accounted for
    expect(funds0 - b.funds).toBeLessThanOrEqual(paid + 1e-6);
    const delta = f.sim.st.companies[f.A].credits - cr0;
    expect(delta).toBeLessThanOrEqual(paid + 1e-6);                                  // no more than the market paid (upkeep may take some)
    expect(delta).toBeGreaterThan(paid * 0.5);
    expect(world(f, 'alloy')).toBe(200 - sold);                                       // sold units left the world, nothing created
    expect(g.smug?.why).toMatch(/처분/);
  });
});

describe('P13.3 D/E — privacy and legacy', () => {
  it('D01: other companies see neither unknown black markets, the trade/inspection log nor inspection records', () => {
    const f = fixture(); const b = bm(f); discover(f.sim, f.A, b, 'test');
    const { s } = dockHauler(f, f.A, f.a); s.insp = { 'st:x#0': 'pass' };
    const vA = legacyView(f.sim.st, { company: f.A } as any, 'astra') as any, vC = legacyView(f.sim.st, { company: f.C } as any, 'astra') as any;
    expect(Object.keys(vA.blackMarkets)).toEqual([b.id]);
    expect(Object.keys(vC.blackMarkets)).toEqual([]);
    expect(vC.companies[f.A].bm).toBeUndefined();
    expect(vC.ships[s.id]?.insp).toBeUndefined();
  });
  it('E01: a world without the opt-in has no black markets and plain recovery', () => {
    const sim = WorldSim.create(133, { piracy: 'p132' });
    expect(sim.st.blackMarketV).toBeUndefined(); expect(sim.st.blackMarkets).toBeUndefined();
    seedBlackMarkets(sim); expect(sim.st.blackMarkets).toBeUndefined();
    expect(recoveredKey(sim.st, 'x', { k: 'cargo', item: 'ore', owner: 'y' })).toBe('ore');
    expect(sim.command(sim.addPlayer('x'), { c: 'bmSell', station: 'rustport', res: 'hot:ore:y', amount: 1 })).toMatch(/암시장/);
  });
  it('E02: placement is deterministic per seed and one market per region type', () => {
    const a = WorldSim.create(5, { blackMarket: 'p133' }).st.blackMarkets!, b = WorldSim.create(5, { blackMarket: 'p133' }).st.blackMarkets!;
    expect(Object.values(a).map(x => x.station)).toEqual(Object.values(b).map(x => x.station));
    expect(Object.keys(a).sort()).toEqual(['bm_border', 'bm_lawless', 'bm_neutral', 'bm_secure']);
    void isHot; void bmAt; void ({} as BlackMarket);
  });
});

describe('P13.3 D — protocol 2 replication', () => {
  it('D02: a protocol 2 client holds exactly the legacy view (only known black markets) before and after a discovery', async () => {
    const { GameServer } = await import('../src/server/core');
    const { applySync, SYNC_PROTO } = await import('../src/server/sync');
    const g = new GameServer(null, { singleplayer: false, snapInterval: 1, blackMarketNew: true } as any, 133);
    const wire = (x: unknown) => JSON.parse(JSON.stringify(x));
    const mk = (id: string, proto: number | undefined) => {
      const cl: { conn: any; state: any } = { conn: null, state: null };
      cl.conn = { id, lastEvent: 0, battles: new Set(), send: (m: any) => { if (m.t === 'snap') cl.state = wire(m.state); }, sendText: (s: string) => { const m = JSON.parse(s); if (m.t === 'sd') cl.state = applySync(cl.state, m); else if (m.t === 'snap') cl.state = m.state; } };
      g.connect(cl.conn); g.handle(id, { t: 'hello', name: `PMC ${id}`, proto } as any); return cl;
    };
    const A = mk('a', SYNC_PROTO), B = mk('b', SYNC_PROTO), L = mk('l', undefined);
    const st = g.sim.st, b = st.blackMarkets!.bm_lawless;
    const same = () => { for (const c of [A, B, L]) expect(wire(c.state)).toEqual(wire(legacyView(st, c.conn, (g as any).viewOf(c.conn)))); };
    for (let i = 0; i < 40; i++) g.step(0.05);
    same(); expect(Object.keys(A.state.blackMarkets ?? {})).toEqual([]);
    discover(g.sim, A.conn.company, b, 'test');
    for (let i = 0; i < 400; i++) g.step(0.05);          // budgets regenerate, glut decays: the known market keeps changing
    same();
    expect(Object.keys(A.state.blackMarkets)).toEqual([b.id]);
    expect(A.state.blackMarkets[b.id].funds).toBe(wire(b).funds);
    expect(Object.keys(B.state.blackMarkets ?? {})).toEqual([]);
    expect(B.state.companies[A.conn.company].bm).toBeUndefined();
  });
});

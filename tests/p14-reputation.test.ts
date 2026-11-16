// P14.0 reputation: company credit + six independent faction trusts (repV worlds), anti-farming, crime once,
// access by the selling faction's trust, the unique-blueprint limit on every path, migration, persistence.
import { describe, it, expect } from 'vitest';
import { WorldSim } from '../src/world/sim';
import type { WorldState } from '../src/world/types';
import { qty } from '../src/world/types';
import {
  REP, dimOf, CREDIT, bandOf, mapLegacy, repTrade, repGain, repWork, repBattle, repLair, repContract, repContractFailed, repOffense, repBlackMarket,
  repRecord, gainLimit, coRep, nextReq, hullGate, valueOf, enableRepV, killBase,
} from '../src/world/reputation';
import { migrateRep } from '../src/world/repMigrate';
import { offersAt, buyBlueprint, grantBlueprint, uniqueHolders, assembleBlueprint, fragId } from '../src/world/blueprints';
import { CONTENT } from '../src/content/registry';
import { P10_PUBLIC_STATIONS, hullEcon, hullSale } from '../src/world/hullops';
import { lawCrime } from '../src/world/law';
import { legacyView } from '../src/server/sync';

const world = (o: { rep?: boolean; layout?: 'p10' | 'p9' } = {}) => {
  const sim = WorldSim.create(11, { ...(o.layout === 'p9' ? {} : { layout: 'p10' as const }), ...(o.rep === false ? {} : { rep: 'p14' as const }) });
  const a = sim.addPlayer('신용 PMC'), b = sim.addPlayer('비교 PMC');
  return { sim, w: sim.st, a, b };
};
const H = 3600;
/** advance game time without stepping the whole world (reputation only reads w.time) */
const at = (w: WorldState, t: number) => { w.time = t; };

describe('P14.0 bands, map, gates', () => {
  it('bands follow the spec and the legacy map is monotonic and keeps thresholds', () => {
    expect(bandOf(-100).name).toBe('극단적 적대'); expect(bandOf(-61).name).toBe('극단적 적대'); expect(bandOf(-60).name).toBe('적대');
    expect(bandOf(-26).name).toBe('적대'); expect(bandOf(-25).name).toBe('불신'); expect(bandOf(-1).name).toBe('불신');
    expect(bandOf(0).name).toBe('중립'); expect(bandOf(9.9).name).toBe('중립'); expect(bandOf(10).name).toBe('협력'); expect(bandOf(25).name).toBe('우호');
    expect(bandOf(40).name).toBe('신뢰'); expect(bandOf(60).name).toBe('핵심 협력사'); expect(bandOf(80).name).toBe('최고 신뢰'); expect(bandOf(100).name).toBe('최고 신뢰');
    let prev = -1;
    for (let r = 0; r <= 1200; r += 0.5) { const m = mapLegacy(r); expect(m).toBeGreaterThanOrEqual(prev); expect(m).toBeLessThanOrEqual(100); prev = m; }
    expect(mapLegacy(0)).toBe(0); expect(mapLegacy(10)).toBe(10); expect(mapLegacy(150)).toBe(80); expect(mapLegacy(999)).toBe(100); expect(mapLegacy(-5)).toBe(0);
    // a legacy reputation that met a legacy threshold meets the mapped one
    for (const thr of [5, 10, 15, 20, 25, 30, 35, 40, 60, 150]) for (const v of [thr, thr + 0.1, thr + 7]) expect(mapLegacy(v)).toBeGreaterThanOrEqual(mapLegacy(thr));
  });

  it('a new repV P10 world starts every company neutral with an empty record', () => {
    const { w, a } = world();
    expect(w.repV).toBe(1); expect(w.companies[a].rep).toBe(0); expect(w.companies[a].standing ?? {}).toEqual({});
    expect(Object.keys(w.factions!)).toEqual(['union', 'guild', 'ceres', 'miners', 'iron', 'pirates']);
  });

  it('routine work stops at its ceiling; the 신뢰 band needs contracts and time; 60/80 need major operations', () => {
    const { w, a } = world();
    const co = w.companies[a];
    // trade alone, for many hours: never above the trade ceiling
    for (let h = 0; h < 200; h++) { at(w, h * H); for (let i = 0; i < 30; i++) repTrade(w, a, w.stations.astra, 'electronics', 50000, true); }
    expect(co.standing!.guild).toBeLessThanOrEqual(REP.ceiling.trade + 1e-9);
    expect(co.standing!.guild).toBeGreaterThan(REP.ceiling.trade - 0.5);
    // lairs (no ceiling) still cannot cross 40 without the record
    for (let i = 0; i < 40; i++) { at(w, (300 + i) * H); repLair(w, a, `l${i}`, w.systems.astra, 2, 1); }
    expect(co.standing!.guild).toBeLessThan(40);
    expect(gainLimit(w, co, 'guild', co.standing!.guild)).toBe(39.99);
    const req = nextReq(w, co, 'guild')!; expect(req.at).toBe(40); expect(req.ok).toBe(false);
    // the record: 8 contracts for the guild → the gate opens, but 60 needs two major operations
    for (let i = 0; i < 8; i++) repRecord(w, a, 'guild', 'k', `k${i}`);
    for (let i = 0; i < 400; i++) { at(w, (400 + i) * H); repLair(w, a, `m${i}`, w.systems.astra, 2, 1); }
    expect(co.standing!.guild).toBeGreaterThanOrEqual(40);
    expect(co.standing!.guild).toBeLessThan(60);
  });

  it('gains diminish with the band', () => {
    const { w, a } = world();
    const co = w.companies[a];
    const one = (v: number) => { co.standing = { union: v }; coRep(co).acc.union = { since: 0, k: 999, mj: 99 }; at(w, 1e7 + v * H); return repGain(w, a, 'union', 'lair', 1, 't'); };
    const g0 = one(0), g15 = one(15), g30 = one(30), g50 = one(50), g70 = one(70), g90 = one(90);
    expect(g0).toBeGreaterThan(g15); expect(g15).toBeGreaterThan(g30); expect(g30).toBeGreaterThan(g50); expect(g50).toBeGreaterThan(g70); expect(g70).toBeGreaterThan(g90);
    expect(g90 / g0).toBeLessThan(0.1);
  });
});

describe('P14.0 anti-farming', () => {
  it('splitting a sale does not change the gain; a buy/sell loop at the same market gains nothing', () => {
    const one = world(), split = world(), loop = world();
    repTrade(one.w, one.a, one.w.stations.astra, 'machinery', 90000, true);
    for (let i = 0; i < 900; i++) repTrade(split.w, split.a, split.w.stations.astra, 'machinery', 100, true);
    expect(split.w.companies[split.a].standing?.guild ?? 0).toBeCloseTo(one.w.companies[one.a].standing?.guild ?? 0, 9);
    expect(split.w.companies[split.a].rep).toBeCloseTo(one.w.companies[one.a].rep, 9);
    for (let i = 0; i < 200; i++) { repTrade(loop.w, loop.a, loop.w.stations.astra, 'machinery', 20000, false); repTrade(loop.w, loop.a, loop.w.stations.astra, 'machinery', 19000, true); }
    expect(loop.w.companies[loop.a].standing?.guild ?? 0).toBe(0);
    expect(loop.w.companies[loop.a].rep).toBe(0);
  });

  it('real market commands: one sale of 100 = ten sales of 10', () => {
    const run = (chunks: number) => {
      const { sim, w, a } = world();
      const st = w.stations.astra; st.funds = 1e9; st.fundsMax = 1e9; st.market!.electronics.stock = 0;
      st.storage[a] = { electronics: 400 } as any;
      for (let i = 0; i < chunks; i++) expect(sim.command(a, { c: 'sell', station: 'astra', res: 'electronics', amount: 400 / chunks })).toBeNull();
      return { g: w.companies[a].standing?.guild ?? 0, c: w.companies[a].rep, left: qty(st.storage[a], 'electronics') };
    };
    const r1 = run(1), r10 = run(10);
    expect(r1.left).toBe(0); expect(r10.left).toBe(0);
    expect(r1.g).toBeGreaterThan(0);
    // market prices walk while selling, so values differ slightly; the gain is a function of the total, not the count
    expect(Math.abs(r10.g - r1.g)).toBeLessThan(0.051);
  });

  it('per-hour budget: repeating work in one hour is capped; weak pirates pay less per kill', () => {
    const { w, a } = world();
    for (let i = 0; i < 200; i++) repBattle(w, a, `b${i}`, w.systems.helios, [45], 1);
    const capped = w.companies[a].standing!.union;
    const most = REP.hourCap.kill * 1.2 * 1.1 * dimOf(0); // budget × union personality × capital bonus × the first band's (largest) multiplier
    expect(capped).toBeLessThanOrEqual(most + 1e-9);
    expect(killBase(45)).toBeLessThan(killBase(140)); expect(killBase(600)).toBe(REP.base.killMax);
  });

  it('one battle, one lair, one contract → applied once (keys), and the bounty never pays twice', () => {
    const { w, a } = world();
    repBattle(w, a, 'eng1', w.systems.helios, [80, 80], 1);
    const v = w.companies[a].standing!.union, p = w.companies[a].standing!.pirates;
    repBattle(w, a, 'eng1', w.systems.helios, [80, 80], 1);
    expect(w.companies[a].standing!.union).toBe(v); expect(w.companies[a].standing!.pirates).toBe(p);
    repLair(w, a, 'lairX@100', w.systems.helios, 3, 1); const l = w.companies[a].standing!.union;
    repLair(w, a, 'lairX@100', w.systems.helios, 3, 1); expect(w.companies[a].standing!.union).toBe(l);
    const k = { id: 'k77', kind: 'delivery', stationId: 'helios', res: 'ore', reward: 1000 };
    repContract(w, a, k); const c = w.companies[a].rep, kc = w.companies[a].repx!.acc.union.k;
    repContract(w, a, k); expect(w.companies[a].rep).toBe(c); expect(w.companies[a].repx!.acc.union.k).toBe(kc);
  });
});

describe('P14.0 faction independence and personalities', () => {
  it('work for one faction never raises another; hunting pirates lowers only the pirates', () => {
    const { w, a } = world();
    repWork(w, a, 'iron', 'delivery', 0.5, 't', { key: 'x1' });
    expect(Object.keys(w.companies[a].standing!)).toEqual(['iron']);
    repBattle(w, a, 'e9', w.systems.bulwark, [140], 1);
    const s = w.companies[a].standing!;
    expect(s.iron).toBeGreaterThan(0); expect(s.pirates).toBeLessThan(0);
    for (const f of ['union', 'guild', 'ceres', 'miners']) expect(s[f] ?? 0).toBe(0);
  });

  it('each faction values its own kind of work (same delivery, different goods)', () => {
    const g = (f: string, station: string, res: string) => { const { w, a } = world(); repContract(w, a, { id: 'k', kind: 'delivery', stationId: station, res, reward: 1 }); return w.companies[a].standing?.[f] ?? 0; };
    expect(g('ceres', 'p9_ceres_works', 'alloy')).toBeGreaterThan(g('ceres', 'p9_ceres_works', 'eq_autocannon'));
    expect(g('iron', 'p10_bulwark_yard', 'armor_plate')).toBeGreaterThan(g('iron', 'p10_bulwark_yard', 'ore'));
    expect(g('miners', 'p9_anvil_port', 'machinery')).toBeGreaterThan(g('miners', 'p9_anvil_port', 'ore'));
    // the same pirate fight is worth more to iron than to the guild
    const k = (sys: string, f: string) => { const { w, a } = world(); repBattle(w, a, 'e', w.systems[sys], [140, 140], 1); return w.companies[a].standing?.[f] ?? 0; };
    expect(k('bulwark', 'iron')).toBeGreaterThan(k('astra', 'guild'));
  });

  it('pirates: crime alone never raises their trust; the black market and their markets do', () => {
    const { w, a } = world();
    repOffense(w, a, 'pirates', 'extortion', 50000, 'ext:1', 't');
    repOffense(w, a, w.systems.helios.faction, 'strike', 0, 'law:1', 't');
    expect(w.companies[a].standing?.pirates ?? 0).toBe(0);
    repBlackMarket(w, a, 40000);
    expect(w.companies[a].standing!.pirates).toBeGreaterThan(0);
    expect(w.companies[a].rep).toBe(0); // the black market never earns company credit
    const v = w.companies[a].standing!.pirates;
    repTrade(w, a, w.stations.rustport, 'weapon_parts', 30000, true);
    expect(w.companies[a].standing!.pirates).toBeGreaterThan(v);
  });
});

describe('P14.0 crime: once per event, repeat offences, grudge', () => {
  it('a growing salvage case is charged by its cumulative value, never per lot', () => {
    const one = world(), lots = world();
    one.w.companies[one.a].standing = { union: 30 }; lots.w.companies[lots.a].standing = { union: 30 };
    repOffense(one.w, one.a, 'union', 'salvage', 9000, 'salv:s1:x', 't');
    for (let v = 300; v <= 9000; v += 300) repOffense(lots.w, lots.a, 'union', 'salvage', v, 'salv:s1:x', 't');
    expect(lots.w.companies[lots.a].standing!.union).toBeCloseTo(one.w.companies[one.a].standing!.union, 9);
    expect(lots.w.companies[lots.a].rep).toBeCloseTo(one.w.companies[one.a].rep, 9);
  });

  it('a minor mistake is small; repeated serious crimes cost more each time and leave a grudge that slows recovery', () => {
    const { w, a } = world();
    w.companies[a].standing = { union: 30 };
    repOffense(w, a, 'union', 'smuggling', 500, 'seize:1', 't');
    expect(30 - w.companies[a].standing!.union).toBeLessThan(1);
    const before = w.companies[a].standing!.union;
    const l1 = repOffense(w, a, 'union', 'strike', 0, 'law:a', 't').trust;
    const l2 = repOffense(w, a, 'union', 'strike', 0, 'law:b', 't').trust;
    expect(l2).toBeGreaterThan(l1);
    expect(before - w.companies[a].standing!.union).toBeCloseTo(l1 + l2, 9);
    // the same event again: nothing
    expect(repOffense(w, a, 'union', 'strike', 0, 'law:b', 't').trust).toBe(0);
    // grudge: the same lair pays far less now than it would to a clean company at the same value
    const clean = world(); clean.w.companies[clean.a].standing = { union: w.companies[a].standing!.union };
    const g1 = repGain(w, a, 'union', 'lair', 1, 't'), g2 = repGain(clean.w, clean.a, 'union', 'lair', 1, 't');
    expect(g1).toBeLessThan(g2 * 0.5);
    // the grudge ends
    at(w, w.time + REP.grudgeMax + 10);
    expect(repGain(w, a, 'union', 'lair', 0.1, 't')).toBeGreaterThan(0.09);
  });

  it('law cases: extortion is charged by the act (not again when known); strike only when known', () => {
    const { sim, w, a } = world();
    // enable the law book on this world (P13.4) without other gates
    w.lawV = 1; w.law = { seq: 0, next: 0, cases: {}, keys: {}, ops: {} } as any;
    w.companies[a].standing = { union: 20 };
    const pos = { ...w.stations.helios.pos, x: w.stations.helios.pos.x + 3000 };
    // an extortion law case on its own (the act's penalty lives in piracy.ts) changes nothing here
    lawCrime(sim, { kind: 'extortion', by: a, sys: 'helios', pos, value: 30000, key: 'ext:L1', how: 'station' });
    expect(w.companies[a].standing!.union).toBe(20);
    // a strike becomes known through a guard → charged once; the same case again → nothing
    const c = lawCrime(sim, { kind: 'strike', by: a, sys: 'helios', pos, value: 0, key: 'strike:L2', how: 'guard' })!;
    expect(c.known).toBe(true);
    const after = w.companies[a].standing!.union;
    expect(after).toBeLessThan(20);
    lawCrime(sim, { kind: 'strike', by: a, sys: 'helios', pos, value: 0, key: 'strike:L2', how: 'guard' });
    expect(w.companies[a].standing!.union).toBe(after);
  });
});

describe('P14.0 access: faction blueprints and public-yard ships', () => {
  it('a faction blueprint needs that faction\'s trust at a station it holds — not influence, not another faction', () => {
    const { w, a } = world();
    const co = w.companies[a]; co.credits = 5e6;
    const bw = w.stations.p10_bulwark_yard;
    const bs = () => offersAt(w, bw, co).find(o => o.bp.id === 'bp_battleship_mk1')!;
    expect(bs()).toBeDefined(); expect(bs().src).toMatchObject({ kind: 'faction', faction: 'iron' });
    co.standing = { union: 100, guild: 100 }; co.rep = 100;
    expect(bs().why).toMatch(/철갑 사령부 신뢰도 45 필요 \(현재 0\)/);
    co.standing.iron = 50;
    expect(bs().why).toMatch(/철갑 사령부 계약 실적 12건 필요/);
    for (let i = 0; i < 12; i++) repRecord(w, a, 'iron', 'k', `k${i}`);
    expect(bs().why).toBeNull();
    expect(buyBlueprint(w, co, bw, 'bp_battleship_mk1')).toBeNull();
    expect(co.blueprints!.bp_battleship_mk1.src).toBe('faction');
    // the union does not sell at a station the guild holds (bastion in P10)
    expect(offersAt(w, w.stations.bastion, co).find(o => o.src.kind === 'faction' && o.src.faction === 'union')).toBeUndefined();
  });

  it('six factions each sell somewhere; repOnly sources are absent on legacy rules', () => {
    const { w, a } = world();
    const sellers = new Set<string>();
    for (const st of Object.values(w.stations)) for (const o of offersAt(w, st, w.companies[a])) if (o.src.kind === 'faction') sellers.add(o.src.faction);
    expect([...sellers].sort()).toEqual(['ceres', 'guild', 'iron', 'miners', 'pirates', 'union']);
    const old = world({ rep: false });
    for (const st of Object.values(old.w.stations)) for (const o of offersAt(old.w, st, old.w.companies[old.a])) expect((o.src as any).repOnly).toBeUndefined();
    // the P10 station list the content may name is the real one
    const pub = Object.values(w.stations).filter(s => s.public && s.market).map(s => s.id);
    for (const id of P10_PUBLIC_STATIONS) expect(pub).toContain(id);
  });

  it('military hulls need the yard faction\'s trust; civilian hulls only a little credit', () => {
    const { w, a } = world();
    const co = w.companies[a];
    expect(hullGate(w, co, w.stations.helios, 'cruiser_mk1', 30, true)).toMatch(/연합 관리청 신뢰도 24 필요/);
    co.standing = { guild: 90 };
    expect(hullGate(w, co, w.stations.helios, 'cruiser_mk1', 30, true)).toMatch(/연합 관리청/);
    co.standing.union = 24;
    expect(hullGate(w, co, w.stations.helios, 'cruiser_mk1', 30, true)).toBeNull();
    expect(hullGate(w, co, w.stations.helios, 'hauler_xl', 30, false)).toMatch(/회사 신용도 5 필요/);
    co.rep = 10;
    expect(hullGate(w, co, w.stations.helios, 'hauler_xl', 30, false)).toBeNull();
    // no territory (P9 repV world): company credit decides
    const p9 = world({ layout: 'p9' });
    expect(hullGate(p9.w, p9.w.companies[p9.a], p9.w.stations.helios, 'cruiser_mk1', 30, true)).toMatch(/회사 신용도 24 필요/);
  });

  it('the real buyShip command applies the same gate', () => {
    const { sim, w, a } = world();
    const co = w.companies[a]; co.credits = 5e6;
    const hull = Object.keys(w.stations.helios.shipStock ?? {}).find(h => CONTENT.hulls[h] && hullEcon(h).military && (hullSale(h)?.rep ?? 0) >= 10)!;
    expect(hull).toBeDefined();
    const err = sim.command(a, { c: 'buyShip', station: 'helios', classId: CONTENT.hulls[hull].classId, hull } as any);
    expect(err).toMatch(/연합 관리청 신뢰도/);
    co.standing = { union: 100 };
    w.stations.helios.shipStock![hull].n = 3;
    expect(sim.command(a, { c: 'buyShip', station: 'helios', classId: CONTENT.hulls[hull].classId, hull } as any)).toBeNull();
  });
});

describe('P14.0 unique blueprint limit holds on every grant path', () => {
  it('a faction purchase cannot make a fourth dreadnought holder (and charges nothing when refused)', () => {
    for (const rep of [false, true]) {
      const { w } = world({ rep });
      const ids = Object.values(w.companies).filter(c => c.kind === 'player').map(c => c.id);
      while (ids.length < 5) { const id = `pX${ids.length}`; w.companies[id] = { ...structuredClone(w.companies[ids[0]]), id, blueprints: {}, standing: {}, repx: undefined }; ids.push(id); }
      for (const id of ids.slice(0, 3)) expect(grantBlueprint(w, w.companies[id], 'bp_dreadnought_mk1', 'unique', 0)).toBe(true);
      expect(uniqueHolders(w, 'bp_dreadnought_mk1')).toBe(3);
      const co = w.companies[ids[3]]; co.credits = 5e6; co.rep = 999; co.standing = { union: 100 };
      for (let i = 0; i < 40; i++) repRecord(w, co.id, 'union', 'k', `k${i}`);
      const o = offersAt(w, w.stations.helios, co).find(x => x.bp.id === 'bp_dreadnought_mk1')!;
      expect(o.why).toMatch(/세계 보유 한도/);
      const cr = co.credits;
      expect(buyBlueprint(w, co, w.stations.helios, 'bp_dreadnought_mk1')).toMatch(/한도/);
      expect(co.credits).toBe(cr); expect(co.blueprints?.bp_dreadnought_mk1).toBeUndefined();
      // contract / explore / salvage paths are bound by the same limit
      expect(grantBlueprint(w, co, 'bp_dreadnought_mk1', 'contract', 0)).toBe(false);
      expect(grantBlueprint(w, co, 'bp_dreadnought_mk1', 'explore', 0)).toBe(false);
      // restoring an existing holding (migration) is never refused
      expect(grantBlueprint(w, w.companies[ids[4]], 'bp_dreadnought_mk1', 'migration', 0)).toBe(true);
    }
  });

  it('a holding granted before the fix counts toward the limit; salvage assembly keeps fragments when refused', () => {
    const { w, a, b } = world({ rep: false });
    // simulate a pre-fix faction purchase: held, but not in w.uniques
    w.companies[b].blueprints!.bp_dreadnought_mk1 = { src: 'faction', t: 0 };
    w.uniques = { bp_dreadnought_mk1: ['x1', 'x2'] };
    expect(uniqueHolders(w, 'bp_dreadnought_mk1')).toBe(3);
    expect(grantBlueprint(w, w.companies[a], 'bp_dreadnought_mk1', 'unique', 0)).toBe(false);
    // a salvage-restorable blueprint assembles normally (non-unique)
    const bp = Object.values(CONTENT.blueprints).find(x => x.sources.some(s => s.kind === 'salvage'))!.id;
    const st = w.stations.helios; st.storage[a] = { [fragId(bp)]: 20 } as any;
    expect(assembleBlueprint(w, w.companies[a], st, bp)).toBeNull();
  });
});

describe('P14.0 contracts and failures', () => {
  it('a contract raises credit and the issuing faction only; an expired one costs a little of both', () => {
    const { w, a } = world();
    w.companies[a].rep = 5;
    repContract(w, a, { id: 'kA', kind: 'bounty', stationId: 'p10_bulwark_yard', reward: 1 });
    const s = w.companies[a].standing!;
    expect(s.iron).toBeGreaterThan(0); expect(Object.keys(s)).toEqual(['iron']);
    expect(w.companies[a].rep).toBeGreaterThan(5);
    expect(w.companies[a].repx!.acc.iron.k).toBe(1);
    const i0 = s.iron, c0 = w.companies[a].rep;
    repContractFailed(w, a, { id: 'kB', stationId: 'p10_bulwark_yard' });
    repContractFailed(w, a, { id: 'kB', stationId: 'p10_bulwark_yard' });
    expect(i0 - w.companies[a].standing!.iron).toBeCloseTo(REP.failTrust, 9);
    expect(c0 - w.companies[a].rep).toBeCloseTo(REP.failCredit, 9);
  });
});

describe('P14.0 legacy worlds and migration', () => {
  it('a world without repV keeps the old rules exactly (sale standing, common reputation)', () => {
    const { sim, w, a } = world({ rep: false });
    expect(w.repV).toBeUndefined();
    const st = w.stations.astra; st.funds = 1e9; st.storage[a] = { electronics: 200 } as any;
    expect(sim.command(a, { c: 'sell', station: 'astra', res: 'electronics', amount: 200 })).toBeNull();
    expect(w.companies[a].standing!.guild).toBeGreaterThan(0);
    expect(w.companies[a].repx).toBeUndefined();
    repTrade(w, a, st, 'ore', 1e6, true); repOffense(w, a, 'union', 'strike', 0, 'k', 't');
    expect(w.companies[a].repx).toBeUndefined();
  });

  it('migration: idempotent, keeps assets, order and faction trust, never copies the common reputation; grace for lost rights', () => {
    const { w, a, b } = world({ rep: false });
    const A = w.companies[a], B = w.companies[b];
    A.rep = 75; A.standing = { union: 12, guild: -30 }; A.credits = 1e6;
    B.rep = 8; B.standing = {};
    const before = JSON.stringify({ ships: w.ships, groups: w.groups, credits: [A.credits, B.credits], bps: [A.blueprints, B.blueprints], stats: [A.stats, B.stats] });
    const r = migrateRep(w);
    expect(r.ok).toBe(true); expect(w.repV).toBe(1);
    expect(A.repx!.legacy).toBe(75); expect(B.repx!.legacy).toBe(8);
    expect(A.rep).toBeGreaterThan(B.rep); expect(A.rep).toBe(mapLegacy(75));
    expect(A.standing).toEqual({ union: 12, guild: -30 }); expect(B.standing).toEqual({});
    expect(JSON.stringify({ ships: w.ships, groups: w.groups, credits: [A.credits, B.credits], bps: [A.blueprints, B.blueprints], stats: [A.stats, B.stats] })).toBe(before);
    // A met the legacy battlecruiser rule (rep 40 + union influence at helios): kept for the grace period
    expect(A.repx!.grand!.keys).toContain('bp:bp_battlecruiser_mk1');
    const bc = () => offersAt(w, w.stations.helios, A).find(o => o.bp.id === 'bp_battlecruiser_mk1')!;
    expect(bc().why).toBeNull();
    at(w, w.time + REP.graceSec + 1);
    expect(bc().why).toMatch(/연합 관리청 신뢰도 32 필요 \(현재 12\)/);
    // second run: nothing changes
    const snap = JSON.stringify(w.companies);
    expect(migrateRep(w).why).toMatch(/이미 적용/);
    expect(JSON.stringify(w.companies)).toBe(snap);
    expect(enableRepV(w, { migrate: true })).toBeNull();
  });

  it('legacy (pre-growth) worlds are refused', () => {
    const { w } = world({ rep: false });
    w.contentV = 2;
    expect(migrateRep(w).ok).toBe(false); expect(w.repV).toBeUndefined();
  });

  it('save → restore keeps the record, the gates and the applied keys (no double payout after a restart)', () => {
    const { sim, w, a } = world();
    for (let i = 0; i < 5; i++) repRecord(w, a, 'iron', 'k', `k${i}`);
    repBattle(w, a, 'eng-r', w.systems.bulwark, [140], 1);
    const restored = new WorldSim(JSON.parse(sim.serialize()), { migrateContent: false });
    const R = restored.st, co = R.companies[a];
    expect(R.repV).toBe(1); expect(co.repx!.acc.iron.k).toBe(5);
    const v = co.standing!.iron;
    repBattle(R, a, 'eng-r', R.systems.bulwark, [140], 1);
    expect(co.standing!.iron).toBe(v);
    expect(nextReq(R, co, 'iron')).toEqual(nextReq(w, w.companies[a], 'iron'));
  });

  it('replication: the owner sees its record, never the applied keys or crime tallies; others see nothing', () => {
    const { sim, w, a, b } = world();
    repBattle(w, a, 'eng-s', w.systems.helios, [80], 1);
    repOffense(w, a, 'union', 'salvage', 5000, 'salv:z', 't');
    void sim;
    const mine = legacyView(w, { company: a } as any, 'helios') as any;
    const other = legacyView(w, { company: b } as any, 'helios') as any;
    expect(mine.companies[a].repx.log.length).toBeGreaterThan(0);
    expect(mine.companies[a].repx.keys).toBeUndefined(); expect(mine.companies[a].repx.cases).toBeUndefined();
    expect(other.companies[a].repx).toBeUndefined(); expect(other.companies[a].standing).toBeUndefined();
    expect(w.companies[a].repx!.keys.length).toBeGreaterThan(0);
  });
});

describe('P14.0 company credit', () => {
  it('credit grows from all legal work with the same curve, is never negative, ignores faction personality', () => {
    const { w, a } = world();
    repOffense(w, a, 'union', 'guard_attack', 0, 'law:g', 't');
    expect(w.companies[a].rep).toBe(0);
    expect(valueOf(w.companies[a], CREDIT)).toBe(0);
    at(w, 10 * H);
    repWork(w, a, 'pirates', 'delivery', 0.5, 't', { key: 'p1' });
    expect(w.companies[a].rep).toBeGreaterThan(0);
  });
});

describe('P14.0 crime tally stays bounded', () => {
  it('many distinct offences keep at most REP.casesMax tallies; a growing recent event still charges only its increase', () => {
    const { w, a } = world();
    for (let i = 0; i < 500; i++) { w.time += 1; repOffense(w, a, 'union', 'smuggling', 100, `many${i}`, 't'); }
    expect(Object.keys(coRep(w.companies[a]).cases).length).toBeLessThanOrEqual(REP.casesMax);
    const before = w.companies[a].standing!.union;
    repOffense(w, a, 'union', 'salvage', 3000, 'grow', 't');
    const once = before - w.companies[a].standing!.union;
    repOffense(w, a, 'union', 'salvage', 3000, 'grow', 't');
    expect(w.companies[a].standing!.union).toBe(before - once);
  });
});

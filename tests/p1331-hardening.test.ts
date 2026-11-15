// P13.3.1 black-market hardening: customs return lots (no instant transfer home, no warehouse overflow, claim with a
// docked ship within real capacity), safety-first automatic unloading of stolen goods, the lane-raid "no black market"
// reason, and black-market discovery through P10 deep intel. Every check reads real holds, storage and company state.
import { afterEach, describe, expect, it } from 'vitest';
import { WorldSim } from '../src/world/sim';
import { qty, type V, type WShip, type WGroup, type Cargo, type Station } from '../src/world/types';
import { BM, NO_BM_WHY, customsHeld, discover, hotKey, inspect, parseHot, unloadRisk } from '../src/world/blackmarket';
import { legacyView } from '../src/server/sync';
import { sysAt } from '../src/world/geom';
import { econOf } from '../src/world/hullops';

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
const until = (sim: WorldSim, cond: () => boolean, seconds = 1500, dt = .5) => { for (let t = 0; t < seconds && !cond(); t += dt) sim.update(dt); return cond(); };
function dockHauler(f: F, owner: string, st: Station, cargo: Cargo = {}) {
  const g = fleet(f, owner, { x: st.pos.x + 300, y: 0, z: st.pos.z }, ['hauler']);
  const s = ships(f, g)[0]; s.logisticsExcluded = true; Object.assign(s.cargo, cargo);
  return { g, s };
}
/** every unit of an item (plain and stolen) anywhere incl. customs lots */
function world(f: F, item: string) {
  let n = 0;
  const of = (c: Cargo | undefined) => Object.entries(c ?? {}).reduce((a, [k, v]) => a + (k === item || parseHot(k)?.item === item ? v : 0), 0);
  for (const s of Object.values(f.sim.st.ships)) n += of(s.cargo);
  for (const st of Object.values(f.sim.st.stations)) for (const c of [f.A, f.B, f.C]) n += of(st.storage[c]);
  for (const c of [f.A, f.B, f.C]) n += customsHeld(f.sim.st.companies[c], item);
  return n;
}
/** A's hauler carrying B's stolen alloy is caught docking at helios (certain catch) */
function seizeAtHelios(f: F, n = 120) {
  BM.dockBase = 10; BM.maxChance = 1;
  const st = f.sim.st.stations.helios;
  const { s } = dockHauler(f, f.A, st, { [hotKey('alloy', f.B)]: n });
  f.sim.dockShip(s, st);
  Object.assign(BM, base);
  return st;
}

describe('P13.3.1 — customs return lots (decision 4)', () => {
  it('H01: a seizure keeps the goods at the seizing station’s customs: no transfer home, no storage overflow, conserved', () => {
    const f = fixture(133, 100);
    const home = f.sim.st.stations[f.sim.st.companies[f.B].homeStation];
    const before = JSON.stringify(Object.values(f.sim.st.stations).map(st => st.storage[f.B] ?? {}));
    const st = seizeAtHelios(f);
    expect(home.id).not.toBe(st.id);
    expect(JSON.stringify(Object.values(f.sim.st.stations).map(x => x.storage[f.B] ?? {}))).toBe(before);   // no storage anywhere grew
    const lots = f.sim.st.companies[f.B].bm!.customs!;
    expect(lots).toEqual([expect.objectContaining({ item: 'alloy', n: 120, station: st.id, from: f.A })]);
    expect(world(f, 'alloy')).toBe(120);
    expect(f.sim.st.companies[f.B].bm!.log!.at(-1)).toMatchObject({ k: 'held', at: st.id });
    // a second seizure of the same goods at the same station merges into one lot
    seizeAtHelios(f, 30);
    expect(f.sim.st.companies[f.B].bm!.customs).toEqual([expect.objectContaining({ n: 150, station: st.id })]);
  });

  it('H02: a gate seizure goes to a public station of that system the owner may dock at (not the owner’s home)', () => {
    const f = fixture(133, 100); BM.gateBase = 10; BM.maxChance = 1;
    const st = f.sim.st.stations.helios, sys = sysAt(f.sim.st.systems, st.pos)!;
    const g = fleet(f, f.A, { x: sys.origin.x + 500, y: 0, z: sys.origin.z }, ['hauler']);
    const s = ships(f, g)[0]; s.cargo[hotKey('ore', f.B)] = 50;
    expect(inspect(f.sim, s, 'gate', sys)).toBe('seize');
    const lot = f.sim.st.companies[f.B].bm!.customs![0];
    const office = f.sim.st.stations[lot.station];
    expect(office.public).toBe(true);
    expect(sysAt(f.sim.st.systems, office.pos)!.id).toBe(sys.id);
    expect(lot.n).toBe(50);
  });

  it('H03: claiming needs an own ship docked there, moves only what really fits (hold or storage), the rest waits', () => {
    const f = fixture(133, 100);
    const st = seizeAtHelios(f, 500);
    const lot = () => f.sim.st.companies[f.B].bm?.customs?.[0];
    const id = lot()!.id;
    // no ship there
    const far = fleet(f, f.B, f.at(5000, 0), ['hauler']);
    expect(f.sim.command(f.B, { c: 'customsClaim', lot: id, ship: ships(f, far)[0].id })).toMatch(/정박 중인 함선/);
    // another company cannot claim it
    const { s: cs } = dockHauler(f, f.C, st); f.sim.dockShip(cs, st);
    expect(f.sim.command(f.C, { c: 'customsClaim', lot: id, ship: cs.id })).toMatch(/대기 화물이 없습니다/);
    // B docks a hauler with a part-full hold: only the free hold moves
    const { s } = dockHauler(f, f.B, st, { ore: 0 }); f.sim.dockShip(s, st);
    const cap = Math.floor(econOf(s).cargo);
    s.cargo.ore = cap - 40;
    expect(f.sim.command(f.B, { c: 'customsClaim', lot: id, ship: s.id })).toBeNull();
    expect(qty(s.cargo, 'alloy')).toBe(40);
    expect(lot()!.n).toBe(460);
    // full hold → refused, nothing moves
    expect(f.sim.command(f.B, { c: 'customsClaim', lot: id, ship: s.id })).toMatch(/화물칸 부족/);
    expect(lot()!.n).toBe(460);
    // storage: only the real room at this station
    const free = Math.floor(f.sim.intakeRoom(st, f.B, 'alloy'));
    (st.storage[f.B] ??= {} as any).ore = (st.storage[f.B].ore ?? 0) + free - 100;          // only 100 units of room left
    const room = Math.floor(f.sim.intakeRoom(st, f.B, 'alloy'));
    expect(room).toBe(100);
    const store0 = qty(st.storage[f.B], 'alloy');
    expect(f.sim.command(f.B, { c: 'customsClaim', lot: id, ship: s.id, toStorage: true })).toBeNull();
    const moved = qty(st.storage[f.B], 'alloy') - store0;
    expect(moved).toBe(Math.min(460, room));
    expect(f.sim.intakeRoom(st, f.B, 'alloy')).toBeGreaterThanOrEqual(-1e-9);                // never over the cap
    expect((lot()?.n ?? 0) + moved + 40).toBe(500);
    expect(world(f, 'alloy')).toBe(500);
    expect(lot()!.n).toBe(360);                                                                // the rest keeps waiting
    {
      expect(f.sim.command(f.B, { c: 'customsClaim', lot: id, ship: s.id, toStorage: true })).toMatch(/창고|보관|공간|임대/);
      expect(world(f, 'alloy')).toBe(500);
    }
  });

  it('H04: lots are not stock — they cannot be sold, used by production/construction, and survive save/restore', () => {
    const f = fixture(133, 100);
    const st = seizeAtHelios(f, 80);
    expect(f.sim.st.stations[st.id].storage[f.B]?.alloy ?? 0).toBe(0);
    expect(f.sim.command(f.B, { c: 'sell', station: st.id, res: 'alloy', amount: 10 })).not.toBeNull();   // nothing to sell
    // the company inventory used by production/construction planning reads storage and holds only
    const inv = Object.values(f.sim.st.stations).reduce((a, x) => a + qty(x.storage[f.B], 'alloy'), 0);
    expect(inv).toBe(0);
    const copy = new WorldSim(JSON.parse(f.sim.serialize()), { migrateContent: false });
    expect(copy.st.companies[f.B].bm?.customs).toEqual(f.sim.st.companies[f.B].bm?.customs);
    // claim after restore works the same
    const { s } = (() => { const g = copy.newGroup(f.B, 'B2'); g.commanderId = copy.newCommander(f.B, 2).id; const sh = copy.spawnShip(f.B, 'hauler', 'std', g.id, { x: st.pos.x + 300, y: 0, z: st.pos.z }); return { s: sh }; })();
    s.logisticsExcluded = true; copy.dockShip(s, copy.st.stations[st.id]);
    expect(copy.command(f.B, { c: 'customsClaim', lot: copy.st.companies[f.B].bm!.customs![0].id, ship: s.id })).toBeNull();
    expect(qty(s.cargo, 'alloy')).toBe(80);
    expect(copy.st.companies[f.B].bm?.customs).toBeUndefined();
  });

  it('H05: other companies never see a company’s customs lots', () => {
    const f = fixture(133, 100);
    seizeAtHelios(f, 60);
    const vB = legacyView(f.sim.st, { company: f.B } as any, 'astra') as any, vA = legacyView(f.sim.st, { company: f.A } as any, 'astra') as any;
    expect(vB.companies[f.B].bm.customs[0].n).toBe(60);
    expect(vA.companies[f.B].bm).toBeUndefined();
  });
});

describe('P13.3.1 — safety-first automatic unloading (decision 3)', () => {
  /** an A hauler fleet with stolen salvage aboard, in an auto-unload run (P13.1 recover engine via a P13.2 container) */
  function loadedSalvager(f: F) {
    const g = fleet(f, f.A, f.at(3000, 2000), ['hauler']);
    const s = ships(f, g)[0]; s.logisticsExcluded = true;
    const k = hotKey('alloy', f.B);
    s.cargo[k] = 90; s.salvaged = { [k]: 90 };
    return { g, s, k };
  }
  it('S01: risk is 0 at an own/private or lawless station and > 0 at a policed public station', () => {
    const f = fixture(133, 100);
    const { g, s } = loadedSalvager(f);
    const pubs = Object.values(f.sim.st.stations).filter(x => x.public);
    expect(pubs.every(x => unloadRisk(f.sim, f.A, s.pos, x, [s]) > 0)).toBe(true);
    for (const sys of Object.values(f.sim.st.systems)) sys.security = 10;
    expect(pubs.every(x => unloadRisk(f.sim, f.A, s.pos, x, [s]) === 0)).toBe(true);
    // normal cargo only: never a risk
    for (const sys of Object.values(f.sim.st.systems)) sys.security = 100;
    const clean = ships(f, fleet(f, f.A, f.at(0, 0), ['hauler']))[0]; clean.cargo.alloy = 100;
    expect(pubs.every(x => unloadRisk(f.sim, f.A, clean.pos, x, [clean]) === 0)).toBe(true);
    // pirates / NPCs are never inspected
    expect(unloadRisk(f.sim, 'pirates', s.pos, pubs[0], [s])).toBe(0);
    void g;
  });

  it('S02: with no safe station the fleet keeps the stolen goods aboard, waits (blocked) and warns; once safe it unloads', () => {
    const f = fixture(133, 100);
    const { g, s, k } = loadedSalvager(f);
    // a P13.2 container to recover: the recover order unloads automatically when done
    const drop = { id: 'dp_t', kind: 'drop', name: '테스트 컨테이너', system: sysAt(f.sim.st.systems, s.pos)!.id, pos: { ...s.pos, x: s.pos.x + 200 }, created: 0, expires: 1e9, ship: 'x', owner: f.C, by: f.A, ev: 'e', lots: [{ id: 'l1', k: 'cargo', item: 'ore', n: 5, owner: f.A }], initial: 5, taken: {}, seen: [f.A] };
    (f.sim.st.drops ??= {})[drop.id] = drop as any;
    expect(f.sim.command(f.A, { c: 'setOp', group: g.id, op: { k: 'recover', wreck: drop.id } })).toBeNull();
    const warns = () => f.sim.st.events.filter(e => /장물 안전 하역지 없음/.test(e.text)).length;
    expect(until(f.sim, () => g.salv?.phase === 'blocked', 300)).toBe(true);
    expect(g.salv!.why).toMatch(/장물 안전 하역지 없음/);
    expect(qty(s.cargo, k)).toBe(90);                                                     // cargo preserved
    expect(Object.values(f.sim.st.stations).reduce((a, x) => a + qty(x.storage[f.A], k), 0)).toBe(0);
    expect(s.state).not.toBe('docked');
    expect(warns()).toBe(1);
    // stays waiting (throttled warning, no second message within the interval)
    f.sim.update(30);
    expect(g.salv?.phase).toBe('blocked'); expect(qty(s.cargo, k)).toBe(90);
    expect(warns()).toBe(1);
    // the law leaves the region → a safe station appears → it unloads there
    for (const sys of Object.values(f.sim.st.systems)) sys.security = 10;
    expect(until(f.sim, () => Object.values(f.sim.st.stations).reduce((a, x) => a + qty(x.storage[f.A], k), 0) === 90, 3000)).toBe(true);
    expect(qty(s.cargo, k)).toBe(0);
    expect(f.sim.st.companies[f.A].bm?.log?.some(e => e.k === 'seize') ?? false).toBe(false);
  });

  it('S03: an explicit order still goes into risk (manual dock at a policed station is inspected)', () => {
    const f = fixture(133, 100); BM.dockBase = 10; BM.maxChance = 1;
    const { s, k } = loadedSalvager(f);
    const st = f.sim.st.stations.helios;
    s.pos = { x: st.pos.x + 300, y: 0, z: st.pos.z };
    f.sim.dockShip(s, st);                                                                // the player docked it there
    expect(qty(s.cargo, k)).toBe(0);
    expect(f.sim.st.companies[f.A].bm?.log?.some(e => e.k === 'seize')).toBe(true);
  });
});

describe('P13.3.1 — lane raid without a known black market (decision 2)', () => {
  it('R01: the raid tells why it picks no target, without learning anything about undiscovered markets', () => {
    const f = fixture(133, 10);
    expect(f.sim.command(f.A, { c: 'stance', target: f.B, v: -1 })).toBeNull();
    const pos = f.at(10000, -25000);
    const v = fleet(f, f.B, pos, ['hauler']); const h = ships(f, v)[0]; h.cargo.alloy = 300; h.logisticsExcluded = true;
    expect(f.sim.command(f.B, { c: 'setOp', group: v.id, op: { k: 'move', to: { x: pos.x - 6000, y: 0, z: pos.z } } })).toBeNull();
    const ga = fleet(f, f.A, f.at(10000, -22000), ['destroyer', 'frigate', 'hauler']);
    expect(f.sim.command(f.A, { c: 'setOp', group: ga.id, op: { k: 'plunder', at: pos, radius: 3000, policy: 'nonlethal' } })).toBeNull();
    const known0 = JSON.stringify(f.sim.st.companies[f.A].bm ?? null);
    expect(until(f.sim, () => !!ga.plx?.why, 60)).toBe(true);
    expect(ga.plx!.why).toContain(NO_BM_WHY);
    expect(ga.plx!.target).toBeUndefined();
    expect(JSON.stringify(f.sim.st.companies[f.A].bm ?? null)).toBe(known0);              // nothing discovered for it
    // once it knows a black market, the usual target choice resumes
    discover(f.sim, f.A, f.sim.st.blackMarkets!.bm_lawless, 'test');
    expect(until(f.sim, () => !!ga.plx?.target || (!!ga.plx?.why && !ga.plx.why.includes('암시장 미발견')), 120)).toBe(true);
    // a directly designated target is still allowed without a black market
    const f2 = fixture(134, 10);
    expect(f2.sim.command(f2.A, { c: 'stance', target: f2.B, v: -1 })).toBeNull();
    const v2 = fleet(f2, f2.B, f2.at(10000, -25000), ['hauler']); ships(f2, v2)[0].cargo.alloy = 100;
    const g2 = fleet(f2, f2.A, f2.at(10000, -22000), ['destroyer']);
    expect(f2.sim.command(f2.A, { c: 'setOp', group: g2.id, op: { k: 'plunder', group: v2.id, policy: 'nonlethal' } })).toBeNull();
  });
});

describe('P13.3.1 — P10 deep intel discovers a black market (isolated integration)', () => {
  it('P01: surveying the black market’s system to intel level 3 reveals it to that company only, and its view gets it', () => {
    const sim = WorldSim.create(1330, { layout: 'p10', blackMarket: 'p133', factionEcon: 'v2' });
    expect(sim.st.fog).toBe(1);
    const A = sim.addPlayer('정보 PMC'), C = sim.addPlayer('무관 PMC');
    const b = Object.values(sim.st.blackMarkets!)[0];
    const st = sim.st.stations[b.station], sys = sysAt(sim.st.systems, st.pos)!;
    expect(sim.st.companies[A].bm?.known ?? []).not.toContain(b.id);
    const g = sim.newGroup(A, '탐사대'); g.commanderId = sim.newCommander(A, 2).id;
    for (let i = 0; i < 4; i++) sim.spawnShip(A, 'hauler', 'std', g.id, { x: sys.origin.x + 800 + i * 60, y: 0, z: sys.origin.z });
    expect(sim.command(A, { c: 'setOp', group: g.id, op: { k: 'survey', system: sys.id } })).toBeNull();
    // no docking at the black market station on the way: the only path is the survey
    expect(until(sim, () => (sim.st.intel?.[A]?.sys[sys.id] ?? 0) >= 3, 1500, 1)).toBe(true);
    expect(Object.values(sim.st.ships).filter(s => s.owner === A).every(s => !(s.state === 'docked' && (s.task as any).station === st.id))).toBe(true);
    expect(until(sim, () => !!sim.st.companies[A].bm?.known.includes(b.id), 61, 1)).toBe(true);
    expect(sim.st.companies[A].bm!.log!.some(e => e.k === 'found' && e.at === b.station && /성계 정밀 정보/.test(e.why ?? ''))).toBe(true);
    expect(sim.st.companies[C].bm?.known ?? []).not.toContain(b.id);
    const vA = legacyView(sim.st, { company: A } as any, st.id) as any, vC = legacyView(sim.st, { company: C } as any, st.id) as any;
    expect(Object.keys(vA.blackMarkets)).toContain(b.id);
    expect(Object.keys(vC.blackMarkets)).not.toContain(b.id);
  }, 60000);
});

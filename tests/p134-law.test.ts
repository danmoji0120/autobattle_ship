// P13.4 law enforcement (lawV worlds). Every check runs the real world: crimes come from the real piracy / salvage /
// inspection / battle paths or the case API they all call, guards are the existing Union patrol / response fleets
// flying with real speed and gates, battles are real P11 engagements, money and cargo are read from real holds,
// storage and credits.
import { afterEach, describe, expect, it } from 'vitest';
import { WorldSim } from '../src/world/sim';
import { qty, type V, type WShip, type WGroup, type Cargo } from '../src/world/types';
import { LAW, lawCrime, wanted, jurisdiction, witness, policedSystems, lawBook, levelOf } from '../src/world/law';
import { BM, hotKey, inspect, customsOffice } from '../src/world/blackmarket';
import { demand } from '../src/world/piracy';
import { coRelation } from '../src/world/battleAuth';
import { legacyView } from '../src/server/sync';
import { sysAt, dist } from '../src/world/geom';
import { econOf } from '../src/world/hullops';

const lawBase = JSON.parse(JSON.stringify(LAW)), bmBase = { ...BM };
afterEach(() => { Object.assign(LAW, JSON.parse(JSON.stringify(lawBase))); Object.assign(BM, bmBase); });

/** a lawV world with its real Union forces; every other fleet and all pirates removed; three player companies */
function fixture(opts: { layout?: 'p10' } = {}) {
  const sim = WorldSim.create(133, { law: 'p134', ...opts });
  const [A, B, C] = ['수배 PMC', '피해 PMC', '제3 PMC'].map(n => sim.addPlayer(n));
  sim.update(1);
  for (const g of Object.values(sim.st.groups)) if (g.owner !== 'union') { for (const id of g.shipIds) delete sim.st.ships[id]; delete sim.st.groups[g.id]; }
  for (const l of Object.values(sim.st.lairs)) { l.alive = false; l.respawnAt = 1e10; }
  for (const c of [A, B, C]) sim.st.companies[c].credits = 1e6;
  const a = sim.st.stations.astra;
  const at = (dx: number, dz: number): V => ({ x: a.pos.x + dx, y: 0, z: a.pos.z + dz });
  return { sim, A, B, C, a, at };
}
type F = ReturnType<typeof fixture>;
function fleet(f: F, owner: string, pos: V, comp: string[], lo = 'std'): WGroup {
  const g = f.sim.newGroup(owner, `${f.sim.st.companies[owner]?.name ?? owner} 편대 ${Object.keys(f.sim.st.groups).length}`);
  g.commanderId = f.sim.newCommander(owner, 2).id;
  comp.forEach((cl, i) => f.sim.spawnShip(owner, cl, lo, g.id, { x: pos.x + i * 40, y: 0, z: pos.z }));
  return g;
}
const ships = (f: F, g: WGroup) => g.shipIds.map(id => f.sim.st.ships[id]).filter(Boolean) as WShip[];
const run = (sim: WorldSim, seconds: number, dt = .5) => { for (let t = 0; t < seconds; t += dt) sim.update(dt); };
const until = (sim: WorldSim, cond: () => boolean, seconds = 900, dt = .5) => { for (let t = 0; t < seconds && !cond(); t += dt) sim.update(dt); return cond(); };
const cases = (f: F, co?: string) => Object.values(f.sim.st.law?.cases ?? {}).filter(c => !co || c.by === co);
const ops = (f: F) => Object.values(f.sim.st.law?.ops ?? {});
const guards = (f: F) => Object.values(f.sim.st.groups).filter(g => g.owner === 'union' && g.npc);
const crime = (f: F, g: WGroup, kind: 'extortion' | 'strike' | 'salvage' = 'extortion', value = 30000, key = `t:${g.id}:${kind}`) => {
  const c = ships(f, g)[0].pos, sys = sysAt(f.sim.st.systems, c)!.id;
  return lawCrime(f.sim, { kind, by: g.owner, group: g.id, ship: g.shipIds[0], sys, pos: c, value, key })!;
};
/** a point in system `sys` that no guard ship / garrisoned station can see now */
function darkSpot(f: F, sys: string): V | null {
  const s = f.sim.st.systems[sys];
  for (let k = 0; k < 400; k++) {
    const a = k * 2.399, r = s.radius * (0.35 + 0.6 * ((k * 37) % 100) / 100);
    const p = { x: s.origin.x + Math.cos(a) * r, y: 0, z: s.origin.z + Math.sin(a) * r };
    if (sysAt(f.sim.st.systems, p)?.id === sys && !witness(f.sim, p, sys)) return p;
  }
  return null;
}
/** the largest per-tick displacement of the guard ships of an operation (no teleports) */
function trackMotion(f: F, gs: WGroup[], seconds: number, dt = .5): number {
  let worst = 0;
  const last = new Map<string, V>(), warping = new Set<string>();
  for (let t = 0; t < seconds; t += dt) {
    warping.clear();
    for (const g of gs) for (const s of ships(f, g)) { last.set(s.id, { ...s.pos }); if (s.warp) warping.add(s.id); }
    f.sim.update(dt);
    for (const g of gs) for (const s of ships(f, g)) {
      const p = last.get(s.id); if (!p || s.jumpT === f.sim.time) continue;
      // the existing in-system warp drive (trips > 6 km) is the real travel model of every fleet
      const d = dist(p, s.pos), cap = (s.warp || warping.has(s.id) ? 7000 : f.sim.cruiseOf(s) * 1.6) * dt + 5;
      worst = Math.max(worst, d / cap);
    }
  }
  return worst;
}

describe('P13.4 A — crimes, jurisdiction, witnesses, wanted level', () => {
  it('A01: a real cargo demand near the guards is extortion: one known case, fine, wanted; the P13.2 reputation loss is not repeated', () => {
    const f = fixture();
    const vg = fleet(f, f.B, f.at(4000, 2500), ['hauler']); const h = ships(f, vg)[0]; h.cargo.ore = 300; h.logisticsExcluded = true; vg.piracyPolicy = 'survive';
    const rg = fleet(f, f.A, f.at(4600, 2500), ['destroyer', 'destroyer']);
    f.sim.st.companies[f.A].rep = 100;
    const rep0 = f.sim.st.companies[f.A].rep;
    const r = demand(f.sim, rg, h, { neutral: true });
    expect(typeof r === 'object' && r.response).toBe('comply');
    const cs = cases(f, f.A);
    expect(cs.length).toBe(1);
    expect(cs[0]).toMatchObject({ kind: 'extortion', known: true, auth: 'union', victim: f.B, group: rg.id, state: 'open' });
    expect(['guard', 'station']).toContain(cs[0].how);
    expect(cs[0].fine).toBeGreaterThan(0);
    expect(wanted(f.sim.st, f.A).level).toBeGreaterThanOrEqual(2);
    // the reputation drop is exactly the P13.2 rule (once) — the law case adds a fine, not a second reputation loss
    const sec = f.sim.effSec(f.sim.st.systems.astra);
    const drop = f.sim.st.drops![Object.keys(f.sim.st.drops!)[0]];
    const value = cs[0].value;
    expect(rep0 - f.sim.st.companies[f.A].rep).toBeCloseTo(value * (1 / 2000) * (sec / 100), 0);
    // reporting the same drop again (duplicate / repeated check) makes no second case
    lawCrime(f.sim, { kind: 'extortion', by: f.A, group: rg.id, sys: 'astra', pos: drop.pos, value, key: `ext:${drop.id}` });
    expect(cases(f, f.A).length).toBe(1);
    expect(f.sim.st.companies[f.A].law?.level).toBeGreaterThanOrEqual(2);
  });

  it('A02: unwitnessed: recorded, but the authority knows neither who nor where; a surviving victim reports later — with the crime scene, not the live position', () => {
    const f = fixture();
    const p = darkSpot(f, 'astra'); expect(p).not.toBeNull();
    const rg = fleet(f, f.A, p!, ['destroyer']);
    const vg = fleet(f, f.B, { ...p!, x: p!.x + 300 }, ['hauler']);
    // a: no victim → never known
    const c1 = lawCrime(f.sim, { kind: 'extortion', by: f.A, group: rg.id, ship: rg.shipIds[0], sys: 'astra', pos: p!, value: 20000, key: 'k1' })!;
    expect(c1.state).toBe('unreported'); expect(c1.known).toBe(false); expect(c1.warrant).toBe(false); expect(c1.seen).toBeUndefined();
    expect(wanted(f.sim.st, f.A).level).toBe(0);
    // b: the victim survives → report after the delay
    const c2 = lawCrime(f.sim, { kind: 'extortion', by: f.A, group: rg.id, ship: rg.shipIds[0], victim: f.B, vgroup: vg.id, sys: 'astra', pos: p!, value: 20000, key: 'k2' })!;
    expect(c2.reportAt).toBe(f.sim.time + LAW.reportDelay);
    // the raider moves away meanwhile
    for (const s of ships(f, rg)) s.pos = { ...s.pos, x: s.pos.x + 5000 };
    run(f.sim, LAW.reportDelay + 4);
    expect(c2.known).toBe(true); expect(c2.how).toBe('victim');
    expect(dist(c2.seen!.pos, p!)).toBeLessThan(1);         // where it happened, when it happened
    expect(c2.seen!.t).toBe(c2.t);
    // c: the victim was destroyed before reporting → stays unknown
    const vg3 = fleet(f, f.B, { ...p!, z: p!.z + 300 }, ['hauler']);
    const c3 = lawCrime(f.sim, { kind: 'extortion', by: f.A, group: rg.id, victim: f.B, vgroup: vg3.id, sys: 'astra', pos: p!, value: 20000, key: 'k3' })!;
    for (const id of vg3.shipIds) delete f.sim.st.ships[id]; vg3.shipIds = [];
    run(f.sim, LAW.reportDelay + 4);
    expect(c3.known).toBe(false);
  });

  it('A03: lawless space and another jurisdiction: no universe-wide warrant; record-only where no Union force is stationed', () => {
    const f = fixture({ layout: 'p10' });
    const pol = policedSystems(f.sim);
    expect([...pol].sort()).toEqual(['astra', 'bulwark', 'drake', 'ember', 'helios']);
    expect(jurisdiction(f.sim, 'fang')).toEqual({ juris: null, auth: null });          // pirate lawless
    expect(jurisdiction(f.sim, 'gloam')).toEqual({ juris: null, auth: null });         // uncharted
    expect(jurisdiction(f.sim, 'lyra')).toEqual({ juris: 'union', auth: null });       // union territory, no force there
    expect(jurisdiction(f.sim, 'astra')).toEqual({ juris: 'guild', auth: 'union' });   // guild capital under the Union security accord
    const fang = f.sim.st.systems.fang, lyra = f.sim.st.systems.lyra;
    const g1 = fleet(f, f.A, fang.origin, ['destroyer']);
    const c1 = crime(f, g1);
    expect(c1.state).toBe('closed'); expect(c1.end).toBe('lawless'); expect(c1.warrant).toBe(false);
    const g2 = fleet(f, f.A, lyra.origin, ['destroyer']);
    const c2 = lawCrime(f.sim, { kind: 'extortion', by: f.A, group: g2.id, sys: 'lyra', pos: lyra.origin, value: 30000, key: 'ly', how: 'victim' })!;
    expect(c2.known).toBe(true); expect(c2.auth).toBeNull(); expect(c2.warrant).toBe(false); expect(c2.fine).toBe(0);
    expect(wanted(f.sim.st, f.A).level).toBe(0);
    run(f.sim, 20);
    expect(ops(f).length).toBe(0);
  });

  it('A04: a real dock inspection that seizes stolen goods is a smuggling case known by inspection: the BM fine once, no law fine, watch level only, no dispatch', () => {
    const f = fixture();
    BM.dockBase = 1; BM.maxChance = 1;
    const g = fleet(f, f.A, f.at(300, 0), ['hauler']); const s = ships(f, g)[0]; s.logisticsExcluded = true;
    const k = hotKey('ore', f.B); s.cargo[k] = 50;
    const cr0 = f.sim.st.companies[f.A].credits;
    expect(inspect(f.sim, s, 'dock', f.sim.st.systems.astra, f.a)).toBe('seize');
    const fineBm = cr0 - f.sim.st.companies[f.A].credits;
    expect(fineBm).toBeGreaterThan(0);
    const cs = cases(f, f.A);
    expect(cs.length).toBe(1);
    expect(cs[0]).toMatchObject({ kind: 'smuggling', how: 'inspection', fine: 0 });
    // the same window again: replayed outcome, nothing left to seize, no new case
    inspect(f.sim, s, 'dock', f.sim.st.systems.astra, f.a);
    expect(cases(f, f.A).length).toBe(1);
    expect(levelOf(wanted(f.sim.st, f.A).score)).toBe(1);
    run(f.sim, 30);
    expect(ops(f).length).toBe(0);
    // stolen goods went to the owner's customs at this station (exactly)
    expect(f.sim.st.companies[f.B].bm?.customs?.[0]).toMatchObject({ item: 'ore', n: 50, station: 'astra' });
  });

  it('A05: an unprovoked P11 attack in policed space is a strike case for the aggressor only; a mutual war is not', () => {
    const f = fixture();
    expect(f.sim.command(f.A, { c: 'stance', target: f.B, v: -1 })).toBeNull();
    const ga = fleet(f, f.A, f.at(3000, 1500), ['destroyer']);
    const gb = fleet(f, f.B, f.at(3200, 1500), ['corvette']);
    expect(until(f.sim, () => ships(f, ga).some(s => s.state === 'battle'), 30)).toBe(true);
    expect(cases(f, f.A).map(c => c.kind)).toEqual(['strike']);
    expect(cases(f, f.B).length).toBe(0);
    // mutual hostility (B declared too) → a war between them, no new strike case
    const f2 = fixture();
    f2.sim.command(f2.A, { c: 'stance', target: f2.B, v: -1 }); f2.sim.command(f2.B, { c: 'stance', target: f2.A, v: -1 });
    fleet(f2, f2.A, f2.at(3000, 1500), ['destroyer']); fleet(f2, f2.B, f2.at(3200, 1500), ['corvette']);
    run(f2.sim, 10);
    expect(cases(f2).length).toBe(0);
    void gb;
  });

  it('A06: unauthorised salvage of another company\'s container through the salvage engine is one growing case per site', () => {
    const f = fixture();
    const g = fleet(f, f.A, f.at(2500, 2000), ['hauler']); ships(f, g)[0].logisticsExcluded = true;
    const p = ships(f, g)[0].pos;
    const drop = { id: 'dp_law', kind: 'drop', name: '테스트 컨테이너', system: 'astra', pos: { ...p, x: p.x + 200 }, created: 0, expires: 1e9, ship: 'x', owner: f.B, by: f.C, ev: 'e', lots: [{ id: 'l1', k: 'cargo', item: 'ore', n: 40, owner: f.B }], initial: 40, taken: {}, seen: [f.A] };
    (f.sim.st.drops ??= {})[drop.id] = drop as any;
    expect(f.sim.command(f.A, { c: 'setOp', group: g.id, op: { k: 'recover', wreck: drop.id, illegal: true } as any })).toBeNull();
    expect(until(f.sim, () => (drop.lots[0]?.n ?? 0) === 0 || !drop.lots.length, 400)).toBe(true);
    const cs = cases(f, f.A).filter(c => c.kind === 'salvage');
    expect(cs.length).toBe(1);
    expect(cs[0].value).toBeGreaterThan(0);
    expect(cs[0].key).toBe(`salv:${drop.id}:${f.A}`);
  });

  it('A07: duplicates and restarts never stack: same key → one case; save/restore keeps cases, scores, fines and the dispatch book identical', () => {
    const f = fixture();
    const g = fleet(f, f.A, f.at(4000, 2500), ['corvette', 'corvette']);
    crime(f, g); crime(f, g); crime(f, g);
    expect(cases(f, f.A).length).toBe(1);
    run(f.sim, 12);
    const before = { law: JSON.stringify(f.sim.st.law), co: JSON.stringify(f.sim.st.companies[f.A].law), w: wanted(f.sim.st, f.A) };
    const copy = new WorldSim(JSON.parse(f.sim.serialize()));
    expect(JSON.stringify(copy.st.law)).toBe(before.law);
    expect(JSON.stringify(copy.st.companies[f.A].law)).toBe(before.co);
    expect(wanted(copy.st, f.A)).toEqual(before.w);
    lawCrime(copy, { kind: 'extortion', by: f.A, group: g.id, sys: 'astra', pos: f.at(4000, 2500), value: 30000, key: `t:${g.id}:extortion` });
    expect(Object.keys(copy.st.law!.cases).length).toBe(1);
    expect(Object.values(copy.st.groups).filter(x => x.lawx).map(x => x.lawx)).toEqual(Object.values(f.sim.st.groups).filter(x => x.lawx).map(x => x.lawx));
  });
});

describe('P13.4 B — guard fleets: dispatch, approach, pursuit', () => {
  it('B01: minor case → the nearest patrol flies there for real (no teleport, real speed), stops at the stop range and demands', () => {
    const f = fixture();
    const g = fleet(f, f.A, f.at(5000, 3000), ['corvette', 'corvette']);
    const before = Object.fromEntries(guards(f).flatMap(x => ships(f, x)).map(s => [s.id, { ...s.pos }]));
    crime(f, g);
    f.sim.update(.5); run(f.sim, 2);
    const op = ops(f)[0]; expect(op).toBeTruthy();
    const gs = op.guards.map(id => f.sim.st.groups[id]);
    expect(gs[0].npc!.role).toBe('patrol');
    // the guards started where they really were
    for (const s of gs.flatMap(x => ships(f, x))) expect(dist(before[s.id], s.pos)).toBeLessThan(f.sim.cruiseOf(s) * 3.5 + 5);
    expect(trackMotion(f, gs, 60)).toBeLessThanOrEqual(1);
    expect(until(f.sim, () => op.phase === 'demand', 400)).toBe(true);
    expect(g.lawStop?.phase).toBe('demand');
    expect(g.lawStop?.answerBy).toBeGreaterThan(f.sim.time);
    const gc = f.sim.groupCenter(gs[0])!, tc = f.sim.groupCenter(g)!;
    expect(dist(gc, tc)).toBeLessThan(LAW.stopR + 200);
    // no second operation for the same target, no second group dispatched for it
    run(f.sim, 10);
    expect(ops(f).filter(o => o.target === g.id).length).toBe(1);
  });

  it('B02: high-risk → the rapid-response fleet; guards fighting already are never taken; per-system and world caps hold under many incidents', () => {
    const f = fixture();
    const g = fleet(f, f.A, f.at(5000, 3000), ['destroyer']);
    lawCrime(f.sim, { kind: 'strike', by: f.A, group: g.id, ship: g.shipIds[0], sys: 'astra', pos: ships(f, g)[0].pos, value: 0, key: 's1', how: 'guard' });
    lawCrime(f.sim, { kind: 'extortion', by: f.A, group: g.id, ship: g.shipIds[0], sys: 'astra', pos: ships(f, g)[0].pos, value: 40000, key: 's2', how: 'guard' });
    expect(wanted(f.sim.st, f.A).level).toBeGreaterThanOrEqual(3);
    run(f.sim, 3);
    expect(f.sim.st.groups[ops(f)[0].guards[0]].npc!.role).toBe('qrf');
    // many simultaneous incidents in astra and helios
    const f2 = fixture();
    for (let i = 0; i < 6; i++) { const x = fleet(f2, i % 2 ? f2.A : f2.C, f2.at(3000 + i * 900, 2000), ['corvette']); crime(f2, x, 'extortion', 30000, `m${i}`); }
    const h = f2.sim.st.stations.helios;
    for (let i = 0; i < 4; i++) { const x = fleet(f2, f2.B, { x: h.pos.x + 3000 + i * 900, y: 0, z: h.pos.z + 2000 }, ['corvette']); crime(f2, x, 'extortion', 30000, `h${i}`); }
    run(f2.sim, 6);
    const os = ops(f2);
    const bySys = new Map<string, number>(); for (const o of os) bySys.set(o.sys, (bySys.get(o.sys) ?? 0) + 1);
    expect(Math.max(...bySys.values())).toBeLessThanOrEqual(LAW.capSys);
    expect(os.length).toBeLessThanOrEqual(LAW.capAll);
    // a guard group is in at most one operation; garrisons never leave their station
    const assigned = os.flatMap(o => o.guards);
    expect(new Set(assigned).size).toBe(assigned.length);
    expect(assigned.every(id => f2.sim.st.groups[id].npc!.role !== 'garrison')).toBe(true);
  });

  it('B03: flee → pursuit at real speed; out of sight the guards go to the last known position; lost → pursuit ends and they return home', () => {
    const f = fixture();
    const g = fleet(f, f.A, f.at(5000, 3000), ['corvette', 'corvette']);
    crime(f, g);
    run(f.sim, 2);
    const op = ops(f)[0];
    expect(until(f.sim, () => op.phase === 'demand', 400)).toBe(true);
    expect(f.sim.command(f.A, { c: 'lawAnswer', group: g.id, choice: 'flee' })).toBeNull();
    expect(op.phase).toBe('pursue'); expect(g.lawStop?.phase).toBe('pursuit');
    expect(cases(f, f.A).some(c => c.kind === 'flee' && c.known)).toBe(true);
    // the fugitive vanishes: we move it far out of every sensor (a cloak stand-in) — the guards only know the last sighting
    const lastSeen = { ...op.last.pos };
    const dark = darkSpot(f, 'astra')!;
    for (const s of ships(f, g)) { s.pos = { ...dark, x: dark.x + 30 }; s.vel = { x: 0, y: 0, z: 0 }; }
    g.op = { k: 'idle' }; g.override = true;
    run(f.sim, 6);
    expect(dist(op.last.pos, lastSeen)).toBeLessThan(400);       // no omniscient update
    const gs = op.guards.map(id => f.sim.st.groups[id]);
    expect(until(f.sim, () => op.end !== undefined, 600)).toBe(true);
    expect(op.end).toBe('lost');
    expect(g.lawStop?.phase).toBe('released');
    // they fly home and drop the job
    expect(until(f.sim, () => !gs[0].lawx, 600)).toBe(true);
    expect(dist(f.sim.groupCenter(gs[0])!, f.sim.st.stations[gs[0].npc!.home].pos)).toBeLessThan(3600);
    expect(ops(f).length).toBe(0);
  });

  it('B04: pursuit limits — time and leaving the policed area end it (no off-screen kill)', () => {
    const f = fixture();
    LAW.pursuitMax = 120;
    const g = fleet(f, f.A, f.at(5000, 3000), ['corvette']);
    crime(f, g); run(f.sim, 2);
    const op = ops(f)[0];
    expect(until(f.sim, () => op.phase === 'demand', 400)).toBe(true);
    f.sim.command(f.A, { c: 'lawAnswer', group: g.id, choice: 'flee' });
    // keep it in sight but out of reach (it is moved ahead of the guards each tick)
    expect(until(f.sim, () => { const gc = f.sim.groupCenter(f.sim.st.groups[op.guards[0]])!; for (const s of ships(f, g)) { const dx = s.pos.x - gc.x, dz = s.pos.z - gc.z, l = Math.hypot(dx, dz) || 1; s.pos = { x: gc.x + dx / l * 3000, y: 0, z: gc.z + dz / l * 3000 }; } return op.end !== undefined; }, 400)).toBe(true);
    expect(op.end).toBe('timeout');
    expect(ships(f, g).length).toBe(1);
    expect(ships(f, g).every(s => s.state !== 'battle')).toBe(true);
    // leaving the policed area: the last sighting is in a system without Union forces
    const f2 = fixture();
    const g2 = fleet(f2, f2.A, f2.at(5000, 3000), ['corvette']);
    crime(f2, g2); run(f2.sim, 2);
    const op2 = ops(f2)[0];
    expect(until(f2.sim, () => op2.phase === 'demand', 400)).toBe(true);
    f2.sim.command(f2.A, { c: 'lawAnswer', group: g2.id, choice: 'flee' });
    // it got through a gate into lawless space with the guards on its tail (both placed there for the check)
    const fang = f2.sim.st.systems.fang.origin;
    for (const s of ships(f2, g2)) s.pos = { ...fang, x: fang.x + 2000 };
    for (const gid of op2.guards) for (const s of ships(f2, f2.sim.st.groups[gid])) s.pos = { ...fang, x: fang.x - 500 };
    run(f2.sim, 5);
    expect(op2.end).toBe('left_jurisdiction');
  });
});

describe('P13.4 C — stop, comply, flee, resist; P11', () => {
  it('C01: comply → hold → real inspection: stolen goods seized to the owner (exact), outstanding fines billed, case closed, released', () => {
    const f = fixture();
    const g = fleet(f, f.A, f.at(5000, 3000), ['hauler', 'corvette']);
    const h = ships(f, g).find(s => s.classId === 'hauler')!; h.logisticsExcluded = true;
    const k = hotKey('alloy', f.B); h.cargo[k] = 60; h.cargo.ore = 20;
    const c = crime(f, g);
    const cr0 = f.sim.st.companies[f.A].credits;
    run(f.sim, 2);
    const op = ops(f)[0];
    expect(until(f.sim, () => op.phase === 'demand', 400)).toBe(true);
    expect(f.sim.command(f.A, { c: 'lawAnswer', group: g.id, choice: 'comply' })).toBeNull();
    expect(g.lawStop?.phase).toBe('hold');
    const p0 = { ...h.pos };
    expect(until(f.sim, () => op.end !== undefined, 60)).toBe(true);
    expect(dist(p0, h.pos)).toBeLessThan(150);               // it held still
    expect(op.end).toBe('inspected');
    expect(qty(h.cargo, k)).toBe(0);
    expect(qty(h.cargo, 'ore')).toBe(20);                       // legal cargo untouched
    const lots = f.sim.st.companies[f.B].bm?.customs ?? [];
    expect(lots.reduce((a, l) => a + (l.item === 'alloy' ? l.n : 0), 0)).toBe(60);
    // credits: the BM seizure fine + the law fine, each once
    const lawPaid = c.paid; expect(lawPaid).toBe(c.fine);
    const bmFine = (f.sim.st.companies[f.A].bm?.log ?? []).filter(e => e.k === 'seize').reduce((a, e) => a + (e.fine ?? 0), 0);
    expect(cr0 - f.sim.st.companies[f.A].credits).toBeGreaterThanOrEqual(lawPaid + bmFine - 50);   // (minus upkeep noise)
    expect(cr0 - f.sim.st.companies[f.A].credits).toBeLessThan(lawPaid + bmFine + 400);
    expect(c.state).toBe('closed'); expect(c.end).toBe('paid');
    expect(g.lawStop?.phase).toBe('released');
    expect(wanted(f.sim.st, f.A).level).toBeLessThanOrEqual(1);
    // no second inspection for the same operation
    run(f.sim, 20);
    expect((f.sim.st.companies[f.A].bm?.log ?? []).filter(e => e.k === 'seize').length).toBe(1);
  });

  it('C02: no answer, offline, idle and unarmed → treated as compliance (never as resistance)', () => {
    const f = fixture();
    f.sim.st.companies[f.A].online = false;
    const g = fleet(f, f.A, f.at(5000, 3000), ['hauler']);
    crime(f, g); run(f.sim, 2);
    const op = ops(f)[0];
    expect(until(f.sim, () => op.phase === 'demand', 400)).toBe(true);
    expect(until(f.sim, () => op.phase !== 'demand', LAW.answerFor + 10)).toBe(true);
    expect(op.phase === 'hold' || op.end === 'inspected').toBe(true);
    expect(cases(f, f.A).some(c => c.kind === 'resist' || c.kind === 'flee')).toBe(false);
    expect(Object.values(f.sim.st.engagements).filter(e => e.law).length).toBe(0);
  });

  it('C03: running from the stop point without answering is fleeing (actual behaviour, not a guess)', () => {
    const f = fixture();
    const g = fleet(f, f.A, f.at(5000, 3000), ['corvette']);
    crime(f, g); run(f.sim, 2);
    const op = ops(f)[0];
    expect(until(f.sim, () => op.phase === 'demand', 400)).toBe(true);
    const tc = f.sim.groupCenter(g)!;
    expect(f.sim.command(f.A, { c: 'setOp', group: g.id, op: { k: 'move', to: { x: tc.x + 30000, y: 0, z: tc.z + 12000 } } })).toBeNull();
    expect(until(f.sim, () => op.phase !== 'demand', 60)).toBe(true);
    expect(op.phase).toBe('pursue');
    expect(cases(f, f.A).some(c => c.kind === 'flee')).toBe(true);
  });

  it('C04: resist → a real P11 battle between the guard group and that fleet only; no stance change; other fleets of the company and neutral PMCs stay out', () => {
    const f = fixture();
    const g = fleet(f, f.A, f.at(5000, 3000), ['destroyer', 'corvette']);
    const other = fleet(f, f.A, f.at(5600, 3300), ['corvette']);           // same company, not the suspect
    const third = fleet(f, f.C, f.at(5300, 2700), ['corvette']);           // an unrelated PMC
    crime(f, g); run(f.sim, 2);
    const op = ops(f)[0];
    expect(until(f.sim, () => op.phase === 'demand', 400)).toBe(true);
    expect(f.sim.command(f.A, { c: 'lawAnswer', group: g.id, choice: 'resist' })).toBeNull();
    expect(until(f.sim, () => op.phase === 'fight', 120)).toBe(true);
    const e = f.sim.st.engagements[op.e!];
    expect(e.law).toMatchObject({ op: op.id, co: f.A });
    expect(e.sides.map(x => x[0]).sort()).toEqual(['union', f.A].sort());
    const ui = e.sides.findIndex(x => x[0] === 'union'), ai = e.sides.findIndex(x => x[0] === f.A);
    expect(e.setup.rel![ui][ai]).toBe(-1); expect(e.setup.rel![ai][ui]).toBe(-1);
    expect(coRelation(f.sim.st, 'union', f.A)).toBe(0);                     // no permanent hostility
    expect(cases(f, f.A).some(c => c.kind === 'resist')).toBe(true);
    run(f.sim, 20);
    expect(ships(f, other).every(s => s.engagement !== e.id)).toBe(true);
    expect(ships(f, third).every(s => s.engagement !== e.id)).toBe(true);
    expect(e.groupRefs.every(id => f.sim.st.groups[id]?.owner === 'union' || id === g.id)).toBe(true);
    // the battle runs to its end; the operation closes with it
    expect(until(f.sim, () => e.done, 900)).toBe(true);
    run(f.sim, 4);
    expect(op.end === 'battle_over' || op.end === 'suppressed').toBe(true);
    expect(coRelation(f.sim.st, 'union', f.A)).toBe(0);
  });

  it('C05: guards hit in a law battle → guard-attack case (combat record); lost hulls are replaced by the existing refit rules', () => {
    const f = fixture();
    const g = fleet(f, f.A, f.at(5000, 3000), ['cruiser', 'cruiser', 'destroyer', 'destroyer']);
    crime(f, g); run(f.sim, 2);
    const op = ops(f)[0];
    const gid = op.guards[0], tmpl = f.sim.st.groups[gid].npc!.template.length;
    expect(until(f.sim, () => op.phase === 'demand', 400)).toBe(true);
    f.sim.command(f.A, { c: 'lawAnswer', group: g.id, choice: 'resist' });
    expect(until(f.sim, () => op.phase === 'fight', 120)).toBe(true);
    const e = f.sim.st.engagements[op.e!];
    expect(until(f.sim, () => e.done, 900)).toBe(true);
    run(f.sim, 4);
    const ga = cases(f, f.A).find(c => c.kind === 'guard_attack');
    expect(ga).toBeTruthy(); expect(ga!.how).toBe('combat');
    expect(wanted(f.sim.st, f.A).level).toBeGreaterThanOrEqual(3);
    const gg = f.sim.st.groups[gid];
    if (ships(f, gg).length < tmpl) {
      expect(until(f.sim, () => ships(f, gg).length >= tmpl || (!gg.lawx && ships(f, gg).length > 0 && f.sim.time > (gg.npc!.nextRefit ?? 0) + 30), 1500)).toBe(true);
    }
  });

  it('C06: armed-danger → forced suppression without a stop demand', () => {
    const f = fixture();
    const g = fleet(f, f.A, f.at(5000, 3000), ['destroyer']);
    for (const k of ['a', 'b']) lawCrime(f.sim, { kind: 'guard_attack', by: f.A, group: g.id, ship: g.shipIds[0], sys: 'astra', pos: ships(f, g)[0].pos, value: 0, key: k, how: 'combat' });
    expect(wanted(f.sim.st, f.A).level).toBe(4);
    run(f.sim, 2);
    const op = ops(f)[0];
    expect(until(f.sim, () => op.phase === 'fight', 500)).toBe(true);
    expect(g.lawStop?.phase).toBe('fight');
    expect(f.sim.st.engagements[op.e!].law?.co).toBe(f.A);
  });

  it('C07: a plunder truce holds — the truced victim is not pulled into the law battle against its raider', () => {
    const f = fixture();
    const vg = fleet(f, f.B, f.at(5200, 2900), ['hauler']); const h = ships(f, vg)[0]; h.cargo.ore = 300; h.logisticsExcluded = true; vg.piracyPolicy = 'survive';
    expect(f.sim.command(f.B, { c: 'stance', target: f.A, v: -1 })).toBeNull();
    f.sim.command(f.A, { c: 'stance', target: f.B, v: -1 });
    const rg = fleet(f, f.A, f.at(5600, 2900), ['destroyer', 'destroyer']);
    const r = demand(f.sim, rg, h); expect(typeof r === 'object' && r.response).toBe('comply');
    expect(f.sim.st.piracy!.truces.length).toBeGreaterThan(0);
    lawCrime(f.sim, { kind: 'resist', by: f.A, group: rg.id, ship: rg.shipIds[0], sys: 'astra', pos: ships(f, rg)[0].pos, value: 0, key: 'x1', how: 'guard' });
    lawCrime(f.sim, { kind: 'guard_attack', by: f.A, group: rg.id, ship: rg.shipIds[0], sys: 'astra', pos: ships(f, rg)[0].pos, value: 0, key: 'x2', how: 'guard' });
    run(f.sim, 2);
    const op = ops(f).find(o => o.target === rg.id)!;
    expect(until(f.sim, () => op.phase === 'fight', 500)).toBe(true);
    const e = f.sim.st.engagements[op.e!];
    run(f.sim, 15);
    expect(ships(f, vg).every(s => s.engagement !== e.id)).toBe(true);
    expect(e.sides.flat()).not.toContain(f.B);
  });
});

describe('P13.4 D — fines, clearing, customs holds, privacy, legacy worlds', () => {
  it('D01: pay a fine where allowed (near a policed public station); partial payment keeps the rest owed; serious cases go on probation, then close', () => {
    const f = fixture();
    const far = darkSpot(f, 'astra')!;
    const g = fleet(f, f.A, far, ['corvette']);
    const minor = lawCrime(f.sim, { kind: 'extortion', by: f.A, group: g.id, sys: 'astra', pos: far, value: 30000, key: 'p1', how: 'victim' })!;
    const ser = lawCrime(f.sim, { kind: 'strike', by: f.A, group: g.id, sys: 'astra', pos: far, value: 0, key: 'p2', how: 'victim' })!;
    for (const s of ships(f, g)) s.pos = { ...f.sim.st.systems.fang.origin };     // nowhere near a policed station
    expect(f.sim.command(f.A, { c: 'lawPay' })).toMatch(/공공 정거장 근처/);
    for (const s of ships(f, g)) s.pos = { ...f.a.pos, x: f.a.pos.x + 1500 };
    const cr0 = f.sim.st.companies[f.A].credits;
    expect(f.sim.command(f.A, { c: 'lawPay', amount: 5000 })).toBeNull();
    expect(cr0 - f.sim.st.companies[f.A].credits).toBe(5000);
    expect(minor.paid).toBe(5000); expect(minor.state).toBe('open');
    expect(f.sim.command(f.A, { c: 'lawPay' })).toBeNull();
    expect(minor.state).toBe('closed'); expect(minor.end).toBe('paid');
    expect(ser.state).toBe('probation');
    expect(wanted(f.sim.st, f.A).score).toBeCloseTo(ser.sev * 0.5, 5);
    expect(f.sim.st.companies[f.A].law?.unpaid).toBe(0);
    f.sim.st.time += LAW.probation + 5; run(f.sim, 3);
    expect(ser.state).toBe('closed'); expect(wanted(f.sim.st, f.A).level).toBe(0);
    expect(f.sim.command(f.A, { c: 'lawPay' })).toMatch(/미납 벌금이 없습니다/);
  });

  it('D02: unpaid fines never expire; minor cases decay to watch level only; a broke company is stopped once, not harassed forever', () => {
    const f = fixture();
    f.sim.st.companies[f.A].credits = 0;
    const g = fleet(f, f.A, f.at(5000, 3000), ['corvette']);
    const c = crime(f, g);
    run(f.sim, 2);
    const op = ops(f)[0];
    expect(until(f.sim, () => op.end !== undefined, 600)).toBe(true);
    expect(op.end).toBe('inspected');
    expect(c.paid).toBe(0); expect(c.state).toBe('open'); expect(c.served).toBeDefined();
    expect(wanted(f.sim.st, f.A).level).toBe(1);
    run(f.sim, 30);
    expect(ops(f).filter(o => o.target === g.id).length).toBe(0);
    f.sim.st.time += LAW.decay * 3; run(f.sim, 3);
    expect(c.state).toBe('open'); expect(f.sim.st.companies[f.A].law?.unpaid).toBe(c.fine);
  });

  it('D03: customs hold in a system without a usable customs station stays there (exact) and is collected on site — never sent to a remote station', () => {
    const f = fixture();
    BM.gateBase = 50; BM.maxChance = 1;
    // ember: policed (garrison) — make its stations refuse B so no customs station can take B's goods there
    const ember = f.sim.st.systems.ember; ember.security = 90;
    for (const x of Object.values(f.sim.st.stations)) if (sysAt(f.sim.st.systems, x.pos)?.id === 'ember') (x as any)._refuse = true;
    const canDock = f.sim.canDock.bind(f.sim);
    f.sim.canDock = (st, co) => ((st as any)._refuse && co === f.B) ? false : canDock(st, co);
    expect(customsOffice(f.sim, f.B, undefined, ember, ember.origin)).toBeUndefined();
    const g = fleet(f, f.A, ember.origin, ['hauler']); const s = ships(f, g)[0]; s.logisticsExcluded = true;
    s.cargo[hotKey('ore', f.B)] = 70;
    expect(inspect(f.sim, s, 'gate', ember)).toBe('seize');
    const lot = f.sim.st.companies[f.B].bm!.customs![0];
    expect(lot).toMatchObject({ item: 'ore', n: 70, station: '', sys: 'ember' });
    // collection: off site → refused; on site → into the hold; storage not allowed; exact quantities
    const vg = fleet(f, f.B, f.at(0, 4000), ['hauler']); const v = ships(f, vg)[0];
    expect(f.sim.command(f.B, { c: 'customsClaim', lot: lot.id, ship: v.id })).toMatch(/압수 지점/);
    v.pos = { ...lot.pos!, x: lot.pos!.x + 500 };
    expect(f.sim.command(f.B, { c: 'customsClaim', lot: lot.id, ship: v.id, toStorage: true })).toMatch(/화물칸으로만/);
    expect(f.sim.command(f.B, { c: 'customsClaim', lot: lot.id, ship: v.id, amount: 30 })).toBeNull();
    expect(qty(v.cargo, 'ore')).toBe(30); expect(lot.n).toBe(40);
    const copy = new WorldSim(JSON.parse(f.sim.serialize()));
    expect(copy.st.companies[f.B].bm!.customs![0]).toMatchObject({ n: 40, station: '', sys: 'ember' });
    expect(f.sim.command(f.B, { c: 'customsClaim', lot: lot.id, ship: v.id })).toBeNull();
    expect(qty(v.cargo, 'ore')).toBe(70); expect(f.sim.st.companies[f.B].bm?.customs).toBeUndefined();
    void econOf;
  });

  it('D04: privacy — another company never sees a record, a stop or the server book; the owner sees its own', () => {
    const f = fixture();
    const g = fleet(f, f.A, f.at(5000, 3000), ['corvette']);
    crime(f, g); run(f.sim, 2);
    expect(until(f.sim, () => g.lawStop?.phase === 'demand', 400)).toBe(true);
    const mine = legacyView(f.sim.st, { company: f.A } as any, 'astra') as any;
    const theirs = legacyView(f.sim.st, { company: f.B } as any, 'astra') as any;
    expect(mine.companies[f.A].law?.level).toBeGreaterThanOrEqual(2);
    expect(mine.groups[g.id].lawStop?.phase).toBe('demand');
    expect(theirs.companies[f.A].law).toBeUndefined();
    expect(theirs.groups[g.id]?.lawStop).toBeUndefined();
    expect(mine.law).toBeUndefined(); expect(theirs.law).toBeUndefined();
  });

  it('D05: worlds without P13.4 are unchanged: no law book, the commands refuse, customs keeps its P13.3.1 fallback', () => {
    const sim = WorldSim.create(133, { blackMarket: 'p133' });
    const A = sim.addPlayer('A');
    run(sim, 10);
    expect(sim.st.lawV).toBeUndefined(); expect(sim.st.law).toBeUndefined();
    expect(sim.command(A, { c: 'lawPay' })).toMatch(/치안 집행이 없습니다/);
    expect(Object.values(sim.st.groups).some(g => g.lawx || g.lawStop)).toBe(false);
    // P13.3.1 rule: with no dockable station in the system, the nearest public station anywhere is still used here
    const ember = sim.st.systems.ember;
    const canDock = sim.canDock.bind(sim);
    sim.canDock = (st, co) => (sysAt(sim.st.systems, st.pos)?.id === 'ember' ? false : canDock(st, co));
    expect(customsOffice(sim, A, undefined, ember, ember.origin)).toBeTruthy();
  });

  it('D06: cargo and money are conserved through stop → seizure → customs → claim and a restart in between', () => {
    const f = fixture();
    const g = fleet(f, f.A, f.at(5000, 3000), ['hauler']);
    const h = ships(f, g)[0]; h.logisticsExcluded = true; h.cargo[hotKey('alloy', f.B)] = 45;
    crime(f, g); run(f.sim, 2);
    const op = ops(f)[0];
    expect(until(f.sim, () => op.phase === 'demand', 400)).toBe(true);
    f.sim.command(f.A, { c: 'lawAnswer', group: g.id, choice: 'comply' });
    const total = (sim: WorldSim) => Object.values(sim.st.ships).reduce((a, s) => a + qty(s.cargo, hotKey('alloy', f.B)) + qty(s.cargo, 'alloy'), 0) + (sim.st.companies[f.B].bm?.customs ?? []).reduce((a, l) => a + (l.item === 'alloy' ? l.n : 0), 0) + Object.values(sim.st.stations).reduce((a, x) => a + qty(x.storage[f.B], 'alloy'), 0);
    const t0 = total(f.sim);
    run(f.sim, 3);
    const copy = new WorldSim(JSON.parse(f.sim.serialize()));
    expect(total(copy)).toBe(t0);
    expect(until(copy, () => lawBook(copy.st).ops[op.id]?.end !== undefined || !lawBook(copy.st).ops[op.id], 60)).toBe(true);
    expect(total(copy)).toBe(t0);
    expect((copy.st.companies[f.B].bm?.customs ?? []).reduce((a, l) => a + l.n, 0)).toBe(45);
    expect(copy.st.companies[f.A].credits).toBeLessThan(f.sim.st.companies[f.A].credits);
  });
});

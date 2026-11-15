// P13.2.1 — a post-surrender truce covers only the parties of that plunder event (raider group ↔ surrendered
// group), never other groups of the same companies or third companies; several truces live side by side; a
// direct attack ends only the truce between attacker and target; restarts keep it; force-chase escape counting.
import { describe, expect, it } from 'vitest';
import { WorldSim } from '../src/world/sim';
import type { V, WGroup, WShip, Cargo, Engagement } from '../src/world/types';
import { demand, truceBlocks, stepPlunder, plunderOrder, PIR, type CargoDrop } from '../src/world/piracy';

function fixture(seed = 1321) {
  const sim = WorldSim.create(seed, { piracy: 'p132' });
  const [A, B, C] = ['약탈 PMC', '수송 PMC', '제3 PMC'].map(n => sim.addPlayer(n));
  for (const id of Object.keys(sim.st.ships)) delete sim.st.ships[id];
  for (const id of Object.keys(sim.st.groups)) delete sim.st.groups[id];
  for (const l of Object.values(sim.st.lairs)) { l.alive = false; l.respawnAt = 1e10; }
  for (const sys of Object.values(sim.st.systems)) sys.security = 10;
  for (const c of [A, B, C]) sim.st.companies[c].credits = 1e7;
  const a = sim.st.stations.astra;
  const at = (dx: number, dz: number): V => ({ x: a.pos.x + dx, y: 0, z: a.pos.z + dz });
  return { sim, A, B, C, at };
}
type F = ReturnType<typeof fixture>;
function fleet(f: F, owner: string, pos: V, comp: string[], name = '편대'): WGroup {
  const g = f.sim.newGroup(owner, name); g.commanderId = f.sim.newCommander(owner, 2).id;
  comp.forEach((cl, i) => f.sim.spawnShip(owner, cl, 'std', g.id, { x: pos.x + i * 40, y: 0, z: pos.z }));
  return g;
}
const ships = (f: F, g: WGroup) => g.shipIds.map(id => f.sim.st.ships[id]).filter(Boolean) as WShip[];
const hold = (f: F, g: WGroup) => { for (const s of ships(f, g)) s.vel = { x: 0, y: 0, z: 0 }; g.op = { k: 'idle' }; };
/** run while keeping these groups where they are (no flight, no warp, no docking): only the contact rule is tested */
function runPinned(f: F, seconds: number, gs: WGroup[]) {
  const at = new Map(gs.flatMap(g => ships(f, g).map(s => [s.id, { ...s.pos }] as const)));
  for (let t = 0; t < seconds; t += .5) {
    for (const g of gs) { g.op = { k: 'idle' }; g.fleeing = false; for (const s of ships(f, g)) if (s.state !== 'battle') { s.pos = { ...at.get(s.id)! }; s.vel = { x: 0, y: 0, z: 0 }; s.state = 'space'; s.task = { k: 'none' } as any; delete s.warp; } }
    f.sim.update(.5);
  }
}
const run = (sim: WorldSim, seconds: number) => { for (let t = 0; t < seconds; t += .5) sim.update(.5); };
const hostile = (f: F, a: string, b: string) => expect(f.sim.command(a, { c: 'stance', target: b, v: -1 })).toBeNull();
const engs = (f: F) => Object.values(f.sim.st.engagements) as Engagement[];
const inEng = (f: F, g: WGroup) => engs(f).some(e => e.groupRefs.includes(g.id));
/** B's loaded hauler group (survive policy) at pos, A's raiders 800 m away: a real demand → comply → container */
function plunder(f: F, pos: V, raiderComp = ['destroyer', 'destroyer', 'frigate'], cargo: Cargo = { metal: 300 }) {
  const b1 = fleet(f, f.B, pos, ['hauler'], 'B 수송'); b1.piracyPolicy = 'survive';
  const h = ships(f, b1)[0]; Object.assign(h.cargo, cargo); h.logisticsExcluded = true;
  const a1 = fleet(f, f.A, { x: pos.x, y: 0, z: pos.z - 800 }, raiderComp, 'A 약탈');
  const r = demand(f.sim, a1, h);
  expect(typeof r === 'object' && r.response).toBe('comply');
  return { a1, b1, h, drop: (r as any).drop as CargoDrop };
}

describe('P13.2.1 truce: only the parties of the plunder event', () => {
  it('T01: the raider and the surrendered group stay out of P11 while side by side; the truce names them', () => {
    const f = fixture(); hostile(f, f.A, f.B);
    const p = plunder(f, f.at(20000, 15000));
    const t = f.sim.st.piracy!.truces.find(x => x.id === p.drop.id)!;
    expect(t.pa).toContain(p.a1.id); expect(t.pb).toContain(p.b1.id); expect(t.until - f.sim.time).toBe(PIR.truceFor);
    // put them 200 m apart (inside P11 contact range) and hold them there
    for (const s of ships(f, p.a1)) s.pos = { ...p.h.pos, x: p.h.pos.x + 200 };
    runPinned(f, 30, [p.a1, p.b1]);
    expect(inEng(f, p.a1) || inEng(f, p.b1)).toBe(false);
    expect(truceBlocks(f.sim.st, p.a1, p.b1, p.h.pos, f.sim.time)).toBe(true);
  });

  it('T02: other groups of the same two companies fight normally inside the truce radius; the parties are not pulled in', () => {
    const f = fixture(); hostile(f, f.A, f.B);
    const pos = f.at(20000, 15000);
    const p = plunder(f, pos);
    // A2 and B2 meet 2.5 km away (inside the 4 km truce radius, outside JOIN_R of the parties)
    const a2 = fleet(f, f.A, { x: pos.x + 2600, y: 0, z: pos.z }, ['destroyer', 'frigate'], 'A2');
    const b2 = fleet(f, f.B, { x: pos.x + 2900, y: 0, z: pos.z }, ['destroyer', 'frigate'], 'B2');
    expect(truceBlocks(f.sim.st, a2, b2, pos, f.sim.time)).toBe(false);
    expect(truceBlocks(f.sim.st, p.a1, b2, pos, f.sim.time)).toBe(false);   // A1 ↔ B2 not covered
    expect(truceBlocks(f.sim.st, a2, p.b1, pos, f.sim.time)).toBe(false);   // A2 ↔ B1 not covered
    runPinned(f, 10, [p.a1, p.b1]);
    const e = engs(f).find(x => x.groupRefs.includes(a2.id));
    expect(e).toBeDefined(); expect(e!.groupRefs).toContain(b2.id);
    expect(e!.groupRefs).not.toContain(p.a1.id); expect(e!.groupRefs).not.toContain(p.b1.id);
  });

  it('T03: a third company is not protected — C attacks the raider right at the drop', () => {
    const f = fixture(); hostile(f, f.A, f.B); hostile(f, f.C, f.A);
    const p = plunder(f, f.at(20000, 15000));
    const a1c = ships(f, p.a1)[0].pos;
    const c1 = fleet(f, f.C, { x: a1c.x - 250, y: 0, z: a1c.z - 150 }, ['destroyer', 'destroyer'], 'C');
    runPinned(f, 10, [p.a1, p.b1]);
    const e = engs(f).find(x => x.groupRefs.includes(c1.id));
    expect(e).toBeDefined(); expect(e!.groupRefs).toContain(p.a1.id);
  });

  it('T04: reinforcement — a non-party group joins a running battle; a party is kept out when only its partner is there', () => {
    const f = fixture(); hostile(f, f.A, f.B); hostile(f, f.C, f.B);
    const pos = f.at(20000, 15000);
    const p = plunder(f, pos);
    // C (hostile to B only) attacks the surrendered hauler: a real battle C vs B1 next to A1
    const c1 = fleet(f, f.C, { x: p.h.pos.x + 300, y: 0, z: p.h.pos.z }, ['destroyer', 'destroyer'], 'C');
    runPinned(f, 6, [p.a1, p.b1]);
    const e = engs(f).find(x => !x.done && x.groupRefs.includes(c1.id))!;
    expect(e).toBeDefined(); expect(e.groupRefs).toContain(p.b1.id);
    // A1 is hostile to B but B's only group here is its truce partner: it does not join
    runPinned(f, 6, [p.a1, p.b1]);
    expect(e.groupRefs).not.toContain(p.a1.id);
    // A3, an unrelated A group arriving within JOIN_R, does join (B1 is no partner of it)
    const a3 = fleet(f, f.A, { x: p.h.pos.x - 600, y: 0, z: p.h.pos.z + 300 }, ['destroyer'], 'A3');
    runPinned(f, 4, [p.a1, p.b1]);
    if (!e.done) expect(e.groupRefs).toContain(a3.id);
  });

  it('T05: two plunders of the same companies keep two truces; neither overwrites the other; a replay adds none', () => {
    const f = fixture(); hostile(f, f.A, f.B);
    const p1 = plunder(f, f.at(20000, 15000));
    const p2 = plunder(f, f.at(-20000, 15000));
    const ts = f.sim.st.piracy!.truces;
    expect(ts.map(t => t.id).sort()).toEqual([p1.drop.id, p2.drop.id].sort());
    expect(truceBlocks(f.sim.st, p1.a1, p1.b1, p1.h.pos, f.sim.time)).toBe(true);
    expect(truceBlocks(f.sim.st, p2.a1, p2.b1, p2.h.pos, f.sim.time)).toBe(true);
    // crossed pairs are not covered
    expect(truceBlocks(f.sim.st, p1.a1, p2.b1, p2.h.pos, f.sim.time)).toBe(false);
    // the same demand event again: no new container, no new truce
    const r = demand(f.sim, p1.a1, p1.h);
    expect(typeof r === 'string' || r.response !== 'comply' || r.drop?.id === p1.drop.id).toBe(true);
    expect(f.sim.st.piracy!.truces).toHaveLength(2);
  });

  it('T06/T07: a direct attack ends only that truce; an unrelated attack ends none', () => {
    const f = fixture(); hostile(f, f.A, f.B);
    const p1 = plunder(f, f.at(20000, 15000));
    const p2 = plunder(f, f.at(-20000, 15000));
    const a2 = fleet(f, f.A, f.at(0, 30000), ['destroyer'], 'A2'), b2 = fleet(f, f.B, f.at(0, 31000), ['destroyer'], 'B2');
    expect(f.sim.command(f.A, { c: 'setOp', group: a2.id, op: { k: 'attack', group: b2.id } })).toBeNull();
    expect(f.sim.st.piracy!.truces).toHaveLength(2);
    expect(f.sim.command(f.A, { c: 'setOp', group: p1.a1.id, op: { k: 'attack', group: p1.b1.id } })).toBeNull();
    expect(f.sim.st.piracy!.truces.map(t => t.id)).toEqual([p2.drop.id]);
    expect(f.sim.st.piracy!.log.some(l => l.kind === 'force' && l.policy === `attack:${p1.b1.id}`)).toBe(true);
  });

  it('T06b: the victim side ending it — an escort of the surrendered group attacks the raider', () => {
    const f = fixture(); hostile(f, f.A, f.B);
    const pos = f.at(20000, 15000);
    const b1 = fleet(f, f.B, pos, ['hauler'], 'B 수송'); b1.piracyPolicy = 'survive';
    const h = ships(f, b1)[0]; h.cargo.metal = 300; h.logisticsExcluded = true;
    const esc = fleet(f, f.B, { x: pos.x + 60, y: 0, z: pos.z + 60 }, ['corvette'], 'B 호위');
    expect(f.sim.command(f.B, { c: 'setOp', group: esc.id, op: { k: 'escort', group: b1.id } })).toBeNull();
    const a1 = fleet(f, f.A, { x: pos.x, y: 0, z: pos.z - 800 }, ['cruiser', 'destroyer', 'destroyer', 'destroyer'], 'A 약탈');
    const r = demand(f.sim, a1, h); expect(typeof r === 'object' && r.response).toBe('comply');
    const t = f.sim.st.piracy!.truces[0];
    expect(t.pb).toContain(esc.id);                          // the escort is a party of the surrendered side
    expect(truceBlocks(f.sim.st, a1, esc, pos, f.sim.time)).toBe(true);
    expect(f.sim.command(f.B, { c: 'setOp', group: esc.id, op: { k: 'attack', group: a1.id } })).toBeNull();
    expect(f.sim.st.piracy!.truces).toHaveLength(0);
  });

  it('T08: after the truce time the same parties meet in P11 normally', () => {
    const f = fixture(); hostile(f, f.A, f.B);
    const p = plunder(f, f.at(20000, 15000));
    for (const s of ships(f, p.a1)) s.pos = { ...p.h.pos, x: p.h.pos.x + 200 };
    runPinned(f, 20, [p.a1, p.b1]); expect(inEng(f, p.a1)).toBe(false);
    runPinned(f, PIR.truceFor, [p.a1, p.b1]);
    expect(inEng(f, p.a1) && inEng(f, p.b1)).toBe(true);
  });

  it('T09: save / restore during a truce: same truces, same protection', () => {
    const f = fixture(); hostile(f, f.A, f.B);
    const p1 = plunder(f, f.at(20000, 15000)); plunder(f, f.at(-20000, 15000));
    const copy = new WorldSim(JSON.parse(f.sim.serialize()), { migrateContent: false });
    expect(JSON.stringify(copy.st.piracy!.truces)).toBe(JSON.stringify(f.sim.st.piracy!.truces));
    expect(truceBlocks(copy.st, copy.st.groups[p1.a1.id], copy.st.groups[p1.b1.id], p1.h.pos, copy.time)).toBe(true);
  });

  it('T10: a separate recovery group of the raider sent to that container is a party (no needless fight while recovering)', () => {
    const f = fixture(); hostile(f, f.A, f.B);
    const p = plunder(f, f.at(20000, 15000), ['destroyer', 'destroyer', 'frigate']);
    hold(f, p.a1); hold(f, p.b1);
    const col = fleet(f, f.A, { x: p.h.pos.x - 1500, y: 0, z: p.h.pos.z }, ['hauler'], 'A 회수');
    expect(f.sim.command(f.A, { c: 'setOp', group: col.id, op: { k: 'recover', wreck: p.drop.id } })).toBeNull();
    expect(truceBlocks(f.sim.st, col, p.b1, p.h.pos, f.sim.time)).toBe(true);
    const initial = p.drop.initial;
    for (let t = 0; t < 400 && (f.sim.st.drops?.[p.drop.id]?.taken[f.A] === undefined); t++) f.sim.update(.5);
    expect(Object.values(f.sim.st.drops?.[p.drop.id]?.taken[f.A] ?? { x: 1 }).reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
    expect(engs(f).filter(e => e.groupRefs.includes(p.b1.id))).toHaveLength(0);
    expect(initial).toBeGreaterThan(0);
  });

  it('T11: P13.2 saves (truce without parties) keep the company-pair rule; worlds without P13.2 have none', () => {
    const f = fixture(); hostile(f, f.A, f.B);
    const a = fleet(f, f.A, f.at(5000, 5000), ['destroyer']), b = fleet(f, f.B, f.at(5100, 5000), ['destroyer']);
    f.sim.st.piracy = { seq: 0, log: [], truces: [{ a: f.A, b: f.B, pos: f.at(5000, 5000), r: 4000, until: f.sim.time + 100 }] };
    expect(truceBlocks(f.sim.st, a, b, f.at(5000, 5000), f.sim.time)).toBe(true);
    const legacy = WorldSim.create(5, { salvage: 'p131' });
    expect(legacy.st.piracyV).toBeUndefined(); expect(legacy.st.piracy).toBeUndefined();
  });
});

describe('P13.2.1 truce follows its parties', () => {
  it('T12: the parties stay covered away from the jettison point (same dock approach, 12 km off) until the truce ends; then normal contact', () => {
    const f = fixture(); hostile(f, f.A, f.B);
    const pos = f.at(20000, 15000);
    const p = plunder(f, pos);
    const t = f.sim.st.piracy!.truces.find(x => x.id === p.drop.id)!;
    // both end up next to each other 12 km from where the cargo was jettisoned (e.g. the same nearest dock)
    const far = { x: pos.x + 12000, y: 0, z: pos.z };
    ships(f, p.b1).forEach(s => { s.pos = { ...far }; });
    ships(f, p.a1).forEach((s, i) => { s.pos = { x: far.x + 150 + i * 30, y: 0, z: far.z }; });
    expect(truceBlocks(f.sim.st, p.a1, p.b1, far, f.sim.time)).toBe(true);
    runPinned(f, 20, [p.a1, p.b1]);
    expect(inEng(f, p.a1) || inEng(f, p.b1)).toBe(false);
    // after the truce: ordinary P11 contact on the spot
    runPinned(f, t.until - f.sim.time + 4, [p.a1, p.b1]);
    expect(truceBlocks(f.sim.st, p.a1, p.b1, far, f.sim.time)).toBe(false);
    expect(inEng(f, p.a1) && inEng(f, p.b1)).toBe(true);
  });
  it('T11b: an old company-pair truce (P13.2 save) keeps its radius around the jettison point', () => {
    const f = fixture(); hostile(f, f.A, f.B);
    const a = fleet(f, f.A, f.at(5000, 5000), ['destroyer']), b = fleet(f, f.B, f.at(5100, 5000), ['destroyer']);
    f.sim.st.piracy = { seq: 0, log: [], truces: [{ a: f.A, b: f.B, pos: f.at(5000, 5000), r: 4000, until: f.sim.time + 100 }] };
    expect(truceBlocks(f.sim.st, a, b, f.at(5000, 5000), f.sim.time)).toBe(true);
    expect(truceBlocks(f.sim.st, a, b, f.at(15000, 5000), f.sim.time)).toBe(false);
  });
});

describe('P13.2.1 force chase: escape counting', () => {
  function chase(f: F) {
    hostile(f, f.A, f.B);
    const pos = f.at(10000, -25000);
    const v = fleet(f, f.B, pos, ['hauler'], 'B 수송'); v.piracyPolicy = 'protect';
    const h = ships(f, v)[0]; h.cargo.ore = 300; h.logisticsExcluded = true;
    expect(f.sim.command(f.B, { c: 'setOp', group: v.id, op: { k: 'move', to: { x: pos.x - 6000, y: 0, z: pos.z } } })).toBeNull();
    const ga = fleet(f, f.A, f.at(10000, -21000), ['destroyer', 'destroyer', 'frigate'], 'A 약탈');
    expect(f.sim.command(f.A, { c: 'setOp', group: ga.id, op: { k: 'plunder', group: v.id, policy: 'force' } })).toBeNull();
    for (let t = 0; t < 1600 && ga.plx?.phase !== 'force'; t++) f.sim.update(.5);
    expect(ga.plx?.phase).toBe('force');
    const op = plunderOrder(f.sim.st, ga.op)!, key = JSON.stringify(ga.op);
    const step = () => stepPlunder(f.sim, ga, ships(f, ga), op, .5, {} as any, key);
    return { v, h, ga, step };
  }
  it('E01: only a battle → space transition counts; moving or docking does not', () => {
    const f = fixture(); const c = chase(f);
    c.h.state = 'space'; c.step(); c.step(); expect(c.ga.plx?.escapes ?? 0).toBe(0);
    c.h.state = 'docked'; c.step();                    // docked: the chase ends (target took refuge), not an escape
    expect(c.ga.plx?.escapes ?? 0).toBe(0);
    expect(c.ga.op.k).toBe('idle'); expect(c.ga.status).toMatch(/정박/);
  });
  it('E02: a ship sunk in the battle is not an escape (the wreck is looted instead)', () => {
    const f = fixture(); const c = chase(f);
    c.h.state = 'battle'; c.step();
    delete f.sim.st.ships[c.h.id]; c.v.shipIds = [];
    c.step();
    expect(c.ga.plx?.escapes ?? 0).toBe(0);
    expect(f.sim.st.piracy!.log.some(l => l.kind === 'sunk' && l.ship === c.h.id)).toBe(true);
  });
  it('E03: the count survives a restart; after 3 escapes the order ends; a new order on another target runs', () => {
    const f = fixture(); const c = chase(f);
    c.h.state = 'battle'; c.step(); c.h.state = 'space'; c.step();
    c.h.state = 'battle'; c.step(); c.h.state = 'space'; c.step();
    expect(c.ga.plx?.escapes).toBe(2);
    const copy = new WorldSim(JSON.parse(f.sim.serialize()), { migrateContent: false });
    const g2 = copy.st.groups[c.ga.id], h2 = copy.st.ships[c.h.id];
    expect(g2.plx?.escapes).toBe(2);
    const step2 = () => stepPlunder(copy, g2, g2.shipIds.map(id => copy.st.ships[id]), plunderOrder(copy.st, g2.op)!, .5, {} as any, JSON.stringify(g2.op));
    h2.state = 'battle'; step2(); h2.state = 'space'; step2();
    expect(g2.op.k).toBe('idle'); expect(g2.status).toMatch(/3회 이탈/);
    // another loaded hauler: a fresh plunder order works normally (no carried-over state)
    const other = copy.newGroup(f.B, 'B 다른 수송'); const s = copy.spawnShip(f.B, 'hauler', 'std', other.id, { ...g2.shipIds.map(id => copy.st.ships[id])[0].pos, x: copy.st.ships[g2.shipIds[0]].pos.x + 900 });
    s.cargo.ore = 200; s.logisticsExcluded = true; other.piracyPolicy = 'survive';
    expect(copy.command(f.A, { c: 'setOp', group: g2.id, op: { k: 'plunder', group: other.id, policy: 'nonlethal' } })).toBeNull();
    for (let t = 0; t < 400 && !Object.values(copy.st.drops ?? {}).some(d => d.ship === s.id); t++) copy.update(.5);
    expect(Object.values(copy.st.drops ?? {}).some(d => d.ship === s.id)).toBe(true);
    expect(g2.plx?.escapes ?? 0).toBe(0);
  });
  it('E04: changing the order ends the chase state', () => {
    const f = fixture(); const c = chase(f);
    c.h.state = 'battle'; c.step(); c.h.state = 'space'; c.step();
    expect(c.ga.plx?.escapes).toBe(1);
    expect(f.sim.command(f.A, { c: 'setOp', group: c.ga.id, op: { k: 'move', to: f.at(0, 0) } })).toBeNull();
    run(f.sim, 2);
    expect(c.ga.plx).toBeUndefined();
  });
});

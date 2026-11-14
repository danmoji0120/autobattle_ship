// P11 persistent-world combat: PvP between PMCs, reinforcements joining the same battle instance from
// their real position, per-company command authority (server side), per-side withdrawal, save/restore
// mid-battle, replay of a record with joins, and once-only per-company settlement.
import { describe, it, expect } from 'vitest';
import { WorldSim } from '../src/world/sim';
import { World } from '../src/sim/world';
import { coRelation, canCommandGroup } from '../src/world/battleAuth';
import type { Engagement, V } from '../src/world/types';

const FAR = { x: 640000, y: 0, z: 640000 };   // deep space, away from NPC traffic
const at = (dx: number, dz: number): V => ({ x: FAR.x + dx, y: 0, z: FAR.z + dz });

function mk(seed = 5, combat: 'p11' | null = 'p11') {
  const sim = WorldSim.create(seed, combat ? { combat } : {});
  const ids = ['A', 'B', 'C', 'D'].map(n => sim.addPlayer('PMC-' + n));
  return { sim, A: ids[0], B: ids[1], C: ids[2], D: ids[3] };
}
function fleet(sim: WorldSim, owner: string, pos: V, comp: string[] = ['destroyer', 'frigate', 'frigate'], commander = true) {
  const g = sim.newGroup(owner, `${owner}-편대`);
  if (commander) { const c = sim.newCommander(owner, 2); g.commanderId = c.id; }
  comp.forEach((cl, i) => sim.spawnShip(owner, cl, 'std', g.id, { x: pos.x + i * 40, y: 0, z: pos.z }));
  return g;
}
const run = (sim: WorldSim, sec: number, until?: () => boolean) => { for (let t = 0; t < sec; t += 0.5) { sim.update(0.5); if (until?.()) return true; } return false; };
const engOf = (sim: WorldSim, gid: string): Engagement | undefined => { const s = sim.st.ships[sim.st.groups[gid].shipIds[0]]; return s?.engagement ? sim.st.engagements[s.engagement] : undefined; };
const battle = (sim: WorldSim, id: string) => (sim as any).battles.get(id) as World | undefined;

describe('P11 persistent world: opt-in gate', () => {
  it('legacy worlds keep the pirate-only attack rule and refuse stances', () => {
    const { sim, A, B } = mk(5, null);
    const ga = fleet(sim, A, at(0, 0)), gb = fleet(sim, B, at(300, 0));
    expect(sim.command(A, { c: 'setOp', group: ga.id, op: { k: 'attack', group: gb.id } })).toMatch(/해적만/);
    expect(sim.command(A, { c: 'stance', target: B, v: -1 })).toMatch(/P11/);
    run(sim, 3);
    expect(engOf(sim, ga.id)).toBeUndefined();   // two PMCs side by side never fight in a legacy world
  });
});

describe('P11 persistent world: PvP, relations, reinforcement, authority', () => {
  it('T08/T12: an attack order declares hostility; a neutral third PMC is not pulled in; nobody commands another company', () => {
    const { sim, A, B, C } = mk(6);
    const ga = fleet(sim, A, at(0, 0)), gb = fleet(sim, B, at(1000, 0)), gc = fleet(sim, C, at(500, 900));
    expect(coRelation(sim.st, A, B)).toBe(0);
    expect(sim.command(A, { c: 'setOp', group: ga.id, op: { k: 'attack', group: gb.id } })).toBeNull();
    expect(coRelation(sim.st, A, B)).toBe(-1);
    expect(coRelation(sim.st, A, C)).toBe(0);
    expect(coRelation(sim.st, B, C)).toBe(0);
    expect(sim.st.attackLog?.at(-1)).toMatchObject({ by: A, to: B, kind: 'attack' });
    expect(run(sim, 120, () => !!engOf(sim, ga.id))).toBe(true);
    const e = engOf(sim, ga.id)!;
    expect(e.v).toBe(2);
    expect(e.sides).toEqual([[A], [B]].sort((x, y) => e.sides.findIndex(s => s[0] === x[0]) - e.sides.findIndex(s => s[0] === y[0])));
    expect(e.sides.flat()).not.toContain(C);
    expect(sim.st.ships[gc.shipIds[0]].state).toBe('space');
    const w = battle(sim, e.id)!;
    run(sim, 2);
    const groupOf = (co: string) => w.groups.find(g => g.ref && sim.st.groups[g.ref]?.owner === co)!;
    const rootOf = (co: string) => w.groups.find(g => g.ref === 'co:' + co)!;
    // the server is the authority: B cannot command A's fleet or A's side root, C (not in the fight) nothing
    expect(sim.battleOrder(B, e.id, groupOf(A).id, { type: 'retreat' }, {})).toBe('지휘 권한 없음');
    expect(sim.battleOrder(B, e.id, rootOf(A).id, { type: 'retreat' }, {})).toBe('지휘 권한 없음');
    expect(sim.battleOrder(C, e.id, groupOf(B).id, { type: 'engage' }, {})).toBe('지휘 권한 없음');
    expect(sim.battleOrder(A, e.id, rootOf(A).id, { type: 'engage' }, {})).toBeNull();
    expect(sim.battleOrder(A, e.id, groupOf(A).id, { type: 'attack', targetGroup: groupOf(B).id }, {})).toBeNull();
    // the same function decides what the client shows
    expect(canCommandGroup(sim.st, w, groupOf(A), A)).toBe(true);
    expect(canCommandGroup(sim.st, w, groupOf(A), B)).toBe(false);
    expect(canCommandGroup(sim.st, w, rootOf(B), A)).toBe(false);
  });

  it('T06/T07/T09/T10/T11 + §14: B vs A running, C joins in place for A, D joins hostile to all, B withdraws, the rest fight on', () => {
    const { sim, A, B, C, D } = mk(7);
    const ga = fleet(sim, A, at(0, 0)), gb = fleet(sim, B, at(350, 0));
    sim.command(A, { c: 'stance', target: B, v: -1 });
    expect(run(sim, 30, () => !!engOf(sim, ga.id))).toBe(true);
    const e = engOf(sim, ga.id)!, w = battle(sim, e.id)!;
    run(sim, 20);
    const hpBefore = w.ships.map(s => s.hp), tickBefore = w.tick, nBefore = w.ships.length;
    // C: allied with A, declares on B; arrives from its real position (1300 east of the battle)
    sim.command(A, { c: 'stance', target: C, v: 1 }); sim.command(C, { c: 'stance', target: A, v: 1 });
    sim.command(C, { c: 'stance', target: B, v: -1 });
    expect(coRelation(sim.st, A, C)).toBe(1);
    const gc = fleet(sim, C, { x: e.pos.x + 1300, y: 0, z: e.pos.z }, ['destroyer', 'frigate'], false);  // no commander
    run(sim, 2);
    expect(engOf(sim, gc.id)?.id).toBe(e.id);           // the same engagement …
    expect(battle(sim, e.id)).toBe(w);                  // … and the same tactical world instance
    expect(w.tick).toBeGreaterThan(tickBefore);
    for (let i = 0; i < nBefore; i++) expect(w.ships[i].hp).toBeLessThanOrEqual(hpBefore[i]); // nothing reset
    expect(w.ships.length).toBe(nBefore + 2);
    const kC = e.sides.findIndex(x => x[0] === C);
    expect(kC).toBe(2);
    expect(w.relation(kC, e.sides.findIndex(x => x[0] === A))).toBe(1);
    expect(w.relation(kC, e.sides.findIndex(x => x[0] === B))).toBe(-1);
    const cShip = w.ships.find(s => s.team === kC)!;
    expect(cShip.pos.x).toBeGreaterThan(800);            // entered where it really was
    // T11: the same fleet cannot join twice
    expect(sim.joinEngagement(e, C, [{ g: gc, ss: sim.shipsOf(gc) }])).toBeNull();
    // D: hostile to everyone
    for (const x of [A, B, C]) sim.command(D, { c: 'stance', target: x, v: -1 });
    const gd = fleet(sim, D, { x: e.pos.x, y: 0, z: e.pos.z - 1400 });
    run(sim, 2);
    expect(engOf(sim, gd.id)?.id).toBe(e.id);
    const kD = e.sides.findIndex(x => x[0] === D);
    expect(kD).toBe(3);
    for (const k of [0, 1, 2]) expect(w.relation(kD, k)).toBe(-1);
    expect(e.joins?.map(j => j.company)).toEqual([C, D]);
    // T10: B withdraws its whole side; the battle continues for A, C, D
    const kB = e.sides.findIndex(x => x[0] === B);
    const E = sim.addPlayer('PMC-E');   // not in this battle: may not withdraw anybody
    expect(sim.battleOrder(E, e.id, -1, null, { withdraw: true })).toBe('지휘 권한 없음');
    expect(sim.battleOrder(B, e.id, -1, null, { withdraw: true })).toBeNull();
    const gone = run(sim, 240, () => !!w.sides[kB].out);
    expect(gone).toBe(true);
    run(sim, 1);
    expect(e.done).toBe(false);
    expect(e.released).toContain(B);
    // every B ship that escaped is back in the world now; the dead ones wait for the final settlement
    const escaped = w.ships.filter(s => s.team === kB && s.state === 'escaped').map(s => s.ref!);
    expect(escaped.length).toBeGreaterThan(0);
    for (const id of escaped) expect(sim.st.ships[id].state).toBe('space');
    // B may not rejoin this battle
    run(sim, 3);
    for (const id of escaped) expect(sim.st.ships[id].engagement).toBeUndefined();
    void kD;
  });

  it('a hostile pair meeting inside a running battle zone merges into it (overlap); a fleet destroyed before its join is dropped', () => {
    const { sim, A, B, C, D } = mk(8);
    sim.command(A, { c: 'stance', target: B, v: -1 });
    const ga = fleet(sim, A, at(0, 0)); fleet(sim, B, at(350, 0));
    run(sim, 30, () => !!engOf(sim, ga.id));
    const e = engOf(sim, ga.id)!;
    sim.command(C, { c: 'stance', target: D, v: -1 });
    const gc = fleet(sim, C, { x: e.pos.x + 1450, y: 0, z: e.pos.z + 1450 }), gd = fleet(sim, D, { x: e.pos.x + 1650, y: 0, z: e.pos.z + 1450 });
    run(sim, 2);
    expect(engOf(sim, gc.id)?.id).toBe(e.id);
    expect(engOf(sim, gd.id)?.id).toBe(e.id);
    expect(Object.values(sim.st.engagements).filter(x => !x.done).length).toBe(1);
    // a fleet whose ships are gone by the time the server builds the join event is not added
    const gx = fleet(sim, D, { x: e.pos.x - 1200, y: 0, z: e.pos.z });
    for (const id of gx.shipIds) delete sim.st.ships[id];
    expect(sim.joinEngagement(e, D, [{ g: gx, ss: [] }])).toBeNull();
  });
});

describe('P11 persistent world: save/restore, replay, settlement', () => {
  /** A vs B, C joins, then save; returns the sim, the engagement and the restored copy */
  function midBattle(seed: number) {
    const { sim, A, B, C } = mk(seed);
    sim.command(A, { c: 'stance', target: B, v: -1 });
    sim.command(C, { c: 'stance', target: B, v: -1 });
    const ga = fleet(sim, A, at(0, 0)); fleet(sim, B, at(350, 0), ['destroyer', 'destroyer', 'frigate']);
    run(sim, 30, () => !!engOf(sim, ga.id));
    const e = engOf(sim, ga.id)!;
    run(sim, 10);
    fleet(sim, C, { x: e.pos.x - 1200, y: 0, z: e.pos.z + 300 });
    run(sim, 6);
    return { sim, e, A, B, C };
  }

  it('T15/T16/T20: restore mid-battle after a join continues identically; the record replays to the same hash; settled once', () => {
    const { sim, e } = midBattle(9);
    expect(e.joins?.length).toBe(1);
    const restored = new WorldSim(JSON.parse(sim.serialize()));
    const re = restored.st.engagements[e.id];
    expect(battle(restored, e.id)!.digest()).toBe(battle(sim, e.id)!.digest());
    const finals: Record<string, string> = {};
    let ends = 0;
    for (const [k, x] of [['live', sim], ['restored', restored]] as const) {
      x.onBattleEnd = eng => { if (eng.id !== e.id) return; ends++; finals[k] = battle(x, e.id)!.digest(); };
      run(x, 900, () => x.st.engagements[e.id].done);
    }
    expect(sim.st.engagements[e.id].done).toBe(true);
    expect(ends).toBe(2);                                  // once per sim, never twice
    expect(finals.restored).toBe(finals.live);
    expect(re.summary).toBe(sim.st.engagements[e.id].summary);
    const credits = (x: WorldSim) => Object.values(x.st.companies).filter(c => c.kind === 'player').map(c => c.credits);
    expect(credits(restored)).toEqual(credits(sim));
    // the record replays from setup + orders (joins included) to the same final state
    const rec = sim.st.battleLog!.find(r => r.id === e.id)!;
    expect(rec.orders.some(o => o.ev?.k === 'join')).toBe(true);
    const w = new World(JSON.parse(JSON.stringify(rec.setup)));
    w.scheduleReplay(JSON.parse(JSON.stringify(rec.orders)));
    while (!w.outcome && w.tick < 30 * 1200) w.step();
    expect(w.digest()).toBe(finals.live);
    // settling again is a no-op
    const before = credits(sim);
    (sim as any).finishEngagement(sim.st.engagements[e.id], { winner: 0, ships: [], groupKills: new Map() }, true);
    expect(credits(sim)).toEqual(before);
  });

  it('T02/T20: pirate bounty goes only to companies that damaged pirates; a PvP kill pays no bounty', () => {
    const { sim, A, B, C } = mk(10);
    // A and C hunt a pirate band; B (neutral to both, hostile to pirates) watches from inside the zone but holds fire? —
    // B is hostile to pirates by rule, so it fights too: give it a hauler only so it deals no damage.
    const ga = fleet(sim, A, at(0, 0), ['destroyer', 'destroyer', 'frigate']);
    const gp = fleet(sim, 'pirates', at(380, 0), ['frigate', 'frigate'], false);
    const gb = fleet(sim, B, at(200, -500), ['hauler'], false);
    const gc = fleet(sim, C, at(-200, 500), ['destroyer']);
    void gp; void gb; void gc;
    const cr0 = Object.fromEntries([A, B, C].map(c => [c, sim.st.companies[c].credits]));
    expect(run(sim, 30, () => !!engOf(sim, ga.id))).toBe(true);
    const e = engOf(sim, ga.id)!;
    run(sim, 900, () => e.done);
    expect(e.done).toBe(true);
    const vsPir = (c: string) => e.dmg?.[c]?.pirates ?? 0;
    const gain = (c: string) => sim.st.companies[c].credits - cr0[c];
    console.log('[T20 bounty] dmg', JSON.stringify(e.dmg), 'gain', [A, B, C].map(gain), 'summary', e.summary);
    expect(vsPir(A)).toBeGreaterThan(0);
    expect(vsPir(B)).toBe(0);                 // a hauler deals no damage …
    expect(gain(B)).toBeLessThanOrEqual(0);   // … and earns no bounty
    for (const c of [A, B, C]) if (vsPir(c) === 0) expect(gain(c)).toBeLessThanOrEqual(0);
    if (vsPir(A) > 0 && sim.st.battleLog?.find(r => r.id === e.id)?.losses[e.sides.findIndex(x => x[0] === 'pirates')]) expect(gain(A)).toBeGreaterThan(0);

    // PvP only: A destroys B's ships — no pirate bounty for anyone
    const s2 = mk(11);
    s2.sim.command(s2.A, { c: 'stance', target: s2.B, v: -1 });
    const a2 = fleet(s2.sim, s2.A, at(0, 0), ['destroyer', 'destroyer', 'destroyer']); fleet(s2.sim, s2.B, at(350, 0), ['frigate']);
    const c2 = s2.sim.st.companies[s2.A].credits;
    run(s2.sim, 30, () => !!engOf(s2.sim, a2.id));
    const e2 = engOf(s2.sim, a2.id)!;
    run(s2.sim, 900, () => e2.done);
    expect(e2.done).toBe(true);
    console.log('[T20 pvp]', e2.summary, 'credits', c2, '→', s2.sim.st.companies[s2.A].credits, 'rep', s2.sim.st.companies[s2.A].rep);
    expect(s2.sim.st.battleLog!.at(-1)!.losses.reduce((a, b) => a + b, 0)).toBeGreaterThan(0);  // someone died
    expect(s2.sim.st.companies[s2.A].credits).toBeLessThanOrEqual(c2);
    expect(s2.sim.st.companies[s2.A].rep).toBe(0);    // no pirate standing for a PvP kill
  });
});

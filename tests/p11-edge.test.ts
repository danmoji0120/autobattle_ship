// P11 edge cases in the persistent world: many fleets arriving on the same tick, every side retreating,
// the last hostile side leaving, a fleet arriving as the battle ends, and a 200-ship three-way battle with a
// reinforcement that stays deterministic across save/restore (T18).
import { describe, it, expect } from 'vitest';
import { WorldSim } from '../src/world/sim';
import type { World } from '../src/sim/world';
import type { Engagement, V } from '../src/world/types';

const FAR = { x: 640000, y: 0, z: 640000 };
const at = (dx: number, dz: number): V => ({ x: FAR.x + dx, y: 0, z: FAR.z + dz });
function mk(seed: number, n = 5) {
  const sim = WorldSim.create(seed, { combat: 'p11' });
  return { sim, ids: Array.from({ length: n }, (_, i) => sim.addPlayer('PMC-' + 'ABCDEFGH'[i])) };
}
function fleet(sim: WorldSim, owner: string, pos: V, comp: string[] = ['destroyer', 'frigate', 'frigate']) {
  const g = sim.newGroup(owner, `${owner}-편대`);
  const c = sim.newCommander(owner, 2); g.commanderId = c.id;
  comp.forEach((cl, i) => sim.spawnShip(owner, cl, 'std', g.id, { x: pos.x + (i % 10) * 40, y: 0, z: pos.z + Math.floor(i / 10) * 40 }));
  return g;
}
const run = (sim: WorldSim, sec: number, until?: () => boolean) => { for (let t = 0; t < sec; t += 0.5) { sim.update(0.5); if (until?.()) return true; } return false; };
const engOf = (sim: WorldSim, gid: string): Engagement | undefined => { const s = sim.st.ships[sim.st.groups[gid].shipIds[0]]; return s?.engagement ? sim.st.engagements[s.engagement] : undefined; };
const battle = (sim: WorldSim, id: string) => (sim as any).battles.get(id) as World | undefined;
const rec = (sim: WorldSim, id: string) => sim.st.battleLog!.find(r => r.id === id)!;
/** no ship anywhere may point at a finished engagement */
const noStuck = (sim: WorldSim) => Object.values(sim.st.ships).filter(s => s.engagement && sim.st.engagements[s.engagement]?.done).map(s => s.id);

describe('P11 edge cases', () => {
  it('three fleets reaching a running battle on the same tick all join it, each once, at one tick', () => {
    const { sim, ids: [A, B, C, D, E] } = mk(31);
    sim.command(A, { c: 'stance', target: B, v: -1 });
    for (const x of [C, D, E]) sim.command(x, { c: 'stance', target: B, v: -1 });
    const ga = fleet(sim, A, at(0, 0)); fleet(sim, B, at(350, 0));
    expect(run(sim, 30, () => !!engOf(sim, ga.id))).toBe(true);
    const e = engOf(sim, ga.id)!;
    run(sim, 5);
    const gs = [C, D, E].map((x, i) => fleet(sim, x, { x: e.pos.x + [1300, -1300, 0][i], y: 0, z: e.pos.z + [0, 0, 1300][i] }, ['destroyer', 'frigate']));
    run(sim, 2);
    for (const g of gs) expect(engOf(sim, g.id)?.id).toBe(e.id);
    expect(e.sides.length).toBe(5);
    expect(e.joins!.map(j => j.company).sort()).toEqual([C, D, E].sort());
    expect(new Set(e.joins!.map(j => j.tick)).size).toBe(1);           // same server tick
    const w = battle(sim, e.id)!;
    expect(w.ships.length).toBe(6 + 6);
    // C, D, E are each hostile to B only: neutral to A and to each other (no forced coalition)
    const k = (co: string) => e.sides.findIndex(s => s[0] === co);
    expect(w.relation(k(C), k(D))).toBe(0);
    expect(w.relation(k(C), k(A))).toBe(0);
    expect(w.relation(k(C), k(B))).toBe(-1);
  });

  it('every side withdrawing ends the battle with no victor; all surviving ships return to the world; settled once', () => {
    const { sim, ids: [A, B] } = mk(32, 2);
    sim.command(A, { c: 'stance', target: B, v: -1 });
    const ga = fleet(sim, A, at(0, 0)), gb = fleet(sim, B, at(350, 0));
    expect(run(sim, 30, () => !!engOf(sim, ga.id))).toBe(true);
    const e = engOf(sim, ga.id)!;
    run(sim, 4);
    let ends = 0; sim.onBattleEnd = x => { if (x.id === e.id) ends++; };
    expect(sim.battleOrder(A, e.id, -1, null, { withdraw: true })).toBeNull();
    expect(sim.battleOrder(B, e.id, -1, null, { withdraw: true })).toBeNull();
    expect(run(sim, 400, () => e.done)).toBe(true);
    run(sim, 2);
    expect(ends).toBe(1);
    const r = rec(sim, e.id);
    // whoever got out first is 'withdrawn'; a side still pulling out when the field emptied 'survived' — never a victor
    expect(r.sides!.every(s => ['withdrawn', 'survived', 'destroyed'].includes(s.status))).toBe(true);
    expect(r.sides!.some(s => s.status === 'withdrawn')).toBe(true);
    expect(r.sides!.some(s => s.status === 'victor')).toBe(false);
    expect(e.summary).not.toMatch(/승리/);
    for (const g of [ga, gb]) for (const id of sim.st.groups[g.id]?.shipIds ?? []) expect(sim.st.ships[id].engagement).toBeUndefined();
    expect(noStuck(sim)).toEqual([]);
  });

  // a voluntary withdrawal is not a defeat: the sides left hold the field ('survived'), nobody is credited a
  // victory (no win farming by withdrawing a second account); destroying or routing a side is a victory
  it('when the last hostile side withdraws, the remaining (allied) sides end the battle together, nobody routed', () => {
    const { sim, ids: [A, B, C] } = mk(33, 3);
    sim.command(A, { c: 'stance', target: B, v: -1 });
    sim.command(A, { c: 'stance', target: C, v: 1 }); sim.command(C, { c: 'stance', target: A, v: 1 });
    sim.command(C, { c: 'stance', target: B, v: -1 });
    const ga = fleet(sim, A, at(0, 0)); fleet(sim, B, at(350, 0));
    expect(run(sim, 30, () => !!engOf(sim, ga.id))).toBe(true);
    const e = engOf(sim, ga.id)!;
    run(sim, 3);
    fleet(sim, C, { x: e.pos.x + 1300, y: 0, z: e.pos.z });
    run(sim, 2);
    expect(e.sides.length).toBe(3);
    expect(sim.battleOrder(B, e.id, -1, null, { withdraw: true })).toBeNull();
    expect(run(sim, 400, () => e.done)).toBe(true);
    const r = rec(sim, e.id), st = (co: string) => r.sides![e.sides.findIndex(s => s[0] === co)].status;
    expect(['withdrawn', 'destroyed']).toContain(st(B));
    expect(st(A)).toBe('survived');
    expect(st(C)).toBe('survived');
    expect(e.summary).toMatch(/잔존/);
    run(sim, 2);
    expect(noStuck(sim)).toEqual([]);
  });

  it('a fleet reaching the zone as the battle ends is never left stuck in the finished engagement', () => {
    const { sim, ids: [A, B, C] } = mk(34, 3);
    sim.command(A, { c: 'stance', target: B, v: -1 }); sim.command(C, { c: 'stance', target: B, v: -1 });
    const ga = fleet(sim, A, at(0, 0), ['destroyer', 'destroyer', 'destroyer', 'frigate']);
    fleet(sim, B, at(350, 0), ['hauler']);                         // dies fast
    expect(run(sim, 30, () => !!engOf(sim, ga.id))).toBe(true);
    const e = engOf(sim, ga.id)!;
    // C moves in from beyond the join radius towards the battle the whole time
    const gc = fleet(sim, C, { x: e.pos.x + 2600, y: 0, z: e.pos.z }, ['frigate']);
    sim.command(C, { c: 'setOp', group: gc.id, op: { k: 'patrol', at: e.pos, radius: 200 } } as any);
    expect(run(sim, 400, () => e.done)).toBe(true);
    run(sim, 3);
    expect(noStuck(sim)).toEqual([]);
    const cs = sim.st.ships[gc.shipIds[0]];
    expect(cs.state).toBe('space');
    expect(!cs.engagement || !sim.st.engagements[cs.engagement].done).toBe(true);
  });

  it('NPC-only fights past the load cap fall back to the light resolution (N-side), players are never throttled', () => {
    const { sim } = mk(36, 0);
    const lawful = Object.values(sim.st.companies).find(c => c.kind !== 'player' && c.kind !== 'pirate' && c.id !== 'pirates')!.id;
    const gs: string[] = [];
    for (let i = 0; i < 12; i++) {   // 12 fights × 16 ships = 192 > NPC_BATTLE_CAP (160)
      const p = at(i * 20000, 0);
      gs.push(fleet(sim, lawful, p, Array(8).fill('frigate')).id);
      fleet(sim, 'pirates', { ...p, x: p.x + 350 }, Array(8).fill('frigate'));
    }
    run(sim, 3);
    const es = gs.map(g => engOf(sim, g)).filter((e): e is Engagement => !!e);
    expect(es.length).toBe(12);
    const live = es.filter(e => battle(sim, e.id)), light = es.filter(e => e.autoEnd !== undefined);
    console.log('[budget] live', live.length, 'light', light.length);
    expect(live.length + light.length).toBe(12);
    expect(light.length).toBeGreaterThan(0);
    expect(live.reduce((a, e) => a + (e.n ?? 0), 0)).toBeLessThanOrEqual(160);
    for (const e of es) expect(e.v).toBe(2);
    expect(run(sim, 400, () => es.every(e => e.done))).toBe(true);
    for (const e of light) { const r = rec(sim, e.id); expect(r?.sides?.length ?? 2).toBe(2); }
    expect(noStuck(sim)).toEqual([]);
  });

  it('T18: a 200-ship three-way battle with a mid-battle reinforcement stays deterministic across save/restore', () => {
    const { sim, ids: [A, B, C] } = mk(35, 3);
    sim.command(A, { c: 'stance', target: B, v: -1 }); sim.command(C, { c: 'stance', target: A, v: -1 }); sim.command(C, { c: 'stance', target: B, v: -1 });
    const comp = (n: number) => Array.from({ length: n }, (_, i) => i % 5 === 0 ? 'destroyer' : 'frigate');
    const ga = fleet(sim, A, at(0, 0), comp(70)); fleet(sim, B, at(420, 0), comp(70));
    expect(run(sim, 30, () => !!engOf(sim, ga.id))).toBe(true);
    const e = engOf(sim, ga.id)!;
    run(sim, 5);
    fleet(sim, C, { x: e.pos.x, y: 0, z: e.pos.z + 1300 }, comp(60));
    run(sim, 2);
    const w = battle(sim, e.id)!;
    expect(e.sides.length).toBe(3);
    expect(w.ships.length).toBe(200);
    const restored = new WorldSim(JSON.parse(sim.serialize()));
    expect(battle(restored, e.id)!.digest()).toBe(w.digest());
    run(sim, 30); run(restored, 30);
    expect(battle(restored, e.id)?.digest()).toBe(battle(sim, e.id)?.digest());
  }, 120000);
});

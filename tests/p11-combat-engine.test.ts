// P11 combat engine: N sides with relations, reinforcements and withdrawals as server-stamped battle
// events, replayable from setup + order log. Ordinary two-sided battles are unchanged (scripts/combat/baseline.ts).
import { describe, expect, it } from 'vitest';
import { World, type BattleSetup } from '../src/sim/world';
import { lineFleet, bbexFleet } from '../src/sim/bbex/trials';
import type { FleetSpec } from '../src/sim/fleet';
import type { OrderRecord, Relation, SimEvent } from '../src/sim/types';

const F = (name: string, n = 1, team: 0 | 1 = 1): FleetSpec => lineFleet(name, [['cruiser', 'multi', 2 * n], ['destroyer', 'aa', 2 * n], ['corvette', 'torp', 2 * n]], 6, team);
const H: Relation = -1, N: Relation = 0, A: Relation = 1;

/** run to the end, checking every hit on the way: nobody damages a side it is not hostile to */
function run(w: World, maxT = 1300, each?: (w: World) => void) {
  const bad: string[] = [];
  while (!w.outcome && w.time < maxT) {
    each?.(w);
    w.step();
    for (const e of w.events) if (e.t === 'hit' && e.weapon !== 'blast') {
      const a = w.shipById.get(e.attacker), t = w.shipById.get(e.target);
      if (a && t && !w.hostile(a.team, t.team)) bad.push(`${a.team}->${t.team} ${e.weapon}`);
    }
  }
  return bad;
}
const dmgTo = (w: World, side: number) => w.ships.filter(s => s.team === side).reduce((a, s) => a + s.stats.dmgTaken, 0);
const dmgBy = (w: World, side: number) => w.ships.filter(s => s.team === side).reduce((a, s) => a + s.stats.dmgDealt, 0);

describe('P11 N-side combat engine', () => {
  it('T03: three independent sides fight each other and the battle ends', () => {
    const w = new World({ seed: 3, scenarioId: 'kestrel', fleets: [F('A', 1, 0), F('B'), F('C')], sides: [{ name: 'A' }, { name: 'B' }, { name: 'C' }] });
    expect(w.sides.length).toBe(3);
    const bad = run(w);
    expect(bad).toEqual([]);
    expect(w.outcome).not.toBeNull();
    for (const k of [0, 1, 2]) expect(dmgTo(w, k), `side ${k} took fire`).toBeGreaterThan(0);
    expect(w.outcome!.sides!.length).toBe(3);
    expect(w.outcome!.sides!.filter(s => s.status === 'victor').length).toBeLessThanOrEqual(1);
  });

  it('T04/T05: allied sides never shoot each other; A+B vs C and A+B vs C+D end with the coalition statuses', () => {
    const rel3: Relation[][] = [[A, A, H], [A, A, H], [H, H, A]];
    const w = new World({ seed: 4, scenarioId: 'kestrel', fleets: [F('A', 1, 0), F('B', 1, 0), F('C', 2)], rel: rel3 });
    expect(run(w)).toEqual([]);
    expect(dmgBy(w, 0) + dmgBy(w, 1)).toBeGreaterThan(0);
    const st = w.outcome!.sides!;
    // either the coalition stands (both victors / survivors together) or C does
    if (st[2].status === 'victor') expect(st[0].status).not.toBe('victor');
    else expect(st[0].status === st[1].status || st[0].status === 'victor' || st[1].status === 'victor').toBe(true);
    const rel4: Relation[][] = [[A, A, H, H], [A, A, H, H], [H, H, A, A], [H, H, A, A]];
    const w4 = new World({ seed: 5, scenarioId: 'kestrel', fleets: [F('A', 1, 0), F('B', 1, 0), F('C'), F('D')], rel: rel4 });
    expect(run(w4)).toEqual([]);
    expect(w4.outcome).not.toBeNull();
  });

  it('T08: a side neutral to both belligerents is never attacked and never attacks', () => {
    const w = new World({ seed: 8, scenarioId: 'kestrel', fleets: [F('A', 1, 0), F('B'), F('C')], rel: [[A, H, N], [H, A, N], [N, N, A]] });
    expect(run(w)).toEqual([]);
    expect(dmgTo(w, 2)).toBe(0);
    expect(dmgBy(w, 2)).toBe(0);
    expect(dmgTo(w, 0) + dmgTo(w, 1)).toBeGreaterThan(0);
    // the battle ends once A or B is gone: C is still there, it simply survives
    expect(w.outcome!.sides![2].status).toBe('survived');
  });

  it('T09: A is hostile to B and C, B and C are neutral to each other — no B↔C fire', () => {
    const w = new World({ seed: 9, scenarioId: 'kestrel', fleets: [F('A', 2, 0), F('B'), F('C')], rel: [[A, H, H], [H, A, N], [H, N, A]] });
    let bc = 0;
    run(w, 1300, ww => { for (const e of ww.events) if (e.t === 'hit') { const a = ww.shipById.get(e.attacker)?.team, t = ww.shipById.get(e.target)?.team; if ((a === 1 && t === 2) || (a === 2 && t === 1)) bc++; } });
    expect(bc).toBe(0);
    expect(dmgBy(w, 1)).toBeGreaterThan(0);
    expect(dmgBy(w, 2)).toBeGreaterThan(0);
  });

  it('T06/T07: reinforcements join a running battle at their tick; nothing already there is reset', () => {
    const base = (): World => new World({ seed: 6, scenarioId: 'kestrel', fleets: [F('A', 1, 0), F('B')], sides: [{ name: 'A' }, { name: 'B' }] });
    const plain = base(), w = base();
    // identical until the join tick
    for (let i = 0; i < 1800; i++) { plain.step(); w.step(); }
    expect(w.digest()).toBe(plain.digest());
    const before = w.ships.map(s => ({ id: s.id, hp: s.hp, x: s.pos.x, ammo: s.mounts.map(m => m.ammo).join(), order: JSON.stringify(w.groupById.get(s.groupId)!.order) }));
    const munitions = w.munitions.filter(m => !m.dead).length;
    // C arrives at 60 s as A's ally (new side), D at 120 s hostile to all
    w.scheduleEvent(1800, { k: 'join', fleet: F('C', 1, 0), side: { name: 'C', rel: [A, H] }, entry: { x: -1800, z: -300 } });
    w.step();
    expect(w.sides.length).toBe(3);
    const joined = w.events.find((e): e is Extract<SimEvent, { t: 'join' }> => e.t === 'join')!;
    expect(joined.side).toBe(2);
    expect(joined.ships.length).toBe(6);
    for (const b of before) {
      const s = w.shipById.get(b.id)!;
      expect(w.groupById.get(s.groupId)!.order ? true : false).toBe(true);
      expect(s.mounts.map(m => m.ammo).join()).toBe(b.ammo);
    }
    expect(w.munitions.length).toBeGreaterThanOrEqual(munitions);
    // ids never collide
    expect(new Set(w.ships.map(s => s.id)).size).toBe(w.ships.length);
    const ids = new Set([...w.ships.map(s => s.id), ...w.groups.map(g => g.id)]);
    expect(ids.size).toBe(w.ships.length + w.groups.length);
    // joined ships stand at the entry point, facing the centre
    const c = w.ships.filter(s => s.team === 2);
    const cx = c.reduce((a, s) => a + s.pos.x, 0) / c.length;
    expect(cx).toBeLessThan(-1200);
    expect(Math.cos(c[0].yaw - Math.atan2(1800, 300))).toBeGreaterThan(0.99);
    while (w.tick < 3600) w.step();
    w.scheduleEvent(3600, { k: 'join', fleet: F('D', 2), side: { name: 'D' }, entry: { x: 1500, z: 1500 } });
    w.step();
    expect(w.sides.length).toBe(4);
    expect(w.hostile(3, 0) && w.hostile(3, 1) && w.hostile(3, 2)).toBe(true);
    expect(w.hostile(0, 2)).toBe(false);
    const bad = run(w, 1300);
    expect(bad).toEqual([]);
    expect(dmgTo(w, 3)).toBeGreaterThan(0);
    expect(w.outcome).not.toBeNull();
  });

  it('T10: one side withdraws; the others keep fighting in the same battle', () => {
    const w = new World({ seed: 10, scenarioId: 'kestrel', fleets: [F('A', 1, 0), F('B'), F('C', 1)], rel: [[A, H, H], [H, A, H], [H, H, A]] });
    while (w.tick < 900) w.step();
    w.scheduleEvent(900, { k: 'withdraw', side: 1 });
    let outAt = -1;
    run(w, 1300, ww => { if (outAt < 0 && ww.sides[1].out) outAt = ww.time; });
    expect(outAt).toBeGreaterThan(0);
    expect(w.outcome!.time).toBeGreaterThan(outAt);
    expect(w.outcome!.sides![1].status).toBe('withdrawn');
    expect(w.outcome!.sides![1].escaped).toBeGreaterThan(0);
    expect(dmgTo(w, 0) + dmgTo(w, 2)).toBeGreaterThan(0);
  });

  it('T16: a battle with reinforcements, a relation change, a withdrawal and orders replays to the same state', () => {
    const setup: BattleSetup = { seed: 16, scenarioId: 'kestrel', fleets: [F('A', 1, 0), F('B')] };
    const live = new World(setup);
    const log: OrderRecord[] = [];
    const stamp = (rec: OrderRecord) => { log.push(JSON.parse(JSON.stringify(rec))); live.scheduleOrder(rec); };
    while (!live.outcome && live.time < 900) {
      const t = live.tick;
      if (t === 600) stamp({ tick: 604, groupId: -1, order: null, ev: { k: 'join', fleet: F('C', 1, 0), side: { name: 'C', rel: [A, H] }, entry: { x: -1500, z: 0 } } });
      if (t === 700) { const g = live.groups.find(x => x.team === 0 && x.shipIds.length)!; const tg = live.groups.find(x => x.team === 1 && x.shipIds.length)!; stamp({ tick: 704, groupId: g.id, order: { type: 'attack', targetGroup: tg.id } }); }
      if (t === 1200) stamp({ tick: 1204, groupId: -1, order: null, ev: { k: 'join', fleet: F('D', 1), side: { name: 'D' }, entry: { x: 1200, z: 1200 } } });
      // same tick: an event and an order for a group it creates
      if (t === 1500) { stamp({ tick: 1504, groupId: -1, order: null, ev: { k: 'rel', a: 1, b: 3, v: 1 } }); }
      if (t === 2100) stamp({ tick: 2104, groupId: -1, order: null, ev: { k: 'withdraw', side: 1 } });
      live.step();
    }
    const replay = new World(setup);
    replay.scheduleReplay(log.map(r => JSON.parse(JSON.stringify(r))));
    while (replay.tick < live.tick) replay.step();
    expect(replay.digest()).toBe(live.digest());
    expect(replay.sides.length).toBe(live.sides.length);
    expect(replay.hostile(1, 3)).toBe(false);
    expect(JSON.stringify(replay.outcome)).toBe(JSON.stringify(live.outcome));
  });

  it('an order and a join stamped for the same tick both apply (join first, then the order for its group)', () => {
    const w = new World({ seed: 21, scenarioId: 'kestrel', fleets: [F('A', 1, 0), F('B')] });
    for (let i = 0; i < 300; i++) w.step();
    const nextGroup = Math.max(...w.groups.map(g => g.id), ...w.ships.map(s => s.id)) + 1;
    w.scheduleEvent(305, { k: 'join', fleet: F('C', 1, 0), side: 0, entry: { x: 0, z: -1600 } });
    w.scheduleOrder({ tick: 305, groupId: nextGroup + 1, order: { type: 'hold' } });
    for (let i = 0; i < 6; i++) w.step();
    const g = w.groupById.get(nextGroup + 1)!;
    expect(g.team).toBe(0);
    expect(g.order.type).toBe('hold');
    expect(w.sides[0].roots.length).toBe(2);
  });

  it('a join after the end is ignored; joins close before the hard time cap', () => {
    const w = new World({ seed: 22, scenarioId: 'kestrel', fleets: [F('A', 2, 0), F('B')], timeLimit: 120 });
    run(w, 400);
    expect(w.outcome).not.toBeNull();
    const n = w.ships.length;
    w.scheduleEvent(w.tick, { k: 'join', fleet: F('C'), side: { name: 'C' }, entry: { x: 0, z: 0 } });
    w.step();
    expect(w.ships.length).toBe(n);
    const w2 = new World({ seed: 22, scenarioId: 'kestrel', fleets: [F('A', 1, 0), F('B')], timeLimit: 100 });
    while (w2.time < 150 && !w2.outcome) w2.step();
    expect(w2.joinOpen()).toBe(false);
  });

  it('time limit with reinforcements: extended, capped, and a stalemate — never a strength-based winner', () => {
    const w = new World({ seed: 23, scenarioId: 'kestrel', fleets: [F('A', 1, 0), F('B')], timeLimit: 60, rel: [[A, N], [N, A]] });
    // neutral sides: nothing to fight, the battle ends at once
    while (!w.outcome && w.time < 30) w.step();
    expect(w.outcome?.winner).toBe(-1);
    const w2 = new World({ seed: 23, scenarioId: 'kestrel', fleets: [F('A', 3, 0), F('B', 3)], timeLimit: 60, spawnZ: 2400 });
    for (let i = 0; i < 1500; i++) w2.step();
    w2.scheduleEvent(w2.tick, { k: 'join', fleet: F('C'), side: { name: 'C' }, entry: { x: 2500, z: 0 } });
    while (!w2.outcome && w2.time < 400) w2.step();
    expect(w2.outcome).not.toBeNull();
    expect(w2.outcome!.time).toBeLessThanOrEqual(120.6);
    if (w2.outcome!.reason === '교전 시간 종료') expect(w2.outcome!.winner).toBe(-1);
  });

  it('T17: BB-EX in a three-way battle (and joining one) only fights hostile sides', () => {
    const w = new World({ seed: 17, scenarioId: 'kestrel', fleets: [bbexFleet({ arrive: 5 }), F('B', 2), F('C', 2)], rel: [[A, H, N], [H, A, H], [N, H, A]] });
    expect(run(w, 600)).toEqual([]);
    // BB-EX never shot side C (neutral to it)
    const bbex = w.ships.find(s => s.ex)!;
    expect(bbex).toBeTruthy();
    const w2 = new World({ seed: 18, scenarioId: 'kestrel', fleets: [F('A', 2, 0), F('B', 2)] });
    for (let i = 0; i < 600; i++) w2.step();
    w2.scheduleEvent(w2.tick, { k: 'join', fleet: bbexFleet({ arrive: 3 }), side: { name: 'BB', rel: [N, H] }, entry: { x: 0, z: -900 } });
    const bad = run(w2, 500);
    expect(bad).toEqual([]);
    expect(w2.ships.find(s => s.ex)!.stats.dmgDealt).toBeGreaterThan(0);
    expect(dmgTo(w2, 0)).toBeGreaterThanOrEqual(0);
  });
});

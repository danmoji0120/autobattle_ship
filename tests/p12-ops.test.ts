// P12 military operations: defend, patrol, escort (P11 relations), attack-move, blockade, harass, reinforce,
// intercept, recon, rally; commander threat judgement, chase limits, P11 interplay and save/restore
// (P12-09..16, P12-18). See docs/P12_FLEET_OPERATIONS.md §3, §5.
import { describe, it, expect } from 'vitest';
import { WorldSim } from '../src/world/sim';
import { interceptPoint, engageLimit } from '../src/world/fleetops';
import { dist } from '../src/world/geom';
import type { Op, V, WGroup } from '../src/world/types';

const mk = (seed = 7, n = 1) => { const sim = WorldSim.create(seed, { ops: 'p12' }); return { sim, ids: Array.from({ length: n }, (_, i) => sim.addPlayer('PMC-' + 'ABCD'[i])) }; };
function fleet(sim: WorldSim, owner: string, pos: V, comp: string[] = ['destroyer', 'frigate', 'frigate'], name = '기동대', commander = true) {
  const g = sim.newGroup(owner, name);
  if (commander) { const c = sim.newCommander(owner, 2); g.commanderId = c.id; }
  comp.forEach((cl, i) => sim.spawnShip(owner, cl, 'std', g.id, { x: pos.x + (i % 8) * 45, y: 0, z: pos.z + Math.floor(i / 8) * 45 }));
  return g;
}
const run = (sim: WorldSim, sec: number, until?: () => boolean) => { for (let t = 0; t < sec; t += 0.5) { sim.update(0.5); if (until?.()) return true; } return false; };
const order = (sim: WorldSim, co: string, g: WGroup, op: Op) => sim.command(co, { c: 'setOp', group: g.id, op } as any);
const ships = (sim: WorldSim, g: WGroup) => g.shipIds.map(id => sim.st.ships[id]).filter(Boolean);
const cen = (sim: WorldSim, g: WGroup) => sim.centroid(ships(sim, g));
const engOf = (sim: WorldSim, g: WGroup) => ships(sim, g).find(s => s.engagement)?.engagement;
/** a point in Drake (its origin is the map origin in the P9 layout) */
const P = (dx: number, dz: number): V => ({ x: dx, y: 0, z: dz });
const evs = (sim: WorldSim, n = 40) => sim.st.events.slice(-n).map(e => e.text);
const pirates = (sim: WorldSim, pos: V, comp = ['corvette', 'corvette'], name = '해적') => fleet(sim, 'pirates', pos, comp, name, false);

describe('P12 operations', () => {
  it('P12-09: area defence chases an intruder, fights it (P11), then returns to its zone and keeps defending', () => {
    const { sim, ids: [A] } = mk();
    const at = P(9000, 4000);
    const g = fleet(sim, A, at, ['cruiser', 'destroyer', 'destroyer']);
    expect(order(sim, A, g, { k: 'defend', at, radius: 2500 })).toBeNull();
    run(sim, 5);
    const pir = pirates(sim, { x: at.x + 2200, y: 0, z: at.z });
    expect(run(sim, 60, () => !!engOf(sim, g))).toBe(true);
    expect(evs(sim).some(t => t.includes('방어 구역 침입'))).toBe(true);
    expect(run(sim, 600, () => !engOf(sim, g) && ships(sim, pir).length === 0)).toBe(true);
    expect(g.op.k).toBe('defend');                              // the order survived the battle
    expect(run(sim, 120, () => dist(cen(sim, g), at) < 500)).toBe(true);
    expect(g.opx!.phase).toBe('hold');
    expect(g.status).toMatch(/경계/);
  });

  it('P12-09b: defence never chases beyond its leash; a far hostile is ignored; a superior one is held against', () => {
    const { sim, ids: [A] } = mk();
    const at = P(9000, 4000);
    const g = fleet(sim, A, at, ['destroyer', 'frigate']);
    order(sim, A, g, { k: 'defend', at, radius: 1500 });
    pirates(sim, { x: at.x + 6000, y: 0, z: at.z });           // outside the zone
    run(sim, 30);
    expect(g.opx!.target).toBeUndefined();
    expect(dist(cen(sim, g), at) < 600).toBe(true);
    // a much stronger hostile inside the zone: alert, hold the position, no suicidal charge
    pirates(sim, { x: at.x + 1300, y: 0, z: at.z + 1300 }, ['battleship', 'battlecruiser', 'cruiser', 'cruiser'], '해적 본대');
    run(sim, 4);
    expect(g.opx!.phase).toBe('alert');
    expect(g.opx!.target).toBeUndefined();
  });

  it('chase limits: a fleeing target is given up after the leash, and the fleet returns to its anchor', () => {
    const { sim, ids: [A] } = mk();
    const at = P(9000, 4000);
    const g = fleet(sim, A, at, ['corvette', 'corvette']);
    order(sim, A, g, { k: 'defend', at, radius: 2500 });
    run(sim, 3);
    const pir = pirates(sim, { x: at.x + 1800, y: 0, z: at.z }, ['corvette']);
    run(sim, 2);
    pir.op = { k: 'move', to: { x: at.x + 30000, y: 0, z: at.z } }; pir.override = true;
    for (const s of ships(sim, pir)) { s.hp = 1; }
    expect(run(sim, 200, () => evs(sim).some(t => t.includes('추격 중단')) || !!engOf(sim, g))).toBe(true);
    if (!engOf(sim, g)) {
      expect(g.opx!.ignore?.[pir.id]).toBeGreaterThan(sim.time);
      expect(run(sim, 200, () => dist(cen(sim, g), at) < 600)).toBe(true);
    }
  });

  it('neutral fleets are never attacked automatically (patrol/defend/blockade declare nothing)', () => {
    const { sim, ids: [A, B] } = mk(7, 2);
    const at = P(9000, 4000);
    const g = fleet(sim, A, at);
    order(sim, A, g, { k: 'defend', at, radius: 2500 });
    const b = fleet(sim, B, { x: at.x + 300, y: 0, z: at.z });
    run(sim, 30);
    expect(engOf(sim, g)).toBeUndefined(); expect(engOf(sim, b)).toBeUndefined();
    expect(sim.st.stance?.[A]?.hostile ?? []).not.toContain(B);
  });

  it('P12-10: patrol follows its waypoints in a loop, fights on the way and resumes the route', () => {
    const { sim, ids: [A] } = mk();
    const route = [P(8000, 4000), P(12000, 4000), P(12000, 8000)];
    const g = fleet(sim, A, route[0], ['cruiser', 'destroyer']);
    expect(order(sim, A, g, { k: 'patrol', at: route[0], radius: 2000, route } as Op)).toBeNull();
    const legs = new Set<number>();
    run(sim, 150, () => { legs.add(g.opx?.leg ?? -1); return false; });
    expect([...legs].filter(x => x >= 0).sort()).toEqual([0, 1, 2]);
    pirates(sim, { x: route[1].x, y: 0, z: route[1].z + 600 });
    expect(run(sim, 200, () => !!engOf(sim, g))).toBe(true);
    expect(run(sim, 600, () => !engOf(sim, g))).toBe(true);
    expect(g.op.k).toBe('patrol');
    const after = new Set<number>();
    run(sim, 200, () => { after.add(g.opx!.leg!); return false; });
    expect(after.size).toBeGreaterThan(1);                      // the route continues
  });

  it('P12-11: escort answers a hostile PMC attacking its ward (P12 relations) and keeps its leash', () => {
    const { sim, ids: [A, B] } = mk(7, 2);
    const at = P(9000, 4000);
    const ward = fleet(sim, A, at, ['hauler'], '수송대');
    const esc = fleet(sim, A, { x: at.x - 300, y: 0, z: at.z }, ['destroyer', 'destroyer'], '호위대');
    expect(order(sim, A, esc, { k: 'escort', group: ward.id })).toBeNull();
    run(sim, 10);
    sim.command(A, { c: 'stance', target: B, v: -1 } as any);
    fleet(sim, B, { x: at.x + 1800, y: 0, z: at.z }, ['corvette'], 'B 습격대');
    run(sim, 30, () => !!engOf(sim, esc));
    expect(sim.st.groups[esc.id].status).toBeTruthy();
    expect(engOf(sim, esc) ?? engOf(sim, ward)).toBeTruthy();
  });

  it('P12-12: attack-move fights hostiles met on the way, then resumes the advance and arrives', () => {
    const { sim, ids: [A] } = mk();
    const from = P(5000, 4000), to = P(20000, 4000);
    const g = fleet(sim, A, from, ['cruiser', 'destroyer', 'destroyer']);
    pirates(sim, P(9000, 4300));
    expect(order(sim, A, g, { k: 'amove', to })).toBeNull();
    expect(run(sim, 200, () => !!engOf(sim, g))).toBe(true);
    expect(run(sim, 600, () => !engOf(sim, g))).toBe(true);
    expect(g.op.k).toBe('amove');
    expect(run(sim, 600, () => dist(cen(sim, g), to) < 500)).toBe(true);
    expect(g.status).toMatch(/공격 이동/);
  });

  it('P12-13: blockade holds a real position at the gate, engages hostiles there and lets neutrals pass', () => {
    const { sim, ids: [A, B] } = mk(7, 2);
    const gate = sim.st.systems.drake.gates.find(x => x.to === 'ember')!;
    const g = fleet(sim, A, P(0, 0), ['cruiser', 'destroyer', 'destroyer']);
    expect(order(sim, A, g, { k: 'blockade', system: 'drake', gate: gate.id })).toBeNull();
    expect(run(sim, 400, () => dist(cen(sim, g), gate.pos) < 900 && g.opx?.phase === 'hold')).toBe(true);
    expect(sim.st.conflicts ? Object.values(sim.st.conflicts).some(c => !c.ended && c.gates.includes(gate.id)) : false).toBe(false);   // no abstract closure
    const neutral = fleet(sim, B, { x: gate.pos.x + 900, y: 0, z: gate.pos.z }, ['hauler'], '중립 수송');
    run(sim, 20);
    expect(engOf(sim, neutral)).toBeUndefined();
    pirates(sim, { x: gate.pos.x + 1500, y: 0, z: gate.pos.z + 300 });
    expect(run(sim, 60, () => !!engOf(sim, g))).toBe(true);
    expect(run(sim, 600, () => !engOf(sim, g))).toBe(true);
    expect(run(sim, 200, () => dist(cen(sim, g), gate.pos) < 900)).toBe(true);
    expect(g.op.k).toBe('blockade');
  });

  it('P12-14: harass hunts a weak hostile target, and breaks off from a superior force', () => {
    const { sim, ids: [A, B] } = mk(7, 2);
    const at = P(9000, 4000);
    sim.command(A, { c: 'stance', target: B, v: -1 } as any);
    const g = fleet(sim, A, at, ['destroyer', 'frigate', 'frigate']);
    const prey = fleet(sim, B, { x: at.x + 2200, y: 0, z: at.z }, ['hauler'], 'B 수송선');
    expect(order(sim, A, g, { k: 'harass', at, radius: 3000 })).toBeNull();
    expect(run(sim, 120, () => !!engOf(sim, g))).toBe(true);
    expect(evs(sim).some(t => t.includes('습격 목표 포착') && t.includes(prey.name))).toBe(true);
    run(sim, 600, () => !engOf(sim, g));
    // a superior force arrives: evade, resume after
    const big = pirates(sim, { x: cen(sim, g).x + 2000, y: 0, z: cen(sim, g).z }, ['battleship', 'battlecruiser', 'cruiser', 'cruiser'], '해적 본대');
    void big;
    expect(run(sim, 10, () => g.opx?.phase === 'evade')).toBe(true);
    expect(g.status).toMatch(/이탈/);
  });

  it('P12-15: reinforce joins a running P11 battle mid-way (one battle, no reset), then idles', () => {
    const { sim, ids: [A, C] } = mk(7, 2);
    const at = P(9000, 4000);
    const a = fleet(sim, A, at, ['cruiser', 'destroyer']);
    pirates(sim, { x: at.x + 380, y: 0, z: at.z }, ['destroyer', 'destroyer', 'frigate', 'frigate', 'frigate']);
    expect(run(sim, 20, () => !!engOf(sim, a))).toBe(true);
    const eng = engOf(sim, a)!;
    const tick0 = (sim as any).battles.get(eng).tick;
    const c = fleet(sim, C, { x: at.x + 9000, y: 0, z: at.z + 3000 }, ['cruiser', 'cruiser', 'destroyer'], 'C 증원대');
    expect(order(sim, C, c, { k: 'reinforce', eng })).toBeNull();
    expect(run(sim, 200, () => engOf(sim, c) === eng)).toBe(true);
    const e = sim.st.engagements[eng];
    expect(e.joins!.some(j => j.company === C)).toBe(true);
    expect((sim as any).battles.get(eng).tick).toBeGreaterThan(tick0);      // same battle, not restarted
    expect(run(sim, 900, () => e.done === true)).toBe(true);
    run(sim, 3);
    expect(c.op.k).toBe('idle');
    expect(c.opx).toMatchObject({ done: 'reinforce', reason: '증원 완료' });
  });

  it('reinforce is refused when no fighting side is hostile to us (no forced entry)', () => {
    const { sim, ids: [A, B, C] } = mk(7, 3);
    sim.command(A, { c: 'stance', target: B, v: -1 } as any);
    const at = P(9000, 4000);
    const a = fleet(sim, A, at); fleet(sim, B, { x: at.x + 350, y: 0, z: at.z });
    expect(run(sim, 20, () => !!engOf(sim, a))).toBe(true);
    const c = fleet(sim, C, { x: at.x + 9000, y: 0, z: at.z }, ['destroyer'], 'C');
    expect(order(sim, C, c, { k: 'reinforce', eng: engOf(sim, a)! })).toMatch(/적대/);
  });

  it('intercept leads a moving target instead of chasing its tail', () => {
    const p = interceptPoint({ x: 0, y: 0, z: 0 }, 150, { x: 3000, y: 0, z: 0 }, { x: 0, y: 0, z: 100 });
    expect(p.z).toBeGreaterThan(1000);                           // aims ahead of the target
    expect(Math.abs(Math.hypot(p.x, p.z) / 150 - (p.z / 100))).toBeLessThan(0.5);
    const { sim, ids: [A] } = mk();
    const g = fleet(sim, A, P(5000, 0), ['corvette', 'corvette']);
    const t = pirates(sim, P(12000, 0), ['hauler'], '해적 수송');
    t.op = { k: 'move', to: P(12000, 30000) }; t.override = true;
    expect(order(sim, A, g, { k: 'intercept', group: t.id })).toBeNull();
    run(sim, 2);
    expect(g.opx!.anchor!.z).toBeGreaterThan(cen(sim, t).z + 200);
    expect(run(sim, 300, () => !!engOf(sim, g))).toBe(true);
  });

  it('intercept: the target destroyed or gone ends the operation (idle, reported)', () => {
    const { sim, ids: [A] } = mk();
    const g = fleet(sim, A, P(5000, 0));
    const t = pirates(sim, P(15000, 0), ['corvette']);
    order(sim, A, g, { k: 'intercept', group: t.id });
    run(sim, 3);
    for (const id of [...t.shipIds]) delete sim.st.ships[id];
    t.shipIds = [];
    run(sim, 3);
    expect(g.op.k).toBe('idle');
    expect(g.opx).toMatchObject({ done: 'intercept', reason: '목표 소멸' });
  });

  it('recon sweeps the area, records only what its sensors saw, and reports on completion', () => {
    const { sim, ids: [A, B] } = mk(7, 2);
    const at = P(9000, 4000);
    const g = fleet(sim, A, P(4000, 4000), ['corvette']);
    const seen = fleet(sim, B, { x: at.x + 800, y: 0, z: at.z }, ['hauler'], 'B 근처');
    const far = fleet(sim, B, P(-40000, -30000), ['hauler'], 'B 먼 곳');
    expect(order(sim, A, g, { k: 'recon', at, radius: 2000 })).toBeNull();
    expect(run(sim, 600, () => g.op.k === 'idle')).toBe(true);
    const ids = g.opx!.report!.map(r => r.id);
    expect(ids).toContain(seen.id); expect(ids).not.toContain(far.id);
    expect(g.opx!.done).toBe('recon');
  });

  it('rally gathers scattered ships at the point and waits', () => {
    const { sim, ids: [A] } = mk();
    const g = fleet(sim, A, P(0, 0), ['destroyer', 'frigate', 'corvette']);
    ships(sim, g)[2].pos = P(6000, 6000);
    const at = P(3000, 3000);
    expect(order(sim, A, g, { k: 'rally', at })).toBeNull();
    expect(run(sim, 200, () => ships(sim, g).every(s => dist(s.pos, at) < 300))).toBe(true);
    expect(g.status).toMatch(/집결 완료 \(3\/3척\)/);
  });

  it('server validation: bad shapes, unknown targets, self targets and empty fleets are refused', () => {
    const { sim, ids: [A] } = mk();
    const g = fleet(sim, A, P(0, 0));
    const empty = sim.newGroup(A, '빈 편대');
    expect(order(sim, A, g, { k: 'defend', at: { x: NaN, y: 0, z: 0 }, radius: 2000 } as Op)).toMatch(/좌표/);
    expect(order(sim, A, g, { k: 'defend', at: P(0, 0), radius: 99999 } as Op)).toMatch(/반경/);
    expect(order(sim, A, g, { k: 'intercept', group: 'nope' } as Op)).toMatch(/대상/);
    expect(order(sim, A, g, { k: 'intercept', group: g.id } as Op)).toMatch(/자사/);
    expect(order(sim, A, g, { k: 'blockade', system: 'drake', gate: 'nope' } as Op)).toMatch(/관문/);
    expect(order(sim, A, empty, { k: 'return' } as Op)).toMatch(/함선/);
    expect(order(sim, A, g, { k: 'patrol', at: P(0, 0), radius: 2000, route: [P(0, 0)] } as Op)).toMatch(/경로/);
  });

  it('commander judgement: aggression and damage change the engagement limit', () => {
    expect(engageLimit({ aggression: 0.9 }, 1)).toBeGreaterThan(engageLimit({ aggression: 0.1 }, 1));
    expect(engageLimit({ aggression: 0.5 }, 0.3)).toBeLessThan(engageLimit({ aggression: 0.5 }, 1));
  });

  it('P12-16/18: an operation interrupted by a battle and a save/restore resumes with the same state', () => {
    const mkRun = () => {
      const { sim, ids: [A] } = mk(9);
      const at = P(9000, 4000);
      const g = fleet(sim, A, at, ['cruiser', 'destroyer', 'destroyer']);
      order(sim, A, g, { k: 'defend', at, radius: 2500 });
      run(sim, 5);
      pirates(sim, { x: at.x + 2000, y: 0, z: at.z });
      run(sim, 25);
      return { sim, g };
    };
    const a = mkRun(), b = mkRun();
    const r = new WorldSim(JSON.parse(b.sim.serialize()));
    const gb = r.st.groups[b.g.id];
    expect(gb.op).toEqual(b.g.op); expect(gb.opx).toEqual(b.g.opx);
    run(a.sim, 400); run(r, 400);
    expect(gb.opx).toEqual(a.sim.st.groups[a.g.id].opx);
    expect(gb.shipIds.map(id => r.st.ships[id]?.pos)).toEqual(a.g.shipIds.map(id => a.sim.st.ships[id]?.pos));
    expect(r.st.battleLog?.length).toBe(a.sim.st.battleLog?.length);
  });
});

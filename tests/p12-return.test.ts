// P12 auto return: one order, no station in it — the commander picks the destination (P12-01..08, P12-17 and
// the extra checks: no/injured commander, cross-system travel, gate blockade, berth space, repair funds,
// return in battle, restart mid-route, repeated orders, cargo preservation). See docs/P12_FLEET_OPERATIONS.md §4.
import { describe, it, expect } from 'vitest';
import { WorldSim } from '../src/world/sim';
import { evalStations } from '../src/world/fleetops';
import type { V, WGroup } from '../src/world/types';

const mk = (seed = 7) => { const sim = WorldSim.create(seed, { ops: 'p12' }); const A = sim.addPlayer('PMC-A'); return { sim, A }; };
function fleet(sim: WorldSim, owner: string, pos: V, comp: string[] = ['destroyer', 'frigate', 'frigate'], name = '기동대', parent: string | null = null, commander = true) {
  const g = sim.newGroup(owner, name, parent);
  if (commander) { const c = sim.newCommander(owner, 2); g.commanderId = c.id; }
  comp.forEach((cl, i) => sim.spawnShip(owner, cl, 'std', g.id, { x: pos.x + (i % 8) * 45, y: 0, z: pos.z + Math.floor(i / 8) * 45 }));
  return g;
}
const run = (sim: WorldSim, sec: number, until?: () => boolean) => { for (let t = 0; t < sec; t += 0.5) { sim.update(0.5); if (until?.()) return true; } return false; };
const ret = (sim: WorldSim, co: string, g: WGroup) => sim.command(co, { c: 'setOp', group: g.id, op: { k: 'return' } } as any);
const ships = (sim: WorldSim, g: WGroup) => g.shipIds.map(id => sim.st.ships[id]);
const dockedAt = (sim: WorldSim, g: WGroup) => [...new Set(ships(sim, g).map(s => s.state === 'docked' && s.task.k === 'docked' ? s.task.station : '-'))];
const sysP = (sim: WorldSim, id: string, dx = 0, dz = 0): V => { const o = sim.st.systems[id].origin; return { x: o.x + dx, y: 0, z: o.z + dz }; };
const evs = (sim: WorldSim, n = 30) => sim.st.events.slice(-n).map(e => e.text);
/** take a public station out of service for this company (not ours to dock at) */
const deny = (sim: WorldSim, id: string) => { const s = sim.st.stations[id]; s.public = false; s.owner = 'union'; };

describe('P12 auto return', () => {
  it('P12-01: the return order carries no station and is accepted in one step; the commander picks it', () => {
    const { sim, A } = mk();
    const g = fleet(sim, A, sysP(sim, 'drake', 9000, 4000));
    expect(ret(sim, A, g)).toBeNull();
    expect(g.op).toEqual({ k: 'return' });
    run(sim, 2);
    expect(g.opx?.station).toBeTruthy();
    expect(evs(sim).some(t => t.includes('귀환지 결정'))).toBe(true);
    expect(run(sim, 300, () => g.op.k === 'idle')).toBe(true);
    expect(dockedAt(sim, g)).toEqual([g.opx!.station]);
  });

  it('legacy and P11-only worlds refuse the new orders (opt-in)', () => {
    for (const opts of [{}, { combat: 'p11' as const }]) {
      const sim = WorldSim.create(7, opts); const A = sim.addPlayer('PMC-A');
      const g = fleet(sim, A, sysP(sim, 'drake', 9000, 4000));
      expect(ret(sim, A, g)).toMatch(/P12/);
      expect(g.op.k).toBe('idle');
      expect(sim.st.opsV).toBeUndefined();
    }
  });

  it('P12-02: the nearest station is unusable → another one is chosen automatically', () => {
    const { sim, A } = mk();
    const S = sim.st.stations.drakeout;
    const g = fleet(sim, A, { x: S.pos.x + 3000, y: 0, z: S.pos.z });
    deny(sim, 'drakeout');
    expect(ret(sim, A, g)).toBeNull();
    run(sim, 2);
    expect(g.opx!.station).not.toBe('drakeout');
    const why = evalStations(sim, g, ships(sim, g), sim.cmdr(g)).find(e => e.station.id === 'drakeout')!;
    expect(why.ok).toBe(false); expect(why.why).toBe('정박 권한 없음');
    expect(run(sim, 600, () => g.op.k === 'idle')).toBe(true);
    expect(dockedAt(sim, g)).toEqual([g.opx!.station]);
  });

  it('P12-03: a hull too large for the nearby berth → a station whose berth fits', () => {
    const { sim, A } = mk();
    const S = sim.st.stations.drakeout;               // M berth
    const g = fleet(sim, A, { x: S.pos.x + 3000, y: 0, z: S.pos.z }, ['destroyer', 'hauler']);
    const big = ships(sim, g)[1]; big.hull = 'hauler_meridian';   // L-size industrial hull
    expect(ret(sim, A, g)).toBeNull();
    run(sim, 2);
    const ev = evalStations(sim, g, ships(sim, g), sim.cmdr(g));
    expect(ev.find(e => e.station.id === 'drakeout')!.why).toMatch(/정박 규격 부족/);
    expect(g.opx!.station).not.toBe('drakeout');
    expect(run(sim, 900, () => g.op.k === 'idle')).toBe(true);
    expect(ships(sim, g).every(s => s.state === 'docked')).toBe(true);
  });

  it('P12-04: hostiles on the best route make the commander evaluate and take a safer one', () => {
    const pick = (danger: boolean) => {
      const { sim, A } = mk(11);
      deny(sim, 'drakeout');
      const out = sim.st.systems.drake.gates.find(x => x.to === 'ember')!;
      const g = fleet(sim, A, { x: out.pos.x + 2500, y: 0, z: out.pos.z + 2500 });
      // the calm favourite (Astra) is reached through the drake→astra gate: a strong hostile fleet sits on it
      const gate = sim.st.systems.drake.gates.find(x => x.to === 'astra')!;
      if (danger) fleet(sim, 'pirates', { x: gate.pos.x + 1500, y: 0, z: gate.pos.z }, ['cruiser', 'cruiser', 'destroyer', 'destroyer', 'destroyer', 'frigate'], '해적단', null, false);
      const ev = evalStations(sim, g, ships(sim, g), sim.cmdr(g)).filter(e => e.ok);
      return { best: ev[0], all: ev, sys: (id: string) => sim.sysOf(sim.st.stations[id].pos)!.id };
    };
    const calm = pick(false), hot = pick(true);
    expect(calm.sys(calm.best.station.id)).toBe('astra');
    const same = hot.all.find(e => e.station.id === calm.best.station.id)!;
    expect(same.risk).toBeGreaterThan(calm.best.risk);          // the route risk is evaluated, not only distance
    expect(hot.sys(hot.best.station.id)).not.toBe('astra');     // and the commander takes another way home
  });

  it('P12-05: the destination is lost on the way → a replacement is found (no flip-flopping otherwise)', () => {
    const { sim, A } = mk();
    const g = fleet(sim, A, sysP(sim, 'drake', -20000, 20000));
    expect(ret(sim, A, g)).toBeNull();
    run(sim, 2);
    const first = g.opx!.station!;
    // the destination does not change while it stays valid
    const seen = new Set<string>();
    run(sim, 6, () => { seen.add(g.opx!.station!); return false; });
    expect([...seen]).toEqual([first]);
    deny(sim, first);
    run(sim, 2);
    expect(g.opx!.station).toBeTruthy();
    expect(g.opx!.station).not.toBe(first);
    expect(evs(sim).some(t => t.includes('이용 불가'))).toBe(true);
    expect(run(sim, 900, () => g.op.k === 'idle')).toBe(true);
    expect(dockedAt(sim, g)).toEqual([g.opx!.station]);
  });

  it('P12-06: no usable station anywhere → the fleet waits where it is, reports, keeps every ship', () => {
    const { sim, A } = mk();
    const g = fleet(sim, A, sysP(sim, 'drake', 9000, 4000));
    for (const id of Object.keys(sim.st.stations)) deny(sim, id);
    const before = ships(sim, g).map(s => ({ id: s.id, hp: s.hp }));
    expect(ret(sim, A, g)).toBeNull();
    const p0 = { ...ships(sim, g)[0].pos };
    run(sim, 40);
    expect(g.op.k).toBe('return');
    expect(g.opx!.phase).toBe('blocked');
    expect(g.opx!.reason).toMatch(/귀환 가능한 정거장 없음/);
    expect(g.status).toMatch(/귀환 가능한 정거장 없음/);
    expect(evs(sim).filter(t => t.includes('귀환 가능한 정거장 없음')).length).toBe(1);   // reported once, not spammed
    expect(Math.hypot(ships(sim, g)[0].pos.x - p0.x, ships(sim, g)[0].pos.z - p0.z)).toBeLessThan(300);
    expect(ships(sim, g).map(s => ({ id: s.id, hp: s.hp }))).toEqual(before);
    // a station becomes available again: the retry picks it up
    sim.st.stations.drakeout.public = true; sim.st.stations.drakeout.owner = 'union';
    run(sim, 20);
    expect(g.opx!.station).toBe('drakeout');
  });

  it('P12-07: completion docks, idles, and never resumes the previous mission', () => {
    const { sim, A } = mk();
    const g = fleet(sim, A, sysP(sim, 'drake', 9000, 4000));
    expect(sim.command(A, { c: 'setOp', group: g.id, op: { k: 'patrol', at: sysP(sim, 'drake', 9000, 4000), radius: 2000 } } as any)).toBeNull();
    run(sim, 10);
    expect(ret(sim, A, g)).toBeNull();
    expect(run(sim, 600, () => g.op.k === 'idle')).toBe(true);
    expect(g.opx).toMatchObject({ phase: 'done', done: 'return' });
    run(sim, 120);
    expect(g.op.k).toBe('idle');
    expect(ships(sim, g).every(s => s.state === 'docked')).toBe(true);
    expect(evs(sim, 60).filter(t => t.includes('귀환 완료')).length).toBe(1);
  });

  it('P12-08: a mixed fleet (warships, miners, haulers, subgroups) returns together, nothing lost, cargo kept', () => {
    const { sim, A } = mk();
    const at = sysP(sim, 'drake', -15000, -9000);
    const g = fleet(sim, A, at, ['cruiser', 'destroyer'], '본대');
    const sub = fleet(sim, A, { x: at.x + 400, y: 0, z: at.z }, ['miner', 'hauler'], '지원대', g.id);
    const all = [...ships(sim, g), ...ships(sim, sub)];
    all[3].cargo = { metal: 120 } as any;
    expect(ret(sim, A, g)).toBeNull();
    // the slow hauler and the miner are not left behind: the march waits for them
    expect(run(sim, 900, () => g.op.k === 'idle')).toBe(true);
    expect(all.every(s => sim.st.ships[s.id] && s.state === 'docked' && s.task.k === 'docked' && s.task.station === g.opx!.station)).toBe(true);
    expect((sim.st.ships[all[3].id].cargo as any).metal).toBe(120);
    expect(sub.op.k).toBe('idle');                    // the subgroup followed the parent's order
    expect(sub.parentId).toBe(g.id);                  // hierarchy untouched
  });

  it('P12-17: one group returning does not change other groups of the company (or overridden children)', () => {
    const { sim, A } = mk();
    const at = sysP(sim, 'drake', 9000, 4000);
    const g = fleet(sim, A, at, ['destroyer', 'frigate'], '복귀대');
    const child = fleet(sim, A, { x: at.x, y: 0, z: at.z + 600 }, ['frigate'], '독립 자대', g.id);
    const other = fleet(sim, A, { x: at.x + 5000, y: 0, z: at.z }, ['destroyer'], '순찰대');
    const pat = { k: 'patrol', at: { x: at.x + 5000, y: 0, z: at.z }, radius: 1500 };
    expect(sim.command(A, { c: 'setOp', group: other.id, op: pat } as any)).toBeNull();
    expect(sim.command(A, { c: 'setOp', group: child.id, op: { k: 'move', to: { x: at.x - 3000, y: 0, z: at.z } } } as any)).toBeNull();
    expect(ret(sim, A, g)).toBeNull();
    expect(run(sim, 600, () => g.op.k === 'idle')).toBe(true);
    expect(other.op).toEqual(pat);
    expect(child.op.k).toBe('move');
    expect(ships(sim, child).every(s => s.state === 'space')).toBe(true);
    expect(ships(sim, other).every(s => s.state === 'space')).toBe(true);
  });

  it('reorganisation mid-return: a group joining follows the order, a group leaving stops following it', () => {
    const { sim, A } = mk();
    const at = sysP(sim, 'drake', -20000, 20000);
    const g = fleet(sim, A, at, ['destroyer', 'frigate'], '본대');
    const leaver = fleet(sim, A, { x: at.x, y: 0, z: at.z + 500 }, ['frigate'], '이탈대', g.id);
    const joiner = fleet(sim, A, { x: at.x + 3000, y: 0, z: at.z }, ['corvette'], '합류대');
    expect(ret(sim, A, g)).toBeNull();
    run(sim, 5);
    expect(sim.command(A, { c: 'setParent', group: leaver.id, parent: null } as any)).toBeNull();
    expect(sim.command(A, { c: 'setParent', group: joiner.id, parent: g.id } as any)).toBeNull();
    expect(run(sim, 900, () => g.op.k === 'idle')).toBe(true);
    expect(ships(sim, joiner).every(s => s.state === 'docked' && s.task.k === 'docked' && s.task.station === g.opx!.station)).toBe(true);
    expect(ships(sim, leaver).every(s => s.state === 'space')).toBe(true);     // left the command: not docked by it
    expect(leaver.op.k).toBe('idle');
    expect([...ships(sim, g), ...ships(sim, joiner), ...ships(sim, leaver)].length).toBe(4);
  });

  it('no commander and an injured commander still return (acting captain decides)', () => {
    const { sim, A } = mk();
    const a = fleet(sim, A, sysP(sim, 'drake', 9000, 4000), ['destroyer'], '무지휘', null, false);
    const b = fleet(sim, A, sysP(sim, 'drake', 9000, 6000), ['destroyer'], '부상');
    sim.st.commanders[b.commanderId!].injuredUntil = sim.time + 9999;
    expect(ret(sim, A, a)).toBeNull(); expect(ret(sim, A, b)).toBeNull();
    expect(run(sim, 600, () => a.op.k === 'idle' && b.op.k === 'idle')).toBe(true);
  });

  it('cross-system return goes through gates and docks; a blockaded gate is routed around', () => {
    const { sim, A } = mk();
    // in drake, with drake's station closed: the route to an Astra station goes through the drake→astra gate
    deny(sim, 'drakeout');
    const g = fleet(sim, A, sysP(sim, 'drake', 9000, 4000));
    const gate = sim.st.systems.drake.gates.find(x => x.to === 'astra')!;
    const back = sim.st.systems.astra.gates.find(x => x.to === 'drake')!;
    sim.st.conflicts = { c1: { id: 'c1', a: 'x', b: 'y', gates: [gate.id, back.id], since: 0, lost: {} } };
    const ev = evalStations(sim, g, ships(sim, g), sim.cmdr(g));
    expect(ret(sim, A, g)).toBeNull();
    run(sim, 2);
    const S = sim.st.stations[g.opx!.station!];
    expect(sim.sysOf(S.pos)!.id).not.toBe('drake');
    expect(ev.filter(e => e.ok).length).toBeGreaterThan(0);
    expect(run(sim, 1800, () => g.op.k === 'idle')).toBe(true);
    expect(dockedAt(sim, g)).toEqual([S.id]);
  });

  it('berth space shortage: a station without room for the whole fleet is skipped', () => {
    const { sim, A } = mk();
    const S = sim.st.stations.drakeout;
    const g = fleet(sim, A, { x: S.pos.x + 3000, y: 0, z: S.pos.z }, ['destroyer', 'frigate', 'frigate']);
    // make drakeout a sized station with 4 berths, 2 of them taken
    S.size = 'S';
    const occ = fleet(sim, 'guild', S.pos, ['hauler', 'hauler'], '정박선', null, false);
    for (const s of ships(sim, occ)) sim.dockShip(s, S);
    const e = evalStations(sim, g, ships(sim, g), sim.cmdr(g)).find(x => x.station.id === 'drakeout')!;
    expect(e.ok).toBe(false); expect(e.why).toBe('정박 공간 부족');
    expect(ret(sim, A, g)).toBeNull();
    run(sim, 2);
    expect(g.opx!.station).not.toBe('drakeout');
  });

  it('repair funds: a damaged fleet prefers a repair station it can pay for; no free healing ever', () => {
    const { sim, A } = mk();
    const g = fleet(sim, A, sysP(sim, 'drake', 9000, 4000));
    for (const s of ships(sim, g)) s.hp = 0.4;
    const co = sim.st.companies[A]; co.credits = 5_000_000;
    const withFunds = evalStations(sim, g, ships(sim, g), sim.cmdr(g)).filter(e => e.ok);
    expect(withFunds[0].service).toBeLessThan(0);
    co.credits = 0;
    const broke = evalStations(sim, g, ships(sim, g), sim.cmdr(g)).filter(e => e.ok);
    expect(broke.every(e => e.service >= 0)).toBe(true);
    expect(ret(sim, A, g)).toBeNull();
    expect(run(sim, 600, () => g.op.k === 'idle')).toBe(true);
    expect(ships(sim, g).every(s => s.hp <= 0.4 + 1e-9)).toBe(true);        // docking did not repair for free
    expect(co.credits).toBe(0);
  });

  it('a server restart mid-return continues exactly like the uninterrupted run', () => {
    const base = () => { const { sim, A } = mk(); deny(sim, 'drakeout'); const g = fleet(sim, A, sysP(sim, 'drake', 9000, 4000)); ret(sim, A, g); return { sim, A, g }; };
    const a = base(); run(a.sim, 30);
    const b = base(); run(b.sim, 30);
    expect(b.g.op.k).toBe('return');
    const restored = new WorldSim(JSON.parse(b.sim.serialize()));
    const gb = restored.st.groups[b.g.id];
    expect(gb.op).toEqual({ k: 'return' }); expect(gb.opx).toEqual(b.g.opx);
    expect(run(a.sim, 1200, () => a.g.op.k === 'idle')).toBe(true);
    expect(run(restored, 1200, () => gb.op.k === 'idle')).toBe(true);
    expect(restored.time).toBe(a.sim.time);
    expect(dockedAt(restored, gb)).toEqual(dockedAt(a.sim, a.g));
    expect(gb.shipIds.map(id => restored.st.ships[id].pos)).toEqual(a.g.shipIds.map(id => a.sim.st.ships[id].pos));
  });

  it('the same return order sent repeatedly keeps the decision (no reset, no extra reports)', () => {
    const { sim, A } = mk();
    const g = fleet(sim, A, sysP(sim, 'drake', -20000, 20000));
    expect(ret(sim, A, g)).toBeNull();
    run(sim, 3);
    const x = { ...g.opx! };
    for (let i = 0; i < 5; i++) { expect(ret(sim, A, g)).toBeNull(); run(sim, 0.5); }
    expect(g.opx!.station).toBe(x.station);
    expect(g.opx!.evalT).toBe(x.evalT);
    expect(evs(sim, 80).filter(t => t.includes('귀환지 결정')).length).toBe(1);
  });

  it('return during a battle: only this group retreats (no side-wide withdraw), then it returns home; settled once', () => {
    const { sim, A } = mk();
    const at = sysP(sim, 'drake', 9000, 4000);
    const g = fleet(sim, A, at, ['cruiser', 'destroyer', 'destroyer']);
    const stay = fleet(sim, A, { x: at.x + 200, y: 0, z: at.z + 200 }, ['cruiser', 'destroyer'], '잔류대');
    fleet(sim, 'pirates', { x: at.x + 380, y: 0, z: at.z }, ['destroyer', 'frigate', 'frigate', 'frigate'], '해적', null, false);
    expect(run(sim, 20, () => ships(sim, g).some(s => s.engagement))).toBe(true);
    const eng = ships(sim, g).find(s => s.engagement)!.engagement!;
    const ends: string[] = []; sim.onBattleEnd = e => ends.push(e.id);
    expect(ret(sim, A, g)).toBeNull();
    const e = sim.st.engagements[eng];
    expect(e.orders.filter((o: any) => o.order?.type === 'retreat').length).toBeGreaterThan(0);
    expect(e.orders.some((o: any) => o.ev?.k === 'withdraw' || o.k === 'withdraw')).toBe(false);
    expect(stay.op.k).toBe('idle');
    expect(run(sim, 1200, () => g.op.k === 'idle')).toBe(true);
    const alive = ships(sim, g).filter(Boolean);
    expect(alive.every(s => s.state === 'docked')).toBe(true);
    run(sim, 60);
    expect(ends.filter(x => x === eng).length).toBeLessThanOrEqual(1);
    expect(sim.st.battleLog!.filter(r => r.id === eng).length).toBeLessThanOrEqual(1);
  });
});

// P16.1 strike-craft battle engine prototype (BattleSetup.rules 3, sim/craft.ts): compatibility with rules 0–2
// and with rules 3 without craft, determinism with craft (replay with a mid-battle carrier join), and the
// prototype behaviours: launch / recovery / re-sortie, per-battle spares, instant guns, ordnance munitions,
// interceptors, point defence against craft next to interception, carrier loss and a side leaving.
// docs/P16_0_FIGHTERS_CARRIERS.md (rev 2) §6–§8, §14 T1–T4
import { describe, expect, it } from 'vitest';
import { World, BATTLE_RULES, type BattleSetup } from '../src/sim/world';
import { bandsOf } from '../src/sim/ai/computer';
import { WEAPONS } from '../src/sim/data/weapons';
import { getLoadout } from '../src/sim/data/ships';
import type { FleetSpec, GroupSpec, ShipSpec } from '../src/sim/fleet';
import type { OrderRecord, Ship, SimEvent } from '../src/sim/types';
import { registerP16Fixtures, P16_CARRIER, P16_W, FIGHTERS, BOMBERS } from './helpers/p16Craft';

registerP16Fixtures();
const S = (c: string, l: string, n: number, extra: Partial<ShipSpec> = {}): ShipSpec[] => Array.from({ length: n }, () => ({ classId: c, loadoutId: l, ...extra }));
const G = (ships: ShipSpec[], order: GroupSpec['order'] = 'engage', cmd = 'wolf'): GroupSpec => ({ name: 'g', commanderId: cmd, order, retreatAt: 0, ships, children: [] });
const F = (g: GroupSpec, name = 'x'): FleetSpec => ({ name, root: g });
const setup = (a: GroupSpec, b: GroupSpec, rules = 3, seed = 4): BattleSetup => ({ seed, scenarioId: 'p16', fleets: [F(a, 'A'), F(b, 'B')], rules });
/** run, collecting events */
function run(w: World, T: number, on?: (e: SimEvent) => void) {
  while (!w.outcome && w.time < T) { w.step(); if (on) for (const e of w.events) on(e); }
  return w;
}
const carrierOf = (w: World) => w.ships.find(s => s.cls.id === P16_CARRIER)!;

describe('P16.1 compatibility (T1, T2)', () => {
  it('new battles are still stamped rules 2 (craft content arrives in P16.2); rules 3 is opt-in', () => {
    expect(BATTLE_RULES).toBe(2);
  });

  it('T2: a rules 3 battle without craft weapons runs exactly like rules 2 (no pool, same digest)', () => {
    const cases: [GroupSpec, GroupSpec][] = [
      [G([...S('battleship', 'std', 2), ...S('destroyer', 'aa', 3)]), G([...S('cruiser', 'missile', 2), ...S('corvette', 'torp', 4)])],
      [G([...S('cruiser', 'multi', 3, { cpu: { id: 'cpu_line', arch: 'line' } })]), G([...S('destroyer', 'aa', 3, { cpu: { id: 'cpu_picket', arch: 'picket' } }), ...S('frigate', 'missile', 2)])],
    ];
    for (const [a, b] of cases) {
      const w2 = run(new World(setup(a, b, 2)), 90), w3 = run(new World(setup(a, b, 3)), 90);
      expect(w3.craft).toBeNull();
      expect(w3.tick).toBe(w2.tick);
      expect(w3.digest()).toBe(w2.digest());
    }
  });

  it('T1: a craft mount under rules 0–2 does nothing (no pool, no launches, the mount never fires)', () => {
    for (const rules of [0, 1, 2]) {
      const w = new World(setup(G(S(P16_CARRIER, 'mixed', 1)), G(S('destroyer', 'aa', 2)), rules));
      let launches = 0, craftFire = 0;
      const car = carrierOf(w);
      const craftMounts = new Set(car.mounts.filter(m => m.weapon.kind === 'craft').map(m => m.index));
      run(w, 60, e => { if (e.t === 'craftLaunch') launches++; if (e.t === 'fire' && e.ship === car.id && craftMounts.has(e.mount)) craftFire++; });
      expect(w.craft).toBeNull();
      expect(launches + craftFire).toBe(0);
    }
  });

  it('craft weapons are not guns: combat-computer bands ignore a craft mount', () => {
    const rows = (ids: string[]) => ids.map(id => ({ w: WEAPONS[id], f: 0, arc: 180 }));
    const guns = getLoadout('cruiser', 'multi').mounts.map(m => m.weapon);
    const unguided = () => false;
    expect(bandsOf(rows([...guns, P16_W.fighters, P16_W.bombers]), unguided)).toEqual(bandsOf(rows(guns), unguided));
    expect(bandsOf(rows([P16_W.fighters, 'pd_gun']), unguided).dps).toBe(0);
  });
});

describe('P16.1 determinism with craft (T3)', () => {
  it('the same setup gives the same digest, and a replay with a mid-battle carrier join and orders matches the live battle', () => {
    const a = G([...S(P16_CARRIER, 'mixed', 1), ...S('destroyer', 'aa', 2)]);
    const b = G([...S('cruiser', 'missile', 2), ...S('destroyer', 'aa', 2)]);
    const st = setup(a, b, 3, 9);
    const live = new World(st);
    expect(live.craft).not.toBeNull();
    const log: OrderRecord[] = [];
    const stamp = (rec: OrderRecord) => { log.push(JSON.parse(JSON.stringify(rec))); live.scheduleOrder(rec); };
    while (!live.outcome && live.time < 100) {
      // a second carrier joins the enemy side mid-battle (the pool takes its squadrons), then an order
      if (live.tick === 450) stamp({ tick: 454, groupId: -1, order: null, ev: { k: 'join', fleet: F(G(S(P16_CARRIER, 'fighters', 1)), 'C'), side: 1, entry: { x: 0, z: 2600 } } });
      if (live.tick === 900) { const g = live.groups.find(x => x.team === 0 && x.shipIds.length)!; stamp({ tick: 904, groupId: g.id, order: { type: 'hold' } }); }
      live.step();
    }
    expect(live.craft!.squads.length).toBe(5 + 2);
    expect(live.craft!.squads.some(q => q.team === 1 && q.stats.launched > 0)).toBe(true);
    const replay = new World(st);
    replay.scheduleReplay(log.map(r => JSON.parse(JSON.stringify(r))));
    while (replay.tick < live.tick) replay.step();
    expect(replay.digest()).toBe(live.digest());
    const again = run(new World(st), 40), again2 = run(new World(st), 40);
    expect(again.digest()).toBe(again2.digest());
  });
});

describe('P16.1 behaviour', () => {
  it('launch, recovery and re-sortie; losses replaced from per-battle spares only', () => {
    const w = new World(setup(G([...S(P16_CARRIER, 'mixed', 1), ...S('destroyer', 'aa', 2)]), G([...S('battleship', 'std', 1), ...S('destroyer', 'aa', 3)])));
    run(w, 200);
    const c = w.craft!;
    const bombers = c.squads.filter(q => q.cs.role === 'bomber');
    // bombers come back to re-arm after dropping and go out again
    expect(bombers.some(q => q.stats.recovered > 0)).toBe(true);
    expect(bombers.reduce((a, q) => a + q.stats.launched, 0)).toBeGreaterThan(BOMBERS.n * bombers.length);
    for (const q of c.squads) {
      // never more airframes lost than complement + spares; spares are never negative
      expect(q.stats.lost).toBeLessThanOrEqual(q.cs.n + q.cs.spares);
      expect(q.spares).toBeGreaterThanOrEqual(0);
    }
    // fighters lost enough to dig into their spares
    expect(c.squads.filter(q => q.cs.role === 'fighter').some(q => q.spares < FIGHTERS.spares)).toBe(true);
  });

  it('principle 2: a carrier with no gun but craft detects the enemy, stands off by its craft radius and does damage through its craft', () => {
    const w = new World(setup(G(S(P16_CARRIER, 'mixed', 1)), G(S('destroyer', 'aa', 3))));
    const car = carrierOf(w);
    let farthest = 0, ordFire = 0, gunHits = 0, shellsFromCarrier = 0;
    run(w, 150, e => {
      if (e.t === 'fire' && e.ship === car.id && e.weapon === P16_W.airTorp) ordFire++;
      if (e.t === 'fire' && e.ship === car.id && e.kind === 'shell') shellsFromCarrier++;
      if (e.t === 'hit' && e.attacker === car.id && e.weapon !== P16_W.airTorp) gunHits++;
      if (w.tick % 15 === 0 && car.state === 'alive') {
        const c = w.craft!;
        for (let i = 0; i < c.n; i++) if (c.st[i] === 2 && c.mode[i] !== 2) farthest = Math.max(farthest, Math.hypot(c.px[i] - car.pos.x, c.pz[i] - car.pos.z) / c.squads[c.sq[i]].cs.radius);
      }
    });
    const g = w.groupById.get(car.groupId)!;
    // the stand-off comes from the craft radius, not from a gun range (it has none)
    expect(g.ai.preferredRange).toBeGreaterThan(FIGHTERS.radius * 0.5);
    expect(g.ai.preferredRange).toBeLessThan(FIGHTERS.radius);
    expect(car.stats.dmgDealt).toBeGreaterThan(0);
    expect(ordFire).toBeGreaterThan(0);
    expect(gunHits).toBeGreaterThan(0);
    // guns are instant: no shell munition ever leaves the carrier
    expect(shellsFromCarrier).toBe(0);
    // craft stay inside their operating radius (a small overshoot while turning back)
    expect(farthest).toBeLessThan(1.25);
  });

  it('H mounts are found by weapon, not hull name: a cruiser fitted with a craft weapon launches craft', () => {
    const fit = { name: '시험', mounts: [...getLoadout('cruiser', 'multi').mounts, { weapon: P16_W.fighters, pos: [0, 4, -8] as [number, number, number], facing: 180, arc: 180 }] };
    const w = new World(setup(G([{ classId: 'cruiser', loadoutId: 'multi', fit }]), G(S('destroyer', 'aa', 2))));
    let launches = 0;
    run(w, 40, e => { if (e.t === 'craftLaunch') launches++; });
    expect(w.craft!.squads.length).toBe(1);
    expect(launches).toBeGreaterThan(0);
  });

  it('point defence intercepts rounds and shoots craft in the same battle; interceptors take craft and missiles', () => {
    const a = G([...S(P16_CARRIER, 'interceptors', 1), ...S('destroyer', 'aa', 3)]);
    const b = G([...S(P16_CARRIER, 'mixed', 1), ...S('cruiser', 'missile', 2)]);
    const w = new World(setup(a, b, 3, 6));
    const own = new Set(w.ships.filter(s => s.team === 0).map(s => s.id));
    const icar = w.ships.find(s => s.team === 0 && s.cls.id === P16_CARRIER)!;
    const ddIds = new Set(w.ships.filter(s => s.team === 0 && s.cls.id === 'destroyer').map(s => s.id));
    let pdIntercepts = 0, pdCraft = 0, intCraft = 0, intMunitions = 0;
    run(w, 150, e => {
      if (e.t === 'intercept' && ddIds.has(e.by)) pdIntercepts++;
      if (e.t === 'craftDown' && ddIds.has(e.by)) pdCraft++;
      if (e.t === 'craftDown' && e.by === icar.id) intCraft++;
      if (e.t === 'intercept' && e.by === icar.id) intMunitions++;
    });
    void own;
    expect(pdIntercepts).toBeGreaterThan(0);
    expect(pdCraft).toBeGreaterThan(0);
    expect(intCraft).toBeGreaterThan(0);
    expect(intMunitions).toBeGreaterThan(0);
  });

  it('a disabled H mount neither launches nor recovers', () => {
    const w = new World(setup(G(S(P16_CARRIER, 'fighters', 1)), G(S('destroyer', 'aa', 2))));
    const car = carrierOf(w);
    const m0 = car.mounts.find(m => m.weapon.kind === 'craft')!;
    m0.disabled = 1e9;
    run(w, 60);
    const sq = w.craft!.squads;
    expect(sq.find(q => q.mount === m0)!.stats.launched).toBe(0);
    expect(sq.find(q => q.mount !== m0)!.stats.launched).toBeGreaterThan(0);
  });

  it('carrier lost: craft aboard go with it, craft in the air fight on for their sortie, then leave', () => {
    const w = new World(setup(G([...S(P16_CARRIER, 'fighters', 1), ...S('battleship', 'std', 1)]), G(S('battleship', 'std', 1))));
    const car = carrierOf(w);
    // no enemy point defence, so the craft live long enough to show the sortie rule
    for (const s of w.ships) if (s.team === 1) for (const m of s.mounts) if (m.weapon.kind === 'pd') m.disabled = 1e9;
    while (w.craft!.flying(0) < 6) w.step();
    (w as unknown as { startDying(t: Ship, k: number, r: boolean, kind: string): void }).startDying(car, -1, false, 'test');
    const t0 = w.time;
    let leaves = 0, launches = 0, lastFlying = t0;
    while (!w.outcome && w.time < t0 + FIGHTERS.sortie + 5) {
      w.step();
      for (const e of w.events) { if (e.t === 'craftLeave') leaves++; if (e.t === 'craftLaunch') launches++; }
      if (w.craft!.flying(0) > 0) lastFlying = w.time;
    }
    const c = w.craft!;
    expect(launches).toBe(0);
    expect(c.flying(0)).toBe(0);
    expect(leaves).toBeGreaterThan(0);
    // they stayed for (most of) their remaining sortie, not a moment longer than the full one
    expect(lastFlying - t0).toBeGreaterThan(5);
    expect(lastFlying - t0).toBeLessThanOrEqual(FIGHTERS.sortie + 0.5);
    expect(c.count('hangar') + c.count('prep')).toBe(0);
  });

  it('a side with no ships left: its craft leave at once (they do not count for the outcome)', () => {
    // three sides so the battle goes on after side 0 is gone
    const fleets = [F(G(S(P16_CARRIER, 'fighters', 1)), 'A'), F(G(S('destroyer', 'aa', 2)), 'B'), F(G(S('destroyer', 'aa', 2)), 'C')];
    const w = new World({ seed: 3, scenarioId: 'p16', fleets, rules: 3 });
    while (w.craft!.flying(0) < 6) w.step();
    const car = carrierOf(w);
    (w as unknown as { startDying(t: Ship, k: number, r: boolean, kind: string): void }).startDying(car, -1, false, 'test');
    let outAt = -1;
    while (w.time < 60 && !w.outcome) {
      w.step();
      for (const e of w.events) if (e.t === 'sideOut' && e.side === 0) outAt = w.time;
      if (outAt >= 0 && w.time > outAt + 0.5) break;
    }
    expect(outAt).toBeGreaterThan(0);
    expect(w.craft!.flying(0)).toBe(0);
    expect(w.sides[0].out).toBe('destroyed');
  });
});

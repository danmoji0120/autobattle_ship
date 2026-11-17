// P15.0 capital-ship battle rules (BattleSetup.rules 1): hull structure, unguided plasma torpedoes, limited
// guided torpedoes, point-defence threat/allocation; rules 0 keeps the old rules. docs/P15_0_CAPITAL_SHIPS.md
import { describe, expect, it } from 'vitest';
import { World, BATTLE_RULES } from '../src/sim/world';
import { WEAPONS } from '../src/sim/data/weapons';
import { Vec3 } from '../src/sim/math';
import type { FleetSpec, ShipSpec } from '../src/sim/fleet';
import '../src/content/registry';

const S = (c: string, l: string, n: number): ShipSpec[] => Array.from({ length: n }, () => ({ classId: c, loadoutId: l }));
const F = (ships: ShipSpec[]): FleetSpec => ({ name: 'x', root: { name: 'r', commanderId: 'wolf', order: 'engage', retreatAt: 0, ships, children: [] } });
const world = (a: ShipSpec[], b: ShipSpec[], rules?: number, seed = 3) => new World({ seed, scenarioId: 'p15', fleets: [F(a), F(b)], ...(rules !== undefined ? { rules } : {}) });
const shipOf = (w: World, cls: string) => w.ships.find(s => s.cls.id === cls)!;
/** one hit from a weapon onto a ship's side */
function sideHit(w: World, cls: string, weapon: string) {
  const t = shipOf(w, cls), a = w.ships.find(s => s.team !== t.team)!;
  const side = new Vec3(t.fwd.z, 0, -t.fwd.x);   // perpendicular to the hull: a broadside hit
  const before = t.hp;
  w.rng.next = () => 0.5;                          // fixed damage roll (×1.0) and no crit
  w.applyHit(t, WEAPONS[weapon], a.id, t.pos.clone(), side, 'torpedo');
  return before - t.hp;
}

describe('P15.0 hull structure', () => {
  it('a large hull limits what one heavy hit does; small hulls, small rounds and old battles are unchanged', () => {
    expect(BATTLE_RULES).toBeGreaterThanOrEqual(1);
    const bb1 = sideHit(world(S('corvette', 'torp', 1), S('battleship', 'std', 1), 1), 'battleship', 'torpedo');
    const bb0 = sideHit(world(S('corvette', 'torp', 1), S('battleship', 'std', 1)), 'battleship', 'torpedo');
    expect(bb0).toBeCloseTo(1100, 0);
    expect(bb1).toBeCloseTo(380 + 720 * 0.45, 0);
    const dn1 = sideHit(world(S('corvette', 'torp', 1), S('dreadnought', 'std', 1), 1), 'dreadnought', 'torpedo');
    expect(dn1).toBeLessThan(bb1);
    // a destroyer has no structure entry: the same torpedo does full damage
    expect(sideHit(world(S('corvette', 'torp', 1), S('destroyer', 'aa', 1), 1), 'destroyer', 'torpedo')).toBeCloseTo(1100, 0);
    // a main-gun shell is below the bulkhead threshold: unchanged
    expect(sideHit(world(S('battleship', 'std', 1), S('battleship', 'std', 1), 1), 'battleship', 'heavy_cannon')).toBeCloseTo(360, 0);
  });
});

describe('P15.0 torpedoes', () => {
  it('the plasma torpedo runs straight and unlimited under rules 1, guided and unlimited under rules 0', () => {
    for (const rules of [0, 1]) {
      const w = world(S('corvette', 'torp', 4), S('battleship', 'std', 1), rules);
      let seen = false;
      for (let i = 0; i < 30 * 40 && !seen; i++) { w.step(); for (const m of w.munitions) if (m.kind === 'torpedo') { seen = true; expect(!!m.straight).toBe(rules === 1); } }
      expect(seen).toBe(true);
      const cv = shipOf(w, 'corvette');
      expect(cv.mounts.find(m => m.weapon.kind === 'torpedo')!.ammo).toBe(Infinity);
    }
  });

  it('a guided content torpedo carries a limited load only under rules 1', () => {
    const fit = { name: 't', mounts: [{ weapon: 'torp_std', pos: [0, 0.4, 5] as [number, number, number], facing: 0, arc: 25 }] };
    for (const [rules, ammo] of [[0, Infinity], [1, 4]] as const) {
      const w = new World({ seed: 1, scenarioId: 'p15', fleets: [F([{ classId: 'corvette', loadoutId: 'torp', fit }]), F(S('battleship', 'std', 1))], rules });
      expect(shipOf(w, 'corvette').mounts[0].ammo).toBe(ammo);
    }
    expect(WEAPONS.torp_std.p15?.magazine).toBe(4);
    expect(WEAPONS.torp_asm.p15?.magazine).toBe(3);
  });
});

describe('P15.0 point defence', () => {
  it('spreads over a salvo instead of every emitter following one round, and stays deterministic', () => {
    const run = (rules: number) => {
      const w = world(S('corvette', 'torp', 8), [...S('battleship', 'std', 1), ...S('destroyer', 'aa', 2)], rules, 2);
      let samples = 0, trackers = 0;
      for (let i = 0; i < 30 * 60; i++) {
        w.step();
        const per = new Map<number, number>();
        for (const s of w.ships) if (s.state === 'alive') for (const m of s.mounts) if (m.weapon.kind === 'pd' && m.targetIsMunition && m.targetId >= 0) per.set(m.targetId, (per.get(m.targetId) ?? 0) + 1);
        for (const n of per.values()) { samples++; trackers += n; }
      }
      return { avg: trackers / Math.max(1, samples), digest: w.digest(), intercepts: w.teamIntercepts(1) };
    };
    const a = run(1), b = run(1), old = run(0);
    expect(a.digest).toBe(b.digest);
    expect(a.avg).toBeLessThan(old.avg);
    expect(a.intercepts).toBeGreaterThan(old.intercepts);
  });
});

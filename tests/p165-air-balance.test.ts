// P16.5 air balance: strike-craft target choice (size / value / approach / point defence, the commander's
// target only a hint), coordinated torpedo runs, point defence that matters without wiping a wing, and the
// light judgement's air value taken from the actual fitting. docs/P16_5_AIR_BALANCE.md
import { describe, expect, it } from 'vitest';
import { World, type BattleSetup } from '../src/sim/world';
import { CARRIER_CLASS, SHIP_CLASSES } from '../src/sim/data/ships';
import type { FleetSpec, GroupSpec, ShipSpec } from '../src/sim/fleet';
import { airValueMul, arcWeight, rateClass, strengthParts } from '../src/world/combatRating';
import { shipValue } from '../src/world/data';
import { WorldSim } from '../src/world/sim';
import { STANDARD_WORLD } from '../src/world/worldPreset';
import { registerP165MixedHulls, P165_CRUISER_H, P165_BATTLESHIP_H } from './helpers/p16Craft';

registerP165MixedHulls();
const CV: ShipSpec = { classId: 'carrier', loadoutId: 'air_group', cpu: { id: 'cpu_carrier', arch: 'carrier' } };
const S = (classId: string, loadoutId: string, n = 1): ShipSpec[] => Array.from({ length: n }, () => ({ classId, loadoutId }));
const g = (ships: ShipSpec[]): GroupSpec => ({ name: 't', commanderId: null, order: 'engage', retreatAt: 0, ships, children: [] });
const f = (ships: ShipSpec[]): FleetSpec => ({ name: 't', root: g(ships) });
const battle = (a: ShipSpec[], b: ShipSpec[], seed: number, spawnZ = 1400): BattleSetup => ({ seed, scenarioId: 'kestrel', rules: 3, spawnZ, fleets: [f(a), f(b)] });

/** side-0 torpedo bombers: STRIKE time per target class, torpedoes released (with time), hits, intercepts */
function strikes(setup: BattleSetup, T: number) {
  const w = new World(setup);
  const share: Record<string, number> = {}, drops: number[] = [];
  let hits = 0, dmgToCarrier = 0, intercepted = 0;
  const mine = new Set(w.ships.filter(s => s.team === 0).map(s => s.id));
  const orig = w.craftMunition.bind(w);
  w.craftMunition = (c, m, wd, p, d, t) => { if (c.team === 0) drops.push(w.time); orig(c, m, wd, p, d, t); };
  const flying = new Set<number>();
  while (!w.outcome && w.time < T) {
    w.step();
    // an air torpedo that dies with no hit points left was shot down (point defence or interceptors)
    for (const id of flying) { const mu = w.munitionById.get(id); if (!mu || mu.dead) { if (mu && mu.hp <= 0) intercepted++; flying.delete(id); } }
    for (const mu of w.munitions) if (mu.air && mu.team === 0 && !mu.dead) flying.add(mu.id);
    for (const q of w.craft?.squads ?? []) if (q.team === 0 && q.cs.role === 'bomber' && q.task === 1) { const c = w.shipById.get(q.tgtShip)?.cls.id ?? '?'; share[c] = (share[c] ?? 0) + w.dt; }
    for (const e of w.events as any[]) {
      if (e.t === 'hit' && e.weapon === 'air_torpedo' && mine.has(e.attacker)) { hits++; if (w.shipById.get(e.target)?.cls.id === 'carrier') dmgToCarrier += e.dmg; }
    }
  }
  const lost = (w.craft?.squads ?? []).filter(q => q.team === 0).reduce((a, q) => a + q.stats.lost, 0);
  return { w, share, drops, hits, dmgToCarrier, intercepted, lost };
}

describe('P16.5 strike-craft target choice', () => {
  it('carrier duel: torpedo bombers go for the large ships — the enemy carrier among them — and hurt the carrier', () => {
    // before P16.5 the bombers inherited the carrier's gun target, the nearest escort: in this duel 28–72 % of their
    // strike time went to destroyers and the carriers were barely touched
    let dmg = 0, small = 0, all = 0, cv = 0;
    for (const seed of [1, 2, 3]) {
      const r = strikes(battle([CV, ...S('cruiser', 'multi'), ...S('destroyer', 'strike', 2)], [CV, ...S('cruiser', 'multi'), ...S('destroyer', 'strike', 2)], seed), 240);
      const t = Object.values(r.share).reduce((a, v) => a + v, 0);
      expect((r.share.destroyer ?? 0) / t).toBeLessThan(0.2);
      small += r.share.destroyer ?? 0; all += t; cv += r.share.carrier ?? 0;
      dmg += r.dmgToCarrier;
    }
    expect(cv / all).toBeGreaterThan(0.3);       // the carrier is a main target, not a fixed one
    expect(small).toBeGreaterThan(0);            // escorts are not ignored outright
    expect(dmg).toBeGreaterThan(1000);
  });

  it('a coordinated run: the first wave releases its torpedoes together, not in single file', () => {
    const r = strikes(battle([CV, ...S('cruiser', 'multi')], [...S('battleship', 'std'), ...S('cruiser', 'multi', 2)], 2, 1600), 120);
    expect(r.drops.length).toBeGreaterThanOrEqual(4);
    expect(r.drops[3] - r.drops[0]).toBeLessThan(4);   // four torpedoes inside four seconds
  });
});

describe('P16.5 point defence against strike craft', () => {
  it('AA escorts matter (more torpedoes stopped, fewer hits) but the wing still lands torpedoes', () => {
    const run = (esc: string) => strikes(battle([CV, ...S('cruiser', 'multi')], [...S('battleship', 'std'), ...S('destroyer', esc, 3)], 4, 1600), 200);
    const plain = run('strike'), aa = run('aa');
    const stopRate = (r: typeof plain) => r.intercepted / Math.max(1, r.drops.length);
    expect(stopRate(aa)).toBeGreaterThan(stopRate(plain));
    expect(aa.hits).toBeLessThan(plain.hits);
    expect(aa.drops.length).toBeGreaterThanOrEqual(4);
    expect(aa.hits).toBeGreaterThan(0);
  });
});

describe('P16.5.1 air-to-air attrition in a carrier duel', () => {
  it('defensive air combat stays over the own fleet: fighters keep spares longer, point defence still takes its share', () => {
    // before P16.5.1 both wings chased each other into the other fleet's point defence: fighter spares averaged
    // 0.28 per squadron at 60 s (24 seeds) — almost every squadron had spent all four
    let spares60 = 0, pd = 0, lost = 0, sq = 0;
    for (const seed of [1, 2, 3, 4]) {
      const w = new World(battle([CV, ...S('cruiser', 'multi'), ...S('destroyer', 'strike', 2)], [CV, ...S('cruiser', 'multi'), ...S('destroyer', 'strike', 2)], seed));
      while (w.time < 120) {
        w.step();
        if (w.tick === 60 * 30) for (const q of w.craft!.squads) if (q.cs.role === 'fighter') { spares60 += q.spares; sq++; }
      }
      pd += w.craft!.pdKills.reduce((a, v) => a + (v ?? 0), 0);
      lost += w.craft!.squads.reduce((a, q) => a + q.stats.lost, 0);
    }
    expect(spares60 / sq).toBeGreaterThan(0.8);
    expect(pd).toBeGreaterThan(0);          // point defence keeps its role
    expect(lost).toBeGreaterThan(20);       // and craft are far from invulnerable
  });
});

describe('P16.5 air value from the actual fitting', () => {
  it('rating: torpedo-heavy wings rate above the mixed group, interceptor-heavy below (interceptors never strike ships)', () => {
    const std = CARRIER_CLASS.loadouts[0];
    let k = 0, j = 0;
    const torp = { ...std, mounts: std.mounts.map(m => m.weapon.startsWith('wing_') ? { ...m, weapon: ['wing_fighter', 'wing_torpedo', 'wing_torpedo', 'wing_torpedo'][k++] } : m) };
    const icpt = { ...std, mounts: std.mounts.map(m => m.weapon.startsWith('wing_') ? { ...m, weapon: ['wing_fighter', 'wing_interceptor', 'wing_interceptor', 'wing_interceptor'][j++] } : m) };
    expect(airValueMul(CARRIER_CLASS, torp)).toBeGreaterThan(1);
    expect(airValueMul(CARRIER_CLASS, icpt)).toBeLessThan(1);
    const c = rateClass('carrier');
    expect(c).toBeGreaterThan(rateClass('cruiser'));
    expect(c).toBeLessThan(rateClass('battleship'));
  });

  it('H-slot cruisers / battleships: the wings they carry count, their standard loadouts and every craft-free ship keep their class value', () => {
    const ca = SHIP_CLASSES[P165_CRUISER_H], bb = SHIP_CLASSES[P165_BATTLESHIP_H];
    expect(airValueMul(ca, ca.loadouts[0])).toBe(1);
    expect(airValueMul(ca, ca.loadouts[1])).not.toBe(1);
    expect(airValueMul(bb, bb.loadouts[1])).not.toBe(1);
    // the world's light judgement reads the ship's own loadout (before P16.5 it looked only at the class standard)
    const sim = WorldSim.create(71, { ...STANDARD_WORLD });
    sim.addPlayer('경량 판정');
    const s = Object.values(sim.st.ships).find(x => SHIP_CLASSES[x.classId]?.loadouts.length)!;
    const grp = sim.st.groups[s.groupId];
    const lv = (x: typeof s) => (sim as any).lightValue(x, grp) as number;
    for (const x of Object.values(sim.st.ships)) expect(lv(x)).toBe(shipValue(x.classId));      // no craft anywhere: unchanged
    const as = (classId: string, loadoutId: string) => { const c = structuredClone(s); Object.assign(c, { classId, loadoutId, hull: undefined, variant: undefined, fitting: undefined, fit: [] }); return c; };
    expect(lv(as(P165_CRUISER_H, 'std'))).toBe(shipValue(P165_CRUISER_H));
    expect(lv(as(P165_CRUISER_H, 'air'))).toBeCloseTo(strengthParts(ca, ca.loadouts[1], shipValue(P165_CRUISER_H)).total, 9);
    expect(lv(as(P165_BATTLESHIP_H, 'air'))).toBeCloseTo(strengthParts(bb, bb.loadouts[1], shipValue(P165_BATTLESHIP_H)).total, 9);
    expect(lv(as('carrier', 'air_group'))).toBeCloseTo(strengthParts(SHIP_CLASSES.carrier, CARRIER_CLASS.loadouts[0], shipValue('carrier')).total, 9);
  });

  it('P16.5.1 light strength: class base and fitted air power separated; carriers no longer at their cost', () => {
    const v = (classId: string, lo = SHIP_CLASSES[classId].loadouts[0]) => strengthParts(SHIP_CLASSES[classId], lo, shipValue(classId));
    // craft-free classes: exactly the class value, no air part
    for (const id of ['frigate', 'destroyer', 'cruiser', 'battleship']) expect(v(id)).toEqual({ base: shipValue(id), air: 0, total: shipValue(id) });
    // the carrier's value comes from its wings, not from its cost (250): mixed group well under the cost, wing-dependent
    const std = CARRIER_CLASS.loadouts[0];
    let k = 0, j = 0;
    const torp = { ...std, mounts: std.mounts.map(m => m.weapon.startsWith('wing_') ? { ...m, weapon: ['wing_fighter', 'wing_torpedo', 'wing_torpedo', 'wing_torpedo'][k++] } : m) };
    const icpt = { ...std, mounts: std.mounts.map(m => m.weapon.startsWith('wing_') ? { ...m, weapon: ['wing_fighter', 'wing_interceptor', 'wing_interceptor', 'wing_interceptor'][j++] } : m) };
    const mixed = v('carrier'), t = v('carrier', torp), i = v('carrier', icpt);
    expect(mixed.total).toBeLessThan(shipValue('carrier'));
    expect(t.total).toBeGreaterThan(mixed.total);
    expect(i.total).toBeLessThan(mixed.total);
    expect(mixed.base).toBe(t.base);                      // same hull and guns
    expect(mixed.air).toBeGreaterThan(mixed.base);         // a carrier's strength is mostly its wings
    // H-slot battleship: trading the aft turret (blind ahead) costs less than trading a forward one
    const bb = SHIP_CLASSES[P165_BATTLESHIP_H];
    const aft = strengthParts(bb, bb.loadouts[1], 300), fwd = strengthParts(bb, bb.loadouts[2], 300);
    expect(aft.base).toBeGreaterThan(fwd.base);
    expect(arcWeight({ facing: 0, arc: 150 })).toBe(1);
    expect(arcWeight({ facing: 180, arc: 150 })).toBeCloseTo(0.35, 9);
  });

  it('an H-slot cruiser launches the wing it carries in battle', () => {
    const w = new World(battle([...S(P165_CRUISER_H, 'air')], [...S('destroyer', 'strike', 2)], 5, 1000));
    while (!w.outcome && w.time < 60) w.step();
    expect(w.craft!.squads.filter(q => q.team === 0).reduce((a, q) => a + q.stats.launched, 0)).toBeGreaterThan(0);
  });
});

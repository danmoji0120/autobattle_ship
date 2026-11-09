import { describe, expect, it } from 'vitest';
import { CONTENT, variantLayout } from '../src/content/registry';
import { hpAccepts } from '../src/content/rules';
import { EQUIPMENT } from '../src/world/industry';
import { checkFitting } from '../src/world/fitting';
import { World } from '../src/sim/world';
import { WorldSim } from '../src/world/sim';
import { availableHulls, battleSetup, configProblems, defaultConfig, defaultShip, resultOf, runBattle, summarize } from '../src/devlab/labModel';

describe('DEV-1 local combat experiments', () => {
  it('exposes all usable hulls and variants and excludes developer fixtures', () => {
    const hulls = availableHulls();
    expect(hulls.map(h => h.id).sort()).toEqual(Object.values(CONTENT.hulls).filter(h => !h.dev).map(h => h.id).sort());
    for (const hull of hulls) {
      const variants = Object.values(CONTENT.variants).filter(v => v.hull === hull.id);
      expect(variants.length, hull.id).toBeGreaterThan(0);
      for (const v of variants) expect(defaultShip(hull.id, 'test', v.id).variant).toBe(v.id);
    }
    expect(() => defaultShip(Object.values(CONTENT.hulls).find(h => h.dev)!.id, 'test')).toThrow();
  });

  it('uses the requested standard ships, equal commanders, no bonuses and full starting hull', () => {
    const c = defaultConfig(); expect(configProblems(c)).toEqual([]);
    expect(c.sides.map(s => s.root.children[0].ships[0].hull)).toEqual(['patrol_pathfinder', 'corvette_mk1']);
    expect(c.sides[0].root.commander).toEqual(c.sides[1].root.commander); expect(c.sides.map(s => s.research)).toEqual([[], []]);
    const w = new World(battleSetup(c)); expect(w.ships).toHaveLength(2);
    for (const s of w.ships) expect(s.hp).toBe(s.maxHp);
    expect(w.ships[0].mounts.map(x => x.weapon.id)).toEqual(['autocannon', 'autocannon', 'autocannon', 'pd_gun']);
  });

  it('applies real fitting validation and each side’s separate weapons and internal equipment', () => {
    const c = defaultConfig(), blue = c.sides[0].root.children[0].ships[0], red = c.sides[1].root.children[0].ships[0];
    const hp = variantLayout(blue.variant)!.hardpoints[0];
    const candidates = Object.keys(CONTENT.equipment).filter(id => EQUIPMENT[id]?.weapon && !hpAccepts(hp, id));
    expect(candidates.length).toBeGreaterThan(1);
    blue.fitting.hp[hp.id] = candidates[1];
    blue.fitting.bay.bay1 = 'mod_engine';
    expect(checkFitting(blue.variant, blue.fitting).errors).toEqual([]);
    const setup = battleSetup(c), w = new World(setup);
    expect(w.ships[0].mounts[0].weapon.id).toBe(EQUIPMENT[candidates[1]].weapon);
    expect(w.ships[1].mounts.map(m => m.weapon.id)).toEqual(new World(battleSetup(defaultConfig())).ships[1].mounts.map(m => m.weapon.id));
    expect(w.ships[0].maxSpeed).toBeGreaterThan(new World(battleSetup(defaultConfig())).ships[0].maxSpeed);
    blue.fitting.hp[hp.id] = 'mod_engine';
    expect(configProblems(c).join(' ')).toMatch(/무장|하드포인트/);
    expect(() => battleSetup(c)).toThrow();
    expect(red.fitting).toEqual(defaultConfig().sides[1].root.children[0].ships[0].fitting);
  });

  it('rejects invalid imports, developer hulls, wrong content identity and invalid research', () => {
    const c = defaultConfig(); c.content.fingerprint = 'incorrect';
    expect(configProblems(c).join(' ')).toContain('콘텐츠 식별자');
    c.content = defaultConfig().content; c.sides[0].root.children[0].ships[0].variant = c.sides[1].root.children[0].ships[0].variant;
    expect(configProblems(c).join(' ')).toContain('선체');
    c.sides[0].research = ['not-a-tech']; expect(configProblems(c).join(' ')).toContain('연구');
    expect(configProblems({ schema: 'invalid' }).length).toBeGreaterThan(0);
  });

  it('is deterministic per seed, supports swapped placement and aggregates the real outcomes', () => {
    const c = defaultConfig(); c.timeLimit = 30;
    const a = runBattle(c, 31, false), again = runBattle(c, 31, false), swapped = runBattle(c, 31, true);
    expect(a).toEqual(again); expect(swapped.seed).toBe(31); expect(swapped.swapped).toBe(true);
    const stats = summarize([a, swapped]);
    expect(stats.total).toBe(2); expect(stats.wins[0] + stats.wins[1] + stats.draws).toBe(2);
    expect(stats.meanTime).toBe((a.time + swapped.time) / 2);
    expect(stats.meanSides[0].taken).toBe((a.sides[0].taken + swapped.sides[0].taken) / 2);
  });

  it('aggregates 1,000 real engine runs without a fleet budget', () => {
    const c = defaultConfig(); c.timeLimit = 10;
    const results = Array.from({ length: 1000 }, (_, i) => runBattle(c, i, false));
    const summary = summarize(results);
    expect(summary.total).toBe(1000);
    expect(summary.wins[0] + summary.wins[1] + summary.draws).toBe(1000);
    expect(results.map(r => r.seed)).toEqual(Array.from({ length: 1000 }, (_, i) => i));
  }, 30000);

  it('enforces a custom engine time limit and preserves the separate PMC world', () => {
    const persistent = WorldSim.create(1), player = persistent.addPlayer('실험 분리 검증'), before = persistent.serialize();
    const c = defaultConfig(); c.timeLimit = 10;
    const w = new World(battleSetup(c)); while (!w.outcome) w.step();
    const result = resultOf(w, c.seed, false);
    expect(result.time).toBeGreaterThanOrEqual(10); expect(result.time).toBeLessThanOrEqual(10.5);
    expect(persistent.serialize()).toBe(before); expect(persistent.st.companies[player]).toBeTruthy();
  });
});

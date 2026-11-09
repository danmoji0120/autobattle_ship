import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ACTING_CAPTAIN, COMMANDERS } from '../src/sim/data/commanders';
import { World } from '../src/sim/world';
import { battleSetup, configProblems, defaultConfig, defaultShip, labShipCount, migrateConfig, runBattle, type LabGroup } from '../src/devlab/labModel';

const group = (name: string, order: LabGroup['order'] = 'auto'): LabGroup => ({ name, commander: null, order, retreatAt: 0, ships: [], children: [] });

describe('DEV-1.1 hierarchical local experiment', () => {
  it('migrates a DEV-1 setting without losing its rows, fitting, quantities, commander or deterministic result', () => {
    const baseline = JSON.parse(readFileSync('artifacts/dev1/default-experiment.json', 'utf8'));
    const imported = migrateConfig(baseline.config), original = baseline.config;
    expect(imported.schema).toBe('siderarium-combat-lab-2');
    for (const team of [0, 1]) {
      const side = imported.sides[team], old = original.sides[team];
      expect(side.root.commander).toMatchObject(old.commander);
      expect(side.root.children).toHaveLength(old.ships.length);
      old.ships.forEach((row: any, i: number) => {
        const child = side.root.children[i];
        expect(child).toMatchObject({ name: row.group, order: row.order, retreatAt: 0, commander: old.commander });
        expect(child.ships[0]).toMatchObject({ id: row.id, hull: row.hull, variant: row.variant, fitting: row.fitting, count: row.count });
      });
    }
    expect(runBattle(imported, 1, false)).toEqual(baseline.battles[0]);
    expect(runBattle(imported, 1, true)).toEqual(baseline.battles[1]);
    expect(() => migrateConfig({ schema: 'siderarium-combat-results-1', config: baseline.config })).toThrow();
    expect(migrateConfig(JSON.parse(JSON.stringify(imported)))).toEqual(imported);
  });

  it('migrates several legacy rows and preserves quantities, fitted modules, research and custom commander stats', () => {
    const legacy = JSON.parse(readFileSync('artifacts/dev1/default-experiment.json', 'utf8')).config;
    legacy.sides[0].commander = { skill: .67, aggression: .31, discipline: .86, specialty: 'maneuver' };
    legacy.sides[0].research = ['combined_arms'];
    legacy.sides[0].ships[0].count = 3;
    legacy.sides[0].ships.push({ ...structuredClone(legacy.sides[0].ships[0]), id: 'second-row', group: '측면 편대', order: 'flank_left', count: 2, fitting: { ...legacy.sides[0].ships[0].fitting, bay: { bay1: 'mod_engine' } } });
    const c = migrateConfig(legacy), setup = battleSetup(c), side = c.sides[0];
    expect(side.research).toEqual(['combined_arms']);
    expect(side.root.children.map(g => g.name)).toEqual([legacy.sides[0].ships[0].group, '측면 편대']);
    expect(side.root.commander).toMatchObject(legacy.sides[0].commander);
    expect(side.root.children[1].commander).toMatchObject(legacy.sides[0].commander);
    expect(side.root.children[1].ships[0].fitting.bay).toEqual({ bay1: 'mod_engine' });
    expect(setup.fleets[0].root.children.map(g => g.ships.length)).toEqual([3, 2]);
    expect(setup.fleets[0].root.children[1]).toMatchObject({ order: 'flank_left', ships: [{ ref: 'second-row:0' }, { ref: 'second-row:1' }] });
  });

  it('passes independent commanders, commands and retreat thresholds through every actual engine group', () => {
    const c = defaultConfig(), root = c.sides[0].root;
    root.commander = { ...COMMANDERS[0] };
    const wing = group('제1전단', 'hold'); wing.commander = { ...COMMANDERS[1], skill: .23, aggression: .91 }; wing.retreatAt = .5;
    const squad = group('제1전대'); squad.commander = { ...ACTING_CAPTAIN, id: 'custom-1', name: '실험 전대장', skill: .82, specialty: 'gunnery' };
    squad.ships.push({ ...defaultShip('patrol_pathfinder', 'squad-ship'), count: 5 });
    const uncommanded = group('제2전대', 'flank_left'); uncommanded.ships.push(defaultShip('corvette_mk1', 'second-ship'));
    wing.children.push(squad, uncommanded); root.children = [wing];
    expect(configProblems(c)).toEqual([]); expect(labShipCount(c.sides[0])).toBe(6);
    const setup = battleSetup(c), w = new World(setup), actualWing = w.groups.find(g => g.name === wing.name)!, actualSquad = w.groups.find(g => g.name === squad.name)!, actualUncommanded = w.groups.find(g => g.name === uncommanded.name)!;
    expect(setup.fleets[0].root.children[0]).toMatchObject({ name: wing.name, commander: { skill: .23, aggression: .91 }, order: 'hold', retreatAt: .5 });
    expect(actualWing.commander.skill).toBe(.23); expect(actualWing.retreatAt).toBe(.5);
    expect(actualSquad.parentId).toBe(actualWing.id); expect(actualSquad.commander.skill).toBe(.82); expect(actualSquad.commander.specialty).toBe('gunnery');
    expect(actualSquad.shipIds).toHaveLength(5); expect(actualUncommanded.hasCommander).toBe(false);
    expect(actualUncommanded.order.type).toBe('flank');
    expect(runBattle({ ...c, timeLimit: 10 }, 19, false)).toEqual(runBattle({ ...c, timeLimit: 10 }, 19, false));
  });

  it('isolates copied sides and rejects excessive fleets, cycles, and malformed imports', () => {
    const c = defaultConfig(); c.sides[1] = structuredClone(c.sides[0]); c.sides[1].name = 'RED';
    c.sides[0].root.children[0].ships[0].count = 99;
    expect(c.sides[1].root.children[0].ships[0].count).toBe(1);
    c.sides[1].root.children[0].ships[0].count = 102;
    expect(configProblems(c).join(' ')).toContain('200척');
    c.sides[1].root.children[0].ships[0].count = 1;
    c.sides[0].root.children.push(c.sides[0].root);
    expect(configProblems(c).join(' ')).toContain('부대 정보');
    expect(() => migrateConfig({ schema: 'siderarium-combat-lab-1' })).toThrow();
  });
});

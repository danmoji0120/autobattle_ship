// P16.4: regression guards for the skirmish rules gate and GPU-instancing state (no WebGL required).
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { World, BATTLE_RULES } from '../src/sim/world';
import type { FleetSpec, GroupSpec } from '../src/sim/fleet';
import { CARRIER_CLASS } from '../src/sim/data/ships';
import { skirmishRules } from '../src/ui/setup';
import { CraftMeshes } from '../src/render/craftMeshes';

const g = (ships: GroupSpec['ships']): GroupSpec => ({ name: 'test', commanderId: null, order: 'engage', retreatAt: 0, ships, children: [] });
const f = (ships: GroupSpec['ships']): FleetSpec => ({ name: 'test', root: g(ships) });

describe('P16.4 preview skirmish gate', () => {
  it('keeps ordinary skirmishes on BATTLE_RULES=2, but selects 3 when carrier craft are present', () => {
    expect(BATTLE_RULES).toBe(2);
    expect(skirmishRules(f([{ classId: 'cruiser', loadoutId: 'multi' }]))).toBe(2);
    expect(CARRIER_CLASS.loadouts[0].mounts.some(m => m.weapon === 'wing_fighter')).toBe(true);
    expect(skirmishRules(f([{ classId: 'carrier', loadoutId: 'air_group' }]))).toBe(3);
  });
});

describe('P16.4 instanced light craft', () => {
  it('does not allocate any mesh for a craft-free battle', () => {
    const scene = new THREE.Scene(), visual = new CraftMeshes(scene);
    visual.sync(null, () => true);
    expect(visual.drawn).toBe(0);
    expect(scene.children.length).toBe(0);
    visual.dispose();
  });

  it('uses three instanced mesh batches and never mutates the simulation', () => {
    const scene = new THREE.Scene(), visual = new CraftMeshes(scene);
    const setup = { seed: 7, scenarioId: 'kestrel', rules: 3,
      fleets: [f([{ classId: 'carrier', loadoutId: 'air_group' }]), f([{ classId: 'cruiser', loadoutId: 'multi' }])] };
    const world = new World(setup);
    for (let i = 0; i < 90 && !world.outcome; i++) world.step();
    const digest = world.digest();
    visual.sync(world.craft, team => team === 0);
    expect(visual.drawn).toBe(world.craft!.flying());
    expect(scene.children.length).toBe(3);
    expect(scene.children.every(x => x instanceof THREE.InstancedMesh)).toBe(true);
    expect(world.digest()).toBe(digest);
    visual.dispose();
    expect(scene.children.length).toBe(0);
  });
});

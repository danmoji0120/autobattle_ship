// P16.4 client regression guards (no WebGL needed). Restores the intent of the parallel P16.4 work's
// tests/p16-client.test.ts (kept on backup/p164-parallel-2ff8916) against the current implementation:
// the skirmish rules gate (setup.ts skirmishGate) and the instanced craft renderer (render/craftView.ts).
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { World, BATTLE_RULES } from '../src/sim/world';
import type { FleetSpec, GroupSpec } from '../src/sim/fleet';
import { CARRIER_CLASS } from '../src/sim/data/ships';
import { skirmishGate } from '../src/ui/setup';
import { CraftView, type CraftFxHost } from '../src/render/craftView';
import { CRAFT_ST } from '../src/sim/craft';

const g = (ships: GroupSpec['ships']): GroupSpec => ({ name: 'test', commanderId: null, order: 'engage', retreatAt: 0, ships, children: [] });
const f = (ships: GroupSpec['ships']): FleetSpec => ({ name: 'test', root: g(ships) });
const host = (): CraftFxHost & { glows: number } => {
  const h = { glows: 0, glow: { emit: () => { h.glows++; } }, friendly: (team: number) => team === 0 };
  return h;
};
const cam = () => { const c = new THREE.PerspectiveCamera(50, 1.6, 1, 1e5); c.position.set(0, 900, 1400); c.lookAt(0, 0, 0); c.updateMatrixWorld(); return c; };
const flying = (w: World) => { const c = w.craft!; let n = 0; for (let i = 0; i < c.st.length; i++) if (c.st[i] === CRAFT_ST.OUT) n++; return n; };
// the enemy has a carrier too, so the fighters fight craft (P16.5 fighters keep out of ship point defence)
const carrierBattle = (seed = 7) => new World({ seed, scenarioId: 'kestrel', rules: 3, spawnZ: 900,
  fleets: [f([{ classId: 'carrier', loadoutId: 'air_group' }]), f([{ classId: 'carrier', loadoutId: 'air_group' }, { classId: 'cruiser', loadoutId: 'multi' }, { classId: 'destroyer', loadoutId: 'std' }])] });

describe('P16.4 skirmish rules gate', () => {
  it('BATTLE_RULES stays 2; carriers fly only in the rules-3 trial', () => {
    expect(BATTLE_RULES).toBe(2);
    expect(CARRIER_CLASS.loadouts[0].mounts.some(m => m.weapon === 'wing_fighter')).toBe(true);
    const plain = f([{ classId: 'cruiser', loadoutId: 'multi' }]), cv = f([{ classId: 'carrier', loadoutId: 'air_group' }]);
    expect(skirmishGate(plain, false)).toEqual({ rules: 2, carriers: 0, blocked: false });
    expect(skirmishGate(cv, false)).toEqual({ rules: 2, carriers: 1, blocked: true });
    expect(skirmishGate(cv, true)).toEqual({ rules: 3, carriers: 1, blocked: false });
    expect(skirmishGate(plain, true).rules).toBe(3);
  });
});

describe('P16.4 instanced craft renderer', () => {
  it('draws nothing for a craft-free battle', () => {
    const w = new World({ seed: 3, scenarioId: 'kestrel', rules: 3, fleets: [f([{ classId: 'cruiser', loadoutId: 'multi' }]), f([{ classId: 'destroyer', loadoutId: 'std' }])] });
    const v = new CraftView(host());
    for (let i = 0; i < 30; i++) { w.step(); v.frame(w, 1, w.dt, cam(), true); }
    expect(w.craft).toBeFalsy();
    expect(v.drawn).toBe(0);
    v.dispose();
  });

  it('role batches are InstancedMeshes, draw exactly the airborne craft, and never change the battle', () => {
    const a = carrierBattle(), b = carrierBattle();
    const v = new CraftView(host()), c = cam();
    let peak = 0;
    for (let i = 0; i < 900 && !a.outcome; i++) {
      a.step(); b.step();
      v.frame(a, 0.5, a.dt, c, true);
      expect(v.drawn).toBe(flying(a));
      peak = Math.max(peak, v.drawn);
      if (i % 150 === 0) expect(a.digest()).toBe(b.digest());   // b is never rendered
    }
    expect(peak).toBeGreaterThan(0);
    expect(a.digest()).toBe(b.digest());
    const inst = v.group.children.filter(x => x instanceof THREE.InstancedMesh);
    expect(inst.length).toBe(4);                                   // fighter, bomber, interceptor + slung torpedoes
    v.dispose();
  });

  it('tracers come from real shots: every gun cooldown reset while a slot stays airborne (launch resets excluded)', () => {
    const w = carrierBattle(11), h = host(), v = new CraftView(h), c = cam();
    const cool0 = new Float64Array(4096), st0 = new Uint8Array(4096);
    let resets = 0;
    for (let i = 0; i < 1200 && !w.outcome; i++) {
      w.step();
      const p = w.craft;
      if (p) for (let k = 0; k < p.st.length; k++) { if (st0[k] === CRAFT_ST.OUT && p.st[k] === CRAFT_ST.OUT && p.cool[k] > cool0[k] + 1e-9) resets++; cool0[k] = p.cool[k]; st0[k] = p.st[k]; }
      v.frame(w, 1, w.dt, c, true);
    }
    expect(resets).toBeGreaterThan(0);
    expect(v.shots).toBe(resets);                                  // sampled every tick: no shot missed, none invented
    v.dispose();
  });
});

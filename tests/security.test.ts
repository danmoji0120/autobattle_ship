import { describe, it, expect } from 'vitest';
import { WorldSim } from '../src/world/sim';
import { secAt, secField, secFieldAt } from '../src/world/security';
import { Rng } from '../src/sim/rng';

// The security-map shader evaluates secField per pixel; it must equal what the server AI uses.
describe('security map field', () => {
  it('matches secAt everywhere in every system (heat, dead lair, player defences)', () => {
    const sim = WorldSim.create(3);
    const w = sim.st;
    w.systems.ember.heat = 55; w.systems.astra.heat = 20;
    w.lairs.hollow.alive = false;
    // a player station with a built defence battery in Drake
    const pub = w.stations.drakeout;
    w.stations.mine = { ...JSON.parse(JSON.stringify(pub)), id: 'mine', public: false, garrison: 0, pos: { x: pub.pos.x + 6000, y: 0, z: pub.pos.z - 3000 }, modules: [{ kind: 'defense', built: true }] } as any;
    const rng = new Rng(9);
    let worst = 0;
    for (const sys of Object.values(w.systems)) {
      const f = secField(w, sys);
      for (let i = 0; i < 3000; i++) {
        const a = rng.range(0, Math.PI * 2), r = Math.sqrt(rng.range(0, 1)) * sys.radius * 1.02;
        const p = { x: sys.origin.x + Math.cos(a) * r, y: 0, z: sys.origin.z + Math.sin(a) * r };
        worst = Math.max(worst, Math.abs(secAt(w, p, sys) - secFieldAt(f, p.x - sys.origin.x, p.z - sys.origin.z)));
      }
    }
    expect(worst).toBeLessThan(1e-6);
  });
});

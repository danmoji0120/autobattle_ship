// P17.3f combat computers: the new archetypes (missile control, flank) and product tuning (range, volley,
// guide, cover, energy) each change how a ship actually fights, measured in real battles (rules 2).
import { describe, expect, it } from 'vitest';
import { World, type BattleSetup } from '../src/sim/world';
import { WEAPONS } from '../src/sim/data/weapons';
import { getLoadout, type MountDef } from '../src/sim/data/ships';
import { CONTENT } from '../src/content/registry';
import { EQUIPMENT } from '../src/world/industry';
import { cpuOfFitting } from '../src/world/fitting';
import { cpuPdCover, type CpuSpec } from '../src/sim/ai/computer';
import type { FleetSpec, GroupSpec, ShipSpec } from '../src/sim/fleet';
import type { Ship, SimEvent } from '../src/sim/types';

void CONTENT;
/** a ship whose gun mounts carry `weapon` (point defence kept) and that runs the computer product `cpu` */
function ship(classId: string, loadoutId: string, weapon: string | null, cpu?: string): ShipSpec {
  const lo = getLoadout(classId, loadoutId);
  const mounts: MountDef[] = lo.mounts.map(m => ({ ...m, weapon: WEAPONS[m.weapon].kind === 'pd' ? m.weapon : (weapon ?? m.weapon) }));
  const c = cpu ? EQUIPMENT[cpu]!.cpu! : undefined;
  const spec: CpuSpec | undefined = c ? { id: cpu!, arch: c.arch, ...(c.react ? { react: c.react } : {}), ...(c.tune ? { tune: c.tune } : {}) } : undefined;
  return { classId, loadoutId, fit: { name: 'test', mounts }, ...(spec ? { cpu: spec } : {}) };
}
const G = (ships: ShipSpec[], order: GroupSpec['order'] = 'engage'): GroupSpec => ({ name: 'g', commanderId: 'wolf', order, retreatAt: 0, ships, children: [] });
const F = (g: GroupSpec, name: string): FleetSpec => ({ name, root: g });
const setup = (a: GroupSpec, b: GroupSpec, seed = 5): BattleSetup => ({ seed, scenarioId: 'p173f', fleets: [F(a, 'A'), F(b, 'B')], rules: 2 });
function run(w: World, T: number, each?: (e: SimEvent[]) => void) {
  while (!w.outcome && w.time < T) { w.step(); each?.(w.events); }
  return w;
}
const mine = (w: World) => w.ships.find(s => s.team === 0)!;

describe('P17.3f computer products', () => {
  it('a fitted computer carries its product tuning into the battle (fitting → ShipSpec.cpu)', () => {
    const c = cpuOfFitting({ hp: {}, bay: { cpu1: 'cpu_missile' } } as never)!;
    expect(c).toMatchObject({ id: 'cpu_missile', arch: 'missile', tune: { volley: 2.5, guide: 1.15 } });
  });

  it('missile control: launchers fire together (volley) and the missiles turn harder (guide)', () => {
    // same ship, same seed: the missile archetype with and without the volley / guide tuning
    const wave = (cpu: string) => {
      const w = new World(setup(G([ship('cruiser', 'aa', 'missile_rack', cpu)]), G([ship('cruiser', 'aa', null)], 'hold')));
      const t: number[] = [];
      let gm = 0;
      run(w, 60, ev => {
        for (const e of ev) if (e.t === 'fire' && e.weapon === 'missile_rack') t.push(w.time);
        for (const m of w.munitions) if (m.ownerId === mine(w).id && m.kind === 'missile') gm = Math.max(gm, m.gm ?? 1);
      });
      // share of launches with another launcher firing within 0.15 s
      const together = t.filter((x, i) => t.some((y, j) => j !== i && Math.abs(x - y) < 0.15)).length / Math.max(1, t.length);
      return { together, gm, n: t.length, acting: mine(w).cpu!.acting };
    };
    const tuned = wave('cpu_missile'), lite = wave('cpu_missile_lite');
    expect(tuned.n).toBeGreaterThan(4);
    expect(tuned.together).toBeGreaterThan(0.8);
    expect(tuned.gm).toBeCloseTo(1.15, 5);
    expect(lite.gm).toBe(1);
    expect(tuned.together).toBeGreaterThanOrEqual(lite.together);
  });

  it('missile control holds at missile range; close assault fights much nearer than the plain swarm computer', () => {
    const dist = (cpu: string, weapon: string) => {
      const w = new World(setup(G([ship('destroyer', 'strike', weapon, cpu)]), G([ship('cruiser', 'aa', null)], 'hold'), 9));
      let sum = 0, k = 0;
      run(w, 90, () => {
        const s = mine(w), t = w.ships.find(x => x.team === 1 && x.state === 'alive');
        if (t && w.time > 30 && s.state === 'alive') { sum += s.pos.distTo(t.pos); k++; }
      });
      return sum / Math.max(1, k);
    };
    const swarm = dist('cpu_swarm', 'medium_gun'), assault = dist('cpu_assault', 'medium_gun');
    expect(assault).toBeLessThan(swarm * 0.9);
    const msl = dist('cpu_missile', 'missile_rack');
    expect(msl).toBeGreaterThan(WEAPONS.missile_rack.range * 0.6);
  });

  it('flank: the ship swings round to the target\'s beam / stern quarter (a target that cannot turn to follow it)', () => {
    // the target's heading is pinned: this isolates the manoeuvre. A target free to turn keeps its bow on a lone
    // flanker (it is usually its nearest threat) — see docs/P17_3_ARSENAL.md limits.
    const rear = (cpu: string) => {
      // the target only carries point defence, so the run is about the manoeuvre and not who dies first
      const w = new World(setup(G([ship('destroyer', 'strike', null, cpu)]), G([ship('cruiser', 'aa', 'pd_gun')], 'hold'), 3));
      run(w, 0.1);
      const t = w.ships.find(x => x.team === 1)!; t.turnRate = 0;
      let q = 0, k = 0;
      run(w, 110, () => {
        const s = mine(w);
        if (t.state !== 'alive' || s.state !== 'alive' || w.time < 40) return;
        const rx = s.pos.x - t.pos.x, rz = s.pos.z - t.pos.z, d = Math.hypot(rx, rz);
        if ((rx * t.fwd.x + rz * t.fwd.z) / Math.max(1, d) < -0.2) q++;
        k++;
      });
      return q / Math.max(1, k);
    };
    const f = rear('cpu_flanker'), l = rear('cpu_line');
    expect(f).toBeGreaterThan(0.5);
    expect(f).toBeGreaterThan(l + 0.3);
  });

  it('air defence: the aegis product guards friends over its cover radius whatever behaviour it is acting', () => {
    const w = new World(setup(G([ship('destroyer', 'aa', null, 'cpu_aegis'), ship('destroyer', 'aa', null, 'cpu_line')]), G([ship('cruiser', 'aa', null)], 'hold')));
    run(w, 1);
    const [a, b] = w.ships.filter(s => s.team === 0) as Ship[];
    a.cpu!.acting = 'basic';
    expect(cpuPdCover(a)).toMatchObject({ radius: 1700 });
    b.cpu!.acting = 'line';
    expect(cpuPdCover(b)).toBeNull();
  });

  it('energy management: a shielded ship whose shield fails backs out of the enemy reach until it recharges', () => {
    const trial = (cpu: string) => {
      const w = new World(setup(G([ship('cruiser', 'aa', 'medium_gun', cpu)]), G([ship('cruiser', 'aa', null)], 'hold'), 13));
      const s = mine(w);
      s.maxShield = s.hp * 0.2; s.shield = s.maxShield; s.shieldRegen = 0.02; s.shieldHitAt = -99;
      run(w, 40);
      const t = w.ships.find(x => x.team === 1)!;
      const d0 = s.pos.distTo(t.pos);
      s.shield = s.maxShield! * 0.1;       // the shield collapses
      let dMax = d0;
      run(w, 60, () => { if (s.state === 'alive') dMax = Math.max(dMax, s.pos.distTo(t.pos)); });
      return { d0, dMax, gain: dMax - d0 };
    };
    const e = trial('cpu_energy'), l = trial('cpu_line');
    expect(e.gain).toBeGreaterThan(150);
    expect(e.gain).toBeGreaterThan(l.gain + 100);
  });

  it('same seed, same tuned computers: an identical battle', () => {
    const one = () => {
      const w = new World(setup(G([ship('cruiser', 'aa', 'missile_rack', 'cpu_missile'), ship('destroyer', 'aa', 'medium_gun', 'cpu_flanker')]), G([ship('cruiser', 'aa', null, 'cpu_energy'), ship('destroyer', 'aa', null, 'cpu_aegis')]), 21));
      run(w, 80);
      return w.ships.map(s => `${s.id}:${s.hp.toFixed(3)}:${s.pos.x.toFixed(2)}:${s.pos.z.toFixed(2)}`).join('|');
    };
    expect(one()).toBe(one());
  });
});

// P17.3g economy hook-up: who can get the new content and how (ownership ≠ blueprint ≠ research ≠
// production ≠ supplier), market rows of new worlds only, and NPC pirate bands that field P17 hulls with
// their makers' computers (opt-in world option npc17). docs/P17_3_ARSENAL.md
import { describe, expect, it } from 'vitest';
import { WorldSim } from '../src/world/sim';
import { STANDARD_WORLD } from '../src/world/worldPreset';
import { CONTENT } from '../src/content/registry';
import { EQUIPMENT } from '../src/world/industry';
import { P17_ARMS, P17_ARM_MARKETS } from '../src/content/packs/growth/arsenal17';
import { P17_CPUS, P17_PARTS, P17_PART_MARKETS } from '../src/content/packs/growth/parts17';
import { P17_HULLS } from '../src/content/packs/growth/fleet17';
import { cpuOfFitting } from '../src/world/fitting';

const sold = (sim: WorldSim) => new Set(Object.values(sim.st.stations).flatMap(s => s.public && s.market ? Object.keys(s.market) : []));

describe('P17.3g acquisition', () => {
  it('new worlds stock some of the new weapons / computers / parts; elite mechanisms stay research + production only', () => {
    const sim = WorldSim.create(3, STANDARD_WORLD);
    const m = sold(sim);
    const listed = [...Object.values(P17_ARM_MARKETS).flat(), ...Object.values(P17_PART_MARKETS).flat()];
    for (const id of listed) expect(m.has(id), id).toBe(true);
    for (const id of ['eq_swarm_box', 'eq_swarm_heavy', 'eq_charge_lance', 'eq_beam_l', 'eq_mine_heavy', 'eq_missile_ghost', 'cpu_missile', 'cpu_energy'])
      expect(m.has(id), id).toBe(false);
    // nothing is unobtainable: every new weapon / computer / part has a research unlock and a recipe
    for (const a of [...P17_ARMS, ...P17_CPUS, ...P17_PARTS]) {
      expect(a.recipe?.fac, a.id).toBeTruthy();
      expect(EQUIPMENT[a.id], a.id).toBeTruthy();
    }
    expect([...P17_ARMS, ...P17_CPUS, ...P17_PARTS].filter(a => !a.tech).map(a => a.id)).toEqual([]);
  });

  it('a hull is owned, licensed, researched, built and sold through separate channels — some are never sold built', () => {
    const live = P17_HULLS.filter(h => !h.preview);
    const sale = live.filter(h => h.sale), noSale = live.filter(h => !h.sale);
    expect(sale.length).toBeGreaterThan(5);
    expect(noSale.length).toBeGreaterThan(3);
    for (const h of P17_HULLS) {
      expect(h.build?.parts, h.id).toBeTruthy();
      expect(CONTENT.blueprints[`bp_${h.id}`] ?? Object.values(CONTENT.blueprints).find(b => b.target.kind === 'hull' && b.target.id === h.id), h.id).toBeTruthy();
    }
    // carriers keep their existing preview (release) flag
    expect(P17_HULLS.filter(h => h.classId === 'carrier').every(h => h.preview)).toBe(true);
  });
});

describe('P17.3g NPC use (npc17 world option)', () => {
  const band = (sim: WorldSim) => {
    const s = sim as any;
    const comp: [string, string][] = s.bandComp(5);
    const g = s.spawnBand('시험 무리', comp, { x: 0, y: 0, z: 0 }, { role: 'rogue', sys: Object.keys(sim.st.systems)[0], home: '', homePos: { x: 0, y: 0, z: 0 } }, { k: 'idle' }, 5);
    return g.shipIds.map((id: string) => sim.st.ships[id]);
  };

  it('with the option, pirate bands field P17 pirate-line hulls flying their makers\' computers', () => {
    const sim = WorldSim.create(4, { ...STANDARD_WORLD, npc17: 'p173' });
    expect(sim.st.npc17V).toBe(1);
    const ships = band(sim);
    const p17 = ships.filter((s: any) => s.hull?.startsWith('p17_'));
    expect(p17.length).toBeGreaterThan(1);
    for (const s of p17) {
      const cpu = cpuOfFitting(s.fitting);
      expect(cpu?.id, s.hull).toBe(CONTENT.hulls[s.hull].cpu);
      expect(Object.keys(s.fitting.hp).length).toBeGreaterThan(0);
    }
  });

  it('without it (standard worlds, existing saves) bands are exactly the legacy ships', () => {
    const sim = WorldSim.create(4, STANDARD_WORLD);
    expect(sim.st.npc17V).toBeUndefined();
    expect(band(sim).some((s: any) => s.hull?.startsWith('p17_'))).toBe(false);
  });

  it('player-bought P17 hulls do not come with a free computer', () => {
    const sim = WorldSim.create(4, { ...STANDARD_WORLD, npc17: 'p173' });
    const pl = { id: sim.addPlayer('시험') };
    const g = sim.newGroup(pl.id, 'test');
    const s = sim.spawnHull(pl.id, 'p17_ca_swarm', 'p17_ca_swarm_std', 'p17_ca_swarm_p', g.id, { x: 0, y: 0, z: 0 });
    expect(cpuOfFitting(s.fitting)).toBeUndefined();
  });
});

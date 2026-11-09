import { describe, expect, it } from 'vitest';
import { WorldSim } from '../src/world/sim';
import { grantBlueprint, hullBlueprint, variantBlueprint } from '../src/world/blueprints';
import { TECHS } from '../src/world/industry';

describe('sensor and communications facility', () => {
  it.each([
    { hull: 'destroyer_picket', variant: 'destroyer_picket_cmd', preset: 'dd_picket_cmd', classId: 'destroyer' },
    { hull: 'cruiser_vigil', variant: 'cruiser_vigil_command', preset: 'vigil_command', classId: 'light_cruiser' },
  ])('remains a completed-facility requirement for $variant', ({ hull, variant, preset, classId }) => {
    const sim = WorldSim.create(961), p = sim.addPlayer('통신시설 검증'), co = sim.st.companies[p];
    co.credits = 1_000_000; co.tech = Object.keys(TECHS);
    const base = sim.st.stations.astra;
    const station = { ...structuredClone(base), id: 'p961_yard', name: '시험 조선소', owner: p, public: false, size: 'M' as const, market: null,
      storage: { [p]: {} }, modules: ['core', 'power', 'yard_s', 'yard_m', 'hull_works', 'machine_shop', 'electronics_fab'].map((kind, slot) => ({ kind, slot, progress: 1, built: true })) };
    sim.st.stations[station.id] = station;
    expect(grantBlueprint(sim.st, co, hullBlueprint(hull)!, 'test', sim.time)).toBe(true);
    expect(grantBlueprint(sim.st, co, variantBlueprint(variant)!, 'test', sim.time)).toBe(true);
    const command = { c: 'buildShip', station: station.id, classId, loadoutId: '', hull, variant, preset } as const;
    const credits = co.credits;
    expect(sim.command(p, command)).toMatch(/필요 시설:.*센서·통신시설/);
    station.modules.push({ kind: 'comms', slot: station.modules.length, progress: 0, built: false });
    expect(sim.command(p, command)).toMatch(/필요 시설:.*센서·통신시설/);
    expect(co.credits).toBe(credits); expect(station.builds ?? []).toHaveLength(0);
    const comms = station.modules.at(-1)!; comms.built = true; comms.progress = 1;
    expect(sim.command(p, command)).toBeNull();
    expect(station.builds).toHaveLength(1);
    expect(station.builds![0].variant).toBe(variant);
  });
});

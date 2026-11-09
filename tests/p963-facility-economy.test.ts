import { describe, expect, it } from 'vitest';
import { WorldSim } from '../src/world/sim';
import { newWorld } from '../src/world/worldgen';
import { FACILITIES, TECHS } from '../src/world/industry';
import { facilityProblem, moduleMaterials } from '../src/world/stations';
import { queueShortfall } from '../src/world/construction';
import { qty } from '../src/world/types';
import type { Size } from '../src/content/schema';
import type { Station } from '../src/world/types';
import targets from './fixtures/p963-facility-targets.json';

const rank: Record<Size, number> = { S: 1, M: 2, L: 3, XL: 4 };
function fixture(size: Size | undefined = 'M') {
  const sim = WorldSim.create(963); (sim as any).npcSlow = () => {};
  for (const l of Object.values(sim.st.lairs)) { l.alive = false; l.respawnAt = 1e10; }
  const p = sim.addPlayer('시설 경제 검증'), co = sim.st.companies[p]; co.credits = 100_000_000; co.tech = Object.keys(TECHS);
  const base = sim.st.stations.astra;
  const st: Station = { ...structuredClone(base), id: 'facility_economy', name: '경제 시험 기지', owner: p, public: false, size, market: null,
    storage: { [p]: {} as Record<string, number> }, modules: [{ kind: 'core', slot: 0, built: true, progress: 1 }] };
  sim.st.stations[st.id] = st;
  return { sim, p, co, st };
}
const built = (kind: string, slot = 1) => ({ kind, slot, built: true, progress: 1 });
const until = (sim: WorldSim, condition: () => boolean, seconds = 1000) => {
  for (let t = 0; t < seconds && !condition(); t += .25) sim.update(.25);
  expect(condition()).toBe(true);
};

describe('P9.6.3 facility costs and installation rules', () => {
  it('matches the complete facility price, material and minimum-size table', () => {
    const entries = Object.entries(FACILITIES).filter(([kind]) => kind !== 'core');
    expect(entries.map(([kind]) => kind).sort()).toEqual(Object.keys(targets).sort());
    for (const [kind, expected] of Object.entries(targets)) {
      const f = FACILITIES[kind];
      expect({ credits: f.credits, minStation: f.minStation, mats: f.mats }, kind).toEqual(expected);
      expect(f.legacyBuild, `${kind}: historical terms`).toBeDefined();
    }
  });

  it.each(['S', 'M', 'L', 'XL'] as Size[])('enforces every facility minimum at %s without charging rejected commands', size => {
    const { sim, p, co, st } = fixture(size);
    for (const [kind, expected] of Object.entries(targets)) {
      const f = FACILITIES[kind];
      st.modules = [built('core', 0), ...(f.requires && f.requires !== 'core' ? [built(f.requires)] : [])];
      st.storage[p] = { alloy: 17, machinery: 4 }; co.credits = 100_000_000;
      const before = structuredClone(st.storage[p]), credits = co.credits, n = st.modules.length;
      const error = sim.command(p, { c: 'queueModule', station: st.id, kind });
      if (rank[size] < rank[expected.minStation as Size]) {
        expect(error, `${size}/${kind}`).toMatch(/정거장 규모 부족/);
        expect(co.credits, kind).toBe(credits); expect(st.storage[p], kind).toEqual(before); expect(st.modules).toHaveLength(n);
      } else {
        expect(error, `${size}/${kind}`).toBeNull();
        const plan = st.modules.at(-1)!;
        expect(co.credits, kind).toBe(credits - expected.credits);
        expect(plan.paid, kind).toBe(expected.credits); expect(plan.materials, kind).toEqual(expected.mats);
        expect(plan.economy, kind).toBe('p963');
      }
    }
  });

  it('keeps yard class separate from minimum size and retains research and prerequisites', () => {
    const { sim, p, co, st } = fixture('M');
    expect(FACILITIES.yard_m.yard).toBe(2); expect(FACILITIES.yard_m.minStation).toBe('M');
    expect(FACILITIES.design_bureau.yard).toBeUndefined(); expect(FACILITIES.design_bureau.minStation).toBe('L');
    co.tech = [];
    const before = co.credits;
    expect(sim.command(p, { c: 'queueModule', station: st.id, kind: 'yard_m' })).toMatch(/소형 조선소/);
    st.modules.push(built('yard_s'));
    expect(sim.command(p, { c: 'queueModule', station: st.id, kind: 'yard_m' })).toMatch(/연구 필요/);
    expect(co.credits).toBe(before); co.tech.push('medium_hulls');
    expect(sim.command(p, { c: 'queueModule', station: st.id, kind: 'yard_m' })).toBeNull();
    expect(co.credits).toBe(before - 250_000);
  });

  it('preserves old unsnapshotted plans, their refund and material reservations', () => {
    const { sim, p, co, st } = fixture('S');
    st.modules.push({ kind: 'refinery', slot: 1, built: false, progress: .25, id: 'old-refinery', paid: 7000,
      reserved: { alloy: 165 }, used: { alloy: 55 }, paused: false } as any);
    const restored = new WorldSim(JSON.parse(sim.serialize()), { migrateContent: false });
    const old = restored.st.stations[st.id].modules[1];
    expect(moduleMaterials(old)).toEqual({ alloy: 220 }); expect(old.paid).toBe(7000);
    expect(old.progress).toBe(.25); expect(old.reserved).toEqual({ alloy: 165 }); expect(old.used).toEqual({ alloy: 55 });
    expect(queueShortfall(restored.st.stations[st.id])).toEqual({});
    const before = restored.st.companies[p].credits;
    expect(restored.command(p, { c: 'planOp', station: st.id, plan: 'old-refinery', op: 'cancel' })).toBeNull();
    expect(restored.st.companies[p].credits).toBe(before + 5250);
    expect(qty(restored.st.stations[st.id].storage[p], 'alloy')).toBe(165);
    expect(co.credits).toBe(100_000_000);
  });

  it('allows an existing S communication facility plan to finish but blocks new ones', () => {
    const { sim, p, st } = fixture('S');
    st.modules.push({ kind: 'comms', slot: 1, built: false, progress: 0, id: 'old-comms', paid: 9000,
      materials: { alloy: 200, electronics: 8, sensor: 1 }, reserved: { alloy: 200, electronics: 8, sensor: 1 }, used: {}, paused: false } as any);
    const restored = new WorldSim(JSON.parse(sim.serialize()), { migrateContent: false });
    const plan = restored.st.stations[st.id].modules[1];
    until(restored, () => plan.built, 1000);
    expect(plan.materials).toEqual({ alloy: 200, electronics: 8, sensor: 1 });
    expect(facilityProblem(restored.st.stations[st.id], 'comms')).toMatch(/규모/);
    expect(restored.command(p, { c: 'queueModule', station: st.id, kind: 'comms' })).toMatch(/규모|이미/);
  });

  it('recovers materials from each facility\'s actual cost basis, once, and blocks other companies', () => {
    const { sim, p, st } = fixture('M');
    st.modules.push(built('warehouse'));
    const old = st.modules[1], other = sim.addPlayer('다른 회사');
    expect(sim.command(other, { c: 'removeModule', station: st.id, slot: old.slot })).toMatch(/자사/);
    expect(sim.command(p, { c: 'removeModule', station: st.id, slot: old.slot })).toBeNull();
    expect(qty(st.storage[p], 'alloy')).toBe(60); expect(qty(st.storage[p], 'structure')).toBe(5);
    expect(sim.command(p, { c: 'removeModule', station: st.id, slot: old.slot })).not.toBeNull();
    st.storage[p] = { alloy: 240, structure: 15 };
    expect(sim.command(p, { c: 'queueModule', station: st.id, kind: 'warehouse' })).toBeNull();
    const plan = st.modules.at(-1)!;
    until(sim, () => plan.built);
    expect(plan.materials).toEqual({ alloy: 240, structure: 15 });
    expect(sim.command(p, { c: 'removeModule', station: st.id, slot: plan.slot })).toBeNull();
    expect(qty(st.storage[p], 'alloy')).toBe(120); expect(qty(st.storage[p], 'structure')).toBe(7);
  });

  it('assesses existing and newly built facilities on their own cost basis', () => {
    const { sim, p, st } = fixture('M');
    const initial = sim.netWorth(p);
    st.modules.push(built('warehouse'));
    const historical = sim.netWorth(p);
    expect(historical - initial).toBe(3_000 + 120 * 32 + 10 * 70);
    st.modules.push({ ...built('warehouse', 2), economy: 'p963', paid: 6_000, materials: { alloy: 240, structure: 15 } });
    expect(sim.netWorth(p) - historical).toBe(6_000 + 240 * 32 + 15 * 70);
    const restored = new WorldSim(JSON.parse(sim.serialize()), { migrateContent: false });
    expect(restored.netWorth(p)).toBe(sim.netWorth(p));
  });

  it('keeps c0 pricing and uses the new snapshot for new plans on an unsized growth station', () => {
    const legacy = new WorldSim(newWorld(963), { migrateContent: false }); const p = legacy.addPlayer('c0');
    legacy.st.companies[p].credits = 1_000_000;
    const base = legacy.st.stations.astra;
    const oldStation: Station = { ...structuredClone(base), id: 'c0_old', owner: p, public: false, market: null, storage: { [p]: {} }, modules: [built('core', 0)] };
    legacy.st.stations[oldStation.id] = oldStation;
    expect(legacy.command(p, { c: 'queueModule', station: oldStation.id, kind: 'refinery' })).toBeNull();
    expect(legacy.st.companies[p].credits).toBe(993_000);
    expect(moduleMaterials(oldStation.modules.at(-1)!)).toEqual({ alloy: 220 });
    const f = fixture(); delete f.st.size;
    expect(f.sim.command(f.p, { c: 'queueModule', station: f.st.id, kind: 'refinery' })).toBeNull();
    expect(f.st.modules.at(-1)!.materials).toEqual({ alloy: 500, machinery: 10 });
    expect(f.st.modules.at(-1)!.paid).toBe(20_000);
  });
});

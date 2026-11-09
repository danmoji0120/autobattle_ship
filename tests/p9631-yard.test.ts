import { describe, expect, it } from 'vitest';
import { CONTENT } from '../src/content/registry';
import { WorldSim } from '../src/world/sim';
import { TECHS, FACILITIES, facilityTech, facilityDescription, techUnlocks } from '../src/world/industry';
import { grantBlueprint, hullBlueprint } from '../src/world/blueprints';
import { hullBuild, TIER_BASE } from '../src/world/hullops';
import { buildNeeds, buildSpeed, buildSpec } from '../src/world/production';
import { yardFee } from '../src/world/valuation';
import type { ShipBuild, Station } from '../src/world/types';

const kinds = ['yard_s', 'yard_m', 'yard_l', 'yard_xl'];
const allFacilities = [...new Set([...TIER_BASE[4], 'dock', 'warehouse', 'refinery', 'fitting'])];
const cases = [
  ['corvette_mk1', 1], ['frigate_mk1', 1], ['constructor_s', 1], ['miner_mk1', 1],
  ['destroyer_mk1', 2], ['light_cruiser_mk1', 2], ['miner_m', 2], ['constructor_mk1', 2],
  ['cruiser_mk1', 3], ['battlecruiser_mk1', 3], ['miner_l', 3], ['hauler_l', 3], ['hauler_meridian', 3], ['constructor_l', 3],
  ['battleship_mk1', 4], ['dreadnought_mk1', 4], ['miner_xl', 4], ['hauler_xl', 4], ['constructor_xl', 4],
] as const;
function fixture(yard: number, facilities: string[] = allFacilities) {
  const sim = WorldSim.create(9631); (sim as any).npcSlow = () => {}; (sim as any).npcs = () => {};
  for (const lair of Object.values(sim.st.lairs)) { lair.alive = false; lair.respawnAt = 1e10; }
  const p = sim.addPlayer('조선 등급 검증'), co = sim.st.companies[p]; co.credits = 100_000_000; co.tech = Object.keys(TECHS);
  const base = sim.st.stations.astra;
  const station: Station = { ...structuredClone(base), id: 'p9631_yard', name: '검증용 조선소', owner: p, public: false, size: 'XL', market: null,
    storage: { [p]: {} }, modules: ['core', kinds[yard - 1], 'power', 'power', 'power', ...facilities.filter(k => k !== 'power')].map((kind, slot) => ({ kind, slot, built: true, progress: 1 })) };
  sim.st.stations[station.id] = station;
  for (const [id] of cases) expect(grantBlueprint(sim.st, co, hullBlueprint(id)!, 'test', sim.time), id).toBe(true);
  return { sim, p, co, station };
}
function command(station: Station, hull: string) {
  return { c: 'buildShip', station: station.id, classId: CONTENT.hulls[hull].classId, loadoutId: '', hull, variant: `${hull}_std` } as const;
}

describe('P9.6.3.1 yard tiers and historic build plans', () => {
  it.each([1, 2, 3, 4])('enforces each new hull requirement at a tier %i yard, without charging rejections', tier => {
    const f = fixture(tier);
    for (const [hull, required] of cases) {
      f.station.builds = []; const before = f.co.credits;
      expect(hullBuild(hull).yard, hull).toBe(required);
      const err = f.sim.command(f.p, command(f.station, hull));
      if (tier < required) {
        expect(err, hull).toMatch(/조선소가 필요/); expect(f.co.credits, hull).toBe(before); expect(f.station.builds).toHaveLength(0);
      } else {
        expect(err, hull).toBeNull(); expect(f.station.builds).toHaveLength(1);
        expect(f.station.builds![0].requiredYard, hull).toBe(required);
        expect(f.co.credits, hull).toBe(before - hullBuild(hull).credits - yardFee(hullBuild(hull)));
      }
    }
  });

  it('separates XL yard research from ship-specific research, blueprints and industry', () => {
    const f = fixture(4); f.co.tech = f.co.tech!.filter(t => t !== 'dreadnought_program' && t !== 'battleship_design');
    expect(FACILITIES.yard_xl.tech).toBe('capital_hulls');
    expect(f.sim.command(f.p, command(f.station, 'battleship_mk1'))).toMatch(/연구 필요:.*전함 설계/);
    f.co.tech!.push('battleship_design');
    const battleshipBp = hullBlueprint('battleship_mk1')!; delete f.co.blueprints![battleshipBp];
    expect(f.sim.command(f.p, command(f.station, 'battleship_mk1'))).toMatch(/설계도 필요/);
    expect(grantBlueprint(f.sim.st, f.co, battleshipBp, 'test', f.sim.time)).toBe(true);
    expect(f.sim.command(f.p, command(f.station, 'battleship_mk1'))).toBeNull();
    expect(f.sim.command(f.p, command(f.station, 'miner_xl'))).toBeNull();
    expect(f.sim.command(f.p, command(f.station, 'hauler_xl'))).toBeNull();
    expect(f.sim.command(f.p, command(f.station, 'constructor_xl'))).toBeNull();
    expect(f.sim.command(f.p, command(f.station, 'dreadnought_mk1'))).toMatch(/연구 필요:.*드레드노트/);
    f.co.tech!.push('dreadnought_program');
    const bp = hullBlueprint('dreadnought_mk1')!; delete f.co.blueprints![bp];
    expect(f.sim.command(f.p, command(f.station, 'dreadnought_mk1'))).toMatch(/설계도 필요/);
    expect(grantBlueprint(f.sim.st, f.co, bp, 'test', f.sim.time)).toBe(true);
    f.station.modules = f.station.modules.filter(m => m.kind !== 'weapons_factory');
    expect(f.sim.command(f.p, command(f.station, 'dreadnought_mk1'))).toMatch(/필요 시설:.*무기 공장/);
    f.station.modules.push({ kind: 'weapons_factory', slot: 30, built: true, progress: 1 });
    expect(f.sim.command(f.p, command(f.station, 'dreadnought_mk1'))).toBeNull();
    const x = fixture(3); x.station.modules.push({ kind: 'yard_m', slot: 31, built: true, progress: 1 }); x.co.tech = [];
    const cr = x.co.credits;
    expect(x.sim.command(x.p, { c: 'queueModule', station: x.station.id, kind: 'yard_xl' })).toMatch(/연구 필요/);
    expect(x.co.credits).toBe(cr); x.co.tech.push('capital_hulls');
    expect(x.sim.command(x.p, { c: 'queueModule', station: x.station.id, kind: 'yard_xl' })).toBeNull();
    expect(x.co.tech).not.toContain('dreadnought_program');
  });

  it('retains the original c0 XL yard prerequisite and its research descriptions', () => {
    const f = fixture(3); delete f.sim.st.contentV; delete f.station.size;
    f.co.tech = ['capital_hulls'];
    const command = { c: 'queueModule', station: f.station.id, kind: 'yard_xl' } as const;
    const before = f.co.credits;
    expect(facilityTech(FACILITIES.yard_xl, false)).toBe('dreadnought_program');
    expect(facilityTech(FACILITIES.yard_xl, true)).toBe('capital_hulls');
    expect(f.sim.command(f.p, command)).toMatch(/연구 필요:.*드레드노트/);
    expect(f.co.credits).toBe(before);
    f.co.tech.push('dreadnought_program');
    expect(f.sim.command(f.p, command)).toBeNull();
    expect(facilityDescription(FACILITIES.yard_l, false)).toContain('전함');
    expect(techUnlocks('capital_hulls', false)).toBe('시설: 대형 조선소 · 함선: 중순양함');
    expect(techUnlocks('dreadnought_program', false)).toBe('시설: 초대형 건조 독 · 함선: 드레드노트');
    expect(techUnlocks('capital_hulls', true)).toContain('초대형 건조 독');
  });

  it.each([
    ['battleship_mk1', 'battleship_std', 3], ['miner_l', 'miner_l_std', 2], ['miner_xl', 'miner_xl_std', 3],
  ] as const)('restores started and waiting old %s orders (%s, tier %i) and launches each exactly once', (hull, preset, oldTier) => {
    const f = fixture(oldTier, [...TIER_BASE[oldTier], 'dock']); const def = hullBuild(hull), h = CONTENT.hulls[hull];
    const base: Omit<ShipBuild, 'id' | 'started' | 'left'> = { classId: h.classId, loadoutId: '', hull, variant: `${hull}_std`, preset, fit: [], total: def.time, paid: def.credits + yardFee(def) };
    const started: ShipBuild = { ...base, id: 'old-started', started: true, left: def.time * .4 };
    const waiting: ShipBuild = { ...base, id: 'old-waiting', started: false, left: def.time };
    f.station.builds = [started, waiting];
    const need = buildNeeds(h.classId, '', [], waiting);
    Object.assign(f.station.storage[f.p], need);
    const count = () => Object.values(f.sim.st.ships).filter(s => s.owner === f.p && s.hull === hull).length;
    const initialShips = count(), initialCredits = f.co.credits, oldPaid = waiting.paid;
    expect(buildSpec(started).yard).toBe(oldTier); expect(buildSpec(waiting).yard).toBe(oldTier);
    expect(f.sim.command(f.p, command(f.station, hull))).toMatch(/조선소가 필요/);
    expect(f.co.credits).toBe(initialCredits);
    let sim = new WorldSim(JSON.parse(f.sim.serialize()), { migrateContent: false }); (sim as any).npcSlow = () => {}; (sim as any).npcs = () => {};
    const site = sim.st.stations[f.station.id], co = sim.st.companies[f.p];
    expect(site.builds![0].requiredYard).toBeUndefined(); expect(site.builds![1].paid).toBe(oldPaid);
    sim.tick(.25); expect(site.builds![0].left).toBeLessThan(def.time * .4); expect(site.builds![1].started).toBe(false);
    sim.tick(site.builds![0].left / buildSpeed(site, co) + 1);
    expect(Object.values(sim.st.ships).filter(s => s.owner === f.p && s.hull === hull)).toHaveLength(initialShips + 1);
    sim.tick(.25); expect(site.builds![0].started).toBe(true);
    for (const [item, amount] of Object.entries(need)) expect(site.storage[f.p][item] ?? 0, item).toBeCloseTo(0, 6);
    sim = new WorldSim(JSON.parse(sim.serialize()), { migrateContent: false }); (sim as any).npcSlow = () => {}; (sim as any).npcs = () => {};
    const restored = sim.st.stations[f.station.id], running = restored.builds![0];
    expect(running.started).toBe(true); expect(buildSpec(running).yard).toBe(oldTier); expect(running.paid).toBe(oldPaid);
    sim.tick(running.left / buildSpeed(restored, sim.st.companies[f.p]) + 1);
    expect(restored.builds).toHaveLength(0);
    expect(Object.values(sim.st.ships).filter(s => s.owner === f.p && s.hull === hull)).toHaveLength(initialShips + 2);
    sim.tick(1); expect(Object.values(sim.st.ships).filter(s => s.owner === f.p && s.hull === hull)).toHaveLength(initialShips + 2);
  });

  it.each(['dreadnought_mk1', 'hauler_xl'])('completes and launches a newly registered %s with its unchanged parts', hull => {
    const f = fixture(4), h = CONTENT.hulls[hull], cmd = command(f.station, hull);
    const preset = Object.values(CONTENT.presets).find(p => p.hull === hull && p.variant === `${hull}_std`)!;
    const need = buildNeeds(h.classId, '', [], { hull, variant: `${hull}_std`, preset: preset.id });
    Object.assign(f.station.storage[f.p], need); const beforeShips = Object.values(f.sim.st.ships).filter(s => s.owner === f.p && s.hull === hull).length;
    expect(f.sim.command(f.p, cmd)).toBeNull(); const b = f.station.builds![0];
    expect(b.started).toBe(true); expect(b.requiredYard).toBe(4);
    for (const item of Object.keys(need)) expect(f.station.storage[f.p][item] ?? 0).toBeCloseTo(0, 6);
    const restored = new WorldSim(JSON.parse(f.sim.serialize()), { migrateContent: false }); (restored as any).npcSlow = () => {}; (restored as any).npcs = () => {};
    const site = restored.st.stations[f.station.id];
    restored.tick(site.builds![0].left / buildSpeed(site, restored.st.companies[f.p]) + 1);
    expect(site.builds).toHaveLength(0);
    expect(Object.values(restored.st.ships).filter(s => s.owner === f.p && s.hull === hull)).toHaveLength(beforeShips + 1);
    restored.tick(1); expect(Object.values(restored.st.ships).filter(s => s.owner === f.p && s.hull === hull)).toHaveLength(beforeShips + 1);
  });

  it('still allows complete hulls to be bought without production rights, research or factories', () => {
    const f = fixture(1); f.co.tech = []; f.co.blueprints = {}; f.co.rep = 1000;
    for (const [hull, station] of [['battleship_mk1', 'helios'], ['miner_xl', 'helios'], ['hauler_xl', 'exchange']] as const) {
      const h = CONTENT.hulls[hull], before = Object.values(f.sim.st.ships).filter(s => s.owner === f.p && s.hull === hull).length;
      expect(f.sim.command(f.p, { c: 'buyShip', station, classId: h.classId, loadoutId: '', hull })).toBeNull();
      expect(Object.values(f.sim.st.ships).filter(s => s.owner === f.p && s.hull === hull)).toHaveLength(before + 1);
    }
    expect(f.co.tech).toEqual([]); expect(f.co.blueprints).toEqual({});
  });

  it('lets another company buy a completed player-owned battleship and leave without its blueprint', () => {
    const f = fixture(3); f.station.modules.push({ kind: 'trade_hub', slot: 35, built: true, progress: 1 });
    const sellers = f.sim.newGroup(f.p, '판매 함선'), ship = f.sim.spawnShip(f.p, 'battleship', 'std', sellers.id, f.station.pos);
    expect((f.sim as any).dockShip(ship, f.station)).toBe(true);
    expect(f.sim.command(f.p, { c: 'listShip', ship: ship.id, price: 1000 })).toBeNull();
    const listing = f.station.shipListings![0], buyer = f.sim.addPlayer('완성 함선 구매자');
    expect(f.sim.st.companies[buyer].tech).toEqual([]);
    expect(f.sim.command(buyer, { c: 'buyShipListing', station: f.station.id, listing: listing.id })).toBeNull();
    expect(ship.owner).toBe(buyer); expect(f.sim.st.companies[buyer].blueprints?.bp_battleship_mk1).toBeUndefined();
    expect(f.sim.command(buyer, { c: 'setOp', group: ship.groupId, op: { k: 'move', to: { ...f.station.pos, x: f.station.pos.x + 2000 } } })).toBeNull();
    for (let i = 0; i < 80 && ship.state === 'docked'; i++) f.sim.update(.25);
    expect(ship.state).not.toBe('docked');
  });
});

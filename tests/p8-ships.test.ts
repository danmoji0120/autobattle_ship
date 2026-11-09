// Production content end-to-end: acquisition, construction, fitting and save/reload for all five P8 hulls.
import { describe, expect, it, vi } from 'vitest';
import { addFoundationFreighter } from './helpers/foundation';
import { CONTENT, contentAvail } from '../src/content/registry';
import { WorldSim } from '../src/world/sim';
import { newWorld } from '../src/world/worldgen';
import type { Station } from '../src/world/types';
import { buildNeeds } from '../src/world/production';
import { hullEcon, hullSale, hullUpkeep } from '../src/world/hullops';
import { World } from '../src/sim/world';
import type { FleetSpec } from '../src/sim/fleet';

vi.setConfig({ testTimeout: 300_000 });
const ships = [
  { hull: 'patrol_pathfinder', station: 'helios', preset: 'pathfinder_patrol', variant: 'patrol_pathfinder_scout', refit: 'pathfinder_scout' },
  { hull: 'destroyer_lancet', station: 'helios', preset: 'lancet_salvo', variant: 'destroyer_lancet_screen', refit: 'lancet_screen' },
  { hull: 'miner_quarry', station: 'astra', preset: 'quarry_mining', variant: 'miner_quarry_hold', refit: 'quarry_hold' },
  { hull: 'hauler_meridian', station: 'exchange', preset: 'meridian_cargo', variant: 'hauler_meridian_express', refit: 'meridian_express' },
  { hull: 'cruiser_vigil', station: 'helios', preset: 'vigil_mixed', variant: 'cruiser_vigil_command', refit: 'vigil_command' },
] as const;
const run = (sim: WorldSim, seconds: number, dt = 1) => { for (let t = 0; t < seconds; t += dt) sim.update(dt); };
const calm = (sim: WorldSim) => { for (const l of Object.values(sim.st.lairs)) { l.alive = false; l.respawnAt = 1e9; } for (const s of Object.values(sim.st.systems)) s.security = Math.max(s.security, 75); };
const addModules = (st: Station, ...kinds: string[]) => { for (const kind of kinds) st.modules.push({ kind, progress: 1, built: true, slot: st.modules.length + 1 }); };

describe('P8 production ships', () => {
  it('sells the real hulls at their declared yards and carries their fitted models into battle and saves', () => {
    const sim = WorldSim.create(201); calm(sim);
    const p = sim.addPlayer('함선 시험'); const co = sim.st.companies[p];
    co.credits = 20_000_000; co.rep = 1000;
    for (const x of ships) {
      const h = CONTENT.hulls[x.hull];
      const before = sim.st.stations[x.station].shipStock?.[x.hull]?.n ?? h.sale!.stock;
      expect(sim.command(p, { c: 'buyShip', station: x.station, classId: h.classId, loadoutId: '', hull: h.id, preset: x.preset }), h.id).toBeNull();
      expect(sim.st.stations[x.station].shipStock![x.hull].n).toBe(before - 1);
      const ship = Object.values(sim.st.ships).find(s => s.owner === p && s.hull === h.id)!;
      expect(ship.fitting!.hp).toEqual(CONTENT.presets[x.preset].weapons);
      const spec = sim.fittingSpec(ship)!;
      expect(spec.mesh?.model).toBe(h.mesh.model);
      expect(spec.mounts).toHaveLength(Object.keys(CONTENT.presets[x.preset].weapons).length);
    }
    const reloaded = new WorldSim(JSON.parse(sim.serialize()));
    for (const x of ships) {
      const ship = Object.values(reloaded.st.ships).find(s => s.owner === p && s.hull === x.hull)!;
      expect(ship.fitting!.hp).toEqual(CONTENT.presets[x.preset].weapons);
      expect(reloaded.fittingSpec(ship)!.mesh?.model).toBe(`model.${x.hull}`);
    }
  });

  it('acquires blueprints, enforces research and builds the five hulls with real parts and presets', () => {
    const sim = WorldSim.create(202); calm(sim);
    const p = sim.addPlayer('조선 시험'); const co = sim.st.companies[p];
    co.credits = 20_000_000; co.rep = 1000; co.stats.contracts = 10;
    expect(sim.command(p, { c: 'buyShip', station: 'astra', classId: 'constructor', loadoutId: 'std' })).toBeNull();
    const g = Object.values(sim.st.groups).find(x => x.owner === p && x.shipIds.some(id => sim.st.ships[id].classId === 'constructor'))!;
    const a = sim.st.stations.astra.pos;
    expect(sim.command(p, { c: 'buy', station: 'astra', res: 'alloy', amount: 300 })).toBeNull(); // buy locally before loading the constructor
    addFoundationFreighter(sim, p, g.id);
    expect(sim.command(p, { c: 'setOp', group: g.id, op: { k: 'found', at: { x: a.x + 2600, y: 0, z: a.z + 2600 }, name: '시험 조선소' } })).toBeNull();
    run(sim, 200, 0.5);
    const own = Object.values(sim.st.stations).find(s => s.owner === p)!;
    // This P8 fixture represents a pre-P9.6 saved yard, whose existing docks and assets retain
    // their legacy berth rules. New size and berth limits have separate P9.6 coverage.
    delete own.size;
    addModules(own, 'power', 'power', 'power', 'power', 'yard_s', 'yard_m', 'hull_works', 'machine_shop', 'electronics_fab', 'dock', 'comms', 'fitting');
    for (const x of ships) {
      const h = CONTENT.hulls[x.hull];
      const cmd = { c: 'buildShip', station: own.id, classId: h.classId, loadoutId: '', hull: h.id, preset: x.preset } as const;
      expect(sim.command(p, cmd), h.id).toMatch(/설계도 필요/);
      expect(sim.command(p, { c: 'buyBlueprint', station: x.station, blueprint: `bp_${h.id}` }), h.id).toBeNull();
      if (h.build!.tech?.length) expect(sim.command(p, cmd), h.id).toMatch(/연구 필요/);
    }
    co.tech = [...new Set([...(co.tech ?? []), ...ships.flatMap(x => CONTENT.hulls[x.hull].build!.tech ?? []), 'long_sensors'])];
    // Supply exactly the real hull and preset parts, then let the yard consume them.
    for (const x of ships) {
      const h = CONTENT.hulls[x.hull];
      const need = buildNeeds(h.classId, '', [], { hull: h.id, variant: `${h.id}_std`, preset: x.preset });
      for (const [k, n] of Object.entries(need)) own.storage[p][k] = (own.storage[p][k] ?? 0) + n;
    }
    for (const x of ships) {
      const h = CONTENT.hulls[x.hull];
      expect(sim.command(p, { c: 'buildShip', station: own.id, classId: h.classId, loadoutId: '', hull: h.id, preset: x.preset }), h.id).toBeNull();
    }
    for (let i = 0; i < 20 && own.builds!.length; i++) {
      run(sim, 3);
      for (const b of own.builds!) if (b.started) b.left = 0.1;
      run(sim, 3);
    }
    expect(own.builds).toHaveLength(0);
    for (const x of ships) {
      const ship = Object.values(sim.st.ships).find(s => s.owner === p && s.hull === x.hull)!;
      expect(ship, x.hull).toBeTruthy();
      expect(ship.fitting!.hp).toEqual(CONTENT.presets[x.preset].weapons);
      expect(sim.fittingSpec(ship)!.mesh?.model).toBe(`model.${x.hull}`);
      const refit = { c: 'fit', ship: ship.id, variant: x.variant, hp: CONTENT.presets[x.refit].weapons, bay: {} } as const;
      if (x.hull === 'cruiser_vigil') {
        expect(sim.command(p, refit)).toMatch(/변형 설계도 필요/);
        expect(sim.command(p, { c: 'buyBlueprint', station: 'helios', blueprint: 'bp_cruiser_vigil_command' })).toBeNull();
      }
      expect(sim.command(p, refit), x.variant).toBeNull();
      expect(ship.variant).toBe(x.variant);
    }
    const back = new WorldSim(JSON.parse(sim.serialize()));
    for (const x of ships) {
      const ship = Object.values(back.st.ships).find(s => s.owner === p && s.hull === x.hull)!;
      expect(ship.variant).toBe(x.variant);
      expect(ship.fitting!.hp).toEqual(CONTENT.presets[x.refit].weapons);
    }
  });

  it('keeps growth content out of c0 and retains industrial tradeoffs', () => {
    const c0 = new WorldSim(newWorld(203), { migrateContent: false });
    for (const x of ships) {
      const h = CONTENT.hulls[x.hull];
      expect(contentAvail(`${h.id}_std`, 0)).toBe(false);
      expect(contentAvail(x.variant, 0)).toBe(false);
      expect((c0 as any).hullChoice({ classId: h.classId, loadoutId: '', hull: h.id })).toMatch(/사용할 수 없는 구조/);
    }
    expect(hullSale('miner_quarry')!.price / hullEcon('miner_quarry').mine).toBeGreaterThan(hullSale('miner_mk1')!.price / hullEcon('miner_mk1').mine);
    expect(hullUpkeep('miner_quarry').credits / hullEcon('miner_quarry').mine).toBeGreaterThan(hullUpkeep('miner_mk1').credits / hullEcon('miner_mk1').mine);
    expect(hullSale('hauler_meridian')!.price / hullEcon('hauler_meridian').cargo).toBeGreaterThan(hullSale('hauler_mk1')!.price / hullEcon('hauler_mk1').cargo);
    expect(hullUpkeep('hauler_meridian').credits / hullEcon('hauler_meridian').cargo).toBeGreaterThan(hullUpkeep('hauler_mk1').credits / hullEcon('hauler_mk1').cargo);
    expect(hullEcon('hauler_meridian').berth).toBe('L');
    expect(hullEcon('miner_quarry', 'miner_quarry_hold').mine).toBeLessThan(hullEcon('miner_quarry').mine);
    expect(hullEcon('hauler_meridian', 'hauler_meridian_express').cargo).toBeLessThan(hullEcon('hauler_meridian').cargo);
  });

  it('fires the fitted weapons from each new combat hull in an actual battle simulation', () => {
    const sim = WorldSim.create(204); const p = sim.addPlayer('전투 시험');
    const group = sim.newGroup(p, '시험 함대');
    for (const [hull, preset, weapon] of [
      ['patrol_pathfinder', 'pathfinder_patrol', 'autocannon'],
      ['destroyer_lancet', 'lancet_salvo', 'missile_rack'],
      ['cruiser_vigil', 'vigil_mixed', 'medium_gun'],
    ] as const) {
      const ship = sim.spawnHull(p, hull, `${hull}_std`, preset, group.id, sim.st.stations.astra.pos);
      const fit = sim.fittingSpec(ship)!;
      const fleet = (classId: string, fit0?: typeof fit): FleetSpec => ({
        name: '시험', root: { name: '전대', order: 'engage', retreatAt: 0, ships: [{ classId, loadoutId: 'gun', ...(fit0 ? { fit: fit0 } : {}) }], children: [] },
      });
      const battle = new World({ seed: 5, scenarioId: 'kestrel', fleets: [fleet(ship.classId, fit), fleet('destroyer')] });
      let fired = false;
      for (let i = 0; i < 20000 && !fired; i++) {
        battle.step();
        fired = battle.events.splice(0).some(e => e.t === 'fire' && e.weapon === weapon);
      }
      expect(fired, `${hull}: ${weapon}`).toBe(true);
      expect(battle.ships[0].loadout.mesh?.model).toBe(`model.${hull}`);
    }
  });
});

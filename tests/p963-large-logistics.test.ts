import { describe, expect, it } from 'vitest';
import { WorldSim } from '../src/world/sim';
import { FACILITIES, TECHS } from '../src/world/industry';
import { STATION_SIZES, moduleMaterials } from '../src/world/stations';
import { storageCap, yardSlots } from '../src/world/production';
import { storeUsed } from '../src/world/storage';
import { qty } from '../src/world/types';
import { jumps } from '../src/world/geom';
import { grantBlueprint, hullBlueprint } from '../src/world/blueprints';
import type { Cargo, Station } from '../src/world/types';
import type { Size } from '../src/content/schema';

const add = (out: Cargo, input: Cargo) => { for (const [item, n] of Object.entries(input)) out[item] = (out[item] ?? 0) + n; };
const sum = (cargo: Cargo) => Object.values(cargo).reduce((a, b) => a + b, 0);

describe('P9.6.3 large construction with physical logistics', () => {
  it.each(['L', 'XL'] as Size[])('builds a %s station and its complete yard chain with multi-gate deliveries', size => {
    let sim = WorldSim.create(size === 'L' ? 9633 : 9634); (sim as any).npcSlow = () => {};
    for (const l of Object.values(sim.st.lairs)) { l.alive = false; l.respawnAt = 1e10; }
    const p = sim.addPlayer(`${size} 산업망`), co = sim.st.companies[p];
    co.credits = 100_000_000; co.tech = Object.keys(TECHS); // fixture funding and research, not an unaided progression claim
    const base = sim.st.stations.astra;
    const source: Station = { ...structuredClone(base), id: `p963_source_${size}`, name: '검증용 공급항', owner: p, public: false, size: 'XL', market: null,
      pos: { ...base.pos, x: base.pos.x + 7000 }, storage: { [p]: {} },
      modules: ['core', 'warehouse', 'warehouse', 'warehouse', 'warehouse'].map((kind, slot) => ({ kind, slot, built: true, progress: 1 })) };
    sim.st.stations[source.id] = source;
    const yards = size === 'L' ? ['yard_s', 'yard_m', 'yard_l'] : ['yard_s', 'yard_m', 'yard_l', 'yard_xl'];
    const needs: Cargo = {}; add(needs, STATION_SIZES[size].mats); for (const kind of yards) add(needs, FACILITIES[kind].mats);
    const initial: Cargo = { ...needs, alloy: needs.alloy + 500 }; source.storage[p] = { ...initial };
    expect(storeUsed(source.storage[p])).toBeLessThan(storageCap(source));
    const at = { ...sim.st.systems.quiet.origin, x: sim.st.systems.quiet.origin.x + 10000 };
    expect(jumps(sim.st.systems, 'astra', 'quiet')).toBeGreaterThanOrEqual(2);
    const builders = sim.newGroup(p, '원정 공작반'); sim.spawnShip(p, 'constructor', 'std', builders.id, at);
    expect(sim.command(p, { c: 'setOp', group: builders.id, op: { k: 'found', at, name: `${size} 원정 기지`, size } })).toBeNull();
    sim.update(.25);
    let site = Object.values(sim.st.stations).find(s => s.owner === p && s.id !== source.id)!;
    expect(site).toBeTruthy(); expect(site.modules[0].progress).toBe(0);
    const routes: Record<string, string> = {};
    for (const item of Object.keys(needs)) {
      const group = sim.newGroup(p, `${item} 장거리 공급`);
      const ship = sim.spawnHull(p, 'hauler_xl', 'hauler_xl_std', undefined, group.id, source.pos);
      expect((sim as any).dockShip(ship, source)).toBe(true);
      expect(sim.command(p, { c: 'putRoute', group: group.id, config: { name: `${item} 건설 공급`, from: source.id, to: site.id, item, amount: 9000, mode: 'construction', repeat: true } })).toBeNull();
      routes[item] = Object.values(sim.st.logistics!).find(r => r.group === group.id)!.id;
    }
    const until = (label: string, done: () => boolean, seconds = 20000, tick?: () => void) => {
      for (let t = 0; t < seconds && !done(); t += .25) { sim.update(.25); tick?.(); }
      if (!done()) throw Error(`${size} ${label}: ${JSON.stringify({ time: sim.time, plans: site.modules.filter(m => !m.built), routes: Object.values(sim.st.logistics ?? {}).map(r => ({ item: r.config.item, state: r.state, stats: r.stats, cursors: r.cursors })) })}`);
    };
    until('core', () => site.modules[0].built);
    expect(site.modules[0].materials).toEqual(STATION_SIZES[size].mats);
    for (const kind of yards) {
      expect(sim.command(p, { c: 'queueModule', station: site.id, kind })).toBeNull();
      let plan = site.modules.find(m => m.kind === kind && !m.built)!;
      expect(plan.materials).toEqual(FACILITIES[kind].mats); expect(plan.paid).toBe(FACILITIES[kind].credits);
      let maxSecured = 0, maxWarehouse = storeUsed(site.storage[p]);
      const meter = () => {
        if (!plan.built) maxSecured = Math.max(maxSecured, sum(plan.reserved ?? {}) + sum(plan.used ?? {}));
        maxWarehouse = Math.max(maxWarehouse, storeUsed(site.storage[p]));
      };
      if (kind === 'yard_xl') {
        const filler = storageCap(site) - storeUsed(site.storage[p]);
        site.storage[p].ore = filler; // isolated fixture filling the ordinary warehouse; tracked as cargo below
        const oreInitial = filler;
        const alloyRoute = sim.st.logistics![routes.alloy];
        until('full warehouse blocks alloy', () => Object.values(alloyRoute.manifests).some(m => m.amount > 0) && Object.values(alloyRoute.cursors).some(c => c.code === 'construction' || c.code === 'storage'), 5000, meter);
        expect(plan.progress).toBe(0); expect(qty(site.storage[p], 'ore')).toBe(oreInitial);
        expect(Object.values(alloyRoute.manifests).reduce((n, m) => n + m.amount, 0)).toBeGreaterThan(0);
        const removal = sim.newGroup(p, '창고 공간 확보');
        const empty = sim.spawnHull(p, 'hauler_xl', 'hauler_xl_std', undefined, removal.id, site.pos);
        expect((sim as any).dockShip(empty, site)).toBe(true);
        expect(sim.command(p, { c: 'putRoute', group: removal.id, config: { name: '광석 반출', from: site.id, to: source.id, item: 'ore', amount: 9000, mode: 'transfer', repeat: true } })).toBeNull();
        const out = Object.values(sim.st.logistics!).find(r => r.group === removal.id)!;
        until('warehouse space freed', () => out.stats.loaded > 0, 5000, meter);
        expect(sim.command(p, { c: 'routeControl', routes: [out.id], action: 'pause' })).toBeNull();
        const ore = qty(site.storage[p], 'ore') + qty(source.storage[p], 'ore') + Object.values(sim.st.ships).filter(s => s.owner === p).reduce((n, s) => n + qty(s.cargo, 'ore'), 0);
        expect(ore).toBeCloseTo(oreInitial, 5);
        // Save while a physical supply remains in flight, then continue using the restored authoritative state.
        const siteId = site.id, planId = plan.id!, snapshot = JSON.parse(sim.serialize());
        const alloyBefore = structuredClone(sim.st.logistics![routes.alloy].manifests);
        sim = new WorldSim(snapshot, { migrateContent: false }); (sim as any).npcSlow = () => {};
        site = sim.st.stations[siteId]; plan = site.modules.find(m => m.id === planId)!;
        expect(sim.st.logistics![routes.alloy].manifests).toEqual(alloyBefore);
        expect(plan.materials).toEqual(FACILITIES.yard_xl.mats);
      }
      until(kind, () => plan.built, 20000, meter);
      expect(maxWarehouse).toBeLessThanOrEqual(storageCap(site) + 1e-6);
      if (kind === 'yard_xl') {
        expect(sum(FACILITIES.yard_xl.mats)).toBeGreaterThan(storageCap(site));
        expect(maxSecured).toBeCloseTo(sum(FACILITIES.yard_xl.mats), 3);
      }
    }
    for (const [item, required] of Object.entries(needs)) {
      const route = sim.st.logistics![routes[item]];
      expect(route.stats.delivered, item).toBeCloseTo(required, 4);
      const remaining = qty(sim.st.stations[source.id].storage[p], item) + qty(site.storage[p], item) +
        Object.values(sim.st.ships).filter(s => s.owner === p).reduce((n, s) => n + qty(s.cargo, item), 0) +
        site.modules.filter(m => m.built).reduce((n, m) => n + (moduleMaterials(m)[item] ?? 0), 0);
      expect(remaining, item).toBeCloseTo(initial[item], 4);
    }
    expect(yardSlots(site).some(y => y.size === (size === 'XL' ? 4 : 3))).toBe(true);
    if (size === 'XL') {
      const currentCo = sim.st.companies[p], bp = hullBlueprint('dreadnought_mk1')!;
      expect(grantBlueprint(sim.st, currentCo, bp, 'fixture', sim.time)).toBe(true);
      const command = { c: 'buildShip', station: site.id, classId: 'dreadnought', loadoutId: 'std', hull: 'dreadnought_mk1', variant: 'dreadnought_mk1_std', preset: 'dreadnought_std' } as const;
      expect(sim.command(p, command)).toMatch(/필요 시설/);
      // Supporting facilities are pre-equipped only for this separate shipyard integration check.
      for (const kind of ['hull_works', 'machine_shop', 'armor_plant', 'electronics_fab', 'power', 'hangar', 'engine_plant', 'reactor_plant', 'weapons_factory', 'habitat']) {
        site.modules.push({ kind, slot: site.modules.length, built: true, progress: 1 });
      }
      expect(sim.command(p, command)).toBeNull();
      expect(site.builds?.at(-1)?.classId).toBe('dreadnought');
    }
    console.log(JSON.stringify({ size, simulatedSeconds: sim.time, needs, trips: Object.fromEntries(Object.entries(routes).map(([item, id]) => [item, sim.st.logistics![id].stats.trips])) }));
  }, 180_000);
});

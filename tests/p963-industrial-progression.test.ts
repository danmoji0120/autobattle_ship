import { describe, expect, it } from 'vitest';
import { WorldSim } from '../src/world/sim';
import { FACILITIES, TECHS } from '../src/world/industry';
import { STATION_SIZES } from '../src/world/stations';
import { qty } from '../src/world/types';
import type { Cargo, Station } from '../src/world/types';
import { jumps } from '../src/world/geom';

const add = (to: Cargo, from: Cargo) => { for (const [k, n] of Object.entries(from)) to[k] = (to[k] ?? 0) + n; };

describe('P9.6.3 medium industrial progression', () => {
  it('physically supplies an M station, researches hulls, produces electronics and builds a medium yard', () => {
    const sim = WorldSim.create(9632); (sim as any).npcSlow = () => {};
    for (const lair of Object.values(sim.st.lairs)) { lair.alive = false; lair.respawnAt = 1e10; }
    const p = sim.addPlayer('중형 산업 검증'), co = sim.st.companies[p];
    co.credits = 20_000_000; // fixture capital; source resources and ships below are also test grants
    const base = sim.st.stations.astra;
    const source: Station = { ...structuredClone(base), id: 'p963_m_source', name: '검증용 공급항', owner: p, public: false, size: 'XL', market: null,
      pos: { ...base.pos, x: base.pos.x + 7000 }, storage: { [p]: {} },
      modules: ['core', 'warehouse'].map((kind, slot) => ({ kind, slot, built: true, progress: 1 })) };
    sim.st.stations[source.id] = source;
    const facilities = ['power', 'warehouse', 'refinery', 'smelter', 'machine_shop', 'hull_works', 'lab_basic', 'lab_materials', 'electronics_fab', 'yard_s', 'yard_m'];
    const needs: Cargo = {}; add(needs, STATION_SIZES.M.mats); for (const kind of facilities) add(needs, FACILITIES[kind].mats);
    add(needs, TECHS.frigate_design.cost); add(needs, TECHS.medium_hulls.cost);
    add(needs, { ore: 40, silicate: 40, crystal: 1 }); source.storage[p] = { ...needs };
    const at = { ...sim.st.systems.quiet.origin, x: sim.st.systems.quiet.origin.x + 10000 };
    expect(jumps(sim.st.systems, 'astra', 'quiet')).toBeGreaterThanOrEqual(2);
    const builder = sim.newGroup(p, '원정 공작반'); sim.spawnShip(p, 'constructor', 'std', builder.id, at);
    expect(sim.command(p, { c: 'setOp', group: builder.id, op: { k: 'found', at, name: '중형 산업 거점', size: 'M' } })).toBeNull();
    sim.update(.25);
    const site = Object.values(sim.st.stations).find(s => s.owner === p && s.id !== source.id)!;
    const groups: Record<string, string> = {}, routes: Record<string, string> = {};
    const route = (item: string, mode: 'construction' | 'transfer', amount = 3200) => {
      let group = groups[item];
      if (!group) {
        const g = sim.newGroup(p, `${item} 원정 물류`); group = groups[item] = g.id;
        const ship = sim.spawnHull(p, 'hauler_l', 'hauler_l_std', undefined, group, source.pos);
        expect((sim as any).dockShip(ship, source)).toBe(true);
      }
      expect(sim.command(p, { c: 'putRoute', group, config: { name: `${item} ${mode}`, from: source.id, to: site.id, item, amount, mode, repeat: mode === 'construction' } })).toBeNull();
      routes[item] = Object.values(sim.st.logistics!).find(r => r.group === group)!.id;
    };
    const until = (label: string, done: () => boolean, seconds = 20000) => {
      for (let t = 0; t < seconds && !done(); t += .25) sim.update(.25);
      if (!done()) throw Error(`${label}: ${JSON.stringify({ time: sim.time, plans: site.modules.filter(m => !m.built), research: co.research, routes: Object.values(sim.st.logistics ?? {}).map(r => ({ item: r.config.item, state: r.state, stats: r.stats, cursors: r.cursors })) })}`);
    };
    for (const item of ['alloy', 'structure', 'machinery', 'electronics', 'composite', 'silicon']) route(item, 'construction');
    until('M foundation', () => site.modules[0].built);
    for (const kind of facilities.filter(k => k !== 'yard_m')) {
      expect(sim.command(p, { c: 'queueModule', station: site.id, kind })).toBeNull();
      until(kind, () => site.modules.some(m => m.kind === kind && m.built));
    }
    for (const id of Object.values(routes)) expect(sim.command(p, { c: 'routeControl', routes: [id], action: 'cancel' })).toBeNull();
    for (const [item, amount] of Object.entries({ structure: 40, precision: 4, electronics: 14, ore: 40, silicate: 40, crystal: 1 })) route(item, 'transfer', amount);
    until('research and production inputs', () => ['structure', 'precision', 'electronics', 'ore', 'silicate', 'crystal'].every(item => sim.st.logistics![routes[item]].stats.delivered >= ({ structure: 40, precision: 4, electronics: 14, ore: 40, silicate: 40, crystal: 1 } as Cargo)[item]));
    for (const [recipe, n] of [['metal', 1], ['silicon', 1], ['electronics', 1]] as const)
      expect(sim.command(p, { c: 'prodOrder', station: site.id, recipe, mode: 'count', n })).toBeNull();
    until('manufactured electronics', () => qty(site.storage[p], 'electronics') >= 18);
    expect(sim.command(p, { c: 'research', station: site.id, tech: 'frigate_design' })).toBeNull();
    expect(sim.command(p, { c: 'research', station: site.id, tech: 'medium_hulls' })).toBeNull();
    until('actual research', () => co.tech?.includes('medium_hulls') === true, 24000);
    for (const item of ['structure', 'electronics']) expect(sim.command(p, { c: 'routeControl', routes: [routes[item]], action: 'cancel' })).toBeNull();
    for (const item of ['alloy', 'structure', 'machinery', 'electronics']) route(item, 'construction');
    expect(sim.command(p, { c: 'queueModule', station: site.id, kind: 'yard_m' })).toBeNull();
    until('medium yard', () => site.modules.some(m => m.kind === 'yard_m' && m.built));
    expect(site.modules.find(m => m.kind === 'yard_m')!.materials).toEqual(FACILITIES.yard_m.mats);
    expect(co.tech).toContain('frigate_design'); expect(co.tech).toContain('medium_hulls');
    console.log(JSON.stringify({ size: 'M', simulatedSeconds: sim.time, sourceFixture: needs, mediumResearch: ['frigate_design', 'medium_hulls'] }));
  }, 180_000);
});

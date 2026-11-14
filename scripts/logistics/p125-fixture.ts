// P12.5 §19 fixture: three company stations and five haulers, no route. Only the starting assets are
// placed here (founding three stations by play takes hours); everything after is driven by real commands.
//   A 자재 정거장 (astra)  — ore, alloy and the battleship's structural parts
//   B 전자 정거장 (astra)  — electronics
//   C 조선 정거장 (drake)  — XL dock; short of alloy-based parts and electronics
// Haulers dock at A. A pirate band waits at drake's gate from astra; an escort group stands by at A.
import type { WorldSim } from '../../src/world/sim';
import type { Station } from '../../src/world/types';
import { TECHS } from '../../src/world/industry';
import { grantBlueprint, hullBlueprint } from '../../src/world/blueprints';

export const BB = { classId: 'battleship', loadoutId: '', hull: 'battleship_mk1' };
export function p125Fixture(sim: WorldSim, p: string) {
  const co = sim.st.companies[p]; co.credits = 2e7; co.tech = Object.keys(TECHS);
  grantBlueprint(sim.st, co, hullBlueprint(BB.hull)!, 'fixture', sim.time);
  const astra = sim.st.stations.astra, drake = sim.st.systems.drake;
  const make = (id: string, name: string, pos: { x: number; y: number; z: number }, modules: string[]): Station => ({ ...structuredClone(astra), id, name, public: false, owner: p, pos, size: 'XL', market: null, funds: undefined, fundsMax: undefined, shipStock: undefined, storage: { [p]: {} },
    modules: modules.map((kind, i) => ({ id: `${id}_${kind}`, kind, progress: 1, built: true, slot: i })) as any, orders: [], jobs: [], builds: [] } as Station);
  const base = ['core', 'power', 'power', 'warehouse', 'warehouse', 'logistics', 'dock', 'dock', 'dock', 'repair'];
  const A = make('p125_A', 'A 자재 정거장', { x: astra.pos.x + 2600, y: 0, z: astra.pos.z + 1800 }, base);
  const B = make('p125_B', 'B 전자 정거장', { x: astra.pos.x - 2400, y: 0, z: astra.pos.z + 2200 }, base);
  const C = make('p125_C', 'C 조선 정거장', { x: drake.origin.x + 3000, y: 0, z: drake.origin.z + 2500 }, [...base, 'habitat', 'machine_shop', 'hull_works', 'electronics_fab', 'engine_plant', 'reactor_plant', 'weapons_factory', 'armor_plant', 'hangar', 'yard_s', 'yard_m', 'yard_l', 'yard_xl']);
  for (const s of [A, B, C]) sim.st.stations[s.id] = s;
  co.homeStation = A.id;
  const g = sim.newGroup(p, '수송대');
  const haulers = Array.from({ length: 5 }, () => { const s = sim.spawnShip(p, 'hauler', 'std', g.id, A.pos); (sim as any).dockShip(s, A); return s; });
  const escort = sim.newGroup(p, '호위대'); escort.commanderId = sim.newCommander(p, 2).id;
  for (let k = 0; k < 3; k++) { const s = sim.spawnShip(p, k ? 'frigate' : 'destroyer', 'std', escort.id, A.pos); (sim as any).dockShip(s, A); }
  const gate = drake.gates.find(x => x.to === 'astra')!;
  const pirates = sim.newGroup('pirates', '관문 약탈대');
  for (let k = 0; k < 3; k++) sim.spawnShip('pirates', 'corvette', 'std', pirates.id, { x: gate.pos.x + 1400 + k * 40, y: 0, z: gate.pos.z + 300 });
  return { A, B, C, g, haulers, escort, pirates, gate };
}
/** stock the battleship needs: electronics at B, everything else at A (nothing at C) */
export function stockFor(sim: WorldSim, p: string, needs: Record<string, number>, A: Station, B: Station) {
  for (const [item, n] of Object.entries(needs)) (item === 'electronics' ? B : A).storage[p][item] = n;
  A.storage[p].ore = 400; A.storage[p].alloy = 400;
}

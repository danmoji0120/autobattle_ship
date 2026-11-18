// P16.6 carrier E2E — the shared scenario pieces (used by the headless rehearsal and the real-server run).
//
// What is placed offline (documented in docs/P16_6_CARRIER_RELEASE.md §2): the late-game *non-carrier* state a
// company would have built over many hours of play — an own L station with labs, factories, a large yard and a
// dock; generic industrial goods in its storage; credits; company credit and the contract record the carrier
// blueprint asks for. NOTHING carrier-specific is placed: no tech, no blueprint, no carrier, no strike craft,
// no aviation module, no carrier computer. Those come only from real commands (research, buyBlueprint,
// buildShip, prodOrder, buy, fit) and the simulation.
import type { WorldSim } from '../../../src/world/sim';
import type { Station, V, WGroup } from '../../../src/world/types';
import { emptyCargo } from '../../../src/world/types';
import { dist } from '../../../src/world/geom';

export const TECH_ORDER = [
  // prerequisites before the projects that need them (a queued prerequisite counts; it finishes first)
  'process_control', 'composites',                                                          // industry
  'frigate_design', 'medium_hulls', 'light_cruiser_design', 'capital_hulls', 'modular_assembly', // shipeng
  'fleet_doctrine', 'combined_arms',                                                        // tactics
  'missile_fab', 'torpedo_casting',                                                         // missile
  'fire_control', 'pd_network', 'long_sensors',                                             // electronics
  'damage_control',                                                                         // defense
];
/** generic goods for the research projects, the hull parts and the carrier gear recipes (never carrier gear itself) */
export const GOODS: Record<string, number> = {
  structure: 900, composite: 200, precision: 200, electronics: 600, sensor: 40, munitions: 200, chemicals: 200, silicon: 100,
  machinery: 300, armor_plate: 200, engine: 30, reactor: 20, weapon_parts: 120, crystal: 40, alloy: 400,
};
export const MODULES = ['power', 'power', 'power', 'power', 'power', 'power', 'power', 'power', 'warehouse', 'warehouse', 'warehouse', 'dock',
  'yard_l', 'electronics_fab', 'weapons_factory', 'machine_shop',
  'lab_basic', 'lab_materials', 'design_bureau', 'lab_tactics', 'lab_ballistics', 'lab_electronics', 'lab_power'];

function freeSpot(sim: WorldSim, near: V, r0: number): V {
  for (let i = 0; i < 96; i++) {
    const a = i * 0.71, r = r0 + 1500 * (i % 5);
    const p = { x: near.x + Math.cos(a) * r, y: 0, z: near.z + Math.sin(a) * r };
    if (Object.values(sim.st.stations).every(s => dist(s.pos, p) > 3000) && Object.values(sim.st.lairs).every(l => dist(l.pos, p) > 6000)) return p;
  }
  throw Error('no free spot');
}

/** the carrier company's late-game, non-carrier starting state (see the header) */
export function seedCarrierCompany(sim: WorldSim, co: string, near = 'helios'): Station {
  const h = sim.st.stations[near];
  const id = sim.id('st');
  const st: Station = {
    id, name: `${sim.st.companies[co].name} 본사 기지`, owner: co, public: false, size: 'L', style: 3, pos: freeSpot(sim, h.pos, 9000), radius: 220, market: null,
    services: { repair: false, shipyard: [], recruit: false, contracts: false, refit: false }, storage: {}, modules: [{ kind: 'core', progress: 1, built: true, slot: 0 }], defenseHp: 1, founded: sim.time, desc: '',
  } as Station;
  for (const c of Object.keys(sim.st.companies)) st.storage[c] = emptyCargo();
  for (const kind of MODULES) st.modules.push({ kind, progress: 1, built: true, slot: st.modules.length });
  sim.st.stations[id] = st;
  for (const [k, n] of Object.entries(GOODS)) (st.storage[co] as Record<string, number>)[k] = n;
  const c = sim.st.companies[co];
  c.credits = 3_500_000;
  c.rep = Math.max(c.rep, 60);
  c.stats.contracts = Math.max(c.stats.contracts ?? 0, 8);
  return st;
}

/** an ordinary gun battle group (no strike craft) with an officer, placed at a point */
export function seedWarGroup(sim: WorldSim, co: string, name: string, at: V, comp: [string, string][]): WGroup {
  const g = sim.newGroup(co, name);
  g.commanderId = sim.newCommander(co, 3).id;
  comp.forEach(([cl, lo], i) => sim.spawnShip(co, cl, lo, g.id, { x: at.x + (i % 4) * 60, y: 0, z: at.z + Math.floor(i / 4) * 60 }));
  return g;
}

/** advance the world with its own update loop (the server's tick, without wall-clock waiting) */
export function advance(sim: WorldSim, seconds: number, every?: (t: number) => boolean | void) {
  for (let t = 0; t < seconds; t += 0.5) { sim.update(0.5); if (every && every(t)) return t; }
  return seconds;
}

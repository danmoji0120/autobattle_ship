// B-3 test / measurement fixture. The territory engine always runs in the real standard world loop; this fixture only
// stands in for the parts that take many real hours to play and are not under test here: it places a finished station
// with finished facilities (as the construction queue would leave it), launches combat ships with an officer (as a yard
// and a recruit office would), and delivers administration goods into storage (as haulers would). Everything the
// sovereignty rules measure — control, presence, revenue, liquidity, supply inflow, stabilisation — is then produced
// by the simulation itself. See docs/B3_TERRITORY.md §8.
import { WorldSim } from '../../src/world/sim';
import { STANDARD_WORLD } from '../../src/world/worldPreset';
import { SHIP_CLASSES } from '../../src/sim/data/ships';
import type { Station, V, WGroup } from '../../src/world/types';
import { emptyCargo } from '../../src/world/types';
import { dist } from '../../src/world/geom';
import { book } from '../../src/world/operations';
import { supplyNeed, regionClass, sovTick, powerNeed } from '../../src/world/sovereignty';
import { rateClass } from '../../src/world/combatRating';

export const run = (sim: WorldSim, s: number) => { for (let i = 0; i < s; i++) sim.update(1); };
export const hours = (sim: WorldSim, h: number, each?: (hr: number) => void) => { for (let i = 0; i < h; i++) { run(sim, 3600); each?.(i); } };
export const restore = (save: string) => new WorldSim(JSON.parse(save));
export function world(seed = 41) { return WorldSim.create(seed, { ...STANDARD_WORLD }); }

/** a free spot in the system for a new station */
export function spot(sim: WorldSim, sysId: string, k = 0): V {
  const sys = sim.st.systems[sysId];
  for (let i = 0; i < 64; i++) {
    const a = (i + k * 7) * 0.71, r = sys.radius * (0.35 + 0.1 * (i % 4));
    const p = { x: sys.origin.x + Math.cos(a) * r, y: 0, z: sys.origin.z + Math.sin(a) * r };
    if (Object.values(sim.st.stations).every(s => dist(s.pos, p) > 3000) && Object.values(sim.st.lairs).every(l => dist(l.pos, p) > 3200) && sys.gates.every(g => dist(g.pos, p) > 2500)) return p;
  }
  return { ...sys.origin, x: sys.origin.x + sys.radius * 0.5 };
}
/** a finished own station (core built) with finished facilities */
export function outpost(sim: WorldSim, co: string, sysId: string, size: 'S' | 'M' | 'L' | 'XL', kinds: string[], k = 0): Station {
  const id = sim.id('st');
  const st: Station = { id, name: `${sim.st.companies[co].name} ${sim.st.systems[sysId].name} 기지`, owner: co, public: false, size, style: 3, pos: spot(sim, sysId, k), radius: 180, market: null,
    services: { repair: false, shipyard: [], recruit: false, contracts: false, refit: false }, storage: {}, modules: [{ kind: 'core', progress: 1, built: true, slot: 0 }], defenseHp: 1, founded: sim.time, desc: '' };
  for (const c of Object.keys(sim.st.companies)) st.storage[c] = emptyCargo();
  sim.st.stations[id] = st;
  for (const kind of kinds) st.modules.push({ kind, progress: 1, built: true, slot: st.modules.length });
  return st;
}
export const GOV_KIT = (defense: number) => ['power', 'power', 'warehouse', 'governance', ...Array(defense).fill('defense')];

/** combat ships with an officer, launched at a station or a point */
export function warships(sim: WorldSim, co: string, at: V, classes: string[], name = '영토 경비대'): WGroup {
  const g = sim.newGroup(co, name);
  for (const [i, c] of classes.entries()) {
    const lo = SHIP_CLASSES[c].loadouts[0].id;
    const a = i * 0.9;
    sim.spawnShip(co, c, lo, g.id, { x: at.x + Math.cos(a) * 400, y: 0, z: at.z + Math.sin(a) * 400 });
  }
  const cm = sim.newCommander(co, 2); cm.owner = co;
  g.commanderId = cm.id;
  return g;
}
/** patrol the system's gates and the station */
export function patrol(sim: WorldSim, co: string, g: WGroup, sysId: string, st?: Station) {
  const sys = sim.st.systems[sysId];
  const route = [...sys.gates.map(x => ({ x: x.pos.x + (sys.origin.x - x.pos.x) * 0.05, y: 0, z: x.pos.z + (sys.origin.z - x.pos.z) * 0.05 })), ...(st ? [st.pos] : [])];
  const r = sim.command(co, { c: 'setOp', group: g.id, op: { k: 'patrol', at: route[0], radius: 3000, route } });
  if (r) throw new Error('patrol: ' + r);
}
/** deliver administration goods to the seat (stands in for haulers / purchases); `share` of the hourly need */
export function deliver(sim: WorldSim, co: string, st: Station, share = 1.2, hoursOf = 1) {
  const sys = sim.sysOf(st.pos)!; const need = supplyNeed(regionClass(sim.st, sys));
  const sto = (st.storage[co] ??= emptyCargo());
  for (const [k, n] of Object.entries(need)) sto[k] = (sto[k] ?? 0) + n * share * hoursOf;
}
/** an hour of ordinary business income (stands in for the sales of a grown industrial company); booked as sales */
export function earn(sim: WorldSim, co: string, amount: number) {
  sim.st.companies[co].credits += amount;
  book(sim, co, 'sales', amount);
}

/** warships held at every gate of the system (5 % inward, inside the 4,000 gate radius) and at the station (what a patrol that keeps the points looks like
 *  when the clock is fast-forwarded) — one group per post, each with an officer */
export function garrison(sim: WorldSim, co: string, sysId: string, st: Station | undefined, perGate: string[], atStation: string[]): WGroup[] {
  const sys = sim.st.systems[sysId], out: WGroup[] = [];
  for (const g of sys.gates) out.push(warships(sim, co, { x: g.pos.x + (sys.origin.x - g.pos.x) * 0.05, y: 0, z: g.pos.z + (sys.origin.z - g.pos.z) * 0.05 }, perGate, `${g.name} 경비`));
  if (st && atStation.length) out.push(warships(sim, co, { ...st.pos, x: st.pos.x + 900 }, atStation, '기지 경비'));
  return out;
}
/** advance only the territory clock: the rest of the world stands still (ships stay where they are). Used for the
 *  long holds (12–36 h stabilisation, 24 h occupations) that would take an hour of CPU per scenario in the full loop;
 *  the full-loop runs are scripts/b3/pioneer.ts and scripts/b3/growth.ts. `each` runs once per hour. */
export function ff(sim: WorldSim, h: number, each?: (hr: number) => void) {
  for (let i = 0; i < h; i++) {
    for (let m = 0; m < 60; m++) { sim.st.time += 60; sovTick(sim, 60); }
    each?.(i);
  }
}
/** finished territory kit + garrison + money: what a grown company brings to a system. Unless the posts are given,
 *  the station squadron is sized to 130 % of the system's military requirement (standard cruisers, combat rating ≈ 140 each). */
export function kit(sim: WorldSim, co: string, sysId: string, opts: { size?: 'M' | 'L' | 'XL'; perGate?: string[]; atStation?: string[]; credits?: number } = {}) {
  const st = outpost(sim, co, sysId, opts.size ?? 'M', ['power', 'power', 'warehouse']);
  const perGate = opts.perGate ?? ['cruiser', 'destroyer'];
  let atStation = opts.atStation;
  if (!atStation) {
    const gates = sim.st.systems[sysId].gates.length * perGate.reduce((a, c) => a + rateClass(c), 0);
    const n = Math.max(2, Math.ceil((powerNeed(sim, co, sysId) * 1.3 - gates) / rateClass('cruiser')));
    atStation = Array(n).fill('cruiser');
  }
  const gs = garrison(sim, co, sysId, st, perGate, atStation);
  sim.st.companies[co].credits += opts.credits ?? 2_000_000;
  return { st, gs };
}
export const addMods = (st: Station, kinds: string[]) => { for (const kind of kinds) st.modules.push({ kind, progress: 1, built: true, slot: st.modules.length }); };

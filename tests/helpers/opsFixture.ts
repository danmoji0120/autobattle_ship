// Shared fixture for company-operations tests: one player company, two own stations, three pool haulers.
import { expect } from 'vitest';
import { WorldSim } from '../../src/world/sim';
import type { Station } from '../../src/world/types';
import type { Work } from '../../src/world/operations';

export function fixture(seed = 1201, security = 100) {
  const sim = WorldSim.create(seed), p = sim.addPlayer('통합 운영'), co = sim.st.companies[p]; co.credits = 5e6;
  for (const id of Object.keys(sim.st.ships)) delete sim.st.ships[id];
  for (const id of Object.keys(sim.st.groups)) delete sim.st.groups[id];
  for (const l of Object.values(sim.st.lairs)) { l.alive = false; l.respawnAt = 1e10; }
  for (const sys of Object.values(sim.st.systems)) sys.security = Math.max(sys.security, security);
  const a = sim.st.stations.astra; a.storage[p] = {};
  const make = (id: string, dx: number, modules: string[]): Station => ({ ...structuredClone(a), id, name: id, public: false, owner: p, pos: { ...a.pos, x: a.pos.x + dx }, market: null, funds: undefined, fundsMax: undefined, shipStock: undefined, storage: { [p]: {} }, builds: [], orders: [], jobs: [], listings: [], modules: modules.map((kind, slot) => ({ kind, slot, built: true, progress: 1 })) });
  const home = make('ops_home', 650, ['core', 'power', 'power', 'refinery', 'logistics', 'warehouse', 'warehouse', 'yard_s']), b = make('ops_b', -500, ['core', 'warehouse']);
  for (const s of [home, b]) sim.st.stations[s.id] = s;
  const group = sim.newGroup(p, '공용 수송');
  const ships = Array.from({ length: 3 }, () => { const s = sim.spawnShip(p, 'hauler', 'std', group.id, a.pos); (sim as any).dockShip(s, a); return s; });
  expect(sim.command(p, { c: 'poolShips', ships: ships.map(s => s.id), on: true })).toBeNull();
  return { sim, p, co, a, home, b, ships };
}
export const run = (sim: WorldSim, seconds: number) => { for (let t = 0; t < seconds; t += .25) sim.update(.25); };
export const until = (sim: WorldSim, cond: () => boolean, seconds = 2000) => { for (let t = 0; t < seconds && !cond(); t += .25) sim.update(.25); return cond(); };
export const works = (sim: WorldSim, p: string) => Object.values(sim.st.works ?? {}).filter(w => w.owner === p);
export const approvals = (sim: WorldSim, p: string, open = true) => Object.values(sim.st.approvals ?? {}).filter(a => a.owner === p && (!open || a.state === 'open'));
export const goal = (sim: WorldSim, p: string) => works(sim, p).filter(w => !w.parent && !!w.goal).at(-1)!;
export const kids = (sim: WorldSim, w: Work) => Object.values(sim.st.works ?? {}).filter(c => c.parent === w.id);


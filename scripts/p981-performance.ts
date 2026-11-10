// Isolated deterministic workload. Default: scale samples; --long: 8 game hours.
import { writeFileSync, mkdirSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { WorldSim } from '../src/world/sim';
import { dispatchPool } from '../src/world/autonomousLogistics';
import { qty, type Station } from '../src/world/types';
import { publicCap } from '../src/world/storage';

type Case = { companies: number; ships: number; seconds: number; long?: boolean };
function run(test: Case) {
  let sim = WorldSim.create(98101), owners: string[] = [];
  for (let i = 0; i < test.companies; i++) owners.push(sim.addPlayer(`P981 ${i}`));
  for (const id of Object.keys(sim.st.ships)) delete sim.st.ships[id];
  for (const id of Object.keys(sim.st.groups)) delete sim.st.groups[id];
  for (const l of Object.values(sim.st.lairs)) { l.alive = false; l.respawnAt = 1e10; }
  for (const sys of Object.values(sim.st.systems)) sys.security = 100;
  const source = sim.st.stations.astra;
  const owned: string[] = [], allShips: string[] = [], baseline: Record<string, number> = {};
  for (let i = 0; i < owners.length; i++) {
    const p = owners[i], co = sim.st.companies[p]; co.credits = 1e9; source.storage[p].ore = test.long ? 6000 : 1000;
    const make = (suffix: string, dx: number): Station => ({ ...structuredClone(source), id: `perf_${i}_${suffix}`, name: `${i} ${suffix}`, public: false, owner: p, pos: { ...source.pos, x: source.pos.x + dx }, market: null, funds: undefined, fundsMax: undefined, shipStock: undefined, storage: { [p]: {} }, builds: [], orders: [], jobs: [], listings: [], modules: ['core', 'power', 'logistics'].map((kind, slot) => ({ kind, slot, built: true, progress: 1 })) });
    const dest = make('dest', 500), full = make('full', -500); full.public = true; full.owner = 'guild'; full.storage[p].ore = publicCap(co, full);
    sim.st.stations[dest.id] = dest; sim.st.stations[full.id] = full; owned.push(dest.id, full.id);
    const g = sim.newGroup(p, '공용 수송'), n = Math.floor(test.ships / owners.length) + (i < test.ships % owners.length ? 1 : 0);
    const ids: string[] = [];
    for (let k = 0; k < n; k++) { const s = sim.spawnShip(p, 'hauler', 'std', g.id, source.pos); (sim as any).dockShip(s, source); ids.push(s.id); allShips.push(s.id); }
    if (ids.length && sim.command(p, { c: 'poolShips', ships: ids, on: true })) throw Error('pool enrollment failed');
    const jobs = Math.max(2, n * 2);
    for (let k = 0; k < jobs; k++) {
      const err = sim.command(p, { c: 'poolCreate', request: { from: source.id, to: k % 7 === 0 ? full.id : k % 9 === 0 ? 'helios' : dest.id, item: 'ore', kind: 'transfer', amount: 20, priority: k % 4, repeat: k % 4 === 0 } });
      if (err) throw Error(err);
    }
    baseline[p] = source.storage[p].ore + full.storage[p].ore;
  }
  const t0 = performance.now(); dispatchPool(sim); const dispatchMs = performance.now() - t0;
  const first: Record<string, number> = {}, completion: Record<string, number> = {};
  const samples: number[] = []; let idleShipSeconds = 0, emptyTravelShipSeconds = 0, recoveries = 0, blocks = 0, previous: Record<string, string> = {};
  const start = performance.now();
  for (let t = 0; t < test.seconds; t += .25) {
    const before = performance.now(); sim.update(.25); const cost = performance.now() - before;
    if ((t * 4) % 40 === 0) samples.push(cost);
    if ((t * 4) % 4 === 0) {
      for (const j of Object.values(sim.st.logisticsJobs!)) {
        if (j.ship && first[j.id] === undefined) first[j.id] = sim.time - j.created;
        if (j.state === 'complete' && completion[j.id] === undefined) completion[j.id] = sim.time - j.created;
        if (j.code && !previous[j.id]) blocks++; else if (!j.code && previous[j.id]) recoveries++;
        previous[j.id] = j.code ?? '';
      }
      for (const id of allShips) { const s = sim.st.ships[id]; if (!s) continue; if (!s.logisticsJob) idleShipSeconds++; else if ((sim.st.logisticsJobs![s.logisticsJob]?.carried ?? 0) === 0 && (s.warp || Math.hypot(s.vel.x, s.vel.z) > 1)) emptyTravelShipSeconds++; }
    }
    if (Math.abs(t + .25 - test.seconds / 2) < .01) sim = new WorldSim(JSON.parse(sim.serialize()), { migrateContent: false });
    if (test.long && (t + .25) % 3600 === 0) console.log(`long run ${Math.round((t + .25) / 3600)}h / 8h`);
  }
  const elapsedMs = performance.now() - start, jobs = Object.values(sim.st.logisticsJobs!), sorted = samples.sort((a, b) => a - b);
  const conserved: Record<string, number> = {};
  for (const p of owners) {
    const stock = Object.values(sim.st.stations).reduce((n, st) => n + qty(st.storage[p], 'ore'), 0);
    const cargo = Object.values(sim.st.ships).filter(s => s.owner === p).reduce((n, s) => n + qty(s.cargo, 'ore'), 0);
    const reserved = jobs.filter(j => j.owner === p).reduce((n, j) => n + j.reserved, 0);
    conserved[p] = stock + cargo + reserved - baseline[p];
  }
  const result = { ...test, jobs: jobs.length, completedOneOff: jobs.filter(j => !j.repeat && j.state === 'complete').length, oneOff: jobs.filter(j => !j.repeat).length, repeatCycles: jobs.filter(j => j.repeat).reduce((n, j) => n + j.cycles, 0), delivered: jobs.reduce((n, j) => n + j.delivered, 0), meanFirstWaitSeconds: Object.keys(first).length ? Object.values(first).reduce((a, b) => a + b, 0) / Object.keys(first).length : null, assignedJobs: Object.keys(first).length, meanCompletionSeconds: Object.keys(completion).length ? Object.values(completion).reduce((a, b) => a + b, 0) / Object.keys(completion).length : null, idleShipSeconds, emptyTravelShipSeconds, observedBlocks: blocks, observedRecoveries: recoveries, lost: jobs.reduce((n, j) => n + j.lost, 0), withdrawn: jobs.reduce((n, j) => n + j.withdrawn, 0), conservationDelta: conserved, initialDispatchMs: dispatchMs, tickSampleMeanMs: samples.reduce((a, b) => a + b, 0) / samples.length, tickSampleP95Ms: sorted[Math.floor(sorted.length * .95)], tickSampleMaxMs: sorted.at(-1), elapsedMs };
  if (Object.values(conserved).some(n => Math.abs(n) > 1e-6)) throw Error(`resource conservation failed: ${JSON.stringify(result)}`);
  console.log(JSON.stringify(result)); return result;
}
const cases: Case[] = process.argv.includes('--long') ? [{ companies: 1, ships: 3, seconds: 28800, long: true }] : [
  { companies: 1, ships: 1, seconds: 240 }, { companies: 1, ships: 3, seconds: 240 }, { companies: 2, ships: 10, seconds: 240 }, { companies: 4, ships: 50, seconds: 240 }, { companies: 4, ships: 100, seconds: 240 },
];
mkdirSync('artifacts/p981', { recursive: true });
writeFileSync(`artifacts/p981/${process.argv.includes('--long') ? 'long' : 'scale'}.json`, JSON.stringify(cases.map(run), null, 2));

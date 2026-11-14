// P12.5 §15 tick cost with 10 / 50 / 100 haulers: the same world and the same repeating shipments, run once
// with the legacy registered pool (P12 world, poolShips) and once with automatic eligibility (P12.5 world).
//   npx vite-node scripts/logistics/p125-perf.ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { WorldSim } from '../../src/world/sim';

function run(n: number, mode: 'legacy' | 'p125', seconds = 1800) {
  const sim = WorldSim.create(1252, mode === 'p125' ? { logistics: 'p125' } : { ops: 'p12' });
  const p = sim.addPlayer('성능'), a = sim.st.stations.astra;
  a.storage[p] = { ore: 1e6 };
  const own = { ...structuredClone(a), id: 'pf_own', name: 'pf', public: false, owner: p, pos: { ...a.pos, x: a.pos.x + 2200 }, size: 'XL', market: null, funds: undefined, fundsMax: undefined, shipStock: undefined, storage: { [p]: {} },
    modules: ['core', 'power', 'warehouse', 'warehouse', 'warehouse', 'warehouse', 'warehouse', 'warehouse', 'dock', 'dock', 'dock'].map((kind, i) => ({ id: `pf_${kind}_${i}`, kind, progress: 1, built: true, slot: i })) as any, orders: [], jobs: [], builds: [] } as any;
  sim.st.stations[own.id] = own;
  const ships: string[] = [];
  for (let g = 0; g * 5 < n; g++) { const grp = sim.newGroup(p, `수송${g}`); for (let k = 0; k < 5 && ships.length < n; k++) { const s = sim.spawnShip(p, 'hauler', 'std', grp.id, a.pos); (sim as any).dockShip(s, a); ships.push(s.id); } }
  if (mode === 'legacy') { const e = sim.command(p, { c: 'poolShips', ships, on: true }); if (e) throw Error(e); }
  for (let k = 0; k < Math.ceil(n / 2); k++) { const e = sim.command(p, { c: 'poolCreate', request: { from: a.id, to: own.id, item: 'ore', kind: 'transfer', amount: 400, priority: 5, repeat: true } }); if (e) throw Error(e); }
  for (let t = 0; t < 120; t++) sim.update(1); // warm-up
  const dts: number[] = [];
  for (let t = 0; t < seconds; t++) { const t0 = performance.now(); sim.update(1); dts.push(performance.now() - t0); }
  const jobs = Object.values(sim.st.logisticsJobs ?? {});
  const busy = ships.filter(id => sim.st.ships[id]?.logisticsJob).length;
  const mean = dts.reduce((x, y) => x + y, 0) / dts.length, p95 = dts.slice().sort((x, y) => x - y)[Math.floor(dts.length * .95)];
  return { haulers: n, mode, meanMsPerSimSecond: +mean.toFixed(3), p95Ms: +p95.toFixed(3), delivered: Math.round(jobs.reduce((x, j) => x + j.delivered, 0)), busyAtEnd: busy, jobs: jobs.length };
}
const rows = [];
for (const n of [10, 50, 100]) for (const mode of ['legacy', 'p125'] as const) { const r = run(n, mode); rows.push(r); console.log(JSON.stringify(r)); }
mkdirSync('docs/logistics-results', { recursive: true });
writeFileSync('docs/logistics-results/p125-perf.json', JSON.stringify({ note: 'same seed, world, stations and repeating shipments; 1800 sim seconds at dt 1 after 120 s warm-up; other long runs shared the machine', rows }, null, 2));

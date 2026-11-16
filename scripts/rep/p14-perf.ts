// P14.0 cost check. Reputation runs only on events (sale, purchase, battle settled, lair, contract, crime) — nothing is
// added to the per-tick update. This measures (1) the cost of one call of each event handler on a P10 world with a full
// key list and log, and (2) the plain world tick (sim.update(1)) of the same P10 world with repV on and off.
//   npx vite-node scripts/rep/p14-perf.ts [out.json]
import { writeFileSync } from 'node:fs';
import { WorldSim } from '../../src/world/sim';
import { repTrade, repBattle, repLair, repContract, repOffense, REP } from '../../src/world/reputation';

const res: Record<string, unknown> = {};
const sim = WorldSim.create(14, { layout: 'p10', rep: 'p14' });
const w = sim.st; const a = sim.addPlayer('perf');
const st = w.stations.p10_bulwark_yard, sys = Object.values(w.systems).find(s => s.faction === 'iron')!;
const time = (n: number, f: (i: number) => void) => { const t = process.hrtime.bigint(); for (let i = 0; i < n; i++) f(i); return Number(process.hrtime.bigint() - t) / 1e3 / n; };
// fill the key list and log to their caps first (worst case for the duplicate check)
for (let i = 0; i < REP.keysMax + 10; i++) repBattle(w, a, `warm${i}`, sys, [80], 1);
res.usPerCall = {
  repTrade: time(20000, i => { w.time += 1; repTrade(w, a, st, 'weapon_parts', 5000 + i % 7, i % 2 === 0); }),
  repBattle: time(20000, i => { w.time += 1; repBattle(w, a, `b${i}`, sys, [80, 45], 1); }),
  repLair: time(5000, i => { w.time += 1; repLair(w, a, `l${i}`, sys, 3, 1); }),
  repContract: time(5000, i => { w.time += 1; repContract(w, a, { id: `k${i}`, kind: 'delivery', stationId: st.id, res: 'weapon_parts', reward: 20000 }); }),
  repOffense: time(5000, i => { w.time += 1; repOffense(w, a, 'iron', 'smuggling', 1000, `o${i}`, 'perf'); }),
};
const tick = (rep: boolean) => {
  const s = WorldSim.create(14, { layout: 'p10', ...(rep ? { rep: 'p14' as const } : {}) });
  for (let i = 0; i < 60; i++) s.update(1);
  const t = process.hrtime.bigint(); for (let i = 0; i < 600; i++) s.update(1);
  return Number(process.hrtime.bigint() - t) / 1e6 / 600;
};
const ticks: Record<string, number[]> = { legacy: [], p14: [] };
for (let r = 0; r < 3; r++) { ticks.legacy.push(tick(false)); ticks.p14.push(tick(true)); }
const med = (x: number[]) => [...x].sort((p, q) => p - q)[1];
res.msPerTick = { legacy: ticks.legacy.map(v => +v.toFixed(3)), p14: ticks.p14.map(v => +v.toFixed(3)), medianLegacy: +med(ticks.legacy).toFixed(3), medianP14: +med(ticks.p14).toFixed(3) };
res.state = { keys: w.companies[a].repx?.keys.length, log: w.companies[a].repx?.log.length, cases: Object.keys(w.companies[a].repx?.cases ?? {}).length };
writeFileSync(process.argv[2] ?? 'p14-perf.json', JSON.stringify(res, null, 1));
console.log(JSON.stringify(res));
process.exit(0);

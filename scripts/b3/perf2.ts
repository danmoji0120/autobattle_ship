// B-3 performance: the same world with and without the territory engine, alternated (ON/OFF × 3) so a slow machine
// moment does not land on one side; per 1-s tick timings give the median, p99 and worst tick (tick stability).
//   npx tsx scripts/b3/perf2.ts [seconds=900] [rounds=3]
import { world, outpost, warships, patrol, run } from '../../tests/helpers/territory';
const SEC = +(process.argv[2] ?? 900), ROUNDS = +(process.argv[3] ?? 3);
const q = (a: number[], p: number) => a[Math.min(a.length - 1, Math.floor(a.length * p))];
const out: Record<string, { total: number[]; p50: number[]; p99: number[]; max: number[] }> = { on: { total: [], p50: [], p99: [], max: [] }, off: { total: [], p50: [], p99: [], max: [] } };
for (let r = 0; r < ROUNDS; r++) for (const sov of r % 2 ? [false, true] : [true, false]) {
  const sim = world();
  if (!sov) delete (sim.st as any).sovV;
  const A = sim.addPlayer('개척사'); run(sim, 600);
  const st = outpost(sim, A, 'gloam', 'M', ['power', 'power', 'warehouse']);
  const g = warships(sim, A, st.pos, ['cruiser', 'cruiser', 'cruiser', 'destroyer', 'destroyer', 'destroyer', 'destroyer']);
  patrol(sim, A, g, 'gloam', st);
  const ticks: number[] = []; const t0 = performance.now();
  for (let s = 0; s < SEC; s++) { const a = performance.now(); sim.update(1); ticks.push(performance.now() - a); }
  const total = performance.now() - t0; ticks.sort((x, y) => x - y);
  const o = out[sov ? 'on' : 'off']; o.total.push(total); o.p50.push(q(ticks, .5)); o.p99.push(q(ticks, .99)); o.max.push(ticks.at(-1)!);
  console.log(`round ${r} territory ${sov ? 'ON ' : 'OFF'} total ${total.toFixed(0)} ms · tick p50 ${q(ticks, .5).toFixed(2)} p99 ${q(ticks, .99).toFixed(2)} max ${ticks.at(-1)!.toFixed(1)} ms`);
}
const med = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const s = (k: 'on' | 'off') => ({ total: med(out[k].total), p50: med(out[k].p50), p99: med(out[k].p99), max: Math.max(...out[k].max) });
const on = s('on'), off = s('off');
console.log(JSON.stringify({ on, off, overhead: +((on.total / off.total - 1) * 100).toFixed(1) }));

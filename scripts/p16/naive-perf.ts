// P16.0 analysis probe: what would "every fighter is an ordinary Ship" cost? Corvettes (gun loadout: 4 autocannons + 1 PD) stand in
// for fighters next to a small capital core. ms per 30 Hz step over 40 s of battle.
//   npx vite-node scripts/p16/naive-perf.ts   (results: docs/p16/naive-perf.txt)
import { World, BATTLE_RULES } from '../../src/sim/world';
import { lineFleet } from '../../src/sim/bbex/trials';
import '../../src/content/registry';
const q = (a: number[], p: number) => a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))];
for (const n of [0, 100, 200, 400]) {
  const side = (name: string, team: 0 | 1) => lineFleet(name, [['battleship', 'std', 4], ['destroyer', 'aa', 8], ...(n ? [['corvette', 'gun', n / 2] as [string, string, number]] : [])], 10, team);
  const w = new World({ seed: 5, scenarioId: 'kestrel', fleets: [side('A', 0), side('B', 1)], rules: BATTLE_RULES });
  const dts: number[] = [];
  let mun = 0;
  for (let i = 0; i < 1200 && !w.outcome; i++) { const t0 = performance.now(); w.step(); dts.push(performance.now() - t0); mun = Math.max(mun, w.munitions.length); }
  const mean = dts.reduce((a, b) => a + b, 0) / dts.length;
  console.log(JSON.stringify({ smallCraft: n, ships: w.ships.length, steps: dts.length, meanMs: +mean.toFixed(2), p95Ms: +q(dts, .95).toFixed(2), maxMs: +Math.max(...dts).toFixed(1), budget30Hz: +(mean / 33.3 * 100).toFixed(0) + '%', peakMunitions: mun }));
}

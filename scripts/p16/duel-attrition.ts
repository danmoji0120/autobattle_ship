// P16.5: per-side squadron losses (f fighter, b bomber, i interceptor) every 60 s in the mirrored carrier duel, seeds 1–6.
//   npx vite-node scripts/p16/duel-attrition.ts
import '../../src/content/registry';
process.env.AIR_STRIKE_LIB = '1';
const { AIR_SCEN } = await import('./air-strike');
import { World } from '../../src/sim/world';
for (const seed of [1, 2, 3, 4, 5, 6]) {
  const w = new World(AIR_SCEN.duel(seed));
  const out: string[] = [];
  while (w.time < 180) { w.step(); if (w.tick % 1800 === 0) { const L = [0, 1].map(t => w.craft!.squads.filter(q => q.team === t).map(q => q.cs.role[0] + q.stats.lost).join(' ')); out.push(`${Math.round(w.time)}s ${L.join(' | ')}`); } }
  console.log(seed, out.join('  ;  '));
}

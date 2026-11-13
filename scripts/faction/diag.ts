// Diagnose one faction hour by hour in a natural-war v2 world: budget, sector runs, input stock vs target, buys.
//   npx vite-node scripts/faction/diag.ts -- <faction> <hours> <seed>
import { WorldSim } from '../../src/world/sim';
import { rates, PROFILES2 } from '../../src/world/factionEcon2';
import { RECIPES, ITEMS } from '../../src/world/industry';
import { qty } from '../../src/world/types';
const a = process.argv.slice(2).filter(x => x !== '--'); const fid = a[0] ?? 'iron', hours = +(a[1] ?? 6), seed = +(a[2] ?? 6);
const sim = WorldSim.create(seed, { layout: 'p10', factionEcon: 'v2' });
let prev = JSON.parse(JSON.stringify(sim.st.factions![fid].econ!.led));
for (let h = 1; h <= hours; h++) {
  for (let t = 0; t < 3600; t++) sim.tick(1);
  const f = sim.st.factions![fid], e = f.econ!, L = e.led, R = rates(sim.st, f);
  const d = (k: string, c: string) => Math.round((L as any)[c][k] ?? 0) - Math.round(prev[c][k] ?? 0);
  const inputs = new Set<string>(); for (const r of Object.keys(PROFILES2[fid].sectors)) for (const i of Object.keys(RECIPES[r].in)) inputs.add(i);
  console.log(`h${h} s${f.strength.toFixed(1)} rdy${e.rdy.toFixed(2)} eff${e.eff.toFixed(2)} budget ${Math.round(e.budget)} spent/h ${Math.round(L.spent - prev.spent)} income/h ${Math.round(L.income - prev.income)} exp/h ${Math.round(L.exportRev - prev.exportRev)} war ${R.war}`);
  for (const k of [...inputs, ...Object.keys(PROFILES2[fid].sectors).map(r => Object.keys(RECIPES[r].out)[0])])
    console.log(`   ${k.padEnd(13)} stock ${Math.round(qty(f.stock, k)).toString().padStart(6)} tgt ${Math.round(R.target[k] ?? 0).toString().padStart(6)} made ${d(k, 'made')} in ${d(k, 'inputs')} bought ${d(k, 'bought')} used ${d(k, 'used')} short ${d(k, 'short')} price ${ITEMS[k]?.price}`);
  const sp: Record<string, number> = {}; for (const [k, n] of Object.entries(L.bought)) sp[k] = Math.round((n! - (prev.bought[k] ?? 0)) * (ITEMS[k]?.price ?? 50));
  console.log('   buy value by good:', Object.entries(sp).filter(x => x[1] > 0).sort((x, y) => y[1] - x[1]).slice(0, 8).map(x => x.join(':')).join(' '));
  prev = JSON.parse(JSON.stringify(L));
}

// Point-in-time market supply and direct construction bills in a fresh isolated growth world.
import { writeFileSync } from 'node:fs';
import { WorldSim } from '../src/world/sim';
import { FACILITIES, ITEMS, TECHS } from '../src/world/industry';
import { STATION_SIZES } from '../src/world/stations';
import type { Cargo } from '../src/world/types';

const sim = WorldSim.create(963), player = sim.addPlayer('경제 분석');
const add = (a: Cargo, b: Cargo) => { for (const [k, n] of Object.entries(b)) a[k] = (a[k] ?? 0) + n; };
function stage(size: 'S' | 'M' | 'L' | 'XL', facilities: string[], research: string[] = []) {
  const materials: Cargo = {}; add(materials, STATION_SIZES[size].mats);
  let credits = STATION_SIZES[size].credits;
  for (const f of facilities) { credits += FACILITIES[f].credits; add(materials, FACILITIES[f].mats); }
  for (const t of research) { credits += TECHS[t].credits; add(materials, TECHS[t].cost); }
  return { size, facilities, research, credits, materials, materialsAtBasePrices: Object.entries(materials).reduce((n, [id, q]) => n + q * (ITEMS[id]?.price ?? 0), 0) };
}
const stages = {
  S: stage('S', ['warehouse', 'refinery']),
  M: stage('M', ['lab_basic', 'lab_materials', 'yard_s', 'yard_m'], ['frigate_design', 'medium_hulls']),
  L: stage('L', ['yard_s', 'yard_m', 'yard_l']),
  XL: stage('XL', ['yard_s', 'yard_m', 'yard_l', 'yard_xl']),
};
const items = Object.keys(stages.XL.materials);
const freshMarketStock = Object.fromEntries(items.map(item => [item, Object.values(sim.st.stations).filter(s => s.public && s.market?.[item]).reduce((n, s) => n + s.market![item].stock, 0)]));
const result = { seed: 963, startingCredits: sim.st.companies[player].credits, stages, freshMarketStock,
  marketCaveat: 'A single fresh-world stock snapshot, not restock, reachable supply, transaction price or a completion guarantee.' };
writeFileSync('artifacts/p963/economy.json', JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));

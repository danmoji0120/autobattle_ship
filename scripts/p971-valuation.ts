// Reproducible reference-value and executable NPC quote comparison, without trade or seeded stock.
import { mkdirSync, writeFileSync } from 'node:fs';
import { WorldSim } from '../src/world/sim';
import { ITEMS, itemPrice, recipeFor } from '../src/world/industry';
import { REGIONAL_FIELDS, REGIONAL_RECIPE_INPUTS, regionalHullMaterials } from '../src/world/regional';
import { buildNeeds } from '../src/world/production';
import { hullBuild } from '../src/world/hullops';
import { materialReferenceCost, regionalReferenceValue, valueOf, yardFee } from '../src/world/valuation';
const sim = WorldSim.create(97131);
const recipes = ['dense_alloy', 'resonant_optics', 'stabilized_isotope', 'singular_alloy', ...Object.keys(REGIONAL_RECIPE_INPUTS)].map(id => {
  const r = recipeFor(sim.st, id)!;
  return { id, inputs: r.in, outputs: r.out, inputReferenceValue: materialReferenceCost(sim.st, r.in), oldOutputReference: valueOf(id), regionalOutputReference: regionalReferenceValue(sim.st, id) };
});
const hull = 'dreadnought_mk1';
const builds = ['dreadnought_std', 'dreadnought_lance'].map(preset => {
  const b = hullBuild(hull), need = buildNeeds('dreadnought', 'std', [], { hull, preset, regionalMaterials: regionalHullMaterials(sim.st, hull) });
  const materials = materialReferenceCost(sim.st, need);
  return { preset, need, materials, credits: b.credits, yardFee: yardFee(b), estimatedTotal: materials + b.credits + yardFee(b) };
});
const quoteIds = [...REGIONAL_FIELDS.map(f => f.res), 'dense_alloy', 'resonant_optics', 'stabilized_isotope', 'singular_alloy', ...Object.keys(REGIONAL_RECIPE_INPUTS)];
const quotes = quoteIds.map(id => ({ id, itemBase: itemPrice(id), reference: regionalReferenceValue(sim.st, id),
  npcMarkets: Object.values(sim.st.stations).filter(s => s.market?.[id]).map(s => ({ station: s.id, stock: s.market![id].stock, funds: s.funds, sell: sim.price(s, id, 'sell'), buy: sim.price(s, id, 'buy') })) }));
const out = { assumptions: 'Materials are valued at reference figures, not actual procurement transactions. Equipment/hull sell price is set by players; NPC quotes only exist where actual market entries exist and buying budgets are finite.', recipes, builds, quotes,
  raw: REGIONAL_FIELDS.map(f => ({ id: f.res, reference: valueOf(f.res), base: ITEMS[f.res].price })) };
mkdirSync('artifacts/p971', { recursive: true });
writeFileSync('artifacts/p971/valuation.json', JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify(out, null, 2));

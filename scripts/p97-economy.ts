// Isolated, deterministic design metrics; does not connect to any server or database.
import { mkdirSync, writeFileSync } from 'node:fs';
import { WorldSim, START_CREDITS_GROWTH } from '../src/world/sim';
import { ITEMS, RECIPES, recipeFor } from '../src/world/industry';
import { REGIONAL_FIELDS, REGIONAL_RECIPE_INPUTS, regionalHullMaterials } from '../src/world/regional';
import { regionalReferenceValue, valueOf } from '../src/world/valuation';
import { jumps } from '../src/world/geom';
import { econOf } from '../src/world/hullops';

const sim = WorldSim.create(9700), p = sim.addPlayer('격리 경제 계측');
const sums = (a: Record<string, number>) => Object.entries(a).reduce((total, [id, n]) => total + valueOf(id) * n, 0);
const outputs = ['dense_alloy', 'resonant_optics', 'stabilized_isotope', 'singular_alloy'].map(id => {
  const r = recipeFor(sim.st, id)!;
  return { recipe: id, input: r.in, output: r.out, seconds: r.time, inputReference: sums(r.in), outputReference: sums(r.out) };
});
const advanced = Object.keys(REGIONAL_RECIPE_INPUTS).map(id => ({ recipe: id, input: recipeFor(sim.st, id)!.in,
  inputReference: sums(recipeFor(sim.st, id)!.in), legacyOutputReference: sums(RECIPES[id].out), listingReference: regionalReferenceValue(sim.st, id) }));
const fields = REGIONAL_FIELDS.map(f => ({ id: f.id, system: f.sys, resource: f.res, initialRare: f.amount * f.mix[f.res], rarePerDayAtFullUse: f.regen * f.mix[f.res] * 86400,
  security: sim.st.systems[f.sys].security, jumpsToAstra: jumps(sim.st.systems, f.sys, 'astra'), rawReferenceValue: ITEMS[f.res].price }));
const perDay = (id: string) => fields.find(f => f.resource === id)!.rarePerDayAtFullUse;
const densePerDay = perDay('dense_titanium_ore') / 40 * 12;
const singularPerDay = perDay('singular_ore') / 40 * 10;
const dreadPerDay = Math.min(densePerDay / 52, singularPerDay / 40); // includes 32 dense alloy for 40 singular alloy
const result = { starter: { credits: sim.st.companies[p].credits, expectedCredits: START_CREDITS_GROWTH,
  fleet: Object.values(sim.st.ships).filter(s => s.owner === p).map(s => s.classId), basicMinerCapacity: econOf({ classId: 'miner' }).cargo },
  fields, outputs, advanced, dreadMaterials: regionalHullMaterials(sim.st, 'dreadnought_mk1'), sustainedDreadnoughtsPerDayUpperBound: dreadPerDay,
  assumptions: 'Reference values are production valuation, not executable NPC bids; regional goods have no seeded NPC market. Throughput assumes every regenerated unit is immediately harvested and inputs, facilities, hauling and safety are free; concurrent equipment competes for the same supply.' };
mkdirSync('artifacts/p97', { recursive: true });
writeFileSync('artifacts/p97/economy.json', JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));

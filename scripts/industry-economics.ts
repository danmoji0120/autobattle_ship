// Industry economics (static, read-only analysis; prices are changed only in memory by a proposal).
// Per recipe: market-bought inputs at ask, output at the long-run bid, hauling, station upkeep share,
// capital, payback, and how many lines the NPC demand and buying budget can actually carry. Then the
// mining group and the fleet a business's profit can sustain. Model rules: scripts/econ/model.ts.
//   npx vite-node scripts/industry-economics.ts -- [proposal=base] [origin=fresh|migrated] [seed=5] [json-out]
import fs from 'node:fs';
import { RECIPES } from '../src/world/industry';
import { makeWorld, type Origin } from './econ/world';
import { proposal } from './econ/proposals';
import { lineEcon, marketsOf, miningEcon, fleetCostH, SMALL_FLEET, MID_FLEET, haulPerUnit } from './econ/model';

const args = process.argv.slice(2).filter(a => a !== '--');
const propId = args[0] ?? 'base', origin = (args[1] ?? 'fresh') as Origin, seed = Number(args[2] ?? 5), out = args[3];
const sim = makeWorld(seed, origin, proposal(propId));
const W = sim.st, M = marketsOf(W);
const lines = Object.keys(RECIPES).map(id => lineEcon(W, id, M)).filter((x): x is NonNullable<typeof x> => !!x && x.outBid > 0);
const mining = miningEcon(W, M);
const fleets = { small: Math.round(fleetCostH(W, SMALL_FLEET, M)), mid: Math.round(fleetCostH(W, MID_FLEET, M)) };
const r0 = (n: number) => Math.round(n), r1 = (n: number) => Math.round(n * 10) / 10;
if (out) fs.writeFileSync(out, JSON.stringify({ proposal: propId, origin, seed, lines, mining, fleets, haulPerUnit: haulPerUnit(), budgetH: M.totalBudgetH }));
console.log(`# ${propId} · ${origin} · seed ${seed} — NPC budget regen ${r0(M.totalBudgetH).toLocaleString()} cr/h · hauling ${r1(haulPerUnit())} cr/unit · small fleet ${fleets.small} cr/h · mid fleet ${fleets.mid} cr/h`);
console.log(['recipe', 'stage', 'in(ask)', 'out(bid)', 'ratio', 'profit/h', 'own-input profit/h', 'capex', 'payback h', 'out/h', 'NPC demand/h', 'lines(demand)', 'lines(budget)'].join('\t'));
for (const l of lines.sort((a, b) => a.stage.localeCompare(b.stage) || b.profitH - a.profitH))
  console.log([l.recipe, l.stage, r0(l.inCost), r0(l.outBid), l.ratio.toFixed(2), r0(l.profitH), r0(l.ownProfitH), r0(l.capex), l.paybackH ? r1(l.paybackH) : '—', r1(l.outPerH), r0(l.demandH), r1(l.lines), r1(l.budgetLines)].join('\t'));
console.log(`mining group (4 miners + hauler), median of ${mining.fields} ore fields @${mining.field}: mined ${mining.minedH}/h ${JSON.stringify(mining.per)} → revenue ${mining.revenueH}/h − upkeep ${mining.upkeepH}/h = ${mining.profitH}/h (best @${mining.best.field}: ${mining.best.profitH}/h)`);

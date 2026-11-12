// Industry economics probe (read-only analysis, changes no prices).
// Builds a fresh world, lets the NPC economy settle, then for every base recipe asks: does a player
// production line make money once real market depth, NPC demand, facility capital, station upkeep
// and hauling are counted?
//   npx vite-node scripts/industry-economics.ts -- [seed=5] [settleHours=2]
import { WorldSim } from '../src/world/sim';
import { RECIPES, FACILITIES, ITEMS, recipeFor } from '../src/world/industry';
import { priceOf, absorbRate, FUNDS_REGEN_H } from '../src/world/market';
import { PROFILES } from '../src/world/economy';
import { facilityBuild } from '../src/world/industry';
import { STATION_SIZES } from '../src/world/stations';
import { hullUpkeep } from '../src/world/hullops';
import { ECON } from '../src/world/data';
import type { Station } from '../src/world/types';

const args = process.argv.slice(2).filter(a => a !== '--');
const seed = Number(args[0] ?? 5), settle = Number(args[1] ?? 2);
const sim = WorldSim.create(seed);
for (let t = 0; t < settle * 3600; t += 1) sim.update(1);
const W = sim.st;
const markets = Object.values(W.stations).filter(s => s.public && s.market) as Station[];

type Entry = { st: Station; m: NonNullable<Station['market']>[string] };
const entries = (k: string): Entry[] => markets.filter(s => s.market![k]).map(st => ({ st, m: st.market![k] }));
const buyP = (e: Entry) => priceOf(e.m, 'buy', true), sellP = (e: Entry) => priceOf(e.m, 'sell', true) * (1 - (e.st.tax ?? 0));
const bestBuy = (k: string) => entries(k).filter(e => e.m.stock >= 1).sort((a, b) => buyP(a) - buyP(b))[0];
const bestSell = (k: string) => entries(k).sort((a, b) => sellP(b) - sellP(a))[0];
/** average price per unit as the game fills it: a purchase is one flat price for the whole amount
 *  (limited by stock), a sale walks the price down in 50-unit chunks and pays the station tax */
function walk(e: Entry, n: number, side: 'buy' | 'sell'): { avg: number; filled: number } {
  if (side === 'buy') { const a = Math.min(n, Math.floor(e.m.stock)); return { avg: buyP(e), filled: a }; }
  const m = { ...e.m }; let cr = 0, done = 0;
  while (done < n) { const q = Math.min(50, n - done); cr += priceOf(m, 'sell', true) * q; m.stock += q; done += q; }
  return { avg: done ? cr * (1 - (e.st.tax ?? 0)) / done : 0, filled: done };
}
/** units/hour the NPC economy keeps absorbing once markets sit at their target (the long-run demand) */
const demandH = (k: string) => entries(k).reduce((n, e) => n + absorbRate(e.st, k, e.m.target) * 3600, 0);
/** units/hour NPC producers restock (supply available to buyers at half target) */
const supplyH = (k: string) => entries(k).reduce((n, e) => n + (PROFILES[e.st.id]?.make.includes(k) ? Math.max(0.0004 * e.m.target, 0.002) * 3600 : 0.0032 * e.m.target * 0.5 * 3600), 0);
const fundsH = markets.reduce((n, s) => n + (s.fundsMax ?? 0) * FUNDS_REGEN_H, 0);

// unit values: cheapest of market purchase or own production (one level deep is enough for base chains)
const mkt = (k: string) => { const e = bestBuy(k); return e ? buyP(e) : Infinity; };
const own: Record<string, number> = {};
function unitCost(k: string, depth = 0): number {
  if (own[k] !== undefined) return own[k];
  let best = mkt(k);
  if (depth < 4) for (const r of Object.values(RECIPES)) if (r.out[k] && !r.regional) {
    const c = Object.entries(r.in).reduce((a, [i, n]) => a + unitCost(i, depth + 1) * n, 0) / r.out[k];
    if (c < best) best = c;
  }
  if (depth === 0) own[k] = best;
  return best;
}

// fixed costs
const S = STATION_SIZES.S, hauler = hullUpkeep('hauler'), hCargo = ECON.hauler.cargo;
const chem = mkt('chemicals');
const haulerH = hauler.credits * 1.1 + (hauler.supplies?.chemicals ?? 0) * chem; // with the 10% overhead
/** hauling cost per unit for a trip of `min` minutes (round trip, full load one way) */
const haul = (min: number) => haulerH * (min / 60) / hCargo;

const rows: string[][] = [];
const head = ['recipe', 'fac', 'time', 'in(mkt)', 'in(own)', 'out(best sell)', 'margin/batch mkt', 'margin/h mkt', 'margin/h own', 'line out/h', 'NPC demand/h', 'lines market carries', 'sell 1h avg', 'capex', 'payback h (mkt)', 'haul 20m/batch', 'lines NPC budget carries'];
for (const r0 of Object.values(RECIPES)) {
  if (r0.regional || ITEMS[Object.keys(r0.out)[0]]?.cat === undefined) continue;
  const r = recipeFor(W, r0.id) ?? r0; const [out, n] = Object.entries(r.out)[0];
  const inMkt = Object.entries(r.in).reduce((a, [k, q]) => a + mkt(k) * q, 0);
  const inOwn = Object.entries(r.in).reduce((a, [k, q]) => a + unitCost(k) * q, 0);
  const bs = bestSell(out); if (!bs) { rows.push([r.id, r.fac, String(r.time), inMkt.toFixed(0), inOwn.toFixed(0), '— 시장 없음', '', '', '', '', '', '', '', '', '', '']); continue; }
  const outV = sellP(bs) * n, perH = 3600 / r.time;
  const lineH = n * perH, dem = demandH(out);
  const sold = walk(bs, lineH, 'sell');
  const fac = FACILITIES[r.fac], fb = facilityBuild(fac, true);
  const capex = fb.credits + Object.entries(fb.mats).reduce((a, [k, q]) => a + (isFinite(mkt(k)) ? mkt(k) : unitCost(k)) * q, 0);
  const upkeepShare = S.upkeep / 4; // an S station hosting ~4 production facilities
  const mH = (sold.avg * n - inMkt) * perH - upkeepShare;
  rows.push([r.id + (r.tech ? `*` : ''), r.fac, String(r.time), inMkt.toFixed(0), inOwn.toFixed(0), `${outV.toFixed(0)} @${bs.st.id}`, (outV - inMkt).toFixed(0), mH.toFixed(0), ((sold.avg * n - inOwn) * perH - upkeepShare).toFixed(0), lineH.toFixed(1), dem.toFixed(1), dem > 0 ? (dem / lineH).toFixed(2) : '0', (sold.avg / sellP(bs) * 100).toFixed(0) + '%', capex.toFixed(0), mH > 0 ? (capex / mH).toFixed(1) : '회수 불가', (haul(20) * Object.values(r.in).reduce((a, b) => a + b, 0)).toFixed(1), (entries(out).reduce((a, e) => a + (e.st.fundsMax ?? 0) * FUNDS_REGEN_H, 0) / (sold.avg * lineH)).toFixed(1)]);
}
console.log(`# industry economics — seed ${seed}, after ${settle} h of NPC economy; ${markets.length} public markets; NPC buying budget regen ${Math.round(fundsH).toLocaleString()} cr/h`);
console.log(`# fixed: station S upkeep ${S.upkeep} cr/h (¼ charged per facility), hauler ${haulerH.toFixed(0)} cr/h for ${hCargo} cargo → ${haul(20).toFixed(2)} cr/unit per 20-min trip`);
console.log(head.join('\t')); for (const r of rows) console.log(r.join('\t'));
console.log('\n# items: best buy / best sell / NPC demand/h / NPC supply/h / markets');
for (const k of Object.keys(ITEMS)) { const b = bestBuy(k), s = bestSell(k); if (!b && !s) continue; console.log([k, b ? `${buyP(b)}@${b.st.id}` : '-', s ? `${sellP(s)}@${s.st.id}` : '-', demandH(k).toFixed(1), supplyH(k).toFixed(0), entries(k).length].join('\t')); }

// cross-check: the price walk above against real commands (one player buys ore and sells metal)
const p = sim.addPlayer('검증'); const co = W.companies[p]; co.credits = 1e7;
for (const [k, side, n] of [['ore', 'buy', 2400], ['metal', 'sell', 1200], ['alloy', 'sell', 880]] as const) {
  const e = side === 'buy' ? bestBuy(k)! : bestSell(k)!; const pred = walk(e, n, side);
  if (side === 'sell') { e.st.storage[p] = { ...(e.st.storage[p] ?? {}), [k]: n }; }
  const before = co.credits; const err = sim.command(p, { c: side, station: e.st.id, res: k, amount: n });
  console.log(`check ${side} ${n} ${k} @${e.st.id}: predicted avg ${pred.avg.toFixed(2)} → actual ${err ?? (Math.abs(co.credits - before) / n).toFixed(2)}`);
}

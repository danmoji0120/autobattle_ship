// Long-run industry business simulation in the real WorldSim (analysis only, nothing is saved).
// One specialist company runs unattended on game automation (mining operation, company-ops stockpile
// goals that buy and haul inputs, standing production orders, haul groups to a market and price-floor
// sell goals). Profit is what the company's credits really did; goods that the NPC markets do not buy
// stay in storage and are never counted as income.
//   npx vite-node scripts/econ/companies.ts -- <spec> <proposal=base> <origin=fresh|migrated|p10> <hours=24> <seed=5> [out.json] [copies=1]
// copies > 1: that many identical companies compete for the same inputs and markets (competition run);
// the main result is company 1, `competitors` lists every company's outcome.
import fs from 'node:fs';
import { WorldSim } from '../../src/world/sim';
import { FACILITIES, ITEMS, RECIPES, facilityBuild, recipeFor } from '../../src/world/industry';
import { STATION_SIZES } from '../../src/world/stations';
import { hullSale } from '../../src/world/hullops';
import { priceOf, absorbRate } from '../../src/world/market';
import { valueOf } from '../../src/world/valuation';
import { sysAt, jumps } from '../../src/world/geom';
import { observeWorld, type Observation } from '../../src/world/observe';
import { qty, type Station } from '../../src/world/types';
import type { Size } from '../../src/content/schema';
import { makeWorld, type Origin } from './world';
import { proposal } from './proposals';

export interface Spec {
  name: string; size?: Size; modules: string[];
  /** mining group: miners + one hauler; deliver to own station (vertical) or sell at market */
  miners?: number; minerTo?: 'own' | 'sell'; minerGroups?: number;
  /** pool haulers for buying inputs */
  pool?: number;
  orders?: { recipe: string; n: number }[];
  inputs?: { item: string; target: number }[];
  outputs?: string[];
  /** haulers per output route */
  outHaulers?: number;
  /** sell each output at the best N markets (one haul route + sell floor each) */
  markets?: number;
}
export const SPECS: Record<string, Spec> = {
  mine: { name: '채굴 전문', modules: [], miners: 4, minerTo: 'sell', minerGroups: 1 },
  mine2: { name: '채굴 전문 ×2', modules: [], miners: 4, minerTo: 'sell', minerGroups: 2 },
  refine: { name: '1차 가공 (광석 구매 → 금속)', size: 'S', modules: ['core', 'power', 'refinery', 'refinery', 'warehouse'], pool: 2, orders: [{ recipe: 'metal', n: 800 }], inputs: [{ item: 'ore', target: 2400 }], outputs: ['metal'] },
  refine2: { name: '1차 가공 (광석 구매 → 금속, 2개 시장 분산 판매)', size: 'S', modules: ['core', 'power', 'refinery', 'refinery', 'warehouse'], pool: 2, orders: [{ recipe: 'metal', n: 800 }], inputs: [{ item: 'ore', target: 2400 }], outputs: ['metal'], markets: 2 },
  inter: { name: '중간재 (금속·티타늄 구매 → 합금)', size: 'S', modules: ['core', 'power', 'alloy_plant', 'alloy_plant', 'warehouse'], pool: 2, orders: [{ recipe: 'alloy', n: 800 }], inputs: [{ item: 'metal', target: 600 }, { item: 'titanium', target: 200 }], outputs: ['alloy'] },
  parts: { name: '고급 부품 (시장 구매 → 기계·전자·장갑판)', size: 'M', modules: ['core', 'power', 'power', 'machine_shop', 'electronics_fab', 'armor_plant', 'warehouse'], pool: 3,
    orders: [{ recipe: 'machinery', n: 120 }, { recipe: 'electronics', n: 60 }, { recipe: 'armor_plate', n: 60 }],
    inputs: [{ item: 'metal', target: 300 }, { item: 'alloy', target: 300 }, { item: 'titanium', target: 120 }, { item: 'silicon', target: 150 }, { item: 'crystal', target: 20 }], outputs: ['machinery', 'electronics', 'armor_plate'] },
  direct: { name: '직접 합금 (광석 구매 → 직접 합금, 정제소만)', size: 'S', modules: ['core', 'power', 'refinery', 'refinery', 'warehouse'], pool: 2, orders: [{ recipe: 'alloy_direct', n: 800 }], inputs: [{ item: 'ore', target: 2400 }], outputs: ['alloy'] },
  equip: { name: '장비 제조 (무장 부품 구매 → 기관포·부포)', size: 'M', modules: ['core', 'power', 'power', 'weapons_factory', 'warehouse'], pool: 2,
    orders: [{ recipe: 'eq_autocannon', n: 12 }, { recipe: 'eq_medium_gun', n: 8 }], inputs: [{ item: 'weapon_parts', target: 40 }, { item: 'metal', target: 120 }, { item: 'alloy', target: 150 }], outputs: ['eq_autocannon', 'eq_medium_gun'] },
  vertical: { name: '수직 계열화 (채굴 → 정련 → 기계부품·구조재)', size: 'M', modules: ['core', 'power', 'power', 'refinery', 'refinery', 'machine_shop', 'hull_works', 'warehouse', 'warehouse'], miners: 4, minerTo: 'own', minerGroups: 1, pool: 2,
    orders: [{ recipe: 'metal', n: 300 }, { recipe: 'alloy_direct', n: 300 }, { recipe: 'machinery', n: 120 }, { recipe: 'structure', n: 200 }],
    inputs: [{ item: 'ore', target: 1500 }], outputs: ['machinery', 'structure'] },
};

const args = process.argv.slice(2).filter(a => a !== '--');
const specId = args[0] ?? 'refine', propId = args[1] ?? 'base', origin = (args[2] ?? 'fresh') as Origin, hours = Number(args[3] ?? 24), seed = Number(args[4] ?? 5), out = args[5], copies = Math.max(1, Math.min(4, Number(args[6] ?? 1)));
const spec = SPECS[specId]; if (!spec) throw new Error(`spec ${specId}? ${Object.keys(SPECS).join(' ')}`);
const prop = proposal(propId);
const sim = makeWorld(seed, origin, prop);
const W = sim.st;
for (let t = 0; t < 3600; t += 1) sim.update(1);             // let NPC markets settle for one hour

// observation: every money and goods event, summed per company · kind · reason · item
const tally: Record<string, { amount: number; value: number }> = {};
observeWorld(W, (e: Observation) => {
  if (!e.company) return;
  const k = `${e.company}|${e.kind}|${e.reason ?? ''}|${e.item ?? ''}`;
  const t = (tally[k] ??= { amount: 0, value: 0 }); t.amount += e.amount ?? 0; t.value += e.value ?? 0;
});

const markets = Object.values(W.stations).filter(s => s.public && s.market) as Station[];
const buyPrice = (k: string) => Math.min(...markets.filter(s => s.market![k] && s.market![k].stock > 1).map(s => priceOf(s.market![k], 'buy', true)), Infinity);
const matValue = (mats: Record<string, number>) => Object.entries(mats).reduce((a, [k, n]) => a + n * (isFinite(buyPrice(k)) ? buyPrice(k) : valueOf(k)), 0);

const START = 500_000;
function setupCompany(ci: number) {
const p = sim.addPlayer(`${spec.name.slice(0, 16)}${ci ? ` ${ci + 1}` : ''}`); const co = W.companies[p];
for (const s of Object.values(W.ships)) if (s.owner === p) { const g = W.groups[s.groupId]; if (g) g.shipIds = g.shipIds.filter(x => x !== s.id); delete W.ships[s.id]; }
for (const g of Object.values(W.groups)) if (g.owner === p) delete W.groups[g.id];
co.credits = START;
const capital: Record<string, number> = {};
const home = W.stations[co.homeStation];
let own: Station | undefined;
if (spec.size) {
  const id = `own_${p}`;
  own = { id, name: '자사 공장', owner: p, public: false, size: spec.size, style: 3, pos: { x: home.pos.x + 1400 + ci * 350, y: 0, z: home.pos.z + 500 - ci * 250 }, radius: 180, market: null,
    services: { repair: false, shipyard: [], recruit: false, contracts: false, refit: false }, storage: {}, defenseHp: 1, founded: W.time, desc: '',
    modules: spec.modules.map((kind, slot) => ({ id: sim.id('pl'), kind, slot, built: true, progress: 1 })) } as Station;
  for (const c of Object.keys(W.companies)) own.storage[c] = {};
  W.stations[id] = own;
  const sz = STATION_SIZES[spec.size]; capital['정거장 ' + spec.size] = sz.credits + matValue(sz.mats);
  for (const m of spec.modules) if (m !== 'core') { const b = facilityBuild(FACILITIES[m], true); capital[m] = (capital[m] ?? 0) + b.credits + matValue(b.mats); }
}
const hullCost = (h: string) => hullSale(h)?.price ?? 0;
const spawn = (hull: string, gid: string) => { const s = sim.spawnHull(p, hull, `${hull}_std`, undefined, gid, home.pos); (sim as any).dockShip(s, home); capital[hull] = (capital[hull] ?? 0) + hullCost(hull); return s; };
expectNull(sim.command(p, { c: 'opsPolicy', policy: { autonomy: 'auto', minCredits: 50_000, hourlyLimit: 400_000 } }), 'policy');

// mining
const fields = Object.values(W.fields).filter(f => !f.salvage && (f.mix?.ore ?? (f.res === 'ore' ? 1 : 0)) > 0.3)
  .sort((a, b) => Math.hypot(a.pos.x - home.pos.x, a.pos.z - home.pos.z) - Math.hypot(b.pos.x - home.pos.x, b.pos.z - home.pos.z));
for (let gi = 0; gi < (spec.minerGroups ?? 0); gi++) {
  const g = sim.newGroup(p, `채굴반 ${gi + 1}`);
  for (let i = 0; i < (spec.miners ?? 0); i++) spawn('miner_mk1', g.id);
  if (spec.minerTo === 'sell') spawn('hauler_mk1', g.id);
  const f = fields[(gi + ci) % fields.length];
  expectNull(sim.command(p, { c: 'setOp', group: g.id, op: spec.minerTo === 'own' ? { k: 'mine', field: f.id, deliver: own!.id, sell: false } : { k: 'mine', field: f.id, deliver: '', sell: true, auto: true } }), 'mine');
}
// input purchasing: pooled haulers + maintained stockpile goals at the own station
if (spec.pool) {
  const g = sim.newGroup(p, '공용 수송'); const ships = Array.from({ length: spec.pool }, () => spawn('hauler_mk1', g.id));
  expectNull(sim.command(p, { c: 'poolShips', ships: ships.map(s => s.id), on: true }), 'pool');
}
for (const i of spec.inputs ?? []) expectNull(sim.command(p, { c: 'workCreate', goal: { k: 'stockpile', station: own!.id, item: i.item, target: i.target, maintain: true, buy: true, produce: false } }), 'input ' + i.item);
for (const o of spec.orders ?? []) expectNull(sim.command(p, { c: 'prodOrder', station: own!.id, recipe: o.recipe, mode: 'stock', n: o.n }), 'order ' + o.recipe);
// outputs: the market a player would pick (sustained NPC demand × price, fewer jumps), a haul group, a sell floor
const ownSys = own ? sysAt(W.systems, own.pos)?.id ?? '' : '';
const sellPlan: Record<string, { market: string; floor: number; absorbH: number; jumps: number }> = {};
for (const item of spec.outputs ?? []) {
  const cands = markets.filter(s => s.market![item]).map(s => {
    const m = s.market![item], j = jumps(W.systems, ownSys, sysAt(W.systems, s.pos)?.id ?? ownSys);
    return { s, j, absorbH: absorbRate(s, item, m.target) * 3600, score: absorbRate(s, item, m.target) * m.base * (1 - (s.tax ?? 0)) / (1 + j) };
  }).sort((a, b) => b.score - a.score);
  const best = cands[0]; if (!best) continue;
  const picks = cands.slice(0, Math.max(1, spec.markets ?? 1));
  sellPlan[item] = { market: picks.map(c => c.s.id).join('+'), floor: Math.round(best.s.market![item].base * 0.5 * 10) / 10, absorbH: Math.round(picks.reduce((a, c) => a + c.absorbH, 0)), jumps: best.j };
  for (const c of picks) {
    const floor = Math.round(c.s.market![item].base * 0.5 * 10) / 10;
    const g = sim.newGroup(p, `판매 수송 ${ITEMS[item]?.name ?? item} → ${c.s.name}`);
    for (let i = 0; i < (spec.outHaulers ?? 1); i++) spawn('hauler_mk1', g.id);
    expectNull(sim.command(p, { c: 'setOp', group: g.id, op: { k: 'haul', from: own!.id, to: c.s.id, res: item } }), 'haul ' + item);
    expectNull(sim.command(p, { c: 'workCreate', goal: { k: 'condition', station: c.s.id, item, side: 'sell', price: floor, amount: 1_000_000, repeat: true } }), 'sell ' + item);
  }
}
const invested = Object.values(capital).reduce((a, b) => a + b, 0);

return { p, co, own, capital, invested, sellPlan };
}
const setups = Array.from({ length: copies }, (_, ci) => setupCompany(ci));
const { p, co, capital, invested, sellPlan } = setups[0];

function expectNull(err: string | null, what: string) { if (err) { console.error(`setup failed (${what}): ${err}`); process.exit(1); } }

// run
const hourly: { h: number; credits: number; stock: Record<string, number> }[] = [];
const held = () => { const r: Record<string, number> = {}; for (const s of Object.values(W.stations)) for (const [k, n] of Object.entries(s.storage[p] ?? {})) if (n > 0.5) r[k] = (r[k] ?? 0) + n; for (const s of Object.values(W.ships)) if (s.owner === p) for (const [k, n] of Object.entries(s.cargo ?? {})) if ((n as number) > 0.5) r[k] = (r[k] ?? 0) + (n as number); return r; };
const t0 = Date.now(); let worst = 0;
for (let h = 1; h <= hours; h++) {
  for (let t = 0; t < 3600; t += 1) { const s = performance.now(); sim.update(1); worst = Math.max(worst, performance.now() - s); }
  hourly.push({ h, credits: Math.round(co.credits), stock: Object.fromEntries(Object.entries(held()).map(([k, n]) => [k, Math.round(n)])) });
}
const mine = Object.entries(tally).filter(([k]) => k.startsWith(p + '|')).map(([k, v]) => { const [, kind, reason, item] = k.split('|'); return { kind, reason, item, amount: Math.round(v.amount * 10) / 10, value: Math.round(v.value) }; });
const sum = (f: (r: typeof mine[number]) => boolean, key: 'amount' | 'value' = 'amount') => mine.filter(f).reduce((a, r) => a + r[key], 0);
const steadyFrom = Math.max(1, Math.min(6, Math.floor(hours / 3)));
const steady = hours > steadyFrom ? (hourly.at(-1)!.credits - hourly[steadyFrom - 1].credits) / (hours - steadyFrom) : NaN;
const products: Record<string, unknown> = {};
for (const item of new Set([...(spec.outputs ?? []), ...(spec.minerTo === 'sell' ? ['ore', 'silicate', 'titanium_ore', 'crystal', 'gas', 'rare_ore'] : [])])) {
  const produced = sum(r => r.kind === 'produce' && r.item === item) + sum(r => (r.kind === 'mine' || r.reason === 'mine') && r.item === item);
  const soldUnits = sum(r => r.kind === 'market' && r.reason === 'sell' && r.item === item), soldValue = sum(r => r.kind === 'market' && r.reason === 'sell' && r.item === item, 'value');
  if (!produced && !soldUnits) continue;
  products[item] = { produced: Math.round(produced), sold: Math.round(soldUnits), avgPrice: soldUnits ? Math.round(soldValue / soldUnits * 10) / 10 : 0, revenue: Math.round(soldValue), unsoldHeld: Math.round(held()[item] ?? 0), plan: sellPlan[item],
    marketEnd: sellPlan[item] ? (() => { const m = W.stations[sellPlan[item].market.split('+')[0]].market![item]; return { base: m.base, price: priceOf(m, 'sell', true), stock: Math.round(m.stock), target: m.target }; })() : undefined };
}
const ledger: Record<string, number> = {};
for (const hb of co.ops?.ledger ?? []) { for (const [k, v] of Object.entries(hb.inc)) ledger['+' + k] = (ledger['+' + k] ?? 0) + v; for (const [k, v] of Object.entries(hb.exp)) ledger['-' + k] = (ledger['-' + k] ?? 0) + v; }
const result = {
  spec: specId, name: spec.name, proposal: propId, origin, hours, seed, ms: Date.now() - t0, worstTickMs: Math.round(worst),
  invested: Math.round(invested), capital: Object.fromEntries(Object.entries(capital).map(([k, v]) => [k, Math.round(v)])),
  start: START, end: Math.round(co.credits), net: Math.round(co.credits - START), netPerH: Math.round((co.credits - START) / hours), steadyPerH: Math.round(steady),
  paybackH: steady > 0 ? Math.round(invested / steady * 10) / 10 : null,
  ledger: Object.fromEntries(Object.entries(ledger).map(([k, v]) => [k, Math.round(v)])), products,
  costs: { fleet: Math.round(sum(r => r.kind === 'cost' && r.reason === 'fleet_upkeep')), station: Math.round(sum(r => r.kind === 'cost' && r.reason === 'station_upkeep')), maintenance: Math.round(sum(r => r.kind === 'cost' && r.reason === 'maintenance')) },
  hourly: hourly.map(x => x.credits), endStock: hourly.at(-1)?.stock,
  recipes: Object.fromEntries((spec.orders ?? []).map(o => { const r = recipeFor(W, o.recipe) ?? RECIPES[o.recipe]; return [o.recipe, { time: r.time, in: r.in, out: r.out }]; })),
  events: mine.filter(r => r.kind !== 'cost'),
  competitors: copies > 1 ? setups.map(x => {
    const ev = Object.entries(tally).filter(([k]) => k.startsWith(x.p + '|') && k.includes('|market|sell|'));
    return { company: x.p, net: Math.round(x.co.credits - START), netPerH: Math.round((x.co.credits - START) / hours), invested: Math.round(x.invested),
      sold: Object.fromEntries(ev.map(([k, v]) => [k.split('|')[3], { units: Math.round(v.amount), value: Math.round(v.value) }])) };
  }) : undefined,
};
const text = JSON.stringify(result);
if (out) fs.writeFileSync(out, text); else console.log(text);

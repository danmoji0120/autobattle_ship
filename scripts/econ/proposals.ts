// Balance proposals, applied in memory only (analysis). `patch` changes static data before the world is
// built; `reprice` sets every public market's base price the way a content migration would (raw goods
// and made goods alike), keeping each station's regional multiplier.
import type { WorldState } from '../../src/world/types';
import { ITEMS, RECIPES, FACILITIES, EQUIPMENT, itemPrice } from '../../src/world/industry';
import { PROFILES } from '../../src/world/economy';
import { valueOf } from '../../src/world/valuation';

export interface Proposal { id: string; name: string; desc: string; patch?: () => void; reprice?: (w: WorldState) => void; value?: (id: string) => number }

const isRaw = (k: string) => ITEMS[k]?.cat === 'raw';

/** set market bases from a value function; regional multiplier kept (PROFILES mult) */
function repriceWith(w: WorldState, value: (k: string) => number) {
  for (const s of Object.values(w.stations)) {
    if (!s.public || !s.market) continue;
    const mult = PROFILES[s.id]?.mult ?? 1;
    for (const [k, e] of Object.entries(s.market)) {
      if (k.startsWith('bp:') || (!ITEMS[k] && !EQUIPMENT[k])) continue;
      const v = value(k); if (!(v > 0)) continue;
      // keep the stock ratio (what the market currently holds relative to its target) unchanged
      e.base = Math.round(v * mult * 10) / 10;
    }
  }
}

/**
 * Value-chain price: a made good is worth its inputs plus a spread allowance S plus a value-added rate
 * per second of line time (per recipe, falling back to the facility), divided by its output. Raw goods:
 * hand-set price × RAW. The item's designated main recipe (else the cheapest non-research one) decides.
 */
export interface ChainOpts { raw: number | Record<string, number>; S: number; va: Record<string, number>; vaDefault: number }
export const MAIN: Record<string, string> = { metal: 'metal', alloy: 'alloy', titanium: 'titanium', silicon: 'silicon', chemicals: 'chemicals', rare_metal: 'rare_metal', composite: 'composite',
  machinery: 'machinery', precision: 'precision', structure: 'structure', electronics: 'electronics', armor_plate: 'armor_plate', weapon_parts: 'weapon_parts', engine: 'engine', reactor: 'reactor', sensor: 'sensor' };
export function chainValue(opts: ChainOpts) {
  const cache = new Map<string, number>();
  const rawMul = (k: string) => typeof opts.raw === 'number' ? opts.raw : opts.raw[k] ?? 0.25;
  const v = (id: string): number => {
    const hit = cache.get(id); if (hit !== undefined) return hit;
    cache.set(id, itemPrice(id));                                   // cycle guard
    let out: number;
    if (isRaw(id)) out = itemPrice(id) * rawMul(id);
    else {
      const rs = MAIN[id] ? [RECIPES[MAIN[id]]] : Object.values(RECIPES).filter(r => (r.out[id] ?? 0) > 0 && !r.regional);
      const plain = rs.filter(r => !r.tech || EQUIPMENT[id]);
      const cost = (r: typeof rs[number]) => (Object.entries(r.in).reduce((a, [k, n]) => a + v(k) * n, 0) * (1 + opts.S) + r.time * (opts.va[r.id] ?? opts.va[r.fac] ?? opts.vaDefault)) / r.out[id];
      const best = (plain.length ? plain : rs).map(cost).sort((a, b) => a - b)[0];
      out = best ?? itemPrice(id);
    }
    out = Math.round(out * 10) / 10; cache.set(id, out); return out;
  };
  return v;
}

/** market-bought line profit/h at the model's equilibrium prices (bid 0.855 v, ask 1.121 v, mult 1) */
export function lineProfit(r: { in: Record<string, number>; out: Record<string, number>; time: number; fac: string }, v: (k: string) => number) {
  const perH = 3600 / r.time, [o, n] = Object.entries(r.out)[0];
  const units = Object.values(r.in).reduce((a, b) => a + b, 0) + n;
  const upkeep = FACILITIES[r.fac]?.minStation === 'M' ? 75 : 25;
  return perH * (0.855 * n * v(o) - 1.121 * Object.entries(r.in).reduce((a, [k, q]) => a + q * v(k), 0)) - units * 0.4 * perH - upkeep;
}

/** solve per-recipe value-added rates so each main recipe earns its target profit/h with bought inputs */
export function solveVA(raw: number, S: number, targets: Record<string, number>) {
  const va: Record<string, number> = {};
  for (const id of Object.keys(targets)) va[id] = 2;
  for (let it = 0; it < 60; it++) {
    const v = chainValue({ raw, S, va, vaDefault: 2.5 });
    let moved = 0;
    for (const [id, T] of Object.entries(targets)) { const d = (T - lineProfit(RECIPES[id], v)) / (0.855 * 3600); va[id] = Math.max(0, va[id] + d); moved = Math.max(moved, Math.abs(d)); }
    if (moved < 1e-4) break;
  }
  return va;
}

/** facility value-added rates (credits per line-second), chosen per tier: see docs/INDUSTRY_ECONOMY_BALANCE.md */
export const VA: Record<string, number> = {
  refinery: 2.3, smelter: 2.3, gas_plant: 2.3, rare_refinery: 6,
  alloy_plant: 2.6, composite_plant: 5.2,
  machine_shop: 3.25, hull_works: 3.25, electronics_fab: 4.5, armor_plant: 4.2,
  weapons_factory: 5.2, engine_plant: 5.9, reactor_plant: 7.1, ammo_plant: 3.5, energy_fab: 4.5,
};

const c4Value = (k: string) => isRaw(k) ? itemPrice(k) * 0.25 : valueOf(k);

const recipeBackup = new Map<string, { in: Record<string, number>; out: Record<string, number>; time: number }>();
function setRecipe(id: string, change: Partial<{ in: Record<string, number>; out: Record<string, number>; time: number }>) {
  const r = RECIPES[id]; if (!recipeBackup.has(id)) recipeBackup.set(id, { in: { ...r.in }, out: { ...r.out }, time: r.time });
  if (change.in) { for (const k of Object.keys(r.in)) delete r.in[k]; Object.assign(r.in, change.in); }
  if (change.out) { for (const k of Object.keys(r.out)) delete r.out[k]; Object.assign(r.out, change.out); }
  if (change.time) r.time = change.time;
}
/** NPC demand for processed goods: scale every public station's local consumption of these goods */
function scaleUse(goods: string[], mul: number) { for (const p of Object.values(PROFILES)) for (const k of goods) if (p.use[k] !== undefined) p.use[k] *= mul; }
function addUse(station: string, use: Record<string, number>) { const p = PROFILES[station]; if (p) for (const [k, n] of Object.entries(use)) p.use[k] = (p.use[k] ?? 0) + n; }
function scaleFacility(kind: string, mul: number) { const f = FACILITIES[kind]; f.credits = Math.round(f.credits * mul); for (const k of Object.keys(f.mats)) f.mats[k] = Math.round(f.mats[k] * mul); }

const PROCESSED = ['metal', 'alloy', 'titanium', 'silicon', 'chemicals', 'composite', 'rare_metal', 'machinery', 'electronics', 'structure', 'precision', 'armor_plate', 'weapon_parts', 'engine', 'reactor', 'sensor'];

/** target profit/h of one line buying all inputs on the market (see the design doc for the reasoning) */
export const TARGETS: Record<string, number> = {
  metal: 6000, titanium: 6000, silicon: 5000, chemicals: 5000, rare_metal: 12000,
  alloy: 7000, composite: 12000,
  machinery: 8000, precision: 8000, structure: 8000, electronics: 11000, armor_plate: 10000,
  weapon_parts: 12000, engine: 14000, reactor: 18000, sensor: 12000,
};
const chainOf = (raw: number, S: number, targets = TARGETS) => { const va = solveVA(raw, S, targets); return { va, value: chainValue({ raw, S, va, vaDefault: 2.5 }) }; };
const chain25 = chainOf(0.25, 0.15), chain40 = chainOf(0.4, 0.15);
/** E: top tiers earn less per line (their edge is market size and barrier, not margin) */
export const TARGETS_E: Record<string, number> = { ...TARGETS, precision: 7000, weapon_parts: 10000, engine: 11000, reactor: 12000, sensor: 9000 };
const chainE = chainOf(0.3, 0.15, TARGETS_E);

export const PROPOSALS: Record<string, Proposal> = {
  base: { id: 'base', name: '현행', desc: '변경 없음 (월드 출신에 따라 가격 체계가 다름)' },
  c4: { id: 'c4', name: 'A. c4 가격 일관 적용', desc: '모든 원자재 0.25배, 가공품 valueOf(원가 × 1.1) — 기존 저장을 c4로 이관했을 때와 같은 가격', value: c4Value, reprice: w => repriceWith(w, c4Value) },
  chain: { id: 'chain', name: 'B. 가치 사슬 가격 (원자재 0.25배)', desc: '가공품 = (투입 × 1.15 + 레시피별 부가가치 × 시간) ÷ 산출, 부가가치는 시장 구매 라인 목표 이익에 맞춰 산정. 원자재 0.25배', value: chain25.value, reprice: w => repriceWith(w, chain25.value) },
  chain40: { id: 'chain40', name: 'C. 가치 사슬 가격 (원자재 0.4배)', desc: 'B와 같은 공식, 원자재 0.4배 (채굴 수익 상향)', value: chain40.value, reprice: w => repriceWith(w, chain40.value) },
  recipe: { id: 'recipe', name: 'D. 가격 유지 + 레시피 조정', desc: '시장 가격은 c4 값 그대로 두고, 주 레시피의 투입·산출만 바꿔 시장 구매 라인 목표 이익에 맞춤',
    patch: () => { recipeSnapshot = snapshotValues(c4Value); for (const [id, ch] of Object.entries(solveRecipes(k => recipeSnapshot![k], TARGETS))) setRecipe(id, ch); },
    reprice: w => repriceWith(w, k => recipeSnapshot?.[k] ?? c4Value(k)) },
  combo: { id: 'combo', name: 'E. 추천 조합', desc: '가치 사슬 가격(원자재 0.3배, 상위 티어 목표 이익 하향) + 가공품 NPC 소비 1.5배 + 상위 시설 건설비 0.8배',
    value: chainE.value,
    patch: () => { scaleUse(PROCESSED, 1.5); for (const f of ['electronics_fab', 'armor_plant', 'weapons_factory', 'engine_plant', 'reactor_plant', 'composite_plant']) if (FACILITIES[f]) scaleFacility(f, 0.8); },
    reprice: w => repriceWith(w, chainE.value) },
};

let recipeSnapshot: Record<string, number> | undefined;
function snapshotValues(value: (k: string) => number) { const r: Record<string, number> = {}; for (const k of [...Object.keys(ITEMS), ...Object.keys(EQUIPMENT)]) r[k] = value(k); return r; }

/** recipe-only balancing: for each main recipe pick output count and an input scale closest to its target */
export function solveRecipes(v: (k: string) => number, targets: Record<string, number>) {
  const out: Record<string, { in: Record<string, number>; out: Record<string, number> }> = {};
  for (const [id, T] of Object.entries(targets)) {
    const r = RECIPES[id], [o, n0] = Object.entries(r.out)[0];
    let best: { score: number; in: Record<string, number>; n: number } | undefined;
    for (const f of [1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4]) for (let n = 1; n <= Math.max(30, n0 * 3); n++) {
      const inp = Object.fromEntries(Object.entries(r.in).map(([k, q]) => [k, Math.max(1, Math.round(q * f))]));
      const prof = lineProfit({ ...r, in: inp, out: { [o]: n } }, v);
      const score = Math.abs(prof - T) / T + (1 - f) * 0.15 + Math.abs(n / n0 - 1) * 0.02;
      if (!best || score < best.score) best = { score, in: inp, n };
    }
    out[id] = { in: best!.in, out: { [o]: best!.n } };
  }
  return out;
}

export function proposal(id: string): Proposal {
  const p = PROPOSALS[id]; if (!p) throw new Error(`unknown proposal ${id} (${Object.keys(PROPOSALS).join(', ')})`);
  return p;
}
export { chain25, chain40, chainOf };
export { scaleUse, addUse, scaleFacility, setRecipe, repriceWith, PROCESSED };

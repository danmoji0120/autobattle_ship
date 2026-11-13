// Value-chain pricing ("B" economy, docs/ECONOMY_B_PLAN.md). OPT-IN PER WORLD: a world prices its
// public NPC markets this way only when it carries `st.econ` (set when the world is created with
// `econ: 'chain'`, or by the explicit econ migration of a c4 save — econMigrate.ts). Every other world
// (c0 … c4 saves, worlds made without the option) keeps the prices it has, untouched.
//
// Rule (one formula, whatever created the world or market):
//   raw good        = hand-set base price × RAW (0.25)
//   made good       = (inputs' value × (1 + S) + value-added rate × line time) ÷ output
//   value-added rate per main recipe is solved so ONE line that buys every input at the market and sells
//   its output at the market (long-run equilibrium ask/bid, hauling, facility upkeep) earns the tier's
//   target profit/h (TARGETS). Price × station regional multiplier = the market's base.
// Blueprints (`bp:`), contract rewards, exchange listings and NPC ship prices are NOT priced here:
// hull prices stay on valuation.ts (c4-b1, frozen), so repair quotes and ship worth do not move.
//
// Pure and deterministic. Reads the static recipe/item tables once (lazily) and caches in this module
// only; it never writes to RECIPES/ITEMS. Analysis scripts that mutate those tables in their own
// process must not share a process with a server.
import { ITEMS, RECIPES, EQUIPMENT, FACILITIES, itemPrice, type RecipeDef } from './industry';
import { valueOf } from './valuation';
import { ECON_CHAIN, LABOUR_PER_S } from './econConfig';

/** equipment (fitted weapons and internal modules) price policy — a design decision, stored per world */
export type EqPolicy = 'chain' | 'keep' | 'margin';
export interface EconChainState {
  /** pricing rule version: 1 = value chain b1 */
  v: 1;
  id: string;
  /** equipment policy this world was priced with */
  eq: EqPolicy;
  /** output of the direct ore → alloy fallback recipe in this world */
  alloyDirect: number;
  /** how the world got here, when (world time) */
  how: 'new' | 'migrated';
  at: number;
  /** migrated saves: mean public-market base per good before the change (shown to players as a
   *  valuation reference — the change is not cash; the exact per-market values live in st.econLog) */
  before?: Record<string, number>;
}

export const chainOn = (w?: { econ?: EconChainState } | null): w is { econ: EconChainState } => w?.econ?.v === 1;

/** designated main recipe of a made good (its price is computed from this one) */
export const MAIN_RECIPE: Record<string, string> = {
  metal: 'metal', alloy: 'alloy', titanium: 'titanium', silicon: 'silicon', chemicals: 'chemicals', rare_metal: 'rare_metal', composite: 'composite',
  machinery: 'machinery', precision: 'precision', structure: 'structure', electronics: 'electronics', armor_plate: 'armor_plate', weapon_parts: 'weapon_parts',
  engine: 'engine', reactor: 'reactor', sensor: 'sensor',
};

const isRaw = (k: string) => ITEMS[k]?.cat === 'raw';
const r1 = (n: number) => Math.round(n * 10) / 10;

/** long-run model of one market-bought line (same rule as scripts/econ/model.ts): bid 0.855 v, ask 1.121 v,
 *  hauling 0.4/unit both ways, facility upkeep share 25 (S) / 75 (M) per hour */
export function chainLineProfit(r: Pick<RecipeDef, 'in' | 'out' | 'time' | 'fac'>, v: (k: string) => number): number {
  const perH = 3600 / r.time, [o, n] = Object.entries(r.out)[0];
  const units = Object.values(r.in).reduce((a, b) => a + b, 0) + n;
  const upkeep = FACILITIES[r.fac]?.minStation === 'M' ? 75 : 25;
  return perH * (0.855 * n * v(o) - 1.121 * Object.entries(r.in).reduce((a, [k, q]) => a + q * v(k), 0)) - units * 0.4 * perH - upkeep;
}

function valueFn(va: Record<string, number>, eq: EqPolicy) {
  const cache = new Map<string, number>();
  const v = (id: string): number => {
    const hit = cache.get(id); if (hit !== undefined) return hit;
    cache.set(id, itemPrice(id));                                   // cycle guard
    let out: number;
    if (isRaw(id)) out = itemPrice(id) * ECON_CHAIN.raw;
    else if (EQUIPMENT[id] && eq === 'keep') out = valueOf(id);
    else {
      const rs = MAIN_RECIPE[id] ? [RECIPES[MAIN_RECIPE[id]]] : Object.values(RECIPES).filter(r => (r.out[id] ?? 0) > 0 && !r.regional);
      const plain = rs.filter(r => !r.tech || EQUIPMENT[id]);
      const inputs = (r: RecipeDef) => Object.entries(r.in).reduce((a, [k, n]) => a + v(k) * n, 0);
      const cost = EQUIPMENT[id] && eq === 'margin'
        ? (r: RecipeDef) => (inputs(r) * (1 + ECON_CHAIN.eqMargin) + r.time * LABOUR_PER_S) / r.out[id]
        : (r: RecipeDef) => (inputs(r) * (1 + ECON_CHAIN.S) + r.time * (va[r.id] ?? ECON_CHAIN.vaDefault)) / r.out[id];
      const best = (plain.length ? plain : rs).map(cost).sort((a, b) => a - b)[0];
      out = best ?? itemPrice(id);
    }
    out = r1(out); cache.set(id, out); return out;
  };
  return v;
}

let solved: Record<string, number> | null = null;
/** per-recipe value-added rates (credits per line-second) that hit TARGETS; solved once, deterministic */
export function chainVA(): Record<string, number> {
  if (solved) return solved;
  const va: Record<string, number> = {};
  for (const id of Object.keys(ECON_CHAIN.targets)) va[id] = 2;
  for (let it = 0; it < 60; it++) {
    const v = valueFn(va, 'chain');
    let moved = 0;
    for (const [id, T] of Object.entries(ECON_CHAIN.targets)) { const d = (T - chainLineProfit(RECIPES[id], v)) / (0.855 * 3600); va[id] = Math.max(0, va[id] + d); moved = Math.max(moved, Math.abs(d)); }
    if (moved < 1e-4) break;
  }
  return (solved = va);
}

const fns = new Map<EqPolicy, (k: string) => number>();
/** value-chain unit value of a good (before the regional multiplier) */
export function chainValue(id: string, eq: EqPolicy = ECON_CHAIN.eqDefault): number {
  let f = fns.get(eq); if (!f) fns.set(eq, f = valueFn(chainVA(), eq));
  return f(id);
}

/** does the chain rule price this market good? (blueprints, unknown and regional-only goods: no) */
export const chainPriced = (k: string) => !k.startsWith('bp:') && !k.startsWith('bpf:') && (!!ITEMS[k] || !!EQUIPMENT[k]) && !ITEMS[k]?.regional;

/** a public market's base price for `id` in a chain world (regional multiplier applied) */
export function chainBase(w: { econ: EconChainState }, id: string, mult = 1): number {
  return r1(chainValue(id, w.econ.eq) * mult);
}

/** the market base a newly listed good gets: chain rule in a chain world, else the caller's own rule */
export function marketBase(w: { econ?: EconChainState } | undefined, id: string, mult: number, legacy: () => number): number {
  return chainOn(w) && chainPriced(id) ? chainBase(w, id, mult) : legacy();
}

/** the state a world created with B pricing starts with */
export function newChainState(how: EconChainState['how'], at: number, opts: { eq?: EqPolicy; alloyDirect?: number } = {}): EconChainState {
  return { v: 1, id: ECON_CHAIN.id, eq: opts.eq ?? ECON_CHAIN.eqDefault, alloyDirect: opts.alloyDirect ?? ECON_CHAIN.alloyDirect, how, at };
}

/** unit price of an item the fitting service supplies when the hangar lacks it (not a market trade):
 *  1.2 × the world's reference value — in a chain world its chain value, so the service can never be a
 *  cheaper source than the NPC market it competes with (no buy-from-service, sell-to-market loop) */
export function fitServiceUnit(w: { econ?: EconChainState } | undefined, k: string, marketAsk?: number): number {
  if (!(chainOn(w) && chainPriced(k))) return itemPrice(k) * 1.2;          // legacy worlds: unchanged
  // never below this station's own market ask, so buy-here-via-refit → sell-here is always a loss
  return Math.max(chainValue(k, w.econ.eq) * 1.2, marketAsk && Number.isFinite(marketAsk) ? marketAsk : 0);
}

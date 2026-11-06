// Growth economics (contentV ≥ 3): what goods and hulls are worth, derived from how they are made.
//
// The old item prices (ITEMS[].price) were set by hand and several production steps destroyed value
// (an engine sold for less than its inputs), so industry was never worth doing and ships sold far
// below the cost of their parts. Here every manufactured good is worth its cheapest recipe's inputs
// plus labour, plus a margin; hulls are worth their parts, labour and yard time; NPC yard prices are a
// tier-dependent multiple of that. Raw goods keep their base price. Pure and deterministic — used by
// the server (markets, yards, upkeep) and the client (price breakdowns). contentV < 3 never calls it.
import { CONTENT } from '../content/registry';
import { ITEMS, RECIPES, EQUIPMENT, TECHS, itemPrice } from './industry';
import { hullBuild } from './hullops';

/** value added per production step (covers energy, wear and the producer's profit) */
export const STEP_MARGIN = 1.1;
/** labour per second of recipe time (credits) */
export const LABOUR_PER_S = 0.35;

const cache = new Map<string, number>();
/** what one unit of a good is worth in a growth world */
export function valueOf(id: string): number {
  const hit = cache.get(id); if (hit !== undefined) return hit;
  cache.set(id, itemPrice(id));                       // cycle guard (e.g. alloy ⇄ metal recipes)
  let v: number;
  if (ITEMS[id]?.cat === 'raw' || id.startsWith('bp:') || id.startsWith('bpf:')) v = itemPrice(id);
  else {
    // cheapest way to make it without special research (else any way); unknown → base price
    const rs = Object.values(RECIPES).filter(r => (r.out[id] ?? 0) > 0);
    const plain = rs.filter(r => !r.tech || EQUIPMENT[id]);
    const cost = (r: typeof rs[number]) => (Object.entries(r.in).reduce((a, [k, n]) => a + valueOf(k) * n, 0) + r.time * LABOUR_PER_S) / r.out[id];
    const best = (plain.length ? plain : rs).map(cost).sort((a, b) => a - b)[0];
    v = best === undefined ? itemPrice(id) : Math.max(itemPrice(id) * 0.8, best * STEP_MARGIN);
  }
  v = Math.round(v * 10) / 10;
  cache.set(id, v);
  return v;
}

/** yard labour per second of build time, by yard size: big docks are expensive to run */
export const YARD_LABOUR = [0, 0.8, 1.6, 3, 5];
/** NPC yard price as a multiple of production cost: small standard hulls are mass-produced (cheap
 *  and always available), warships carry military-licence premiums, capital hulls are scarce */
export const SALE_MUL = [0, 0.42, 0.85, 1.25, 2];
export const GRADE_MUL: Record<string, number> = { common: 1, advanced: 1.12, faction: 1.25, rare: 1.45, unique: 2 };

export interface HullCost { parts: number; labour: number; yard: number; equipment: number; total: number }
/** production cost of a hull + variant (+ the weapons of its standard preset) */
export function hullCost(hullId: string, variantId?: string, presetId?: string): HullCost {
  const b = hullBuild(hullId, variantId);
  const parts = Object.entries(b.parts).reduce((a, [k, n]) => a + valueOf(k) * n, 0);
  const labour = b.credits;
  const yard = b.time * (YARD_LABOUR[b.yard] ?? 1);
  const pre = presetId ? CONTENT.presets[presetId] : Object.values(CONTENT.presets).find(p => p.hull === hullId && p.variant === (variantId ?? `${hullId}_std`));
  const equipment = Object.values(pre?.weapons ?? {}).reduce((a, eq) => a + valueOf(eq), 0);
  return { parts: Math.round(parts), labour: Math.round(labour), yard: Math.round(yard), equipment: Math.round(equipment), total: Math.round(parts + labour + yard + equipment) };
}

export interface HullPrice extends HullCost { mul: number; grade: number; price: number }
/** NPC public-yard list price (before the scarcity markup of an emptying yard) */
export function hullPrice(hullId: string, variantId?: string, presetId?: string): HullPrice {
  const c = hullCost(hullId, variantId, presetId);
  const b = hullBuild(hullId, variantId);
  const mul = SALE_MUL[b.yard] ?? 1;
  const bp = Object.values(CONTENT.blueprints).find(x => x.target.kind === 'hull' && x.target.id === hullId);
  const grade = GRADE_MUL[bp?.grade ?? 'common'] ?? 1;
  return { ...c, mul, grade, price: Math.round(c.total * mul * grade / 100) * 100 };
}

export const techName = (id: string) => TECHS[id]?.name ?? id;

/** market goods a public yard consumes to build one more of this hull for its stock: a share of the
 *  hull's production cost taken as bulk materials (alloy, structure, armour, electronics). The yard
 *  draws only on goods its market trades — so selling it alloy and structure keeps warships coming. */
export function yardRestockNeed(hullId: string, st: { market: Record<string, unknown> | null }): Record<string, number> {
  const c = hullCost(hullId).total;
  const b = hullBuild(hullId);
  const shares: [string, number][] = [['alloy', 0.3], ['electronics', 0.06], ...(b.yard >= 2 ? [['structure', 0.1], ['armor_plate', 0.06]] as [string, number][] : [])];
  const out: Record<string, number> = {};
  for (const [k, sh] of shares) {
    const into = st.market?.[k] ? k : 'alloy';              // a yard without that good uses more alloy
    out[into] = (out[into] ?? 0) + Math.ceil(c * sh / valueOf(into));
  }
  return out;
}

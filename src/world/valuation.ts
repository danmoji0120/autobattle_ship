// Growth economics (contentV ≥ 3): what goods and hulls are worth, derived from how they are made.
//
// The old item prices (ITEMS[].price) were set by hand and several production steps destroyed value
// (an engine sold for less than its inputs), so industry was never worth doing and ships sold far
// below the cost of their parts. Here every manufactured good is worth its cheapest recipe's inputs
// plus labour, plus a margin; hulls are worth their parts, labour and yard time; NPC yard prices are a
// tier-dependent multiple of that. Raw goods keep their base price. Pure and deterministic — used by
// the server (markets, yards, upkeep) and the client (price breakdowns). contentV < 3 never calls it.
import { CONTENT } from '../content/registry';
import { ITEMS, RECIPES, EQUIPMENT, TECHS, itemPrice, recipeFor } from './industry';
import { REGIONAL_RECIPE_INPUTS, regionalHullMaterials, regionalOn } from './regional';
import { hullBuild } from './hullops';
import { STEP_MARGIN, LABOUR_PER_S, YARD_FEE, SALE_BY_YARD, SALE_BY_CLASS, GRADE_MUL, YARD_RESTOCK_SHARE, YARD_RESTOCK_SHARE_WAR } from './econConfig';
export { STEP_MARGIN, LABOUR_PER_S, GRADE_MUL };

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

/** An informational P9.7 production reference for player listings, never an NPC market price. */
export function regionalReferenceValue(w: { regionalV?: number }, id: string): number | undefined {
  if (!regionalOn(w)) return undefined;
  if (ITEMS[id]?.regional) return valueOf(id);
  const r = recipeFor(w, id), n = r?.out[id] ?? 0;
  if (!r || n <= 0 || !Object.keys(r.in).some(k => ITEMS[k]?.regional)) return undefined;
  const cost = (Object.entries(r.in).reduce((sum, [k, amount]) => sum + valueOf(k) * amount, 0) + r.time * LABOUR_PER_S) / n;
  return Math.round(Math.max(valueOf(id), cost * STEP_MARGIN) * 10) / 10;
}

/** Opportunity cost of the actual required items at reference values, not cash paid or a bid. */
export function materialReferenceCost(w: { regionalV?: number }, materials: Record<string, number>): number {
  return Object.entries(materials).reduce((sum, [id, amount]) => sum + amount * (regionalReferenceValue(w, id) ?? valueOf(id)), 0);
}

/** Asset assessment only: does not alter executable market prices or upkeep. */
export function assetReferenceValue(w: { regionalV?: number }, id: string): number {
  return regionalOn(w) && (ITEMS[id]?.regional || Object.hasOwn(REGIONAL_RECIPE_INPUTS, id))
    ? regionalReferenceValue(w, id) ?? itemPrice(id) : itemPrice(id);
}

/** The additional regional material value not represented in the old hull-price calculation. */
export function regionalShipValueAdjustment(w: { regionalV?: number }, ship: { hull?: string; classId?: string; fitting?: { hp: Record<string, string>; bay: Record<string, string> }; fit?: string[] }): number {
  if (!regionalOn(w)) return 0;
  const hull = ship.hull ?? (ship.classId ? `${ship.classId}_mk1` : '');
  const hullMaterials = regionalHullMaterials(w, hull);
  let extra = hullMaterials ? materialReferenceCost(w, hullMaterials) : 0;
  const specialWeapons = Object.entries(ship.fitting?.hp ?? {}).filter(([, id]) => Object.hasOwn(REGIONAL_RECIPE_INPUTS, id));
  if (specialWeapons.length) {
    // shipWorth already includes the standard preset. Account for the displaced standard weapon
    // at the same hardpoint, rather than counting both it and the actually fitted rare weapon.
    const standard = Object.values(CONTENT.presets).find(p => p.hull === hull && p.variant === `${hull}_std`);
    for (const [slot, id] of specialWeapons) extra += (regionalReferenceValue(w, id) ?? valueOf(id)) - (standard?.weapons[slot] ? valueOf(standard.weapons[slot]) : 0);
  }
  // Standard hull valuation does not include optional internal modules.
  for (const id of ship.fitting ? Object.values(ship.fitting.bay) : ship.fit ?? [])
    if (Object.hasOwn(REGIONAL_RECIPE_INPUTS, id)) extra += regionalReferenceValue(w, id) ?? valueOf(id);
  return extra;
}

/** yard operating fee of a build (credits): charged for real by an own yard, counted in the cost */
export const yardFee = (b: { yard: number; pricingYard?: number; time: number }) => Math.round(b.time * (YARD_FEE[b.pricingYard ?? b.yard] ?? 1));
/** NPC licence multiple of a hull class (econConfig: class table, else by yard size) */
export const saleMul = (classId: string, yard: number) => (Object.hasOwn(SALE_BY_CLASS, classId) ? SALE_BY_CLASS[classId] : SALE_BY_YARD[yard]) ?? 1;

export interface HullCost { parts: number; labour: number; yard: number; equipment: number; total: number }
/** production cost of a hull + variant (+ the weapons of its standard preset) */
export function hullCost(hullId: string, variantId?: string, presetId?: string): HullCost {
  const b = hullBuild(hullId, variantId);
  const parts = Object.entries(b.parts).reduce((a, [k, n]) => a + valueOf(k) * n, 0);
  const labour = b.credits;
  const yard = yardFee(b);
  const pre = presetId ? CONTENT.presets[presetId] : Object.values(CONTENT.presets).find(p => p.hull === hullId && p.variant === (variantId ?? `${hullId}_std`));
  const equipment = Object.values(pre?.weapons ?? {}).reduce((a, eq) => a + valueOf(eq), 0);
  return { parts: Math.round(parts), labour: Math.round(labour), yard: Math.round(yard), equipment: Math.round(equipment), total: Math.round(parts + labour + yard + equipment) };
}

export interface HullPrice extends HullCost { mul: number; grade: number; price: number }
/** NPC public-yard list price (before the scarcity markup of an emptying yard) */
export function hullPrice(hullId: string, variantId?: string, presetId?: string): HullPrice {
  const c = hullCost(hullId, variantId, presetId);
  const b = hullBuild(hullId, variantId);
  const mul = saleMul(CONTENT.hulls[hullId]?.classId ?? hullId.replace(/_mk1$/, ''), b.pricingYard ?? b.yard);
  const bp = Object.values(CONTENT.blueprints).find(x => x.target.kind === 'hull' && x.target.id === hullId);
  const grade = GRADE_MUL[bp?.grade ?? 'common'] ?? 1;
  return { ...c, mul, grade, price: Math.round(c.total * mul * grade / 100) * 100 };
}

export const techName = (id: string) => TECHS[id]?.name ?? id;

/** market goods a public yard consumes to build one more of this hull for its stock: a share of the
 *  hull's production cost taken as bulk materials (alloy, structure, armour, electronics). The yard
 *  draws only on goods its market trades — so selling it alloy and structure keeps warships coming. */
export function yardRestockNeed(hullId: string, st: { market: Record<string, unknown> | null }): Record<string, number> {
  const hc = hullCost(hullId);
  const c = hc.parts + hc.labour + hc.equipment;          // the yard's own dock time is not a market good
  const b = hullBuild(hullId);
  const shares: [string, number][] = [...YARD_RESTOCK_SHARE, ...((b.pricingYard ?? b.yard) >= 2 ? YARD_RESTOCK_SHARE_WAR : [])];
  const out: Record<string, number> = {};
  for (const [k, sh] of shares) {
    const into = st.market?.[k] ? k : 'alloy';              // a yard without that good uses more alloy
    out[into] = (out[into] ?? 0) + Math.ceil(c * sh / valueOf(into));
  }
  return out;
}

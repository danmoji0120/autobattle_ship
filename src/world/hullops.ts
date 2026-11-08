// Per-hull operation data (growth P3/P4/P6). One place that answers "what does this hull do":
// strategic econ (cruise/cargo/mining/construction), own-yard build requirements, upkeep and NPC
// supply. mk1 hulls carry no overrides and fall back to the class tables (ECON / HULLS), so worlds
// below contentV 3 behave exactly as before. Pure — safe on server and client.
import { CONTENT } from '../content/registry';
import type { HullBuild, HullDef, HullSale, HullUpkeep, Size } from '../content/schema';
import { sizeRank } from '../content/schema';
import { ECON, type ShipEcon } from './data';
import { HULLS, FACILITIES } from './industry';
import { hullPrice } from './valuation';
import { MK1_STOCK, MK1_RESTOCK, MK1_MIL_REP } from './econConfig';
import type { Station, WShip, WorldState } from './types';
import { stationSize } from './stations';

/** contentV from which hull data, upkeep, market demand and blueprint rules apply */
export const GROWTH_V = 3;
export const growthOn = (st: Pick<WorldState, 'contentV'> | undefined) => (st?.contentV ?? 0) >= GROWTH_V;

export interface HullEcon extends ShipEcon { build: number; berth: Size; minField: number }

/** hull id of a ship (legacy ships without content ids map to their class's mk1 hull) */
export const hullIdOf = (s: { classId: string; hull?: string }) => s.hull && CONTENT.hulls[s.hull] ? s.hull : `${s.classId}_mk1`;
export const hullDefOf = (s: { classId: string; hull?: string }): HullDef | undefined => CONTENT.hulls[hullIdOf(s)];

const econCache = new Map<string, HullEcon>();
/** strategic econ of a hull + variant (variant mods applied) */
export function hullEcon(hullId: string, variantId?: string): HullEcon {
  const key = `${hullId}|${variantId ?? ''}`;
  const hit = econCache.get(key); if (hit) return hit;
  const h = CONTENT.hulls[hullId];
  const base = ECON[h?.classId ?? hullId.replace(/_mk1$/, '')] ?? ECON.corvette;
  const v = variantId ? CONTENT.variants[variantId] : undefined;
  const m = v?.mods ?? {};
  const o = h?.ops ?? {};
  const e: HullEcon = {
    ...base,
    cruise: (o.cruise ?? base.cruise) * (m.cruiseMul ?? 1),
    cargo: Math.round((o.cargo ?? base.cargo) * (m.cargoMul ?? 1)),
    mine: (o.mine ?? base.mine) * (m.mineMul ?? 1),
    price: h?.sale?.price ?? (h && !h.id.endsWith('_mk1') ? hullPrice(h.id).price : base.price),
    rep: h?.sale?.rep ?? base.rep,
    build: (o.build ?? (h?.classId === 'constructor' ? 1 : 0)) * (m.buildMul ?? 1),
    berth: o.berth ?? (h ? (h.size === 'XL' || h.size === 'L') && (h.classId === 'miner' || h.classId === 'hauler' || h.classId === 'constructor') ? h.size : 'S' : 'S'),
    minField: o.minField ?? 0,
  };
  econCache.set(key, e);
  return e;
}

/** strategic econ of a ship (its hull + variant). Wear is applied by the callers that move or mine. */
export const econOf = (s: { classId: string; hull?: string; variant?: string }): HullEcon =>
  s.hull ? hullEcon(hullIdOf(s), s.variant) : hullEcon(`${s.classId}_mk1`);

/** own-yard build requirements of a hull (+ variant extra parts) */
export function hullBuild(hullId: string, variantId?: string, growth = true): HullBuild {
  const h = CONTENT.hulls[hullId];
  const legacy = HULLS[h?.classId ?? hullId.replace(/_mk1$/, '')];
  const b: HullBuild = h?.build ?? { yard: legacy?.yard ?? 1, time: legacy?.time ?? 1800, credits: legacy?.credits ?? 1500, parts: { ...(legacy?.parts ?? {}) }, ...(legacy?.tech ? { tech: [legacy.tech] } : {}) };
  const v = variantId ? CONTENT.variants[variantId] : undefined;
  // the industrial base a yard of this size needs, plus the hull's and the variant's own facilities
  // (growth only: a legacy c0 build of a mk1 class keeps its old requirements — growth = false)
  const facilities = [...new Set([...(growth ? TIER_BASE[b.yard] ?? [] : []), ...(b.facilities ?? []), ...(v?.needs?.facilities ?? [])])];
  const tech = [...new Set([...(b.tech ?? []), ...(v?.needs?.tech ?? [])])];
  const parts = { ...b.parts };
  for (const [k, n] of Object.entries(v?.parts ?? {})) parts[k] = (parts[k] ?? 0) + n;
  return { ...b, parts, ...(facilities.length ? { facilities } : {}), ...(tech.length ? { tech } : {}) };
}

/** industrial base an own yard of each size needs before it can lay down a hull (growth worlds):
 *  small hulls need only the slip; warships need hull and machine works; capital hulls a full
 *  shipbuilding complex — armour, electronics, power and a hangar to fit them out; the largest add
 *  engines, reactors, weapons and crew support. */
export const TIER_BASE: Record<number, string[]> = {
  1: [],
  2: ['hull_works', 'machine_shop'],
  3: ['hull_works', 'machine_shop', 'armor_plant', 'electronics_fab', 'power', 'hangar'],
  4: ['hull_works', 'machine_shop', 'armor_plant', 'electronics_fab', 'power', 'hangar', 'engine_plant', 'reactor_plant', 'weapons_factory', 'habitat'],
};

/** default running cost per class (mk1 hulls; growth hulls declare their own) */
const CLASS_UPKEEP: Record<string, HullUpkeep> = {
  corvette: { credits: 300, supplies: { chemicals: 0.5 }, wear: 0.05 },
  frigate: { credits: 450, supplies: { chemicals: 0.8 }, wear: 0.05 },
  destroyer: { credits: 750, supplies: { chemicals: 1 }, wear: 0.05 },
  light_cruiser: { credits: 1300, supplies: { chemicals: 1.5, machinery: 0.1 }, wear: 0.05 },
  cruiser: { credits: 2200, supplies: { chemicals: 2, machinery: 0.2 }, wear: 0.05 },
  battlecruiser: { credits: 4000, supplies: { chemicals: 3, machinery: 0.4, electronics: 0.1 }, wear: 0.05 },
  battleship: { credits: 6000, supplies: { chemicals: 4, machinery: 0.6, electronics: 0.15 }, wear: 0.05 },
  dreadnought: { credits: 20000, supplies: { chemicals: 10, machinery: 2, electronics: 0.5 }, wear: 0.05 },
  miner: { credits: 350, supplies: { machinery: 0.05 }, wear: 0.06 },
  hauler: { credits: 300, supplies: { chemicals: 0.2 }, wear: 0.04 },
  constructor: { credits: 600, supplies: { machinery: 0.1 }, wear: 0.03 },
  platform: { credits: 0, wear: 0 },
};
export function hullUpkeep(hullId: string, variantId?: string): HullUpkeep {
  const h = CONTENT.hulls[hullId];
  const u = h?.upkeep ?? CLASS_UPKEEP[h?.classId ?? hullId.replace(/_mk1$/, '')] ?? { credits: 0 };
  const mul = (variantId ? CONTENT.variants[variantId]?.mods?.upkeepMul : undefined) ?? 1;
  if (mul === 1) return u;
  return { credits: u.credits * mul, supplies: Object.fromEntries(Object.entries(u.supplies ?? {}).map(([k, n]) => [k, n * mul])), wear: u.wear };
}

/** Legacy hulls sold at public yards share the same class and yard eligibility rules. */
function legacySaleYard(h: HullDef): number | undefined {
  if (!ECON[h.classId] || h.classId === 'platform') return undefined;
  const yard = HULLS[h.classId]?.yard ?? 1;
  return yard >= 4 ? undefined : yard;
}

/** Restock only needs quantities and time, not the much more expensive price calculation. */
export function hullStock(hullId: string): Pick<HullSale, 'stock' | 'restock'> | undefined {
  const h = CONTENT.hulls[hullId];
  if (!h) return undefined;
  if (h.sale) return h.sale;
  const yard = legacySaleYard(h);
  return yard === undefined ? undefined : { stock: MK1_STOCK[yard], restock: MK1_RESTOCK[yard] };
}

/** NPC supply of a hull (growth hulls declare it; mk1 hulls are stocked by every yard that lists the class) */
export function hullSale(hullId: string): (HullSale & { price: number }) | undefined {
  const h = CONTENT.hulls[hullId];
  if (!h) return undefined;
  // list price = production cost × tier multiple (valuation.ts) unless the content sets one
  if (h.sale) return { ...h.sale, price: h.sale.price ?? hullPrice(h.id).price };
  const yard = legacySaleYard(h); if (yard === undefined) return undefined;
  const e = ECON[h.classId];
  // mk1: stock and restock scale with hull size; stations come from the station's shipyard list.
  // Capital hulls are scarce: one at a time, a day to replace, and only for trusted companies.
  // The largest hulls are never sold by NPC yards: build or buy from a producer.
  return { stations: [], price: hullPrice(h.id).price, rep: e.military ? Math.max(e.rep, MK1_MIL_REP[yard]) : e.rep, stock: MK1_STOCK[yard], restock: MK1_RESTOCK[yard] };
}

/** what a ship is worth (repairs, maintenance and refit fees scale with it): growth worlds use the
 *  production-cost list price, older worlds the old class price */
export const shipWorth = (w: Pick<WorldState, 'contentV'>, s: { classId: string; hull?: string; variant?: string }): number =>
  growthOn(w) ? (hullSale(hullIdOf(s))?.price ?? hullPrice(hullIdOf(s)).price) : econOf(s).price;
/** hulls a public yard stocks at contentV ≥ 3 */
export function yardHulls(st: Station): string[] {
  if (!st.public) return [];
  const out: string[] = [];
  for (const h of Object.values(CONTENT.hulls)) {
    if (h.classId === 'platform') continue;
    if (h.sale ? h.sale.stations.includes(st.id) : h.id.endsWith('_mk1') && st.services.shipyard.includes(h.classId) && legacySaleYard(h) !== undefined) out.push(h.id);
  }
  return out;
}

/** berth size of a station: public hubs by size, own stations grow with dock modules */
export const PUBLIC_BERTH: Record<string, Size> = { helios: 'XL', exchange: 'XL', bastion: 'XL', astra: 'L', nova: 'L', barcaco: 'L', drakeout: 'M', cinderco: 'M', rustport: 'M', p9_lyra_port: 'L', p9_ceres_works: 'L', p9_harbor_port: 'L', p9_forge_works: 'L' };
export function berthOf(st: Station): Size {
  if (st.public) return PUBLIC_BERTH[st.id] ?? 'M';
  const sized = stationSize(st); if (sized) return sized.berth;
  const docks = st.modules.filter(m => m.built && m.kind === 'dock').length;
  const big = st.modules.some(m => m.built && (FACILITIES[m.kind]?.yard ?? 0) >= 3);
  return docks >= 2 || (docks >= 1 && big) ? 'XL' : docks >= 1 ? 'L' : 'M';
}
export const berthFits = (st: Station, size: Size) => sizeRank(size) <= sizeRank(berthOf(st));
/** the largest berth the ships need */
export const berthNeed = (ships: { classId: string; hull?: string; variant?: string }[]): Size =>
  ships.reduce<Size>((a, s) => sizeRank(econOf(s).berth) > sizeRank(a) ? econOf(s).berth : a, 'S');

/** wear slows mining and cruising (up to −25% at full wear) */
export const wearMul = (s: Pick<WShip, 'wear'>) => 1 - 0.25 * Math.min(1, Math.max(0, s.wear ?? 0));

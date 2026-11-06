// NPC regional economy: what each public station makes and consumes, field compositions, and the
// in-place save upgrade that brings older worlds into the multi-tier industry (idempotent).

import type { WorldState, Station, Market } from './types';
import { emptyCargo } from './types';
import { ITEMS, TECHS, itemPrice, EQUIPMENT } from './industry';
import { LEGACY_MODULE } from './data';

export const INDUSTRY_VERSION = 2;
/** hulls on sale at public yards from industry v2 (bought complete with standard weapons) */
const YARD_ADD: Record<string, string[]> = { helios: ['frigate', 'light_cruiser', 'battlecruiser'], bastion: ['frigate', 'light_cruiser'], drakeout: ['frigate'], astra: ['frigate'] };

/** what a mined unit of each field is made of */
export const FIELD_MIX: Record<string, Record<string, number>> = {
  garden: { ore: 0.8, silicate: 0.2 },
  kestrel: { ore: 0.75, silicate: 0.25 },
  grey: { ore: 0.6, silicate: 0.25, titanium_ore: 0.15 },
  still: { ore: 0.5, silicate: 0.5 },
  barcaring: { ore: 0.5, titanium_ore: 0.3, rare_ore: 0.2 },
  kelice: { crystal: 0.7, gas: 0.3 },
  rust: { ore: 0.6, titanium_ore: 0.4 },
  deep: { ore: 0.5, rare_ore: 0.2, silicate: 0.3 },
  orcagem: { crystal: 0.8, rare_ore: 0.2 },
  ember: { ore: 0.4, gas: 0.4, titanium_ore: 0.2 },
  azure: { crystal: 0.7, gas: 0.3 },
  void: { crystal: 0.6, rare_ore: 0.4 },
  graves: { alloy: 0.5, metal: 0.3, electronics: 0.1, weapon_parts: 0.1 },
};
export const SALVAGE_MIX = { alloy: 0.45, metal: 0.35, electronics: 0.1, weapon_parts: 0.1 };

/**
 * Regional profile of a public station.
 *  make: goods produced locally (restock toward target, slowed by pirate activity in the system)
 *  use:  goods consumed locally (per second; demand keeps their price up)
 *  conv: local industry converting goods (only runs while inputs are in stock)
 *  sell: other goods simply traded here (stock drifts toward target)
 */
interface Profile { make: string[]; use: Record<string, number>; conv?: { in: Record<string, number>; out: Record<string, number>; rate: number }[]; sell: string[]; mult?: number; bp?: boolean }
export const PROFILES: Record<string, Profile> = {
  helios: { mult: 1.15, make: ['sensor', 'reactor', 'engine', 'electronics', 'eq_medium_gun', 'eq_missile_rack', 'eq_pd_gun', 'mod_armor', 'mod_fcs'], use: { alloy: 1.0, ore: 0.4, structure: 0.15, armor_plate: 0.08, composite: 0.05 }, sell: ['structure', 'armor_plate', 'composite', 'precision', 'weapon_parts'], bp: true },
  exchange: { make: [], use: { crystal: 0.08, rare_metal: 0.02 }, sell: ['metal', 'titanium', 'silicon', 'chemicals', 'composite', 'rare_metal', 'machinery', 'precision', 'electronics', 'silicate', 'gas'], bp: true },
  astra: { make: ['machinery', 'eq_autocannon', 'mod_engine'], use: { ore: 0.7, alloy: 0.25, metal: 0.1, chemicals: 0.05 }, sell: ['silicate', 'metal', 'gas', 'chemicals', 'structure', 'eq_pd_gun', 'electronics'] },
  bastion: { make: ['weapon_parts', 'armor_plate', 'eq_autocannon', 'eq_medium_gun', 'eq_torpedo', 'eq_pd_gun', 'mod_armor'], use: { alloy: 0.3, chemicals: 0.06 }, sell: ['titanium', 'precision'] },
  nova: { make: [], use: {}, conv: [{ in: { ore: 2 }, out: { metal: 1 }, rate: 1.5 }, { in: { metal: 1, titanium_ore: 0.5 }, out: { alloy: 0.9 }, rate: 0.8 }, { in: { silicate: 2 }, out: { silicon: 0.9 }, rate: 0.4 }, { in: { titanium_ore: 2 }, out: { titanium: 0.8 }, rate: 0.3 }], sell: ['silicate', 'titanium_ore', 'metal', 'titanium', 'silicon', 'machinery'] },
  barcaco: { make: ['ore', 'silicate', 'gas', 'machinery'], use: { alloy: 0.15, machinery: 0.02 }, sell: ['titanium_ore', 'metal', 'chemicals'] },
  drakeout: { mult: 1.1, make: ['titanium_ore', 'rare_ore', 'armor_plate'], use: { ore: 0.5, alloy: 0.4, machinery: 0.04, weapon_parts: 0.02 }, sell: ['titanium', 'machinery', 'weapon_parts', 'eq_autocannon', 'eq_torpedo'] },
  cinderco: { mult: 1.15, make: ['gas', 'chemicals', 'titanium_ore', 'rare_ore'], use: { ore: 0.5, alloy: 0.4, machinery: 0.05, electronics: 0.02, engine: 0.0005 }, sell: ['machinery', 'electronics', 'engine', 'eq_missile_rack'] },
  rustport: { mult: 1.25, make: ['weapon_parts', 'electronics', 'rare_metal'], use: { crystal: 0.05, alloy: 0.2 }, sell: ['rare_ore', 'eq_medium_gun', 'eq_heavy_cannon', 'mod_ecm', 'mod_engine'] },
};

/** target stock for a good at a market: cheap bulk goods are stocked in thousands, ship parts in single digits */
export const targetFor = (id: string) => Math.max(2, Math.round(Math.min(5000, 40000 / Math.max(5, itemPrice(id)))));

function addGood(m: Market, id: string, mult: number, fill: number) {
  if (m[id]) return;
  const target = targetFor(id);
  m[id] = { stock: Math.round(target * fill), target, base: Math.round(itemPrice(id) * mult * 10) / 10 };
}

/** idempotent: older saves gain field compositions, the new goods and renamed facilities */
export function upgradeIndustry(st: WorldState) {
  if ((st.industryV ?? 0) >= INDUSTRY_VERSION) return;
  for (const [id, add] of Object.entries(YARD_ADD)) { const x = st.stations[id]; if (x) for (const c of add) if (!x.services.shipyard.includes(c)) x.services.shipyard.push(c); }
  for (const f of Object.values(st.fields)) if (!f.mix) f.mix = FIELD_MIX[f.id] ?? (f.salvage ? { ...SALVAGE_MIX } : undefined);
  for (const s of Object.values(st.stations)) {
    for (const m of s.modules) if (LEGACY_MODULE[m.kind]) m.kind = LEGACY_MODULE[m.kind];
    if (s.public && s.market) {
      const p = PROFILES[s.id];
      if (p) {
        for (const id of [...p.make, ...p.sell, ...Object.keys(p.use), ...(p.conv ?? []).flatMap(c => [...Object.keys(c.in), ...Object.keys(c.out)])]) addGood(s.market, id, p.mult ?? 1, p.make.includes(id) ? 0.8 : 0.5);
        if (p.bp) for (const t of Object.values(TECHS)) if (t.bp) s.market[`bp:${t.id}`] ??= { stock: 1, target: 1, base: t.bp };
      }
    }
    if (!s.public) {
      // the old refinery turned ore into alloy by itself; keep that running as a standing order
      if ((st.industryV ?? 0) < 1 && s.modules.some(m => m.kind === 'refinery' && m.built) && !(s.orders ?? []).length) {
        s.seq = (s.seq ?? 0) + 1;
        s.orders = [{ id: `o${s.seq}`, recipe: 'alloy_direct', mode: 'stock', n: 5000, done: 0 }];
      }
    }
    for (const c of Object.keys(st.companies)) s.storage[c] ??= emptyCargo();
  }
  for (const c of Object.values(st.companies)) { c.tech ??= []; c.research ??= []; }
  st.industryV = INDUSTRY_VERSION;
}

/** contentV ≥ 3: share of a region's raw-ore appetite that is left once refined goods carry the economy */
export const RAW_USE_V3 = 0.35;
export const rawUseMul = (k: string) => ITEMS[k]?.cat === 'raw' ? RAW_USE_V3 : 1;

/** one public market, dt seconds: local production, consumption, industry and drift */
export function npcMarketStep(s: Station, m: Market, dt: number, heat: number, regional = 1, drift = true) {
  const p = PROFILES[s.id];
  // pirate activity in the system chokes supply (convoys don't arrive, mines shut down);
  // merchant influence and post-liberation reconstruction raise it (factions.ts)
  const supply = Math.max(0.15, 1 - heat / 120) * regional;
  if (p) {
    // growth worlds (drift off): the region burns much less raw ore than it buys refined goods
    for (const [k, r] of Object.entries(p.use)) if (m[k]) m[k].stock = Math.max(0, m[k].stock - r * dt * (drift ? 1 : rawUseMul(k)));
    for (const k of p.make) if (m[k] && m[k].stock < m[k].target) m[k].stock += Math.max(0.0004 * m[k].target, 0.002) * dt * supply;
    for (const c of p.conv ?? []) {
      let k = c.rate * dt * supply;
      for (const [i, n] of Object.entries(c.in)) k = Math.min(k, (m[i]?.stock ?? 0) / n);
      for (const [o] of Object.entries(c.out)) if (m[o] && m[o].stock > m[o].target * 1.4) k = 0;
      if (k <= 0) continue;
      for (const [i, n] of Object.entries(c.in)) m[i].stock -= n * k;
      for (const [o, n] of Object.entries(c.out)) if (m[o]) m[o].stock += n * k;
    }
  }
  if (!drift) return;   // contentV ≥ 3 drifts with market.ts driftV3 (finite demand)
  for (const [k, e] of Object.entries(m)) {
    if (k.startsWith('bp:')) { if (e.stock < e.target) e.stock = Math.min(e.target, e.stock + dt / 7200); continue; }
    const d = e.target - e.stock;
    // shortages refill slowly (more slowly under pirate pressure); gluts are absorbed by the region
    e.stock += d * (d > 0 ? 0.0032 * supply : 0.0032) * dt * (EQUIPMENT[k] || (ITEMS[k]?.tier ?? 1) >= 4 ? 0.3 : 1);
  }
}

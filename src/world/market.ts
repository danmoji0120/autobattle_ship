// Market model v3 (growth P4, contentV ≥ 3). Below contentV 3 the old model runs unchanged.
//
//  - Price follows stock vs target as before, but the floor drops (0.45 → 0.15 of base): a market
//    flooded far beyond its target pays almost nothing for more of the same good.
//  - Demand is finite: a glut is worked off only at the region's real absorption rate (its local
//    consumption, or a small base rate), not by an exponential drift that made every market endless.
//  - Every public station has an NPC buying budget (`funds`). Sales to the station are paid out of
//    it; when it runs dry the station stops buying until it recovers. It recovers continuously from
//    regional income (bounded by fundsMax) and from what players pay the station, so trade never
//    freezes for good and money is never created beyond that bounded income.
import type { Market, Station, WorldState } from './types';
import { PROFILES, rawUseMul } from './economy';
import { EQUIPMENT, ITEMS } from './industry';
import { growthOn } from './hullops';

export const FLOOR_V2 = 0.45, FLOOR_V3 = 0.15;
/** NPC budget per public station (credits) and recovery per hour (fraction of max) */
export const FUNDS_MAX: Record<string, number> = { helios: 420000, exchange: 480000, astra: 220000, bastion: 260000, nova: 160000, barcaco: 130000, drakeout: 160000, cinderco: 150000, rustport: 130000 };
export const FUNDS_REGEN_H = 0.15;
/** share of what players pay a station that returns to its buying budget */
export const FUNDS_INFLOW = 0.7;

export function priceOf(m: Market[string] | undefined, side: 'sell' | 'buy', v3: boolean): number {
  if (!m) return 0;
  const ratio = m.stock / m.target;
  const p = m.base * Math.max(v3 ? FLOOR_V3 : FLOOR_V2, Math.min(1.7, 1.45 - 0.55 * ratio));
  return side === 'sell' ? Math.round(p * 10) / 10 : Math.round(p * 1.18 * 10) / 10;
}

/** how fast the region works off a glut of this good (units/s): its own consumption, else a base rate */
export function absorbRate(s: Station, k: string, target: number): number {
  const use = PROFILES[s.id]?.use?.[k] ?? 0;
  const slow = EQUIPMENT[k] || (ITEMS[k]?.tier ?? 1) >= 4 ? 0.3 : 1;
  return Math.max(use, target * 0.00022 * slow) * rawUseMul(k);
}

/** v3 drift: shortages refill as before (pirates choke supply); gluts shrink at the finite absorption rate */
export function driftV3(s: Station, m: Market, dt: number, supply: number) {
  for (const [k, e] of Object.entries(m)) {
    if (k.startsWith('bp:')) { if (e.stock < e.target) e.stock = Math.min(e.target, e.stock + dt / 7200); continue; }
    const d = e.target - e.stock;
    if (d > 0) e.stock += d * 0.0032 * supply * dt * (EQUIPMENT[k] || (ITEMS[k]?.tier ?? 1) >= 4 ? 0.3 : 1);
    else e.stock = Math.max(e.target, e.stock - absorbRate(s, k, e.target) * dt);
  }
}

/** budget recovery (regional income), dt seconds */
export function fundsStep(s: Station, dt: number) {
  if (!s.public || s.fundsMax === undefined) return;
  s.funds = Math.min(s.fundsMax, (s.funds ?? 0) + s.fundsMax * FUNDS_REGEN_H / 3600 * dt);
}

/** a public station's budget after players paid it `cr` */
export function fundsIn(s: Station, cr: number) {
  if (s.fundsMax === undefined) return;
  s.funds = Math.min(s.fundsMax * 1.5, (s.funds ?? 0) + cr * FUNDS_INFLOW);
}

/** give public stations their budgets (idempotent) */
export function seedFunds(w: WorldState) {
  for (const s of Object.values(w.stations)) {
    if (!s.public || !s.market) continue;
    s.fundsMax ??= FUNDS_MAX[s.id] ?? 120000;
    s.funds ??= s.fundsMax * 0.6;
  }
}

export const marketV3 = growthOn;

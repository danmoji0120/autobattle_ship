// Static industry model over a real world state (after a proposal is applied). Steady state, one line:
//  - prices at equilibrium: a market at its target stock sells at 0.90 × base; a market a buyer keeps
//    drawing sits a little under target (ask = 1.18 × 0.95 × base); the seller pays the station tax
//  - realised sales are capped by NPC absorption (finite demand) and by the NPC buying budget: anything
//    produced above that is NOT revenue (it piles up at floor prices)
//  - capital = facility credits + materials at market ask, plus a share of the station (core + power)
//  - running cost = station upkeep share + hauling (hauler upkeep × trip time / cargo)
//  - own inputs carry their opportunity cost (what they would have sold for)
import { FACILITIES, ITEMS, RECIPES, facilityBuild, recipeFor, type RecipeDef } from '../../src/world/industry';
import { absorbRate, FUNDS_REGEN_H } from '../../src/world/market';
import { STATION_SIZES } from '../../src/world/stations';
import { hullUpkeep } from '../../src/world/hullops';
import { ECON } from '../../src/world/data';
import { valueOf } from '../../src/world/valuation';
import type { Station, WorldState } from '../../src/world/types';

export const ASK = 1.18 * 0.95, BID = 0.9;
/** typical one-way trip between an own station and its market, hours (measured in the company runs) */
export const TRIP_H = 0.25;

export interface Market { st: Station; base: number; target: number; absorbH: number; tax: number }
export function marketsOf(w: WorldState) {
  const ms = Object.values(w.stations).filter(s => s.public && s.market) as Station[];
  const of = (k: string): Market[] => ms.filter(s => s.market![k]).map(st => ({ st, base: st.market![k].base, target: st.market![k].target, absorbH: absorbRate(st, k, st.market![k].target) * 3600, tax: st.tax ?? 0 }));
  const ask = (k: string) => { const m = of(k); return m.length ? Math.min(...m.map(x => x.base * ASK)) : valueOf(k) * 1.6; };
  /** best long-run sale price: highest bid, weighted towards markets that actually absorb volume */
  const bid = (k: string) => { const m = of(k); return m.length ? Math.max(...m.map(x => x.base * BID * (1 - x.tax))) : 0; };
  const demandH = (k: string) => of(k).reduce((a, x) => a + x.absorbH, 0);
  /** NPC buying budget regenerating at the markets that buy this good (shared with every other good) */
  const budgetH = (k: string) => of(k).reduce((a, x) => a + (x.st.fundsMax ?? 0) * FUNDS_REGEN_H, 0);
  const totalBudgetH = ms.reduce((a, s) => a + (s.fundsMax ?? 0) * FUNDS_REGEN_H, 0);
  return { ms, of, ask, bid, demandH, budgetH, totalBudgetH };
}

export const haulerH = () => hullUpkeep('hauler').credits * 1.1 + (hullUpkeep('hauler').supplies?.chemicals ?? 0) * 35;
/** credits per unit moved one way (round trip billed) */
export const haulPerUnit = () => haulerH() * TRIP_H * 2 / ECON.hauler.cargo;

export function facilityCapex(kind: string, ask: (k: string) => number) {
  const b = facilityBuild(FACILITIES[kind], true);
  return b.credits + Object.entries(b.mats).reduce((a, [k, n]) => a + n * ask(k), 0);
}
export function stationCapex(size: 'S' | 'M', ask: (k: string) => number) {
  const s = STATION_SIZES[size]; return s.credits + Object.entries(s.mats).reduce((a, [k, n]) => a + n * ask(k), 0);
}

export interface LineEcon { recipe: string; fac: string; stage: string; outItem: string; outPerH: number; inCost: number; outBid: number; ratio: number;
  grossH: number; haulH: number; upkeepH: number; profitH: number; capex: number; paybackH: number | null; demandH: number; lines: number; budgetLines: number; ownProfitH: number }

export function stageOf(r: RecipeDef): string {
  const out = Object.keys(r.out)[0], cat = ITEMS[out]?.cat;
  if (cat === 'refined') return Object.keys(r.in).every(k => ITEMS[k]?.cat === 'raw') ? '1차 가공' : '중간재';
  if (cat === 'part') return '부품';
  if (cat === 'shippart') return '함선 부품';
  return '장비';
}

/** one production line's steady economics; station share = 1/4 of an S (or M for M-only facilities) */
export function lineEcon(w: WorldState, id: string, M = marketsOf(w)): LineEcon | undefined {
  const r = recipeFor(w, id) ?? RECIPES[id]; if (!r || r.regional) return undefined;
  const [out, n] = Object.entries(r.out)[0]; if (!ITEMS[out]) return undefined;
  const perH = 3600 / r.time;
  const inCost = Object.entries(r.in).reduce((a, [k, q]) => a + q * M.ask(k), 0);
  const outBid = M.bid(out) * n;
  const units = Object.values(r.in).reduce((a, b) => a + b, 0) + n;
  const haulH = units * haulPerUnit() * perH;
  const size = FACILITIES[r.fac]?.minStation === 'M' ? 'M' : 'S';
  const upkeepH = STATION_SIZES[size].upkeep / 4;
  const grossH = (outBid - inCost) * perH;
  const profitH = grossH - haulH - upkeepH;
  const capex = facilityCapex(r.fac, M.ask) + (stationCapex(size, M.ask) + facilityCapex('power', M.ask)) / 4;
  // own inputs at their opportunity cost (bid) instead of ask; no inbound hauling
  const own = Object.entries(r.in).reduce((a, [k, q]) => a + q * (M.bid(k) || M.ask(k)), 0);
  const ownProfitH = (outBid - own) * perH - n * haulPerUnit() * perH - upkeepH;
  const demandH = M.demandH(out), outPerH = n * perH;
  return { recipe: r.id, fac: r.fac, stage: stageOf(r), outItem: out, outPerH, inCost, outBid, ratio: outBid / inCost, grossH, haulH, upkeepH, profitH, capex,
    paybackH: profitH > 0 ? capex / profitH : null, demandH, lines: demandH / outPerH, budgetLines: M.budgetH(out) / Math.max(1, outBid * perH), ownProfitH };
}

/** a mining group: 4 miners + 1 hauler on one field, regrowth-limited, sold at bid, raw demand-capped */
export function miningEcon(w: WorldState, M = marketsOf(w)) {
  const fields = Object.values(w.fields).filter(f => !f.salvage && f.regen > 0);
  const f = fields.sort((a, b) => b.regen - a.regen)[0];
  const minedH = Math.min(4 * ECON.miner.mine * 3600, f.regen * 3600);
  const mix = f.mix ?? { [f.res]: 1 };
  let rev = 0; const per: Record<string, number> = {};
  for (const [k, share] of Object.entries(mix)) { const q = minedH * share; const sell = Math.min(q, M.demandH(k)); per[k] = Math.round(q); rev += sell * M.bid(k); }
  const upkeep = (4 * hullUpkeep('miner').credits + hullUpkeep('hauler').credits) * 1.1;
  return { field: f.id, minedH: Math.round(minedH), per, revenueH: Math.round(rev), upkeepH: Math.round(upkeep), profitH: Math.round(rev - upkeep) };
}

/** running cost of a reference fleet, credits/h (class upkeep + 10 % overhead + chemicals at market) */
export function fleetCostH(w: WorldState, ships: Record<string, number>, M = marketsOf(w)) {
  return Object.entries(ships).reduce((a, [cls, n]) => { const u = hullUpkeep(cls); return a + n * (u.credits * 1.1 + Object.entries(u.supplies ?? {}).reduce((b, [k, q]) => b + q * M.ask(k), 0)); }, 0);
}
export const SMALL_FLEET = { frigate: 4, destroyer: 2 };
export const MID_FLEET = { frigate: 4, destroyer: 4, light_cruiser: 2 };

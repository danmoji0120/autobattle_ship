// P17.4b (AUD-04 / AUD-06): sale-destination search and automatic-sale strategies.
//
// AUD-04: the automatic sale planner already chose a market (saleQuote price walk within the buyer's budget and tax,
// routeScore jumps and risk limit, docking, hauler berth) but showed the player only the winner or "조건에 맞는
// 매입 시장 없음". `saleOptions` runs the same checks for every market that trades the item and returns each one
// with its quote (units, gross, tax, net, unit price), route (jumps, risk, round-trip time), hauler fit and trip count
// — or the first reason it is ruled out. It reuses saleQuote / routeInfo / canCarry, so what the player reads is what
// the planner decides.
//
// AUD-06: a sales rule may carry a strategy. 'local' is the existing behaviour and the default (sell at the store's
// own market when it pays the floor price; otherwise ship to the best value less 6 % a jump). The others only
// change the order markets are tried in:
//   profit — every market, the store's own included, by value less 2 % a jump (the local market loses to a
//            remote one only when that pays clearly more — see PROFIT_EDGE);
//   fast   — the store's own market first, then fewest jumps, then value;
//   safe   — the store's own market first, then lowest summed route risk, then value.
// Floor price, protected stock, budgets, the company risk limit and docking rules are the same in every strategy.
import type { WorldSim } from './sim';
import type { Station, WShip } from './types';
import { qty } from './types';
import { saleQuote, routeInfo, canCarry } from './procurement';
import { priceOf } from './market';
import { econOf } from './hullops';
import { SALV_TRIP_HOP_S, SALV_TRIP_BASE_S } from './procurement';

export type SaleStrategy = 'local' | 'profit' | 'fast' | 'safe';
export const SALE_STRATEGIES: SaleStrategy[] = ['local', 'profit', 'fast', 'safe'];
export const SALE_STRATEGY_NAME: Record<SaleStrategy, string> = { local: '현지 우선', profit: '최대 순수익', fast: '빠른 판매', safe: '최소 위험' };
export const SALE_STRATEGY_DESC: Record<SaleStrategy, string> = {
  local: '보관 정거장 시장이 최저 단가 이상이면 그 자리에서 판매, 아니면 점프당 6% 할인한 판매액이 큰 시장으로 운송 (기존 동작)',
  profit: '현지 시장까지 포함해 점프당 2% 할인한 판매액이 가장 큰 곳 — 다른 시장이 현지보다 5% 이상 더 받을 때만 운송',
  fast: '현지 시장 우선, 다음은 점프 수가 가장 적은 시장',
  safe: '현지 시장 우선, 다음은 경로 위험 합계가 가장 낮은 시장',
};
/** under 'profit', a remote market must beat the local sale by this much (after its jump discount) to ship instead */
export const PROFIT_EDGE = 1.05;

export type SaleHost = Pick<WorldSim, 'st' | 'sysOf' | 'price' | 'canDock'>;

export interface SaleOption {
  station: string; name: string; system?: string; local: boolean;
  /** units this market takes now, its pre-tax and after-tax value, the after-tax average unit price */
  sold: number; gross: number; tax: number; net: number; unit: number;
  /** current after-tax bid for one unit */
  bid: number;
  hops: number; risk: number; /** estimated round trip, seconds (0 for the local market) */ trip: number;
  /** hauler trips needed for `sold` (0 for the local market) */ loads: number;
  /** why this market cannot take the lot (null = it can) */ why: string | null;
}

/** lexicographic sort keys, larger first */
function keys(strategy: SaleStrategy, o: { net: number; hops: number; risk: number; local: boolean }): number[] {
  switch (strategy) {
    case 'profit': return [o.net * Math.max(0.5, 1 - 0.02 * o.hops) * (o.local ? PROFIT_EDGE : 1)];
    case 'fast': return [o.local ? 1 : 0, -o.hops, o.net];
    case 'safe': return [o.local ? 1 : 0, -o.risk, o.net];
    default: return [o.local ? 1 : 0, o.net * Math.max(0.5, 1 - 0.06 * o.hops)];
  }
}
export function compareSale(strategy: SaleStrategy | undefined) {
  return (a: { net: number; hops: number; risk: number; local: boolean; id?: string }, b: { net: number; hops: number; risk: number; local: boolean; id?: string }) => {
    const ka = keys(strategy ?? 'local', a), kb = keys(strategy ?? 'local', b);
    for (let i = 0; i < ka.length; i++) if (Math.abs(kb[i] - ka[i]) > 1e-9) return kb[i] - ka[i];
    return a.hops - b.hops || (a.id ?? '').localeCompare(b.id ?? '');
  };
}

/**
 * Every market that trades `item`, as seen from the store `from`, for selling `amount` units no cheaper than
 * `minPrice` (after tax). `carriers` = the haulers that would carry it (berth / capacity checks; omit to skip them).
 * `promised` = credits already promised to each market by live sale shipments. Sorted: usable first, by strategy.
 */
export function saleOptions(h: SaleHost, owner: string, item: string, from: Station, amount: number, opts: { minPrice?: number; strategy?: SaleStrategy; carriers?: WShip[]; promised?: Map<string, number>; maxRisk?: number; cargoMul?: number } = {}): SaleOption[] {
  const minPrice = opts.minPrice ?? 0, maxRisk = opts.maxRisk ?? h.st.companies[owner]?.procurement?.maxRisk ?? 100;
  const lot = opts.carriers?.length ? Math.max(...opts.carriers.map(s => econOf(s).cargo * (opts.cargoMul ?? 1))) : 0;
  const out: SaleOption[] = [];
  for (const m of Object.values(h.st.stations)) {
    const mk = m.market?.[item]; if (!mk) continue;
    const local = m.id === from.id;
    if (!local && !m.public) continue;
    const tax = m.tax ?? 0, bid = priceOf(mk, 'sell', true) * (1 - tax);
    const base = { station: m.id, name: m.name, system: h.sysOf(m.pos)?.name, local, bid, sold: 0, gross: 0, tax: 0, net: 0, unit: 0, hops: 0, risk: 0, trip: 0, loads: 0 };
    let why: string | null = null;
    const route = local ? { hops: 0, risk: 0 } : routeInfo(h, from, m, maxRisk);
    if (!h.canDock(m, owner)) why = '정박 불가 (입항 거부·권한 없음)';
    else if (!route) why = `경로 없음 또는 회사 위험 한도(${maxRisk}) 초과`;
    else if (!local && opts.carriers && !canCarry(opts.carriers, from, m, false)) why = opts.carriers.length ? '수송선 정박 규격이 맞지 않음' : '운송할 공용 수송선 없음';
    const q = why ? { sold: 0, value: 0 } : saleQuote(h, m, item, amount, minPrice, opts.promised?.get(m.id) ?? 0);
    if (!why && q.sold < 1) {
      const budget = m.public && m.funds !== undefined ? m.funds - (opts.promised?.get(m.id) ?? 0) : Infinity;
      why = bid < minPrice - 1e-9 ? `최저 단가 미달 (현재 ${Math.floor(bid).toLocaleString()} cr < ${Math.ceil(minPrice).toLocaleString()} cr)`
        : budget < bid ? `정거장 매입 예산 소진 (남은 예산 ${Math.max(0, Math.floor(budget)).toLocaleString()} cr)` : '매입하지 않음';
    }
    const hops = route?.hops ?? 0, gross = tax < 1 ? q.value / (1 - tax) : 0;
    out.push({ ...base, sold: q.sold, net: q.value, gross, tax: gross - q.value, unit: q.sold ? q.value / q.sold : 0, hops, risk: route?.risk ?? 0,
      trip: local ? 0 : 2 * hops * SALV_TRIP_HOP_S + SALV_TRIP_BASE_S, loads: local || !lot ? 0 : Math.ceil(q.sold / lot), why });
  }
  const cmp = compareSale(opts.strategy);
  return out.sort((a, b) => (a.why ? 1 : 0) - (b.why ? 1 : 0) || cmp({ ...a, id: a.station }, { ...b, id: b.station }));
}

/** company-wide: units of `item` in each own store (for the search form) */
export function storesHolding(h: Pick<WorldSim, 'st'>, owner: string, item: string): { station: Station; n: number }[] {
  return Object.values(h.st.stations).map(st => ({ station: st, n: qty(st.storage[owner], item) })).filter(x => x.n >= 1).sort((a, b) => b.n - a.n);
}

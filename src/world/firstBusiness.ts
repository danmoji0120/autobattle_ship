// A-3.2a: the first business of a hauler or miner start.
//
// Pure read-only views over the world (server and client share them). Nothing here grants money, goods or
// ships: the guide only reads real markets, budgets, fields and the company's own ledger, and every action it
// offers is an ordinary command (`buy`, `poolCreate`, `accept`, `setOp`). The numbers are estimates made the
// same way the server settles a sale (chunks of 50, the price walking as stock rises, the station's buying
// budget and tax), so what the guide promises is what the market pays at that moment.
import type { Cargo, Company, Field, Station, WorldState } from './types';
import { buyCost, priceOf, tradeChunk } from './market';
import { jumps, sysAt } from './geom';
import { econOf, growthOn } from './hullops';
import { itemName } from './industry';
import { dockRefused } from './territory';
import { believedMix } from './intel';
import { BACKGROUND } from './backgrounds';
import { listedSpace, logisticsReservedSpace, publicCap, storeUsed, takesSpace } from './storage';
import { isHot, RESTRICTED_ITEMS } from './blackmarket';
import { effSec } from './security';
import { territoryRisk } from './territory';
import { usableRouteGate } from './logistics';
import { EQUIPMENT } from './industry';
import { assetReferenceValue } from './valuation';
import { coRelation } from './battleAuth';
import { hullIdOf, hullSale, shipWorth, yardHulls, yardShipPrice } from './hullops';
import { inRecovery, RECOVERY_STAGE } from './recovery';
import { CONTENT } from '../content/registry';

/** backgrounds that get the first-business guide (A-3.2a hauler/miner, A-3.2b salvager; the other three come later) */
export const FIRST_BUSINESS_BG = ['hauler', 'miner', 'salvager'] as const;
export const firstBusinessOn = (co: Company | undefined) => !!co?.background && (FIRST_BUSINESS_BG as readonly string[]).includes(co.background);
/** how far the guide looks for trades and delivery stations */
export const TRADE_JUMPS = 3, FIELD_JUMPS = 2;

const sysId = (w: WorldState, st: { pos: Station['pos'] }) => sysAt(w.systems, st.pos)?.id;
const hop = (w: WorldState, a: Station, b: Station) => { const x = sysId(w, a), y = sysId(w, b); return x && y ? jumps(w.systems, x, y) : 99; };
/** the worst system risk on the shortest route (the same measure the logistics planner uses: 0 safe … 100) */
export function routeRiskOf(w: WorldState, a: Station, b: Station): number {
  return sysRouteRisk(w, sysId(w, a), sysId(w, b));
}
/** the same measure between two systems (A-3.2b: a salvage target is a point in space, not a station) */
export function sysRouteRisk(w: WorldState, s: string | undefined, e: string | undefined): number {
  if (!s || !e) return 100;
  const r = (id: string) => { const y = w.systems[id]; return y ? Math.min(100, 100 - effSec(y) + territoryRisk(w, y)) : 100; };
  if (s === e) return r(s);
  const q = [{ id: s, risk: r(s) }], seen = new Set([s]);
  while (q.length) {
    const n = q.shift()!;
    for (const g of [...(w.systems[n.id]?.gates ?? [])].sort((x, y) => x.id.localeCompare(y.id))) {
      const nx = w.systems[g.to]; if (!nx || seen.has(nx.id) || !usableRouteGate(w, g)) continue;
      const v = { id: nx.id, risk: Math.max(n.risk, r(nx.id)) };
      if (nx.id === e) return v.risk;
      seen.add(nx.id); q.push(v);
    }
  }
  return 100;
}
export const riskLabel = (r: number) => r <= 30 ? '안전' : r <= 55 ? '주의' : '위험';

const usable = (w: WorldState, st: Station | undefined, me: string): st is Station => !!st && !!st.public && !!st.market && !dockRefused(w, st, me);
const tradable = (k: string) => !k.startsWith('bp') && !isHot(k) && !(RESTRICTED_ITEMS as readonly string[]).includes(k);

/** what selling `amount` of `item` to `st` would pay right now — the server's walk (chunks of 50, budget, tax) */
export function sellWalk(w: WorldState, st: Station, item: string, amount: number): { sold: number; value: number; lastPrice: number; budgetLimited: boolean } {
  const m = st.market?.[item]; if (!m || amount <= 0) return { sold: 0, value: 0, lastPrice: 0, budgetLimited: false };
  const v3 = growthOn(w), tax = 1 - (st.tax ?? 0), budget = v3 && st.public && st.funds !== undefined;
  const sim = { ...m }; let funds = st.funds ?? 0, left = amount, sold = 0, value = 0, p = 0, limited = false;
  while (left > 0.01) {
    let chunk = Math.min(left, v3 ? tradeChunk(m) : 50);
    p = priceOf(sim, 'sell', v3);
    if (budget) { const can = p > 0 ? funds / (p * tax) : 0; if (can < chunk) { chunk = Math.max(0, Math.floor(can)); limited = true; } if (chunk <= 0) break; funds -= chunk * p * tax; }
    value += chunk * p; sim.stock += chunk; left -= chunk; sold += chunk;
  }
  return { sold, value: value * tax, lastPrice: p, budgetLimited: limited };
}

/** free room in a company's public warehouse (what a purchase into storage may add) */
export function storeRoom(w: WorldState, st: Station, me: string): number {
  if (!st.public || !growthOn(w)) return Infinity;
  return Math.max(0, publicCap(w.companies[me], st) - storeUsed(st.storage?.[me]) - listedSpace(st, me) - logisticsReservedSpace(w, st.id, me));
}

/** the company's haulers that the logistics pool can send now, by the station they are docked at */
export function idleHaulers(w: WorldState, me: string): Record<string, { ships: number; cargo: number }> {
  const out: Record<string, { ships: number; cargo: number }> = {};
  for (const s of Object.values(w.ships)) {
    if (s.owner !== me || s.classId !== 'hauler' || s.state !== 'docked' || s.task.k !== 'docked' || s.logisticsJob || s.reserve || s.listed) continue;
    const g = w.groups[s.groupId]; if (g && g.op.k !== 'idle') continue;
    const free = econOf(s).cargo - Object.values(s.cargo).reduce((a, n) => a + (n > 0 ? n : 0), 0);
    if (free < 1) continue;
    const e = out[s.task.station] ??= { ships: 0, cargo: 0 }; e.ships++; e.cargo += free;
  }
  return out;
}

export interface TradeOption {
  from: string; to: string; item: string; jumps: number;
  /** worst system risk on the route (0 safe … 100): pirates attack haulers on risky routes */
  risk: number;
  /** price per unit at the origin now (the purchase walks up from here; `cost` is the whole walk) */
  buy: number;
  /** units the company can do now and why not more */
  amount: number; limit: string;
  cost: number; revenue: number; profit: number;
  /** price at the destination before and after selling `amount` (the walk) */
  sellNow: number; sellAfter: number;
}

/**
 * Worthwhile trades from where the company's idle haulers are. Every candidate is limited by what is real:
 * the origin's stock, the company's credits, the free hold of the haulers docked there, the warehouse room
 * the purchase lands in, and the destination's demand and buying budget. Sorted by profit.
 */
export function tradeOpportunities(w: WorldState, me: string, opts: { limit?: number; credits?: number; fleets?: Record<string, { ships: number; cargo: number }> } = {}): TradeOption[] {
  const co = w.companies[me]; if (!co || !growthOn(w)) return [];
  const credits = Math.max(0, opts.credits ?? co.credits), out: TradeOption[] = [];
  const idle = opts.fleets ?? idleHaulers(w, me);
  for (const [fromId, fleet] of Object.entries(idle)) {
    const O = w.stations[fromId]; if (!usable(w, O, me)) continue;
    const room = storeRoom(w, O, me);
    for (const D of Object.values(w.stations)) {
      if (D.id === O.id || !usable(w, D, me)) continue;
      const j = hop(w, O, D); if (j > TRADE_JUMPS) continue;
      const risk = Math.round(routeRiskOf(w, O, D));
      for (const [k, e] of Object.entries(O.market!)) {
        if (!tradable(k) || !D.market![k] || e.stock < 1) continue;
        const buy = priceOf(e, 'buy', true); if (buy <= 0) continue;
        // what the credits buy with the price rising as the origin's stock falls
        let afford = Math.min(Math.floor(e.stock), Math.floor(credits / buy));
        while (afford > 0 && buyCost(e, afford, true) > credits) afford = Math.floor(afford * 0.95);
        const caps: [number, string][] = [[Math.floor(e.stock), '출발지 재고'], [afford, '보유 자금'], [Math.floor(fleet.cargo), '대기 중 수송선 적재량'], [takesSpace(k) ? Math.floor(room) : Infinity, '출발지 보관 한도']];
        let [n, why] = caps.reduce((a, b) => (b[0] < a[0] ? b : a));
        if (n < 1) continue;
        // the best amount is where the two walks (buy up, sell down) stop adding profit
        let best: { n: number; cost: number; walk: ReturnType<typeof sellWalk> } | null = null;
        for (let a = n; a >= 1; a = a > 1 ? Math.max(1, Math.floor(a * 0.8)) : 0) {
          const walk = sellWalk(w, D, k, a); if (walk.sold < 1) continue;
          const cost = buyCost(e, walk.sold, true);
          if (!best || walk.value - cost > best.walk.value - best.cost) best = { n: walk.sold, cost, walk };
        }
        if (!best) continue;
        const profit = best.walk.value - best.cost; if (profit < 100) continue;
        if (best.n < n) why = best.walk.budgetLimited ? '도착지 구매 예산' : '도착지 가격 하락(수요)';
        n = best.n;
        out.push({ from: O.id, to: D.id, item: k, jumps: j, risk, buy, amount: n, limit: why, cost: best.cost, revenue: best.walk.value, profit, sellNow: priceOf(D.market![k], 'sell', true), sellAfter: best.walk.lastPrice });
      }
    }
  }
  out.sort((a, b) => b.profit - a.profit);
  return out.slice(0, opts.limit ?? 8);
}

export interface Relocation { station: string; from: string; jumps: number; risk: number; best: TradeOption }
/**
 * When nothing pays from where the haulers are, where to send them empty: stations up to two jumps away
 * (routes no worse than `maxRisk`) with the best trade the same haulers could start there right now.
 */
/** groups whose ships are all empty, idle haulers docked at `at` — only these can be moved without breaking a shipment */
export function movableGroups(w: WorldState, me: string, at: string): string[] {
  const out: string[] = [];
  for (const g of Object.values(w.groups)) {
    if (g.owner !== me || g.op.k !== 'idle') continue;
    const ships = Object.values(w.ships).filter(s => s.owner === me && s.groupId === g.id);
    if (ships.length && ships.every(s => s.classId === 'hauler' && s.state === 'docked' && s.task.k === 'docked' && s.task.station === at && !s.logisticsJob && !s.reserve && !s.listed && Object.values(s.cargo).every(n => n <= 0.5))) out.push(g.id);
  }
  return out;
}

export function relocationOptions(w: WorldState, me: string, maxRisk = 55): Relocation[] {
  const out: Relocation[] = [], fleets: Record<string, { ships: number; cargo: number }> = {};
  for (const s of Object.values(w.ships)) {
    if (s.owner !== me || s.task.k !== 'docked' || !movableGroups(w, me, s.task.station).includes(s.groupId)) continue;
    const e = fleets[s.task.station] ??= { ships: 0, cargo: 0 }; e.ships++; e.cargo += econOf(s).cargo;
  }
  for (const [at, fleet] of Object.entries(fleets)) {
    const A = w.stations[at]; if (!A) continue;
    for (const D of Object.values(w.stations)) {
      if (D.id === at || !usable(w, D, me)) continue;
      const j = hop(w, A, D); if (j > 2) continue;
      const risk = Math.round(routeRiskOf(w, A, D)); if (risk > maxRisk) continue;
      const best = tradeOpportunities(w, me, { fleets: { [D.id]: fleet }, limit: 6 }).find(o => o.risk <= maxRisk);
      if (best) out.push({ station: D.id, from: at, jumps: j, risk, best });
    }
  }
  out.sort((a, b) => b.best.profit - a.best.profit);
  return out.slice(0, 3);
}

export interface DeliveryOption { station: string; jumps: number; per100: number; unsold: number; funds: number; budgetLoads: number }
export interface FieldOption { field: string; name: string; jumps: number; amount: number; max: number; depleted: boolean; danger: number; mix: Cargo; deliveries: DeliveryOption[] }

/** what 100 mined units of this mix pay at a station now (unsold share: items that station does not buy) */
function loadValue(w: WorldState, st: Station, mix: Cargo): { per100: number; unsold: number } {
  let per100 = 0, unsold = 0;
  const total = Object.values(mix).reduce((a, n) => a + n, 0) || 1;
  for (const [k, f] of Object.entries(mix)) {
    const u = 100 * f / total;
    if (!st.market?.[k]) { unsold += u; continue; }
    per100 += sellWalk(w, st, k, u).value;
  }
  return { per100, unsold };
}

/** fields the company knows near its home, each with its delivery choices and what a load pays there */
export function fieldOptions(w: WorldState, me: string): FieldOption[] {
  const co = w.companies[me]; if (!co || !growthOn(w)) return [];
  const home = w.stations[co.homeStation ?? '']; if (!home) return [];
  const homeSys = sysId(w, home); if (!homeSys) return [];
  const out: FieldOption[] = [];
  for (const f of Object.values(w.fields ?? {}) as Field[]) {
    if (f.salvage) continue;
    const fs = sysAt(w.systems, f.pos)?.id; if (!fs) continue;
    const fj = jumps(w.systems, homeSys, fs); if (fj > FIELD_JUMPS) continue;
    const mix = believedMix(w, me, f), deliveries: DeliveryOption[] = [];
    for (const st of Object.values(w.stations)) {
      if (!usable(w, st, me)) continue;
      const ss = sysId(w, st); if (!ss) continue;
      const j = jumps(w.systems, fs, ss); if (j > 1) continue;
      const v = loadValue(w, st, mix); if (v.per100 <= 0) continue;
      deliveries.push({ station: st.id, jumps: j, per100: Math.round(v.per100), unsold: Math.round(v.unsold), funds: Math.round(st.funds ?? 0), budgetLoads: v.per100 > 0 ? Math.floor((st.funds ?? 0) / v.per100) : 0 });
    }
    deliveries.sort((a, b) => b.per100 - a.per100);
    out.push({ field: f.id, name: f.name, jumps: fj, amount: Math.round(f.amount), max: Math.round(f.max), depleted: f.amount < f.max * 0.1, danger: f.danger, mix, deliveries: deliveries.slice(0, 4) });
  }
  out.sort((a, b) => a.jumps - b.jumps || (b.deliveries[0]?.per100 ?? 0) - (a.deliveries[0]?.per100 ?? 0));
  return out;
}

export interface FirstPnl { income: Record<string, number>; expense: Record<string, number>; sales: Record<string, number>; net: number }
/** the company's booked cash flows since founding (hourly ledger; at most its last 48 hours) */
export function pnlSinceFounding(co: Company): FirstPnl {
  const from = Math.floor((co.createdAt ?? 0) / 3600), income: Record<string, number> = {}, expense: Record<string, number> = {}, sales: Record<string, number> = {};
  for (const b of co.ops?.ledger ?? []) {
    if (b.h < from) continue;
    for (const [k, v] of Object.entries(b.inc)) income[k] = (income[k] ?? 0) + v;
    for (const [k, v] of Object.entries(b.exp)) expense[k] = (expense[k] ?? 0) + v;
    for (const [k, v] of Object.entries(b.sales ?? {})) sales[k] = (sales[k] ?? 0) + v;
  }
  const net = Object.values(income).reduce((a, n) => a + n, 0) - Object.values(expense).reduce((a, n) => a + n, 0);
  return { income, expense, sales, net };
}

export interface FirstStatus {
  bg: string; start: number; credits: number; cash: number; debt: number; done: boolean;
  pnl: FirstPnl;
  /** goods the company owns: in warehouses and aboard its ships */
  stored: Cargo; aboard: Cargo;
  /** pool shipments (hauler) and mining groups (miner) the company runs now */
  jobs: { id: string; kind: string; from: string; to: string; item: string; amount: number; delivered: number; earned: number; state: string; reason?: string }[];
  mining: { group: string; name: string; field?: string; deliver?: string; status?: string }[];
  steps: { id: string; label: string; done: boolean }[];
  warnings: string[];
  /** A-3.2b salvager: fleets on salvage, what was recovered, its salvage contracts */
  salvage?: SalvageStatus;
}

/** the guide's progress view of the company's first business */
export function firstBusinessStatus(w: WorldState, me: string): FirstStatus | null {
  const co = w.companies[me]; if (!co || !firstBusinessOn(co)) return null;
  const bg = co.background!, start = BACKGROUND[bg]?.credits ?? 0;
  const stored: Cargo = {}, aboard: Cargo = {};
  for (const st of Object.values(w.stations)) for (const [k, n] of Object.entries(st.storage?.[me] ?? {})) if (n > 0.5 && takesSpace(k)) stored[k] = (stored[k] ?? 0) + n;
  for (const s of Object.values(w.ships)) if (s.owner === me) for (const [k, n] of Object.entries(s.cargo)) if (n > 0.5) aboard[k] = (aboard[k] ?? 0) + n;
  const jobs = Object.values(w.logisticsJobs ?? {}).filter(j => j.owner === me && !j.procurement && j.created >= (co.createdAt ?? 0)).sort((a, b) => b.created - a.created).slice(0, 6)
    .map(j => ({ id: j.id, kind: j.kind, from: j.from, to: j.to, item: j.item, amount: j.amount, delivered: j.delivered, earned: j.earned, state: j.state, reason: j.reason }));
  const mining = Object.values(w.groups).filter(g => g.owner === me && g.op.k === 'mine').map(g => { const op = g.op as Extract<typeof g.op, { k: 'mine' }>; return { group: g.id, name: g.name, field: op.field, deliver: op.deliver, status: g.status }; });
  const pnl = pnlSinceFounding(co), done = co.milestones.includes('first_profit'), sold = (pnl.income.sales ?? 0) > 0;
  const salv = bg === 'salvager' ? salvageStatus(w, me) : undefined;
  const contractPaid = (pnl.income.other ?? 0) > 0 || (salv?.contracts.some(k => k.done && !k.ended) ?? false);
  const steps = bg === 'salvager'
    ? [
      { id: 'pick', label: '인양 대상 고르기 · 인양 시작', done: !!salv && (salv.groups.some(g => g.op === 'recover' || g.op === 'salvzone') || salv.units > 0) },
      { id: 'recover', label: '현장 도착 · 회수', done: !!salv && salv.units > 0 },
      { id: 'unload', label: '정거장 하역 (또는 계약 납품)', done: co.milestones.includes('first_salvage') },
      { id: 'sell', label: '회수품 판매 · 계약 보수', done: sold || contractPaid },
      { id: 'profit', label: '운영비를 뺀 첫 순이익', done },
    ]
    : bg === 'hauler'
    ? [
      { id: 'pick', label: '거래 기회 고르기 · 화물 구매', done: (pnl.expense.purchase ?? 0) > 0 || jobs.length > 0 },
      { id: 'ship', label: '수송선 출발 (물류 작업)', done: jobs.some(j => j.state === 'active' || j.delivered > 0) || sold },
      { id: 'sell', label: '도착지 판매', done: sold },
      { id: 'profit', label: '운영비를 뺀 첫 순이익', done },
    ]
    : [
      { id: 'pick', label: '광구와 하역지 고르기', done: mining.length > 0 || co.stats.mined > 0 },
      { id: 'mine', label: '채굴선이 광석 채굴', done: co.stats.mined > 0 },
      { id: 'sell', label: '수송선이 운반 · 판매', done: sold },
      { id: 'profit', label: '운영비를 뺀 첫 순이익', done },
    ];
  const warnings: string[] = [];
  for (const g of mining) {
    const f = g.field ? w.fields?.[g.field] : undefined, st = g.deliver ? w.stations[g.deliver] : undefined;
    if (f && f.amount < f.max * 0.1) warnings.push(`${f.name} 고갈 — 재생을 기다리는 동안 다른 광구로 옮기면 수입이 이어집니다`);
    if (st && f) {
      const mix = believedMix(w, me, f), v = loadValue(w, st, mix);
      if (v.unsold >= 10) warnings.push(`${st.name}은(는) ${Object.keys(mix).filter(k => !st.market?.[k]).map(k => itemName(k)).join(', ')}을(를) 사지 않습니다 — 팔리지 않는 몫(${v.unsold}%)은 창고에 쌓입니다${Object.keys(mix).filter(k => !st.market?.[k]).every(k => w.companies[me]?.procurement?.sales?.[k]) ? ' (자동 판매 정책으로 다른 시장에 운송)' : ' — 물류 관리 › 재고 정책에서 자동 판매를 켜고 대기 편대에 수송선을 두면 다른 시장으로 운송합니다'}`);
      if (st.funds !== undefined && v.per100 > 0 && st.funds < v.per100 * 3) warnings.push(`${st.name} 구매 예산이 거의 바닥났습니다 (${Math.round(st.funds).toLocaleString()} cr) — 예산은 시간이 지나면 회복되며, 이웃 성계 하역지를 고를 수도 있습니다`);
    }
  }
  for (const [stId, cargo] of Object.entries(w.stations).map(([id, st]) => [id, st.storage?.[me]] as const)) {
    if (!cargo) continue; const st = w.stations[stId];
    const used = storeUsed(cargo), cap = st.public ? publicCap(co, st) : 0;
    if (cap > 0 && used >= cap * 0.9) warnings.push(`${st.name} 창고가 거의 찼습니다 (${Math.round(used)}/${cap}) — 재고를 팔거나 옮기지 않으면 하역이 멈춥니다`);
  }
  if (co.stats.lost > 0) warnings.push(`함선 ${co.stats.lost}척을 잃었습니다 — 실려 있던 화물도 함께 잃습니다. 위험도가 높은 항로는 피하거나 호위를 붙이세요`);
  if ((co.upkeep?.debt ?? 0) > 0) warnings.push(`운영비 미납 ${Math.round(co.upkeep!.debt).toLocaleString()} cr — 판매 대금에서 먼저 정산됩니다`);
  if (salv) {
    const equip = Object.keys(stored).filter(k => EQUIPMENT[k] || k.startsWith('bpf:'));
    if (equip.length) warnings.push(`회수한 장비·설계도 조각(${equip.map(k => k.startsWith('bpf:') ? '설계도 조각' : itemName(k)).join(', ')})은 일반 재고와 따로 보관됩니다 — 자동 판매 대상에서 빠지며, 정거장 시장이나 연구·조립에 직접 쓰세요`);
    const unsold = Object.keys(stored).filter(k => !EQUIPMENT[k] && !k.startsWith('bpf:') && !co.procurement?.sales?.[k]);
    if (unsold.length && co.milestones.includes('first_salvage')) warnings.push(`창고의 회수품(${unsold.map(k => itemName(k)).join(', ')})은 자동 판매가 꺼져 있어 쌓이기만 합니다 — 아래 '회수품 자동 판매'를 켜거나 정거장 시장에서 직접 파세요`);
  }
  return { bg, start, credits: co.credits, cash: co.credits - start, debt: co.upkeep?.debt ?? 0, done, pnl, stored, aboard, jobs, mining, steps, warnings, ...(salv ? { salvage: salv } : {}) };
}

/** server milestone: the company made money from its own business — cash above what it was founded with, no arrears */
export function firstProfitReached(co: Company): boolean {
  if (!firstBusinessOn(co) || co.milestones.includes('first_profit')) return false;
  // A-3.2b: a salvager's first business is real salvage unloaded (or handed over) and then the first net profit
  if (co.background === 'salvager' && !co.milestones.includes('first_salvage')) return false;
  const start = BACKGROUND[co.background!]?.credits ?? Infinity;
  return co.credits > start && !(co.upkeep?.debt ?? 0);
}

// ───────────────────────────── A-3.2b salvager

/** how far the salvager's guide looks for targets (jumps from home or from its fleets) */
export const SALVAGE_JUMPS = 3;
/** goods the guide offers to put on automatic sale after salvage (equipment and blueprint fragments stay apart) */
export const SALVAGE_SELL_ITEMS = ['alloy', 'metal', 'electronics', 'machinery', 'weapon_parts', 'titanium', 'ore'] as const;
/** what each starting hull does on a site (units per second, P13.1 SALV.rate) */
export const SALVAGE_ROLES: Record<string, string> = {
  hauler: '화물 회수 초당 8 · 450칸 적재 — 회수품을 싣고 하역',
  miner: '선체 해체 초당 5 · 140칸 — 고철(합금·금속 등) 담당',
  constructor: '선체 3 · 화물 5 · 장비 0.1 · 설계도 조각 0.05 — 장비·조각은 공작선만',
};

type SiteLot = { k: string; item: string; n: number; owner: string };
type SiteView = { id: string; name: string; system: string; pos: Station['pos']; expires: number; created?: number; eng?: string; lots?: SiteLot[]; origin?: string; grade?: string; est?: number; main?: string[]; contract?: string; size?: number; left?: number; ships?: number };

export interface SalvageOption {
  id: string; name: string; kind: 'derelict' | 'wreck' | 'drop'; grade?: string;
  system: string; jumps: number; sec: number; risk: number;
  /** reference value of what the company may take legally (known lots), else the public survey estimate */
  value: number; known: boolean; main: string[]; units?: number;
  /** another company's cargo aboard: skipped by a normal order, a crime if taken on purpose */
  protectedCargo: boolean;
  expiresIn: number;
  contract?: { id: string; title: string; reward: number; res?: string; amount?: number; station: string; mine: boolean; taken: boolean };
  /** A-3.2b.1: route-risk band — safe ≤ 30 (recommended for a beginner), caution 31–55 (asks first), danger > 55 (strong warning) */
  band: RiskBand;
  /** A-3.2b.1: hostile armed ships the company can currently see — at the site (within SITE_THREAT_R) and elsewhere in its system */
  threat: { near: number; system: number };
  /** safe band and nothing hostile seen at the site */
  recommended: boolean;
  /**
   * A-3.2b.2: battlefield wrecks only — when the battle that made it ended (public: the wreck's creation time) and
   * whether a fight this state can see is going on at the site now. `recent`: ended less than RECENT_BATTLE_S ago
   * or still fighting — the risk may remain even when no hostile fleet is visible.
   */
  battle?: { ago: number; fighting: boolean; recent: boolean };
}

/** A-3.2b.2: how long after the battle a battlefield wreck still counts as a "recent battle" (30 game minutes) */
export const RECENT_BATTLE_S = 1800;

/** A-3.2b.1: route-risk bands of the salvager's guide */
export type RiskBand = 'safe' | 'caution' | 'danger';
export const RISK_SAFE = 30, RISK_CAUTION = 55;
export const riskBand = (risk: number): RiskBand => risk <= RISK_SAFE ? 'safe' : risk <= RISK_CAUTION ? 'caution' : 'danger';
/** distance from a site within which a hostile armed fleet counts as "at the site" (P13.1 SALV.hostileR is 5,000) */
export const SITE_THREAT_R = 8000;
/**
 * A-3.2b.1: the question asked before sending the salvage fleet (null: no question). It never refuses or swaps
 * the target — the player decides. Danger (route risk > 55): strong warning. Caution (31–55) or hostile armed
 * ships seen at the site even on a safe route: a confirmation.
 */
export function salvageConfirm(o: Pick<SalvageOption, 'name' | 'risk' | 'band' | 'threat' | 'battle'>): string | null {
  const b = o.battle?.recent ? battleNote(o.battle) : '';
  const t = (o.threat.near ? ` 현장 반경 ${SITE_THREAT_R / 1000}k 안에 적대 무장 함선 ${o.threat.near}척이 보입니다(경로 위험과 별개).` : o.threat.system ? ` 같은 성계에 적대 무장 함선 ${o.threat.system}척이 보입니다.` : '') + b;
  if (o.band === 'danger') return `${o.name}: 경로 위험 ${o.risk} (위험) — 호위 없는 인양선은 격침될 수 있고 실린 화물도 잃습니다.${t} 그래도 보낼까요?`;
  if (o.band === 'caution') return `${o.name}: 경로 위험 ${o.risk} (주의) — 초보 인양반에는 위험 30 이하 대상을 권장합니다. 해적·적대 함대를 만나면 함선을 잃을 수 있습니다.${t} 보낼까요?`;
  if (o.threat.near) return `${o.name}: 경로는 안전(위험 ${o.risk})하지만${t} 도착하면 공격받을 수 있습니다. 보낼까요?`;
  if (b) return `${o.name}: 경로는 안전(위험 ${o.risk})합니다.${b} 지금 보이는 적대 함대는 없지만 전투를 벌인 세력이 근처에 남아 있을 수 있습니다. 보낼까요?`;
  return null;
}
/** A-3.2b.2: the recent-battle sentence — the battle time only, never who fought or where they went */
export function battleNote(b: NonNullable<SalvageOption['battle']>): string {
  return b.fighting ? ' 현장에서 교전이 진행 중입니다.' : ` ${Math.max(1, Math.round(b.ago / 60))}분 전에 이곳에서 전투가 있었습니다.`;
}
/**
 * Hostile armed ships near a point, from what this state holds. On a client that is what the company can see
 * (its interest area), on the server everything. Separate from the route risk, which is the systems' standing
 * security and territory; this is the fleets there right now.
 */
export function knownThreat(w: WorldState, me: string, system: string, pos: Station['pos']): { near: number; system: number } {
  let near = 0, sys = 0;
  for (const g of Object.values(w.groups ?? {})) {
    if (g.owner === me || coRelation(w as never, me, g.owner) !== -1) continue;
    for (const id of g.shipIds) {
      const x = w.ships[id];
      if (!x || x.state === 'docked' || !econOf(x).military) continue;
      if (sysAt(w.systems, x.pos)?.id !== system) continue;
      const d = Math.hypot(x.pos.x - pos.x, x.pos.z - pos.z);
      if (d <= SITE_THREAT_R) near++; else sys++;
    }
  }
  return { near, system: sys };
}

/**
 * A-3.2b.2: the recent-battle record of a battlefield wreck, from what this state already holds — the wreck's
 * public creation time and the engagements this state carries (a client only receives fights it can see or takes
 * part in). Nothing about the fleets involved is added.
 */
function battleAt(w: WorldState, x: { created: number; pos: Station['pos'] }): NonNullable<SalvageOption['battle']> {
  const ago = Math.max(0, w.time - x.created);
  const fighting = Object.values(w.engagements ?? {}).some(e => !e.done && Math.hypot(e.pos.x - x.pos.x, e.pos.z - x.pos.z) <= SITE_THREAT_R);
  return { ago, fighting, recent: fighting || ago < RECENT_BATTLE_S };
}

const lotVal = (w: WorldState, item: string) => item.startsWith('bpf:') ? 500 : assetReferenceValue(w, item);
/** home and the systems the company's ships are in */
function anchors(w: WorldState, me: string): string[] {
  const co = w.companies[me], out = new Set<string>();
  const home = w.stations[co?.homeStation ?? '']; const hs = home && sysId(w, home); if (hs) out.add(hs);
  for (const s of Object.values(w.ships)) if (s.owner === me) { const x = sysAt(w.systems, s.pos)?.id; if (x) out.add(x); }
  return [...out];
}

/** salvage targets near the company: natural derelicts, battlefield wrecks and jettisoned cargo it can see */
export function salvageOpportunities(w: WorldState, me: string): SalvageOption[] {
  const co = w.companies[me]; if (!co) return [];
  const from = anchors(w, me); if (!from.length) return [];
  const home = sysId(w, w.stations[co.homeStation ?? ''] ?? { pos: { x: 0, y: 0, z: 0 } }) ?? from[0];
  const sites: SiteView[] = [...Object.values(w.wrecks ?? {}) as unknown as SiteView[], ...Object.values((w as { drops?: Record<string, SiteView> }).drops ?? {})];
  const out: SalvageOption[] = [];
  for (const x of sites) {
    const sys = w.systems[x.system]; if (!sys) continue;
    const j = Math.min(...from.map(f => jumps(w.systems, f, x.system))); if (j > SALVAGE_JUMPS) continue;
    const lots = x.lots, kind: SalvageOption['kind'] = x.origin === 'derelict' ? 'derelict' : (w as { drops?: Record<string, unknown> }).drops?.[x.id] ? 'drop' : 'wreck';
    let value = 0, units = 0, prot = false;
    if (lots) for (const l of lots) {
      if (l.n < 1) continue;
      const other = l.k === 'cargo' && !!l.owner && l.owner !== me && l.owner !== 'pirates' && w.companies[l.owner]?.kind !== 'pirate' && !!w.companies[l.owner];
      if (other) { prot = true; continue; }
      value += l.n * lotVal(w, l.item); units += l.n;
    }
    const known = !!lots;
    if (known && units < 1) continue;
    const main = known ? [...new Set([...(lots ?? [])].filter(l => l.n > 0).sort((a, b) => b.n * lotVal(w, b.item) - a.n * lotVal(w, a.item)).map(l => l.item.startsWith('bpf:') ? 'bpf' : l.item))].slice(0, 3) : x.main ?? [];
    const k = x.contract ? w.contracts?.[x.contract] : undefined;
    const risk = Math.round(sysRouteRisk(w, home, x.system)), threat = knownThreat(w, me, x.system, x.pos), band = riskBand(risk);
    const battle = kind === 'wreck' && x.created !== undefined ? battleAt(w, x as SiteView & { created: number }) : undefined;
    out.push({
      band, threat, recommended: band === 'safe' && threat.near === 0 && !battle?.recent, ...(battle ? { battle } : {}),
      id: x.id, name: x.name, kind, grade: x.grade, system: x.system, jumps: j, sec: Math.round(effSec(sys)), risk,
      value: Math.round(known ? value : x.est ?? 0), known, main, units: known ? units : undefined, protectedCargo: prot, expiresIn: Math.max(0, x.expires - w.time),
      ...(k && !k.done ? { contract: { id: k.id, title: k.title, reward: k.reward, res: k.res, amount: k.amount, station: k.stationId, mine: k.takenBy === me, taken: !!k.takenBy } } : {}),
    });
  }
  // A-3.2b.1: recommended (route risk ≤ 30, nobody hostile seen at the site; A-3.2b.2: no recent battle) first, then caution, then danger; near, then value
  const rank = (o: SalvageOption) => (o.recommended ? 0 : o.band === 'safe' ? 1 : o.band === 'caution' ? 2 : 3);
  return out.sort((a, b) => rank(a) - rank(b) || a.jumps - b.jumps || b.value - a.value).slice(0, 10);
}

export interface SalvageStatus {
  groups: { group: string; name: string; op: string; target?: string; status?: string; ships: string[] }[];
  units: number; value: number; items: Cargo;
  /** salvaged goods aboard (not yet unloaded) */
  aboard: Cargo;
  contracts: { id: string; title: string; station: string; res?: string; amount?: number; progress: number; reward: number; expiresIn: number; done: boolean; ended?: string; target?: string }[];
  /** open salvage contracts on the boards near the company (not taken by anyone) */
  board: { id: string; title: string; station: string; reward: number; res?: string; amount?: number; target?: string; jumps: number; risk: number }[];
}

export function salvageStatus(w: WorldState, me: string): SalvageStatus {
  const co = w.companies[me], ships = Object.values(w.ships).filter(s => s.owner === me);
  const groups = Object.values(w.groups).filter(g => g.owner === me && ships.some(s => s.groupId === g.id)).map(g => ({
    group: g.id, name: g.name, op: g.op.k, target: g.op.k === 'recover' ? (g.op as { wreck: string }).wreck : undefined, status: g.status,
    ships: ships.filter(s => s.groupId === g.id).map(s => s.classId),
  }));
  const aboard: Cargo = {};
  for (const s of ships) for (const [k, n] of Object.entries(s.salvaged ?? {})) { const v = Math.min(n, s.cargo[k] ?? 0); if (v > 0.5) aboard[k] = (aboard[k] ?? 0) + v; }
  const home = w.stations[co?.homeStation ?? ''], hs = home ? sysId(w, home) : undefined;
  const contracts = Object.values(w.contracts ?? {}).filter(k => k.kind === 'salvage' && k.takenBy === me).sort((a, b) => b.expires - a.expires).slice(0, 4)
    .map(k => ({ id: k.id, title: k.title, station: k.stationId, res: k.res, amount: k.amount, progress: k.progress, reward: k.reward, expiresIn: Math.max(0, k.expires - w.time), done: k.done, ended: k.ended, target: k.target }));
  const board = Object.values(w.contracts ?? {}).filter(k => k.kind === 'salvage' && !k.done && !k.takenBy).map(k => {
    const st = w.stations[k.stationId], ss = st ? sysId(w, st) : undefined, x = k.target ? (w.wrecks?.[k.target] as unknown as SiteView | undefined) : undefined;
    return { id: k.id, title: k.title, station: k.stationId, reward: k.reward, res: k.res, amount: k.amount, target: k.target, jumps: hs && ss ? jumps(w.systems, hs, ss) : 99, risk: Math.round(sysRouteRisk(w, hs, x?.system ?? ss)) };
  }).filter(k => k.jumps <= SALVAGE_JUMPS).sort((a, b) => a.jumps - b.jumps || a.risk - b.risk).slice(0, 5);
  const r = co?.salvage;
  return { groups, units: r?.units ?? 0, value: Math.round(r?.value ?? 0), items: { ...(r?.items ?? {}) }, aboard, contracts, board };
}

// ───────────────────────────── A-3.2b.1 salvager business continuity

/** hulls a salvager can buy back to keep working (the founding fleet's hulls) */
export const SALVAGE_REBUY = ['miner_mk1', 'hauler_mk1', 'constructor_s'] as const;
/** how far from home the guide looks for a yard selling them */
export const REBUY_JUMPS = 3;
/** a hauler below this hull share is not sent on automatic runs (haulers.ts HAULER_MIN_HP) */
const HAULER_DISPATCH_HP = 0.4;

export type SalvageOpState = 'ok' | 'limited' | 'transport' | 'halted';
export const SALVAGE_OP_NAME: Record<SalvageOpState, string> = { ok: '정상 운영', limited: '능력 부족', transport: '운송 병목', halted: '사업 중단' };
export interface SalvageOpStatus {
  state: SalvageOpState;
  /** what the fleet can still do on a site */
  can: { hull: boolean; cargo: boolean; equip: boolean; frag: boolean };
  /** civilian ships able to work a site, haulers fit to carry goods to a market */
  workers: number; haulers: number; damagedHaulers: number;
  lost: number;
  issues: string[];
  /** filled when the business is halted or short of a role: cash, arrears and what a replacement costs nearby */
  comeback?: SalvageComeback;
}
export interface SalvageComeback {
  credits: number; debt: number; stage: number; inRecovery: boolean;
  /** reference value of goods in the company's warehouses that are on automatic sale (cash that selling would bring, roughly) */
  stockValue: number;
  offers: { station: string; jumps: number; hull: string; name: string; price: number; stock: number; affordable: boolean; role: string }[];
  steps: string[];
}

const roleOfShip = (s: { classId: string; hull?: string; variant?: string }) => {
  const e = econOf(s);
  return e.military ? 'military' : s.classId === 'constructor' ? 'constructor' : s.classId === 'miner' ? 'miner' : s.classId === 'hauler' || e.cargo > 0 ? 'hauler' : 'other';
};
const ROLE_NAME: Record<string, string> = { miner_mk1: '선체 해체', hauler_mk1: '화물 회수·운송', constructor_s: '장비·설계도 조각·선체' };

/**
 * A-3.2b.1: what the salvager can do right now, apart from the milestones it already reached (those stay):
 *  - halted: no civilian ship left that can work a site
 *  - limited: hull scrap (miner/constructor) or equipment (constructor) can no longer be taken
 *  - transport: no hauler fit to carry goods to a market that buys them (lost, or below the dispatch hull share)
 *  - ok: otherwise
 * Same rates as the salvage engine (P13.1 SALV.rate): cargo — any civilian; hull — miner, constructor; equipment
 * and fragments — constructor (warships take a little cargo and equipment but are not counted as a salvage fleet).
 */
export function salvageOperatingStatus(w: WorldState, me: string): SalvageOpStatus {
  const co = w.companies[me];
  const ships = Object.values(w.ships).filter(s => s.owner === me && s.state !== 'building');
  const civ = ships.map(s => ({ s, role: roleOfShip(s) })).filter(x => x.role !== 'military' && x.role !== 'other');
  const can = { hull: civ.some(x => x.role === 'miner' || x.role === 'constructor'), cargo: civ.length > 0, equip: civ.some(x => x.role === 'constructor'), frag: civ.some(x => x.role === 'constructor') };
  const hs = civ.filter(x => x.role === 'hauler'), fit = hs.filter(x => x.s.hp >= HAULER_DISPATCH_HP);
  const issues: string[] = [];
  let state: SalvageOpState = 'ok';
  if (!civ.length) { state = 'halted'; issues.push('회수할 수 있는 작업선이 모두 없습니다 — 새 인양은 할 수 없습니다'); }
  else {
    if (!can.hull) issues.push('선체 해체 불가 — 채굴선·공작선이 없어 고철(합금·금속 등)을 떼어 내지 못합니다');
    if (!can.equip) issues.push('장비·설계도 조각 회수 불가 — 공작선이 없습니다');
    if (!can.hull || !can.equip) state = 'limited';
    if (!fit.length) {
      issues.push(hs.length ? `수송선 손상(내구 ${Math.round(Math.max(...hs.map(x => x.s.hp)) * 100)}%) — 수리 전에는 회수품을 다른 시장으로 운송하지 못합니다` : '수송선 없음 — 하역지 시장이 사지 않는 회수품을 다른 시장으로 옮길 수 없습니다');
      if (state === 'ok') state = 'transport';
    }
  }
  const out: SalvageOpStatus = { state, can, workers: civ.length, haulers: fit.length, damagedHaulers: hs.length - fit.length, lost: co?.stats?.lost ?? 0, issues };
  if (co && state !== 'ok') out.comeback = salvageComeback(w, me, can, fit.length > 0);
  return out;
}

/** cash, arrears and replacement hulls near home (public yards, real stock and price) */
function salvageComeback(w: WorldState, me: string, can: SalvageOpStatus['can'], hauler: boolean): SalvageComeback {
  const co = w.companies[me], home = w.stations[co.homeStation ?? ''], hs = home ? sysId(w, home) : undefined;
  const debt = co.upkeep?.debt ?? 0, stage = co.upkeep?.stage ?? 0;
  let stockValue = 0;
  for (const st of Object.values(w.stations)) for (const [k, n] of Object.entries(st.storage?.[me] ?? {})) if (n > 0.5 && co.procurement?.sales?.[k]) stockValue += n * assetReferenceValue(w, k);
  const want = SALVAGE_REBUY.filter(h => h === 'miner_mk1' ? !can.hull : h === 'constructor_s' ? !can.equip : !hauler);
  const offers: SalvageComeback['offers'] = [];
  for (const st of Object.values(w.stations)) {
    if (!st.public || !hs) continue;
    const ss = sysId(w, st); if (!ss) continue;
    const j = jumps(w.systems, hs, ss); if (j > REBUY_JUMPS) continue;
    const sells = yardHulls(st);
    for (const hull of want) {
      if (!sells.includes(hull) || !hullSale(hull)) continue;
      const stock = st.shipStock?.[hull]?.n ?? hullSale(hull)!.stock ?? 0;
      if (stock < 1) continue;
      const price = yardShipPrice(st, hull);
      offers.push({ station: st.id, jumps: j, hull, name: CONTENT.hulls[hull]?.name ?? hull, price, stock, affordable: co.credits >= price, role: ROLE_NAME[hull] ?? '' });
    }
  }
  offers.sort((a, b) => a.price - b.price || a.jumps - b.jumps);
  const cheapest = new Map<string, (typeof offers)[number]>();
  for (const o of offers) if (!cheapest.has(o.hull)) cheapest.set(o.hull, o);
  const steps: string[] = [];
  const rec = inRecovery(co);
  if (rec || stage >= RECOVERY_STAGE) steps.push(`운영비 체납 ${stage}단계(미납 ${Math.round(debt).toLocaleString()} cr) — 상단 운영비 패널의 회생 블록에서 남은 함선 회생 운항·긴급 매각·긴급 교환을 쓸 수 있습니다 (A-2.1)`);
  else if (debt > 1) steps.push(`운영비 미납 ${Math.round(debt).toLocaleString()} cr — 판매 대금에서 먼저 정산됩니다`);
  if (stockValue >= 1) steps.push(`창고의 회수품(기준가 약 ${Math.round(stockValue).toLocaleString()} cr)은 자동 판매 대상입니다 — 수송선이 없으면 하역지 시장이 사는 품목만 팔립니다`);
  const buyable = [...cheapest.values()].filter(o => o.affordable);
  if (buyable.length) steps.push(`대체 함선 구입 가능: ${buyable.map(o => `${o.name} ${o.price.toLocaleString()} cr (${w.stations[o.station]?.name ?? o.station}${o.jumps ? ` · ${o.jumps}점프` : ''})`).join(', ')} — 정거장 조선소 탭에서 구입한 뒤 인양반 편대에 넣으세요`);
  else if (cheapest.size) { const c = [...cheapest.values()].sort((a, b) => a.price - b.price)[0]; steps.push(`가장 싼 대체 함선 ${c.name} ${c.price.toLocaleString()} cr — 자금 ${Math.round(co.credits).toLocaleString()} cr로는 부족합니다 (${Math.round(c.price - co.credits).toLocaleString()} cr 더 필요)`); }
  else if (want.length) steps.push(`${REBUY_JUMPS}점프 안 공영 조선소에 대체 함선 재고가 없습니다 — 재고가 다시 생기면 구입할 수 있습니다`);
  if (!buyable.length && !(rec || stage >= RECOVERY_STAGE)) steps.push('자금이 모자라면 남은 함선을 거래소 매물로 내놓을 수 있고(정박 중), 운영비 체납이 3단계가 되면 회생 수단(긴급 매각·긴급 교환·회생 운항)이 열립니다');
  return { credits: co.credits, debt, stage, inRecovery: rec, stockValue: Math.round(stockValue), offers: [...cheapest.values()], steps };
}

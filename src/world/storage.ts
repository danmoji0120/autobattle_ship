// Public station services (growth, contentV ≥ 3, rev 2). A public station is where a young company
// starts — it stores goods, repairs ships and trades — but it is not built to carry an industry:
//
//  - storage: every company gets a small free allowance per station, plus leased blocks at an hourly
//    rent (a station leases only so many blocks to one company). Over the limit, nothing new comes in
//    (unloads keep the rest aboard, purchases are refused) — but nothing already stored is ever
//    removed: an old save over its new limit just stops taking more until it is drawn down.
//  - repair: a station's docks can maintain only so many hull-points per hour for everyone together.
//    A crowded dock maintains part of the wear; the rest waits. A company's own repair bays and
//    hangars give it its own capacity, so a big fleet needs its own maintenance base.
//  - each station is different (cheap and cramped frontier docks, the capital's big but costly yards,
//    the Guild exchange's warehouses) — see SERVICES.
//
// Own stations have none of these limits beyond their own modules (core 20,000 + warehouses 30,000
// each, repair bays, hangars), which is the point: the answer to a full public warehouse is a station.
// Pure helpers; the sim applies them. Below contentV 3 nothing here is consulted.
import { emit } from './observe';
import { moneyUnits, moneyNumber, upkeepAccount, debtUnits, addDebt, chargeTotals, paidTotals, payDebt } from './money';
import type { Cargo, Company, Station, WorldState, WShip } from './types';
import { queueShortfall } from './construction';
import { qty } from './types';
import { econOf } from './hullops';
import { sizeRank } from '../content/schema';

export interface StationService {
  /** free storage per company (units) */
  store: number;
  /** rent per leased block per hour (credits) */
  lease: number;
  /** blocks one company may lease here */
  blocks: number;
  /** maintenance capacity for all companies together (hull-points per hour) */
  repair: number;
  /** repair price multiplier */
  fee: number;
  note: string;
}
export const LEASE_BLOCK = 2000;
export const SERVICES: Record<string, StationService> = {
  astra:    { store: 3000, lease: 70,  blocks: 4, repair: 16, fee: 1.0,  note: '신생 회사의 출발점. 창고가 좁고 정비소가 늘 붐빈다.' },
  helios:   { store: 4000, lease: 140, blocks: 6, repair: 44, fee: 1.25, note: '연합 수도. 정비 여력이 가장 크지만 임대료가 비싸다.' },
  exchange: { store: 6000, lease: 90,  blocks: 8, repair: 12, fee: 1.1,  note: '길드 거래소. 창고는 넉넉하지만 정비 시설은 빈약하다.' },
  nova:     { store: 2500, lease: 80,  blocks: 4, repair: 10, fee: 1.0,  note: '상업 중계항. 창고·정비 모두 중간.' },
  barcaco:  { store: 3000, lease: 55,  blocks: 5, repair: 18, fee: 0.9,  note: '채광 조합 본거지. 광석 보관 임대료가 싸다.' },
  bastion:  { store: 2500, lease: 110, blocks: 4, repair: 34, fee: 1.1,  note: '연합 군항. 정비 우수, 민간 창고는 비싸고 좁다.' },
  rustport: { store: 2000, lease: 45,  blocks: 3, repair: 8,  fee: 0.8,  note: '변경 자유항. 싸지만 좁고 정비가 느리다.' },
  drakeout: { store: 2000, lease: 50,  blocks: 3, repair: 10, fee: 0.9,  note: '변경 전초기지. 좁고 위험한 항로 끝.' },
  cinderco: { store: 2000, lease: 50,  blocks: 3, repair: 10, fee: 0.9,  note: '변경 정제항. 좁고 위험한 항로 끝.' },
};
const DEFAULT: StationService = { store: 2000, lease: 60, blocks: 3, repair: 10, fee: 1, note: '' };
export const serviceOf = (st: Station): StationService => SERVICES[st.id] ?? DEFAULT;

/** goods that take warehouse space (blueprint copies and fragments are records, not cargo) */
export const takesSpace = (k: string) => !k.startsWith('bpf:') && !k.startsWith('bp:');
export function storeUsed(S: Cargo | undefined): number { let n = 0; if (S) for (const k in S) if (takesSpace(k) && S[k] > 0) n += S[k]; return n; }

export const leasedAt = (co: Company | undefined, st: string) => co?.leases?.[st] ?? 0;
/** a company's storage limit at a public station (free allowance + leased blocks) */
export const publicCap = (co: Company | undefined, st: Station) => serviceOf(st).store + leasedAt(co, st.id) * LEASE_BLOCK;

/** rent per hour for all of a company's leases */
export function leaseRate(w: WorldState, co: Company): number {
  let r = 0;
  for (const [id, n] of Object.entries(co.leases ?? {})) { const st = w.stations[id]; if (st && n > 0) r += n * serviceOf(st).lease; }
  return r;
}

/** change the number of leased blocks. Taking a block pays its first hour now. Releasing is always
 *  allowed — goods over the new limit stay, only new intake stops. */
export function setLease(w: WorldState, co: Company, st: Station, blocks: number): string | null {
  if ((w.contentV ?? 0) < 3 || co.kind !== 'player') return '이 월드에서는 창고를 임대할 수 없습니다';
  if (!Number.isFinite(blocks) || !Number.isInteger(blocks) || blocks < 0) return '임대 구획은 0 이상의 정수여야 합니다';
  if (!st.public) return '자사 정거장은 창고 모듈로 확장합니다';
  const sv = serviceOf(st);
  const n = Math.max(0, Math.min(sv.blocks, Math.floor(blocks)));
  if (blocks > sv.blocks) return `${st.name}은(는) 한 회사에 최대 ${sv.blocks}구획(${(sv.blocks * LEASE_BLOCK).toLocaleString()})까지만 임대합니다 — 더 필요하면 자체 정거장을 지으세요`;
  advanceRent(w, co, w.time, true);
  const cur = leasedAt(co, st.id);
  if (n === cur) return '변경 없음';
  if (n > cur) {
    if (debtUnits(upkeepAccount(co)) > 0n) return '미납금 정산 후 새 구획을 임대할 수 있습니다 — 보관 물품 판매대금으로 우선 정산하거나 운영비 화면에서 납부하세요';
    const first = (n - cur) * sv.lease;
    if (co.credits < first) return `자금 부족 — 첫 시간 임대료 ${first.toLocaleString()} cr 필요`;
    co.credits -= first;
    const u = upkeepAccount(co), units = moneyUnits(first);
    u.rent!.prepaidU = (BigInt(u.rent!.prepaidU) + units).toString();
    u.rent!.billChargeU = (BigInt(u.rent!.billChargeU) + units).toString();
    chargeTotals(co, units); paidTotals(co, units);
    emit(w, { kind: 'cost', reason: 'warehouse_rent', amount: first, company: co.id, station: st.id });
  }
  const paid = (co.leasePaidUntil ??= {})[st.id] ?? Array(cur).fill(w.time);
  // Return newest blocks first; already accrued rent is never refunded or erased.
  paid.length = Math.min(paid.length, n);
  while (paid.length < n) paid.push(w.time + 3600);
  co.leasePaidUntil[st.id] = paid;
  if (!n) delete co.leasePaidUntil[st.id];
  (co.leases ??= {})[st.id] = n;
  if (!n) delete co.leases[st.id];
  return null;
}

/** hull-points one maintenance of `fix` wear takes: bigger hulls take far more dock time */
export const DOCK_WEIGHT = [1, 2.5, 7, 18];
export const repairPoints = (s: WShip, fix: number) => fix * 10 * (DOCK_WEIGHT[sizeRank(econOf(s).berth)] ?? 1);

/** own-station maintenance capacity (hull-points/h): repair bays and hangars */
export const OWN_REPAIR = { repair: 30, hangar: 20 };
export function ownRepairCap(st: Station): number {
  let c = 0;
  for (const m of st.modules) if (m.built) c += (OWN_REPAIR as Record<string, number>)[m.kind] ?? 0;
  return c;
}

/** maintenance capacity left now at a station (refills continuously up to one hour's worth) */
export function dockCapacity(w: WorldState, st: Station): number {
  const cap = st.public ? serviceOf(st).repair : ownRepairCap(st);
  if (cap <= 0) return 0;
  const d = (st.dockCap ??= { left: cap, t: w.time });
  d.left = Math.min(cap, d.left + cap * (w.time - d.t) / 3600);
  d.t = w.time;
  return d.left;
}
export function useDock(st: Station, pts: number) { if (st.dockCap) st.dockCap.left = Math.max(0, st.dockCap.left - pts); }

/** Exact rent ledger. Simulation time is integrated on absolute 250ms boundaries, independently
 * of caller dt or the 60s statement interval. Lease changes flush the final partial boundary first.
 * Unknown historical rent is never invented when an old save first acquires this clock. */
export function advanceRent(w: WorldState, co: Company, start: number, flush = false): Record<string, number> | undefined {
  if ((w.contentV ?? 0) < 3 || co.kind !== 'player') return;
  const u = upkeepAccount(co);
  if (!u.rent) {
    u.rent = { lastMs: Math.round(start * 1000), remainder: '0', debtU: '0', accruedU: '0', prepaidU: '0', paidU: '0', billChargeU: '0' };
    // Earlier versions accumulated this known rent in acc. Move it once, without charging twice.
    const old = moneyUnits(Math.max(0, u.leaseAcc ?? 0));
    if (old > 0n) {
      u.acc = Math.max(0, u.acc - moneyNumber(old)); u.leaseAcc = 0;
      addDebt(co, old, start); chargeTotals(co, old);
      u.rent.debtU = old.toString(); u.rent.accruedU = old.toString(); u.rent.billChargeU = old.toString();
      u.rent.sinceMs = Math.round(start * 1000);
    }
  }
  const r = u.rent, now = Math.round(w.time * 1000), end = flush ? now : Math.floor(now / 250) * 250;
  let cancelled: Record<string, number> | undefined;
  while (r.lastMs < end) {
    // A payment before this update can resolve an earlier overdue balance.
    payDebt(w, co, 'rent', undefined, true);
    if (r.sinceMs !== undefined && r.lastMs >= r.sinceMs + 3_600_000) {
      const blocks = Object.fromEntries(Object.entries(co.leases ?? {}).filter(([, n]) => n > 0));
      if (Object.keys(blocks).length) {
        cancelled = blocks; r.cancelled = { t: r.lastMs / 1000, blocks };
        co.leases = {}; co.leasePaidUntil = {};
      }
    }
    if (!Object.values(co.leases ?? {}).some(n => n > 0)) { r.lastMs = end; break; }
    let until = Math.min(end, (Math.floor(r.lastMs / 250) + 1) * 250);
    if (r.sinceMs !== undefined) until = Math.min(until, r.sinceMs + 3_600_000);
    let numerator = BigInt(r.remainder);
    for (const [id, n] of Object.entries(co.leases ?? {})) {
      const st = w.stations[id]; if (!st || n <= 0) continue;
      const paid = co.leasePaidUntil?.[id] ?? [];
      for (let i = 0; i < n; i++) {
        const elapsed = Math.max(0, until - Math.max(r.lastMs, Math.round((paid[i] ?? 0) * 1000)));
        numerator += moneyUnits(serviceOf(st).lease) * BigInt(elapsed);
      }
    }
    const units = numerator / 3_600_000n; r.remainder = (numerator % 3_600_000n).toString();
    if (units > 0n) {
      addDebt(co, units, r.lastMs / 1000); chargeTotals(co, units);
      r.debtU = (BigInt(r.debtU) + units).toString();
      r.accruedU = (BigInt(r.accruedU) + units).toString();
      r.billChargeU = (BigInt(r.billChargeU) + units).toString();
      if (r.sinceMs === undefined) r.sinceMs = r.lastMs;
      payDebt(w, co, 'rent', undefined, true);
    }
    r.lastMs = until;
  }
  // The final boundary itself may be the termination deadline.
  if (r.sinceMs !== undefined && end >= r.sinceMs + 3_600_000 && Object.values(co.leases ?? {}).some(n => n > 0)) {
    cancelled = Object.fromEntries(Object.entries(co.leases ?? {}).filter(([, n]) => n > 0));
    r.cancelled = { t: (r.sinceMs + 3_600_000) / 1000, blocks: cancelled };
    co.leases = {}; co.leasePaidUntil = {};
  }
  return cancelled;
}

/** Pure interval quote for forecasts/tests. Authoritative charges use advanceRent exclusively. */
export function leaseAccrual(w: WorldState, co: Company, dt: number): number {
  let cost = 0;
  for (const [id, n] of Object.entries(co.leases ?? {})) {
    const st = w.stations[id]; if (!st || n <= 0) continue;
    const paid = co.leasePaidUntil?.[id] ?? [];
    for (let i = 0; i < n; i++) cost += serviceOf(st).lease * Math.max(0, w.time - Math.max(w.time - dt, paid[i] ?? 0)) / 3600;
  }
  return cost;
}

/** Before the core is built only outstanding construction materials may enter.
 * Existing inventory and reservations remain untouched, including over-cap legacy stock. */
export function constructionRoom(st: Station, item: string): number {
  return Math.max(0, (queueShortfall(st)[item] ?? 0) - qty(st.storage[st.owner], item));
}
